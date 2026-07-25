import { z } from "zod";

/**
 * Request-side schemas. These mirror the app's `UserBio` / `NutritionTargets`
 * but stay permissive (`.passthrough()`) so the app can evolve its bio without
 * breaking the API. We only hard-require what the generators actually read.
 */

export const BioSchema = z
  .object({
    age: z.number(),
    sex: z.enum(["male", "female"]).optional(),
    heightCm: z.number().optional(),
    weightKg: z.number().optional(),
    activityLevel: z.string().optional(),
    exerciseLevel: z.string().optional(),
    primaryGoal: z.string().optional(),
    dietaryRestriction: z.string().optional(),
    allergies: z.array(z.string()).default([]),
    medicalConditions: z.array(z.string()).default([]),
    injuries: z.array(z.string()).optional(),
    medications: z.array(z.string()).optional(),
    medicationCategories: z.array(z.string()).optional(),
    pregnancyTrimester: z.number().optional(),
    foodDislikes: z.array(z.string()).optional(),
    cuisinePreference: z.string().optional(),
    /** Free-text region/country — lets the AI cover any continent, not just the local DB. */
    region: z.string().optional(),
    mealsPerDay: z.union([z.literal(3), z.literal(4)]).optional(),
    equipment: z.array(z.string()).optional(),
    workoutDaysPerWeek: z.number().optional(),
  })
  .passthrough();

export type Bio = z.infer<typeof BioSchema>;

export const TargetsSchema = z
  .object({
    calories: z.number(),
    proteinG: z.number(),
    carbsG: z.number(),
    fatG: z.number(),
    fiberG: z.number().optional(),
    sodiumMg: z.number().optional(),
    sugarG: z.number().optional(),
    waterMl: z.number().optional(),
  })
  .passthrough();

export type Targets = z.infer<typeof TargetsSchema>;

export const DietGenerateSchema = z.object({
  bio: BioSchema,
  targets: TargetsSchema,
  date: z.string(),
  /** Optional: nudge the AI toward a named diet style. */
  dietId: z.string().optional(),
});
export type DietGenerateInput = z.infer<typeof DietGenerateSchema>;

export const WorkoutGenerateSchema = z.object({
  bio: BioSchema,
  weekStart: z.string(),
});
export type WorkoutGenerateInput = z.infer<typeof WorkoutGenerateSchema>;

export const CoachChatSchema = z
  .object({
    /** Grounding system prompt built by the app (real user numbers only). */
    system: z.string().optional(),
    user: z.string().optional(),
    message: z.string().optional(),
  })
  .refine((d) => Boolean(d.user ?? d.message), {
    message: "`user` (or `message`) is required",
  });
export type CoachChatInput = z.infer<typeof CoachChatSchema>;

export const ParseFoodSchema = z.object({
  /** Parse-only system prompt supplied by the app. */
  system: z.string().min(1),
  /** The user's free-text meal description. */
  user: z.string().min(1).max(2000),
});
export type ParseFoodInput = z.infer<typeof ParseFoodSchema>;

/**
 * What the model is permitted to return for a food parse.
 *
 * `.strict()` is the load-bearing part: any extra key — `calories`, `protein`,
 * `nutrition` — fails validation rather than being silently passed through.
 * The model parses language; it is structurally prevented from supplying
 * nutrition figures, which the app resolves itself from cited reference data.
 */
export const ParsedFoodItemsSchema = z.object({
  items: z
    .array(
      z
        .object({
          quantity: z.number().positive().max(1000),
          unit: z.string().max(24),
          food: z.string().min(1).max(120),
        })
        .strict(),
    )
    .max(25),
});
export type ParsedFoodItems = z.infer<typeof ParsedFoodItemsSchema>;
