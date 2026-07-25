# Welliva API

Standalone backend for Welliva. It runs the **Gozlin AI coach** and generates
**diet** and **workout** programs from a user's data — all on **Claude Haiku**.

This folder is self-contained (its own `package.json`, `tsconfig`, deps) and has
**no dependency on the mobile app**, so it can be deployed separately to any
Node host (Render, Railway, Fly, a container, a VPS, etc.).

> ### 🔒 The whole point of this backend
> The Anthropic API key lives **here, on the server** — never in the app bundle.
> The app only ever knows the backend's URL. If your key was ever pasted into a
> client, chat, or commit, **rotate it now** at https://console.anthropic.com.

## Model is locked to Haiku

`src/config.ts` resolves the model and **forces it to Claude Haiku**. Any other
model id (from `CLAUDE_MODEL` or anywhere) is ignored. The model is never read
from a request body, so a caller can never escalate to a pricier model.

```ts
export const CLAUDE_MODEL = requestedModel.startsWith("claude-haiku")
  ? requestedModel        // honor a pinned Haiku snapshot, e.g. claude-haiku-4-5-20251001
  : "claude-haiku-4-5";   // anything else → forced back to Haiku
```

## Run it

```bash
cd backend-welliva
cp .env.example .env        # then put your ANTHROPIC_API_KEY in .env
npm install
npm run dev                 # http://localhost:8787  (watch mode)
```

Production:

```bash
npm run build && npm start
```

Health check: `GET http://localhost:8787/health` → `{ "status": "ok", "model": "claude-haiku-4-5" }`

## Auth — every `/v1` route requires a signed-in user

`/health` is open (uptime probes). Everything under `/v1` requires the caller's
**Supabase access token**:

```
Authorization: Bearer <supabase access_token>
```

The app attaches this automatically in `services/api/WellivaApi.ts`. The token is
verified cryptographically in `src/auth.ts` — issuer, audience, expiry, signature,
and `role === "authenticated"`.

> **The anon key is not a credential.** It's a JWT, but it ships inside the app
> bundle, so it's public. It's rejected on two independent grounds (its issuer is
> `supabase`, not your project's `/auth/v1`; and its role is `anon`). Don't try to
> use it to call this API.

Set these in `.env` (the server refuses to boot without `SUPABASE_URL`):

| Variable | Notes |
| --- | --- |
| `SUPABASE_URL` | Same value as the app's `EXPO_PUBLIC_SUPABASE_URL`. Used as the expected token issuer, so another project's tokens are rejected. |
| `SUPABASE_JWT_SECRET` | **Legacy HS256 projects only** — Project Settings → API → JWT Secret. A real secret: server-side only, never in the app. Newer projects sign asymmetrically; leave blank and the public JWKS is used automatically. |

**Which one is this project?** Ask the project, don't infer it from the anon key —
a legacy-format anon key says nothing about how *user* tokens are signed:

```bash
curl -s https://<project>.supabase.co/auth/v1/.well-known/jwks.json
```

Keys returned (Welliva returns one `ES256`) → asymmetric; leave `SUPABASE_JWT_SECRET`
blank. Empty `keys` array → legacy; set the secret. `src/auth.ts` picks the scheme
per-token from its header, so it handles either without a config change; if a
symmetric token ever shows up with no secret configured it fails closed and logs
exactly what to set.

Per-user rate limits guard the Anthropic bill: `RATE_LIMIT_MAX` per
`RATE_LIMIT_WINDOW_MS` (burst) and `RATE_LIMIT_DAILY_MAX` per rolling day, counted
per Supabase user id. Counters are in-process — fine for a single host; move them
to Redis if you scale to several.

Verify the gate at any time (no real keys needed, ~2s):

```bash
npm run verify:auth
```

It mints tokens and asserts each is refused or admitted correctly — an accidentally
open endpoint still *works*, it just works for everyone, so it needs a check that
actively tries to get in.

## Endpoints

All requests/responses are JSON. Errors are `{ "error": { "code, message } }`.
Auth failures are `401 unauthorized`; throttling is `429 rate_limited` with a
`Retry-After` header.

### `POST /v1/diet/generate`
Generates **one day** of meals for any user — any age, any continent/cuisine,
any health condition — not limited to a fixed food DB. Returns an app-ready
`DaySchedule`.

```jsonc
// request
{
  "date": "2026-06-21",
  "bio": { "age": 34, "sex": "female", "weightKg": 68, "heightCm": 165,
           "primaryGoal": "lose_weight", "dietaryRestriction": "none",
           "allergies": ["peanuts"], "medicalConditions": ["hypertension"],
           "cuisinePreference": "mediterranean", "region": "Greece",
           "mealsPerDay": 3 },
  "targets": { "calories": 1700, "proteinG": 120, "carbsG": 160, "fatG": 55 },
  "dietId": null
}
// response
{ "schedule": { "date": "...", "dietId": "ai-...", "dietName": "...",
                "breakfast": { ... }, "lunch": { ... }, "dinner": { ... }, "snacks": [ ... ] },
  "dailyNutritionEstimate": { "calories": 1690, "proteinG": 118, ... },
  "rationale": "...", "coachNote": "...", "model": "claude-haiku-4-5", "source": "ai" }
```

### `POST /v1/workout/generate`
Generates a **weekly** plan honoring equipment, training days, level, injuries
and medical conditions. Returns an app-ready `GeneratedWorkoutPlan`.

```jsonc
{ "weekStart": "2026-06-15",
  "bio": { "age": 40, "exerciseLevel": "beginner", "primaryGoal": "build_muscle",
           "equipment": ["dumbbells", "bench"], "workoutDaysPerWeek": 4,
           "injuries": ["knee"] } }
```

### `POST /v1/coach/chat`
Open-ended Gozlin reply. The app sends a grounding `system` prompt containing
only the user's real numbers; the model may use **only** those facts.

```jsonc
{ "system": "You are Gozlin... Known facts: streak 6 days, ...", "user": "I'm exhausted today" }
// → { "reply": "...", "model": "claude-haiku-4-5" }
```

## How generation works

Diet and workout use **forced tool-use** (`tool_choice` → a single emit tool)
so the model's output is schema-shaped without any structured-output beta — it
works on Haiku. The server then validates with `zod` (one self-repair retry on
failure) and assembles the exact app model shapes (`DaySchedule`,
`GeneratedWorkoutPlan`). The deterministic engines in the app are kept as an
offline fallback, so the app never breaks when the API is unreachable.

## Deploy notes

- Set `ANTHROPIC_API_KEY`, `PORT`, and `CORS_ORIGIN` (lock CORS to your app's
  origin in production instead of `*`).
- Point the app at it with `EXPO_PUBLIC_API_URL` (see the app's `.env.example`).
- This is a normal Node/Express service — any platform that runs Node ≥ 18 works.
