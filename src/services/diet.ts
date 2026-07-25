import { z } from "zod";
import { callToolValidated } from "../anthropic.js";
import { CLAUDE_MODEL } from "../config.js";
import type { DietGenerateInput } from "../domain.js";

/**
 * AI DIET GENERATOR
 *
 * Replaces the app's local, Nigerian/European-biased meal database. The model
 * builds ONE day's plan for ANY user — any age, any continent/cuisine, any
 * health condition — and returns it through the `emit_day_plan` tool so the
 * shape is guaranteed. The server then assembles a canonical `DaySchedule`
 * that drops straight into the existing Welliva UI.
 */

const CUISINES = ["Nigerian", "Western", "Mediterranean", "Universal"] as const;

const MealOut = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  region: z.string().default(""),
  cuisine: z.enum(CUISINES).default("Universal"),
  caloriesMin: z.number().nonnegative(),
  caloriesMax: z.number().nonnegative(),
  proteinMin: z.number().nonnegative(),
  proteinMax: z.number().nonnegative(),
  carbsMin: z.number().nonnegative(),
  carbsMax: z.number().nonnegative(),
  fatMin: z.number().nonnegative(),
  fatMax: z.number().nonnegative(),
});

const DraftOut = z.object({
  dietId: z.string().min(1),
  dietName: z.string().min(1),
  rationale: z.string().default(""),
  coachNote: z.string().default(""),
  breakfast: MealOut,
  lunch: MealOut,
  dinner: MealOut,
  snacks: z.array(MealOut).default([]),
});

type Draft = z.infer<typeof DraftOut>;
type MealDraft = z.infer<typeof MealOut>;

// ── Tool schema (JSON Schema the model fills) ──────────────────────────────
const mealSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "name",
    "description",
    "region",
    "cuisine",
    "caloriesMin",
    "caloriesMax",
    "proteinMin",
    "proteinMax",
    "carbsMin",
    "carbsMax",
    "fatMin",
    "fatMax",
  ],
  properties: {
    name: { type: "string", description: "Dish name" },
    description: {
      type: "string",
      description: "One sentence: what it is + key ingredients + prep style",
    },
    region: {
      type: "string",
      description: "Country/region the dish belongs to, e.g. 'Japan', 'West Africa', 'Levant'",
    },
    cuisine: {
      type: "string",
      enum: [...CUISINES],
      description:
        "Closest app cuisine bucket. Use 'Universal' for anything outside Nigerian/Western/Mediterranean.",
    },
    caloriesMin: { type: "number" },
    caloriesMax: { type: "number" },
    proteinMin: { type: "number", description: "grams" },
    proteinMax: { type: "number", description: "grams" },
    carbsMin: { type: "number", description: "grams" },
    carbsMax: { type: "number", description: "grams" },
    fatMin: { type: "number", description: "grams" },
    fatMax: { type: "number", description: "grams" },
  },
} as const;

const DIET_TOOL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["dietId", "dietName", "rationale", "coachNote", "breakfast", "lunch", "dinner", "snacks"],
  properties: {
    dietId: {
      type: "string",
      description: "Stable kebab-case id for this diet style, e.g. 'mediterranean-high-protein'",
    },
    dietName: { type: "string", description: "Human diet name, e.g. 'High-Protein Mediterranean'" },
    rationale: { type: "string", description: "1-2 sentences on why this plan fits the user" },
    coachNote: {
      type: "string",
      description: "A short, warm note in the voice of a supportive coach (Gozlin)",
    },
    breakfast: mealSchema,
    lunch: mealSchema,
    dinner: mealSchema,
    snacks: {
      type: "array",
      description: "1-2 snacks",
      items: mealSchema,
    },
  },
} as const;

const SYSTEM = `You are Welliva's clinical nutrition engine. You design ONE day of meals tailored to a single person.

You are NOT limited to any fixed food database. The user may live anywhere in the world, be any age, and have any health profile. Choose foods that are culturally appropriate and realistically available for their region/cuisine.

Hard rules:
- Respect the calorie target: the sum of meal midpoints ((min+max)/2 across breakfast, lunch, dinner, snacks) must land within ~7% of the target calories.
- Respect macro targets (protein/carbs/fat grams) as closely as the calorie target allows; prioritize hitting the protein target.
- NEVER include any listed allergy. Honor the dietary restriction strictly (vegan, vegetarian, pescatarian, halal, kosher, gluten_free, dairy_free).
- Avoid the user's disliked foods.
- Use realistic per-meal macros; give each meal a short description and a region tag.

Medical safety (apply when present in medicalConditions):
- hypertension → low sodium, DASH-style, potassium-rich produce.
- diabetes_type2 → low glycemic index, controlled total carbs, high fiber, no added sugar.
- renal_issues → moderate (not high) protein, low potassium/phosphorus/sodium; avoid organ meats and excess dairy.
- pregnancy → adequate calories, rich in folate/iron/calcium/choline; AVOID alcohol, raw/undercooked fish or eggs, high-mercury fish, unpasteurized dairy, liver megadoses.
- postpartum → nutrient-dense, lactation-supportive if relevant.
Consider medicationCategories for interactions (e.g. blood_thinners → keep vitamin-K/leafy greens steady; diuretics/corticosteroids → lower sodium).

Make portions age-appropriate. Return your answer ONLY by calling the emit_day_plan tool.`;

// ── App-compatible output types (mirror models/diet.ts) ────────────────────
type Range = { min: number; max: number };
interface ScheduledMeal {
  id: string;
  mealType: "breakfast" | "lunch" | "dinner" | "snack";
  name: string;
  calories: Range;
  proteinG: Range;
  carbsG: Range;
  fatG: Range;
  isNigerian?: boolean;
  cuisine?: (typeof CUISINES)[number];
  isConsumed: boolean;
  /** Extra AI context (ignored by current UI, available for richer screens). */
  description?: string;
  region?: string;
}
interface DaySchedule {
  date: string;
  dietId: string;
  dietName: string;
  breakfast: ScheduledMeal | null;
  lunch: ScheduledMeal | null;
  dinner: ScheduledMeal | null;
  snacks: ScheduledMeal[];
  status: "upcoming" | "active" | "completed" | "expired";
}

export interface DietGenerateResult {
  schedule: DaySchedule;
  dailyNutritionEstimate: {
    calories: number;
    proteinG: number;
    carbsG: number;
    fatG: number;
  };
  dietName: string;
  rationale: string;
  coachNote: string;
  model: string;
  source: "ai";
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "meal";
}
const r = Math.round;
const range = (min: number, max: number): Range => ({ min: r(Math.min(min, max)), max: r(Math.max(min, max)) });

function toScheduled(
  m: MealDraft,
  mealType: ScheduledMeal["mealType"],
  index: number,
): ScheduledMeal {
  return {
    id: `meal_${mealType}_${index}_${slug(m.name)}`,
    mealType,
    name: m.name,
    calories: range(m.caloriesMin, m.caloriesMax),
    proteinG: range(m.proteinMin, m.proteinMax),
    carbsG: range(m.carbsMin, m.carbsMax),
    fatG: range(m.fatMin, m.fatMax),
    cuisine: m.cuisine,
    isNigerian: m.cuisine === "Nigerian",
    isConsumed: false,
    description: m.description || undefined,
    region: m.region || undefined,
  };
}

function estimate(schedule: DaySchedule) {
  let calories = 0,
    proteinG = 0,
    carbsG = 0,
    fatG = 0;
  const add = (m: ScheduledMeal | null) => {
    if (!m) return;
    calories += (m.calories.min + m.calories.max) / 2;
    proteinG += (m.proteinG.min + m.proteinG.max) / 2;
    carbsG += (m.carbsG.min + m.carbsG.max) / 2;
    fatG += (m.fatG.min + m.fatG.max) / 2;
  };
  add(schedule.breakfast);
  add(schedule.lunch);
  add(schedule.dinner);
  schedule.snacks.forEach(add);
  return { calories: r(calories), proteinG: r(proteinG), carbsG: r(carbsG), fatG: r(fatG) };
}

export async function generateDiet(input: DietGenerateInput): Promise<DietGenerateResult> {
  const mealsPerDay = input.bio.mealsPerDay ?? 3;
  const userPayload = {
    date: input.date,
    mealsPerDay,
    snacksWanted: mealsPerDay === 4 ? 2 : 1,
    requestedDietStyle: input.dietId ?? null,
    targets: input.targets,
    user: input.bio,
  };

  const draft = await callToolValidated<Draft>(
    {
      system: SYSTEM,
      user:
        "Design today's meal plan for this user. Return exactly " +
        `${userPayload.snacksWanted} snack(s).\n\n` +
        JSON.stringify(userPayload),
      toolName: "emit_day_plan",
      toolDescription: "Emit the day's meal plan for the user.",
      inputSchema: DIET_TOOL_SCHEMA as unknown as Record<string, unknown>,
      maxTokens: 3072,
    },
    (raw) => DraftOut.parse(raw),
  );

  const snackCount = mealsPerDay === 4 ? 2 : 1;
  const snacks = draft.snacks.slice(0, snackCount).map((s, i) => toScheduled(s, "snack", i));

  const schedule: DaySchedule = {
    date: input.date,
    dietId: draft.dietId.startsWith("ai-") ? draft.dietId : `ai-${slug(draft.dietId)}`,
    dietName: draft.dietName,
    breakfast: toScheduled(draft.breakfast, "breakfast", 0),
    lunch: toScheduled(draft.lunch, "lunch", 0),
    dinner: toScheduled(draft.dinner, "dinner", 0),
    snacks,
    status: "active",
  };

  return {
    schedule,
    dailyNutritionEstimate: estimate(schedule),
    dietName: draft.dietName,
    rationale: draft.rationale,
    coachNote: draft.coachNote,
    model: CLAUDE_MODEL,
    source: "ai",
  };
}
