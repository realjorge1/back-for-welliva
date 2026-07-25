import { Router } from "express";
import { requireAuth } from "./auth.js";
import { CLAUDE_MODEL, config } from "./config.js";
import {
  CoachChatSchema,
  DietGenerateSchema,
  ParseFoodSchema,
  WorkoutGenerateSchema,
} from "./domain.js";
import { asyncHandler } from "./http.js";
import { createRateLimiter } from "./rateLimit.js";
import { coachReply } from "./services/coach.js";
import { generateDiet } from "./services/diet.js";
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

/** Gozlin coach — open-ended conversational reply, grounded by the app. */
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
