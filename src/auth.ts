/**
 * AUTH — every /v1 route requires a real, signed-in Supabase user.
 *
 * The app sends the user's Supabase access token as `Authorization: Bearer …`.
 * We verify it cryptographically here; there is no way to reach Anthropic
 * without one, so the endpoints can't be used to burn our tokens.
 *
 * Two signing schemes are supported, chosen per-token from its header:
 *   HS256  — legacy projects, shared secret (SUPABASE_JWT_SECRET).
 *   ES256/RS256 — newer projects, verified against the project's public JWKS.
 *
 * ── The check that actually matters ─────────────────────────────────────────
 * The anon key is itself a JWT and it ships inside the app bundle, so it is
 * public. It must never be accepted as a credential. Two things reject it:
 *   1. `iss` — the anon key's issuer is "supabase", not "<project>/auth/v1".
 *   2. `role` — the anon key carries role "anon"; we demand "authenticated".
 * Either alone is sufficient; both are enforced because this is the whole
 * boundary. A token also has to carry a `sub` (the user id) to be usable.
 */
import type { NextFunction, Request, Response } from "express";
import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify } from "jose";
import { config } from "./config.js";
import { ApiError } from "./http.js";
import { log } from "./logger.js";

export interface AuthedUser {
  /** Supabase user id (the JWT `sub`) — also the `users.id` row key. */
  id: string;
  email: string | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthedUser;
    }
  }
}

/** Lazily-built remote key set; jose caches and re-fetches on rotation. */
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function remoteKeys() {
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${config.jwtIssuer}/.well-known/jwks.json`));
  }
  return jwks;
}

const hmacKey = config.supabaseJwtSecret
  ? new TextEncoder().encode(config.supabaseJwtSecret)
  : null;

const unauthorized = (message: string) => new ApiError(401, "unauthorized", message);

/** Pull the bearer token out of the Authorization header. */
function bearerFrom(req: Request): string {
  const header = req.headers.authorization;
  if (!header) throw unauthorized("Missing Authorization header");
  const [scheme, token] = header.split(" ");
  if (!/^Bearer$/i.test(scheme ?? "") || !token?.trim()) {
    throw unauthorized("Expected an 'Authorization: Bearer <token>' header");
  }
  return token.trim();
}

/**
 * Verify a Supabase access token and return the user it identifies.
 * Throws ApiError(401) for anything that isn't a valid, current user token.
 */
export async function verifyAccessToken(token: string): Promise<AuthedUser> {
  let alg: string | undefined;
  try {
    alg = decodeProtectedHeader(token).alg;
  } catch {
    throw unauthorized("Malformed token");
  }

  const verifyOptions = {
    issuer: config.jwtIssuer,
    audience: "authenticated",
  } as const;

  let payload;
  try {
    if (alg === "HS256") {
      if (!hmacKey) {
        // A symmetric token arrived but we hold no secret to check it with.
        // Fail closed and make the misconfiguration obvious in the logs.
        log.error(
          "Received an HS256 token but SUPABASE_JWT_SECRET is not set — cannot verify. " +
            "Set it from Supabase → Project Settings → API → JWT Secret.",
        );
        throw unauthorized("Token cannot be verified");
      }
      ({ payload } = await jwtVerify(token, hmacKey, verifyOptions));
    } else {
      ({ payload } = await jwtVerify(token, remoteKeys(), verifyOptions));
    }
  } catch (e) {
    if (e instanceof ApiError) throw e;
    // Covers expired, wrong-issuer, wrong-audience, bad-signature, unknown-kid.
    const code = (e as { code?: string })?.code;
    if (code === "ERR_JWT_EXPIRED") throw unauthorized("Token expired");
    throw unauthorized("Invalid token");
  }

  // See the header comment: this is what keeps the public anon key out.
  if (payload.role !== "authenticated") {
    throw unauthorized("Token is not a signed-in user token");
  }
  const sub = typeof payload.sub === "string" ? payload.sub.trim() : "";
  if (!sub) throw unauthorized("Token has no subject");

  return {
    id: sub,
    email: typeof payload.email === "string" ? payload.email : null,
  };
}

/** Express middleware — attaches `req.user` or rejects with 401. */
export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    req.user = await verifyAccessToken(bearerFrom(req));
    next();
  } catch (e) {
    next(e);
  }
}
