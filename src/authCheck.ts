/**
 * AUTH GATE CHECK — `npm run verify:auth`
 *
 * Boots the real app with a throwaway JWT secret, mints tokens with jose, and
 * asserts what each one gets back. No test framework, no network, no real keys.
 *
 * Run this after touching auth.ts, rateLimit.ts, or routes.ts. An open endpoint
 * fails silently in normal use — everything keeps working, it just works for
 * everyone — so it needs something that actively tries to get in.
 */
const SECRET = "throwaway-secret-used-only-by-this-check";
const PROJECT = "https://project-under-test.supabase.co";

process.env.ANTHROPIC_API_KEY = "sk-ant-fake-never-reached-for-rejected-tokens";
process.env.SUPABASE_URL = PROJECT;
process.env.SUPABASE_JWT_SECRET = SECRET;
process.env.RATE_LIMIT_MAX = "3";
process.env.RATE_LIMIT_WINDOW_MS = "60000";
process.env.NODE_ENV = "development";

const { SignJWT } = await import("jose");
const { createApp } = await import("./app.js");

const key = new TextEncoder().encode(SECRET);
const ISS = `${PROJECT}/auth/v1`;
const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;

function mint(claims: Record<string, unknown>, opts: { iss?: string; exp?: string } = {}) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(opts.iss ?? ISS)
    .setAudience("authenticated")
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? "1h")
    .sign(key);
}

const results: boolean[] = [];
function record(ok: boolean, label: string, detail: string) {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label.padEnd(34)} → ${detail}`);
}

async function call(token: string | null) {
  const res = await fetch(`${BASE}/v1/coach/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ user: "hi" }),
  });
  const body = (await res.json().catch(() => ({}))) as { error?: { code?: string } };
  return { status: res.status, code: body.error?.code, headers: res.headers };
}

/** Assert a token is refused with 401 unauthorized. */
async function mustReject(label: string, token: string | null) {
  const { status, code } = await call(token);
  record(status === 401 && code === "unauthorized", label, `${status} ${code ?? "ok"}`);
}

const app = createApp();
const server = app.listen(PORT);
await new Promise((resolve) => server.once("listening", resolve));

// Uptime probes must not need a token.
const health = await fetch(`${BASE}/health`);
record(health.status === 200, "/health needs no token", String(health.status));

await mustReject("no Authorization header", null);
await mustReject("garbage token", "not-a-jwt");
await mustReject("empty bearer", "");

// The anon key is a JWT that SHIPS IN THE APP BUNDLE — it is public and must
// never work as a credential. Its issuer is "supabase" and its role is "anon".
const anonKeyShape =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
  "eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InByb2plY3QiLCJyb2xlIjoiYW5vbiIsImlhdCI6MTc4NDM2NTY4MywiZXhwIjoyMDk5OTQxNjgzfQ." +
  "3aQ9J5nQ9m1kUog0Wl9zVQvJmC7yq0hTqvJbYhLZ0aA";
await mustReject("a public anon key", anonKeyShape);

// Correctly signed by us, but not a signed-in user → the role check must catch it.
await mustReject("valid signature, role=anon", await mint({ sub: "u1", role: "anon" }));
await mustReject("service_role token", await mint({ sub: "u1", role: "service_role" }));
await mustReject("authenticated but no sub", await mint({ role: "authenticated" }));

// Signed with a different project's secret.
const foreign = await new SignJWT({ sub: "u1", role: "authenticated" })
  .setProtectedHeader({ alg: "HS256" })
  .setIssuer(ISS)
  .setAudience("authenticated")
  .setIssuedAt()
  .setExpirationTime("1h")
  .sign(new TextEncoder().encode("a-different-projects-secret"));
await mustReject("signed with wrong secret", foreign);

// Our secret, but claiming to be another project.
await mustReject(
  "wrong issuer",
  await mint({ sub: "u1", role: "authenticated" }, { iss: "https://other.supabase.co/auth/v1" }),
);
await mustReject("expired token", await mint({ sub: "u1", role: "authenticated" }, { exp: "-5m" }));

// A genuine user token must get PAST the gate. It then fails at Anthropic with
// the fake key — so "not 401/unauthorized" is what proves the gate opened.
const good = await mint({ sub: "real-user-123", role: "authenticated", email: "a@b.c" });
const passed = await call(good);
record(
  passed.status !== 401 && passed.code !== "unauthorized",
  "valid user token passes gate",
  `${passed.status} ${passed.code ?? "ok"}`,
);

// Burst limit is 3/window for this run; the next calls must 429.
let limited: { status: number; headers: Headers } | null = null;
for (let i = 0; i < 6 && !limited; i++) {
  const r = await call(good);
  if (r.status === 429) limited = { status: r.status, headers: r.headers };
}
record(
  limited !== null,
  "burst limit trips",
  limited ? `429 Retry-After=${limited.headers.get("retry-after")}` : "never returned 429",
);

// One user hitting their ceiling must not lock out anyone else.
const other = await call(await mint({ sub: "other-user-456", role: "authenticated" }));
record(other.status !== 429, "limits are per-user", String(other.status));

server.close();

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
