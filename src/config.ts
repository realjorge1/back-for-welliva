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
 * HARD PRODUCT REQUIREMENT — the model is chosen by the SERVER, per task.
 *
 * Previously this was a single global Haiku lock. That was the right shape when
 * every endpoint was a stateless one-shot generator, and the wrong shape once
 * coaching became a tool-using agent loop: tool orchestration and clinical
 * judgement are exactly where the model-tier gap shows.
 *
 * So it's a routing table now, not a switch. The invariant that actually
 * mattered is preserved and strengthened: the model is NEVER read from a
 * request body, and every id below is a compile-time constant, so no caller can
 * escalate to a pricier model.
 *
 * Split by TASK, never by turn. Prompt caches are model-scoped, so swapping
 * models mid-conversation dumps the entire cache and costs more than it saves.
 */
export const MODELS = {
  /**
   * The Gozlin coaching agent loop. Opus 5 at low effort — it is unusually
   * strong at `low`, which keeps mobile latency tolerable while still
   * orchestrating tools reliably.
   */
  coach: "claude-opus-5",
  /**
   * Depth work that isn't latency-bound: plan generation, long-form review.
   * Same model as `coach` on purpose — one cache scope for the heavy path.
   */
  deep: "claude-opus-5",
  /**
   * Stateless side-tasks (food-text parsing). No conversation, no cache to
   * thrash, and latency here sits in front of someone typing.
   */
  utility: requestedModel.startsWith("claude-haiku") ? requestedModel : "claude-haiku-4-5",
} as const;

/**
 * Back-compat alias. The pre-existing diet/workout/coach-chat endpoints all
 * mean "the cheap stateless model" when they say CLAUDE_MODEL.
 */
export const CLAUDE_MODEL = MODELS.utility;

/** True when the env asked for a non-Haiku utility model and we overrode it. */
export const MODEL_WAS_FORCED = requestedModel !== MODELS.utility;

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

  /**
   * USDA FoodData Central key (free: https://fdc.nal.usda.gov/api-key-signup.html).
   *
   * Server-side only — it must never reach the client, which is the whole
   * reason food lookup runs here rather than in the app. Optional so an
   * existing deployment still boots without it, but /v1/nutrition/lookup then
   * has no measured source to try and falls back to AI estimates for
   * everything, which is a much weaker feature. Set it.
   */
  fdcApiKey: optional("FDC_API_KEY"),

  /** Burst limit: requests per user per short window. */
  rateLimitMax: intFromEnv("RATE_LIMIT_MAX", 20),
  rateLimitWindowMs: intFromEnv("RATE_LIMIT_WINDOW_MS", 60_000),
  /** Cost ceiling: AI calls per user per rolling day. */
  rateLimitDailyMax: intFromEnv("RATE_LIMIT_DAILY_MAX", 300),
} as const;

export const isProduction = config.nodeEnv === "production";
