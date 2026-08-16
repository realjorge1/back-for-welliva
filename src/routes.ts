import { Router } from "express";
import { requireAuth } from "./auth.js";
import { CLAUDE_MODEL, config } from "./config.js";
import {
  CoachChatSchema,
  CoachTurnSchema,
  DietGenerateSchema,
  FoodLookupSchema,
  ParseFoodSchema,
  WorkoutGenerateSchema,
} from "./domain.js";
import { asyncHandler } from "./http.js";
import { createRateLimiter } from "./rateLimit.js";
import { coachReply } from "./services/coach.js";
import { streamCoachTurn } from "./services/coachTurn.js";
import { generateDiet } from "./services/diet.js";
import { lookupFood } from "./services/nutritionLookup.js";
import { parseFood } from "./services/nutritionParse.js";
import { generateWorkout } from "./services/workout.js";

export const router = Router();

/** Unauthenticated on purpose — uptime probes must not need a user token. */
router.get("/health", (_req, res) => {
  res.json({ status: "ok", model: CLAUDE_MODEL, time: new Date().toISOString() });
});

/**
 * Everything below is gated. Applied to the `/v1` prefix rather than route by
 * route so a new endpoint is protected by default — forgetting to add the
 * middleware can't silently open a hole.
 */
router.use(
  "/v1",
  requireAuth,
  createRateLimiter({
    name: "burst",
    windowMs: config.rateLimitWindowMs,
    max: config.rateLimitMax,
  }),
  createRateLimiter({
    name: "daily",
    windowMs: 24 * 60 * 60 * 1000,
    max: config.rateLimitDailyMax,
  }),
);

/** Generate one day's AI meal plan → app-compatible DaySchedule. */
router.post(
  "/v1/diet/generate",
  asyncHandler(async (req, res) => {
    const input = DietGenerateSchema.parse(req.body);
    res.json(await generateDiet(input));
  }),
);

/** Generate a weekly AI workout plan → app-compatible GeneratedWorkoutPlan. */
router.post(
  "/v1/workout/generate",
  asyncHandler(async (req, res) => {
    const input = WorkoutGenerateSchema.parse(req.body);
    res.json(await generateWorkout(input));
  }),
);

/**
 * Gozlin coach — ONE TURN of the agent loop, streamed as NDJSON.
 *
 * The loop itself runs on the phone: it executes tools locally and calls this
 * again with the results. We stay a thin relay and never gain tool logic —
 * that's what keeps the user's raw history off this server.
 */
router.post(
  "/v1/coach/turn",
  asyncHandler(async (req, res) => {
    const input = CoachTurnSchema.parse(req.body);
    await streamCoachTurn(input, res);
  }),
);

/**
 * Gozlin coach — open-ended conversational reply, grounded by the app.
 *
 * Superseded by /v1/coach/turn. Kept so app builds already in the wild keep
 * working; remove once the minimum supported client ships the agent loop.
 */
router.post(
  "/v1/coach/chat",
  asyncHandler(async (req, res) => {
    const input = CoachChatSchema.parse(req.body);
    res.json(await coachReply(input));
  }),
);

/**
 * Parse free text into food names + amounts. Returns NO nutrition data by
 * design — the app resolves that itself from cited reference data. See
 * services/nutritionParse.ts.
 */
router.post(
  "/v1/nutrition/parse",
  asyncHandler(async (req, res) => {
    const input = ParseFoodSchema.parse(req.body);
    res.json(await parseFood(input));
  }),
);

/**
 * Find a food the app's catalog doesn't have — USDA first, an AI estimate only
 * on a USDA miss, and an empty list rather than an invented food.
 *
 * The one endpoint permitted to return nutrition figures, and the only one that
 * can say where each figure came from. Free for every signed-in user: it's what
 * the app falls back to when someone searches a food we simply don't ship, so
 * putting it behind a tier would gate the catalog itself. See
 * services/nutritionLookup.ts for the bounds that make the exception safe.
 */
router.post(
  "/v1/nutrition/lookup",
  asyncHandler(async (req, res) => {
    const input = FoodLookupSchema.parse(req.body);
    res.json(await lookupFood(input));
  }),
);
