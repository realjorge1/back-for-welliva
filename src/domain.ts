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

/**
 * One turn of the Gozlin agent loop.
 *
 * The app owns the conversation array because it drives the loop — it appends
 * assistant turns and tool results between requests. Note what is NOT here:
 * `system`, `model`, `tools`, `max_tokens`. Those are server-owned constants.
 * A client that could set the system prompt could delete the coach's safety
 * rules; a client that could set the model could escalate our bill.
 *
 * Content is `unknown` because it legitimately varies — a plain string, or an
 * array of text / tool_use / tool_result / thinking blocks. The Messages API is
 * the real validator; we bound size and shape here so a malformed body fails
 * cheaply instead of at the upstream.
 */
export const CoachTurnSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant", "system"]),
        content: z.unknown(),
      }),
    )
    .min(1)
    .max(60),
  /**
   * Which build of the prompt/tool contract the app was compiled against.
   * Mismatches are logged, not rejected — an older client still coaches fine.
   */
  promptVersion: z.string().max(40).optional(),
});
export type CoachTurnInput = z.infer<typeof CoachTurnSchema>;

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

/* ── Food lookup (POST /v1/nutrition/lookup) ──────────────────────────────
 *
 * The ONE endpoint allowed to return nutrition figures, and only under the
 * conditions in services/nutritionLookup.ts. Everything below is the wire
 * contract the app already ships against (`FoodLookupResult` in
 * services/api/WellivaApi.ts) — the names and units are load-bearing.
 */

export const FoodLookupSchema = z.object({
  /** The user's raw search text, exactly as typed. */
  query: z.string().trim().min(1).max(120),
  /** Free-text region from the user's profile. A strong hint, never a filter. */
  region: z.string().trim().max(80).optional(),
});
export type FoodLookupInput = z.infer<typeof FoodLookupSchema>;

export type NutrientUnit = "kcal" | "g" | "mg" | "mcg";

/**
 * The app's `NutrientKey` set and the unit each key is measured in. A key that
 * isn't here is silently dropped by the app, so this table is the authority for
 * both what we may send and what it means.
 */
export const NUTRIENT_UNITS = {
  calories: "kcal",
  protein: "g",
  fat: "g",
  satFat: "g",
  transFat: "g",
  monoFat: "g",
  polyFat: "g",
  cholesterol: "mg",
  carbs: "g",
  fiber: "g",
  sugar: "g",
  addedSugar: "g",
  sodium: "mg",
  water: "g",
  caffeine: "mg",
  alcohol: "g",
  potassium: "mg",
  calcium: "mg",
  iron: "mg",
  magnesium: "mg",
  zinc: "mg",
  vitaminA: "mcg",
  vitaminC: "mg",
  vitaminD: "mcg",
  vitaminE: "mg",
  vitaminK: "mcg",
  vitaminB6: "mg",
  vitaminB12: "mcg",
  folate: "mcg",
  thiamin: "mg",
  riboflavin: "mg",
  niacin: "mg",
} as const satisfies Record<string, NutrientUnit>;

export type NutrientKey = keyof typeof NUTRIENT_UNITS;

/**
 * Deliberately Partial. A missing key means "unknown" and renders as `—`; a key
 * set to 0 means a measured zero. Writing 0 for "I don't know" is the one thing
 * this shape must never be used to say.
 */
export type NutrientPanel = Partial<Record<NutrientKey, number>>;

/** The app buckets its Foods screen strictly by these strings. */
export const FOOD_GROUPS = [
  "Fruits",
  "Vegetables",
  "Proteins",
  "Legumes & Plant Protein",
  "Grains & Starches",
  "Nuts, Seeds, Fats & Oils",
  "Dairy & Alternatives",
  "Herbs, Aromatics & Seasonings",
  "Beverages",
] as const;

export type FoodGroup = (typeof FOOD_GROUPS)[number];

export type NutrientOrigin = "usda" | "ai-estimate";

export type FdcDataset = "SR Legacy" | "Foundation" | "FNDDS" | "Branded";

export interface FoodLookupResult {
  name: string;
  /** Human household measure, e.g. "1 cup". Never empty. */
  serving: string;
  servingGrams: number | null;
  group: FoodGroup;
  /** PER SERVING. */
  nutrients: NutrientPanel;
  per100g?: NutrientPanel;
  origin: NutrientOrigin;
  /** Required iff origin === "usda". Never set for an estimate. */
  fdcId?: number;
  dataset?: FdcDataset;
  description?: string;
  /** Required iff origin === "ai-estimate". Never set for a measurement. */
  model?: string;
  isRegional?: boolean;
}

export interface FoodLookupResponse {
  results: FoodLookupResult[];
  resolvedBy: NutrientOrigin | "none";
}
