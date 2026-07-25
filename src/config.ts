import "dotenv/config";

function required(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(
      `Missing required environment variable: ${name}. Copy .env.example to .env and fill it in.`,
    );
  }
  return v.trim();
}

function optional(name: string): string | null {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : null;
}

function intFromEnv(name: string, fallback: number): number {
  const raw = optional(name);
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Environment variable ${name} must be a positive number, got: ${raw}`);
  }
  return Math.floor(n);
}

const requestedModel = (process.env.CLAUDE_MODEL ?? "").trim() || "claude-haiku-4-5";

/**
 * HARD PRODUCT REQUIREMENT — this backend runs on Claude Haiku ONLY.
 *
 * Any non-Haiku model id (from env, a request, or anywhere) is ignored and
 * forced back to the Haiku alias. The model is never read from a request body,
 * so callers can never escalate to a pricier model.
 */
export const CLAUDE_MODEL = requestedModel.startsWith("claude-haiku")
  ? requestedModel
  : "claude-haiku-4-5";

/** True when the env asked for a non-Haiku model and we overrode it. */
export const MODEL_WAS_FORCED = requestedModel !== CLAUDE_MODEL;

/** Supabase project URL, e.g. https://abcd1234.supabase.co (no trailing slash). */
const supabaseUrl = required("SUPABASE_URL").replace(/\/+$/, "");

export const config = {
  anthropicApiKey: required("ANTHROPIC_API_KEY"),
  port: Number(process.env.PORT ?? 8787),
  corsOrigin: (process.env.CORS_ORIGIN ?? "*").trim(),
  nodeEnv: process.env.NODE_ENV ?? "development",

  supabaseUrl,
  /**
   * The `iss` every Supabase-issued user token carries. Verifying against this
   * is what stops a token from some *other* Supabase project being accepted.
   */
  jwtIssuer: `${supabaseUrl}/auth/v1`,
  /**
   * Legacy HS256 projects sign with a shared secret (Project Settings → API →
   * JWT Secret). Newer projects sign asymmetrically and publish a JWKS instead;
   * leave this unset for those and the JWKS endpoint is used automatically.
   */
  supabaseJwtSecret: optional("SUPABASE_JWT_SECRET"),

  /** Burst limit: requests per user per short window. */
  rateLimitMax: intFromEnv("RATE_LIMIT_MAX", 20),
  rateLimitWindowMs: intFromEnv("RATE_LIMIT_WINDOW_MS", 60_000),
  /** Cost ceiling: AI calls per user per rolling day. */
  rateLimitDailyMax: intFromEnv("RATE_LIMIT_DAILY_MAX", 300),
} as const;

export const isProduction = config.nodeEnv === "production";
