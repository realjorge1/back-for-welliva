/**
 * FOOD LOOKUP — the one endpoint allowed to return nutrition figures.
 *
 * Welliva's rule is that a number in a NutrientPanel traces back to a measured
 * source, and that nothing in one is ever produced by a language model. That is
 * why /v1/nutrition/parse can return only {quantity, unit, food} and is
 * schema-forbidden from returning nutrition at all.
 *
 * This endpoint is a deliberate, bounded exception. It exists because the app's
 * catalog covers staples well and the rest of the world badly: a user searching
 * "abacha", "chin chin" or a specific branded cereal gets nothing. What makes
 * the exception acceptable is not the prompt — it's these three bounds:
 *
 *   1. A MEASURED SOURCE IS ALWAYS TRIED FIRST. USDA FoodData Central. If USDA
 *      has the food, the model is never asked (see nutrition/fdc.ts).
 *   2. AN ESTIMATE IS NEVER DRESSED AS A MEASUREMENT. It leaves here tagged
 *      `origin: "ai-estimate"` with the model id attached, and the app carries
 *      that tag on its weakest confidence rung — labelled on the food, on the
 *      day's totals and in the end-of-period report, permanently.
 *   3. `origin` AND `fdcId` ARE SET BY THIS FILE, NEVER BY THE MODEL. The
 *      estimate schema has no field for either, and zod strips unknown keys, so
 *      a model that tries to claim `origin: "usda"` cannot: the key is gone
 *      before this code sees it. Reporting "usda" for a figure a model produced
 *      is the one failure this whole design exists to prevent.
 *
 * Zero results is a successful answer. Inventing a food to avoid an empty list
 * would defeat the point of the endpoint.
 */
import { callToolValidated } from "../anthropic.js";
import { CLAUDE_MODEL } from "../config.js";
import {
  FOOD_GROUPS,
  type FoodLookupInput,
  type FoodLookupResponse,
  type FoodLookupResult,
} from "../domain.js";
import { ApiError } from "../http.js";
import { log } from "../logger.js";
import { lookupUsda } from "../nutrition/fdc.js";
import { coerceGroup } from "../nutrition/foodGroups.js";
import { isPanelEmpty, roundNutrient, sanitizePanel, scalePanel } from "../nutrition/panel.js";
import { z } from "zod";

/** The app truncates past this, and a longer list turns a choice into a chore. */
const MAX_RESULTS = 8;

/* ── rung 2: the model ────────────────────────────────────────────────────── */

const ESTIMATE_SYSTEM = `You estimate nutrition for prepared dishes that no food composition table covers.

Record 1-3 candidate foods through the record_estimates tool.

Rules:
- "nutrients" describes ONE serving, in kcal and grams (sodium in mg).
- OMIT any nutrient you are not reasonably confident of. Never write 0 to mean
  "I don't know" — 0 means a measured zero.
- Base estimates on a typical home preparation, not a restaurant portion.
- "serving" is the household measure alone ("1 cup", "2 pieces"). Put its weight
  in servingGrams — never in the serving text.
- Choose "group" from the dish's dominant ingredient, not from its English name:
  abacha is shredded cassava, so Grains & Starches, despite being called a salad.
- The user's region is a strong hint about which dish is meant, not a filter.
- If the query is not a food, or you genuinely cannot identify it, record an
  empty list. Do not invent a food to avoid returning nothing.`;

/**
 * Only the nutrients a model can reasonably estimate for a home-cooked dish.
 * Micronutrients are absent on purpose: guessing at a food's iron content is
 * exactly the kind of confident, unsourced number this system is built to keep
 * out. The app renders what's missing as `—`.
 */
const ESTIMATE_NUTRIENT_PROPS = {
  calories: { type: "number", description: "kcal in one serving. Required." },
  protein: { type: "number", description: "grams" },
  carbs: { type: "number", description: "grams" },
  fat: { type: "number", description: "grams" },
  fiber: { type: "number", description: "grams — omit unless reasonably confident" },
  sugar: { type: "number", description: "grams — omit unless reasonably confident" },
  satFat: { type: "number", description: "grams — omit unless reasonably confident" },
  sodium: { type: "number", description: "milligrams — omit unless reasonably confident" },
} as const;

const TOOL_SCHEMA = {
  type: "object",
  properties: {
    estimates: {
      type: "array",
      description: "1-3 candidate foods, best match first. Empty if this is not an identifiable food.",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "The dish's common name, e.g. \"Abacha (African salad)\"." },
          serving: { type: "string", description: "A household measure a person would use, e.g. \"1 cup\". No weight in this string." },
          // Required: without it the app cannot re-base the estimate when the
          // user logs a different portion, and the numbers become a fixed lump.
          servingGrams: { type: "number", description: "Grams that serving weighs. Always estimate this." },
          group: { type: "string", enum: [...FOOD_GROUPS] },
          nutrients: {
            type: "object",
            properties: ESTIMATE_NUTRIENT_PROPS,
            required: ["calories"],
            additionalProperties: false,
          },
          basis: { type: "string", description: "What you reasoned from, e.g. \"typical home recipe, cassava + palm oil\"." },
          isRegional: { type: "boolean", description: "True if this is a regional dish rather than a global one." },
        },
        required: ["name", "serving", "servingGrams", "group", "nutrients", "basis"],
        // Load-bearing, together with the zod schema below: there is no field
        // here for `origin`, `fdcId` or `model`, so the model has no way to
        // assert a source for its own numbers.
        additionalProperties: false,
      },
    },
  },
  required: ["estimates"],
  additionalProperties: false,
} as const;

/**
 * Plain `z.object` — NOT `.strict()` — on purpose. zod strips unknown keys, so
 * an `origin` or `fdcId` the model emits anyway is silently discarded instead
 * of failing the request. The safe outcome and the robust one are the same.
 */
const EstimateSchema = z.object({
  estimates: z
    .array(
      z.object({
        name: z.string().min(1).max(120),
        serving: z.string().max(60).optional(),
        servingGrams: z.number().positive().max(5000).optional(),
        group: z.string().max(60).optional(),
        nutrients: z.record(z.unknown()).optional(),
        basis: z.string().max(300).optional(),
        isRegional: z.boolean().optional(),
      }),
    )
    .max(8),
});

async function estimateWithModel(input: FoodLookupInput): Promise<FoodLookupResult[]> {
  // The query is untrusted user text. It is not what keeps this safe — the
  // schema above and the server-set origin below are. Worst case a crafted
  // query gets a nonsense food back, correctly labelled as an estimate.
  const userMessage = input.region
    ? `Food search: "${input.query}"\nUser's region: ${input.region}`
    : `Food search: "${input.query}"`;

  const parsed = await callToolValidated(
    {
      system: ESTIMATE_SYSTEM,
      user: userMessage,
      toolName: "record_estimates",
      toolDescription:
        "Record your best estimate of what this food is and what one serving contains. " +
        "These figures are shown to the user as an ESTIMATE, never as a measurement, so " +
        "omitting a nutrient you are unsure of costs nothing and guessing costs accuracy.",
      inputSchema: TOOL_SCHEMA as unknown as Record<string, unknown>,
      maxTokens: 2048,
    },
    (raw) => EstimateSchema.parse(raw),
  );

  return parsed.estimates.flatMap((estimate) => {
    const nutrients = sanitizePanel(estimate.nutrients);
    // No energy → the app would discard it anyway.
    if (nutrients.calories === undefined) return [];

    const grams = estimate.servingGrams ?? null;
    const serving = estimate.serving?.trim() || (grams ? `${roundNutrient(grams)} g` : "1 serving");

    return [
      {
        name: estimate.name.trim(),
        serving,
        servingGrams: grams === null ? null : roundNutrient(grams),
        group: coerceGroup(estimate.group, estimate.name),
        nutrients,
        // Same estimate rescaled, not a second claim — and it lets the app
        // re-portion the food without asking again.
        ...(grams && grams >= 1 ? { per100g: scalePanel(nutrients, 100 / grams) } : {}),
        origin: "ai-estimate" as const,
        model: CLAUDE_MODEL,
        ...(estimate.basis ? { description: estimate.basis } : {}),
        ...(estimate.isRegional !== undefined ? { isRegional: estimate.isRegional } : {}),
      },
    ];
  });
}

/* ── the last gate ────────────────────────────────────────────────────────── */

/**
 * Mirror the app's sanitizer server-side. The app re-checks all of this before
 * a number enters a user's daily total, but the server should not be the reason
 * that check is necessary.
 *
 * Note the asymmetry: a `usda` result missing a real `fdcId` is DROPPED, and
 * nothing is ever promoted to `usda`. Downgrading is the fail-safe direction;
 * upgrading is the failure this file exists to prevent.
 */
function sanitizeResults(results: FoodLookupResult[]): FoodLookupResult[] {
  const clean: FoodLookupResult[] = [];

  for (const result of results) {
    if (clean.length >= MAX_RESULTS) break;

    const name = result.name?.trim();
    if (!name) continue;

    const nutrients = sanitizePanel(result.nutrients);
    if (nutrients.calories === undefined) continue;

    const servingGrams =
      typeof result.servingGrams === "number" &&
      Number.isFinite(result.servingGrams) &&
      result.servingGrams > 0
        ? roundNutrient(result.servingGrams)
        : null;

    const serving = result.serving?.trim() || (servingGrams ? `${servingGrams} g` : "1 serving");

    const base = {
      name: name.slice(0, 120),
      serving,
      servingGrams,
      group: coerceGroup(result.group, name),
      nutrients,
      ...(result.description ? { description: result.description.slice(0, 300) } : {}),
      ...(result.isRegional !== undefined ? { isRegional: result.isRegional } : {}),
    };

    const per100g = sanitizePanel(result.per100g);
    if (!isPanelEmpty(per100g)) Object.assign(base, { per100g });

    if (result.origin === "usda") {
      if (typeof result.fdcId !== "number" || !Number.isInteger(result.fdcId) || result.fdcId <= 0) {
        // Never relabelled as an estimate: no model produced these numbers, so
        // neither origin would be true. Drop it and say so.
        log.warn(`dropped a usda result with no usable fdcId: ${name}`);
        continue;
      }
      clean.push({
        ...base,
        origin: "usda",
        fdcId: result.fdcId,
        ...(result.dataset ? { dataset: result.dataset } : {}),
      });
      continue;
    }

    if (result.origin === "ai-estimate") {
      if (!result.model) {
        log.warn(`dropped an ai-estimate with no model id: ${name}`);
        continue;
      }
      clean.push({ ...base, origin: "ai-estimate", model: result.model });
      continue;
    }

    log.warn(`dropped a result with an unrecognised origin: ${String(result.origin)}`);
  }

  return clean;
}

/* ── the ladder ───────────────────────────────────────────────────────────── */

export async function lookupFood(input: FoodLookupInput): Promise<FoodLookupResponse> {
  // Rung 1 — measured. `null` means USDA could not be consulted (no key, or an
  // outage); an empty array means it was consulted and has nothing.
  const usda = await lookupUsda(input.query);
  const measured = usda === null ? [] : sanitizeResults(usda);
  if (measured.length > 0) {
    log.info(`lookup "${input.query}" → ${measured.length} usda match(es)`);
    return { results: measured, resolvedBy: "usda" };
  }

  // Rung 2 — estimated. Only reached on a USDA miss.
  let estimates: FoodLookupResult[];
  try {
    estimates = sanitizeResults(await estimateWithModel(input));
  } catch (err) {
    log.error("food lookup estimate failed:", (err as Error).message);
    // There is no local fallback for this endpoint — the app is asking
    // precisely because it doesn't have the food — so the failure is the user's
    // to see, and they read this sentence verbatim.
    throw new ApiError(
      502,
      "lookup_failed",
      "Couldn't look that food up right now. Please try again in a moment.",
    );
  }

  if (estimates.length > 0) {
    log.info(`lookup "${input.query}" → ${estimates.length} ai estimate(s)`);
    return { results: estimates, resolvedBy: "ai-estimate" };
  }

  // Rung 3 — nothing. A successful, honest answer.
  log.info(`lookup "${input.query}" → no match`);
  return { results: [], resolvedBy: "none" };
}
