import { callToolValidated } from "../anthropic.js";
import { CLAUDE_MODEL } from "../config.js";
import { ParsedFoodItemsSchema, type ParseFoodInput } from "../domain.js";

/**
 * FOOD PARSE — the model reads the sentence, not the nutrition label.
 *
 * This endpoint deliberately has a much narrower job than it looks like it
 * should. The obvious design ("send the meal, get back the nutrition") is the
 * wrong one: an LLM asked for calories produces confident, precise, unsourced
 * numbers that differ between runs. In a health app those numbers accumulate
 * into daily totals, weekly averages and end-of-period reports, so a single
 * hallucinated figure quietly corrupts a month of a user's history.
 *
 * So the model's entire output surface is {quantity, unit, food}. The app then
 * resolves those names against its own reference table (USDA FoodData Central /
 * FAO WAFCT), which is where every number comes from and which can be cited
 * back to the user.
 *
 * Two independent mechanisms keep it that way, because instructions alone are
 * not a security boundary:
 *   1. The tool's JSON Schema declares additionalProperties: false.
 *   2. ParsedFoodItemsSchema is `.strict()`, so an unexpected key throws rather
 *      than passing through.
 * A model that ignores the prompt entirely still cannot get a nutrient across
 * this boundary.
 */

const TOOL_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      description: "Each distinct food mentioned, in the order stated.",
      items: {
        type: "object",
        properties: {
          quantity: {
            type: "number",
            description: "How many of the unit. Use 1 when the user gave no amount.",
          },
          unit: {
            type: "string",
            description:
              'Household measure exactly as stated ("cup", "slice", "medium", "g", "tbsp"), or "" if none was given.',
          },
          food: {
            type: "string",
            description:
              'Plain singular food name, no amount. Keep a cooking method that changes the food ("fried egg").',
          },
        },
        required: ["quantity", "unit", "food"],
        // Load-bearing: blocks calories/protein/etc. from being returned at all.
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
  additionalProperties: false,
} as const;

export interface ParseFoodResult {
  items: { quantity: number; unit: string; food: string }[];
  model: string;
}

export async function parseFood(input: ParseFoodInput): Promise<ParseFoodResult> {
  const parsed = await callToolValidated(
    {
      system: input.system,
      user: input.user,
      toolName: "record_foods",
      toolDescription:
        "Record the foods mentioned in the user's message. Names and amounts ONLY — " +
        "you must not report calories, macros or any nutrition data. The application " +
        "resolves nutrition itself from a cited reference database.",
      inputSchema: TOOL_SCHEMA as unknown as Record<string, unknown>,
      maxTokens: 1024,
    },
    (raw) => ParsedFoodItemsSchema.parse(raw),
  );

  return { items: parsed.items, model: CLAUDE_MODEL };
}
