/**
 * FDC → NutrientKey MAPPING.
 *
 * FoodData Central reports nutrients per 100 g as a flat list, identified by an
 * INFOODS "nutrient number" (208, 203, …) and a unit string. This module turns
 * that list into the app's `NutrientPanel`.
 *
 * Two things make this less mechanical than it looks:
 *
 *   • The same nutrient has several numbers. Energy is 208 in SR Legacy but
 *     Foundation foods often carry only 957/958 (Atwater general/specific).
 *     Fibre, carbohydrate, sugar and folate each have a modern alternate too.
 *     So each key maps to a PREFERENCE LIST, not one number.
 *   • Units are not guaranteed. Vitamin A is µg RAE under number 320 but IU
 *     under 318, and vitamin E is reported in "MG_ATE". Every value is
 *     converted through an explicit table and DROPPED if the unit isn't one we
 *     recognise — a silent unit mismatch is a wrong number with a real source
 *     attached to it, which is worse than a missing one.
 *
 * Nothing here ever substitutes a default. A nutrient FDC didn't report comes
 * back absent.
 */
import { NUTRIENT_UNITS, type NutrientKey, type NutrientPanel, type NutrientUnit } from "../domain.js";
import { roundNutrient } from "./panel.js";

/** One nutrient as it appears in either FDC response shape. */
export interface RawFdcNutrient {
  number: string | null;
  name: string | null;
  unit: string | null;
  value: number | null;
}

/**
 * FDC nutrient numbers per app key, most-preferred first. Only numbers whose
 * definition matches the app's key are listed — e.g. vitamin A is RAE (320)
 * only, never IU (318) or RE (392), which are different quantities.
 */
const FDC_NUMBERS: Record<NutrientKey, readonly string[]> = {
  calories: ["208", "958", "957"], // kcal, then Atwater specific, then general
  protein: ["203"],
  fat: ["204"],
  satFat: ["606"],
  transFat: ["605"],
  monoFat: ["645"],
  polyFat: ["646"],
  cholesterol: ["601"],
  carbs: ["205", "205.2"], // by difference, then by summation
  fiber: ["291", "293"], // total dietary, then AOAC 2011.25
  sugar: ["269", "269.3"],
  addedSugar: ["539"],
  sodium: ["307"],
  water: ["255"],
  caffeine: ["262"],
  alcohol: ["221"],
  potassium: ["306"],
  calcium: ["301"],
  iron: ["303"],
  magnesium: ["304"],
  zinc: ["309"],
  vitaminA: ["320"], // RAE µg — NOT 318 (IU) or 392 (RE)
  vitaminC: ["401"],
  vitaminD: ["328"], // D2 + D3 µg — NOT 324 (IU)
  vitaminE: ["323"], // alpha-tocopherol mg — NOT 341-343 (other tocopherols)
  vitaminK: ["430"],
  vitaminB6: ["415"],
  vitaminB12: ["418"],
  folate: ["417", "435"], // total, then DFE
  thiamin: ["404"],
  riboflavin: ["405"],
  niacin: ["406"],
};

/**
 * Name fallback, used ONLY when an entry carries no nutrient number. Branded
 * payloads occasionally omit the number; the names are stable enough to match
 * exactly, and an unrecognised name is simply skipped.
 */
const FDC_NAMES: Record<string, NutrientKey> = {
  energy: "calories",
  "energy (atwater general factors)": "calories",
  "energy (atwater specific factors)": "calories",
  protein: "protein",
  "total lipid (fat)": "fat",
  "total fat (nlea)": "fat",
  "fatty acids, total saturated": "satFat",
  "fatty acids, total trans": "transFat",
  "fatty acids, total monounsaturated": "monoFat",
  "fatty acids, total polyunsaturated": "polyFat",
  cholesterol: "cholesterol",
  "carbohydrate, by difference": "carbs",
  "carbohydrate, by summation": "carbs",
  "fiber, total dietary": "fiber",
  "total dietary fiber (aoac 2011.25)": "fiber",
  "sugars, total including nlea": "sugar",
  "sugars, total": "sugar",
  "sugars, added": "addedSugar",
  "sodium, na": "sodium",
  water: "water",
  caffeine: "caffeine",
  "alcohol, ethyl": "alcohol",
  "potassium, k": "potassium",
  "calcium, ca": "calcium",
  "iron, fe": "iron",
  "magnesium, mg": "magnesium",
  "zinc, zn": "zinc",
  "vitamin a, rae": "vitaminA",
  "vitamin c, total ascorbic acid": "vitaminC",
  "vitamin d (d2 + d3)": "vitaminD",
  "vitamin e (alpha-tocopherol)": "vitaminE",
  "vitamin k (phylloquinone)": "vitaminK",
  "vitamin b-6": "vitaminB6",
  "vitamin b-12": "vitaminB12",
  "folate, total": "folate",
  "folate, dfe": "folate",
  thiamin: "thiamin",
  riboflavin: "riboflavin",
  niacin: "niacin",
};

/**
 * How many grams one unit of each FDC mass unit is. Units NOT listed here —
 * IU, MG_GAE, SP_GR — are refused rather than guessed at, because converting
 * them needs a per-nutrient factor we don't have.
 */
const MASS_IN_GRAMS: Record<string, number> = {
  G: 1,
  GM: 1,
  GRM: 1,
  MG: 1e-3,
  MG_ATE: 1e-3, // mg alpha-tocopherol equivalents — the unit vitamin E (323) uses
  UG: 1e-6,
  "µG": 1e-6,
  MCG: 1e-6,
};

const TARGET_IN_GRAMS: Record<Exclude<NutrientUnit, "kcal">, number> = {
  g: 1,
  mg: 1e-3,
  mcg: 1e-6,
};

const KJ_PER_KCAL = 4.184;

/** Convert an FDC value into the unit the app expects, or null if we can't. */
export function convertToAppUnit(
  value: number,
  fdcUnit: string | null,
  target: NutrientUnit,
): number | null {
  if (!Number.isFinite(value) || value < 0) return null;
  const unit = (fdcUnit ?? "").trim().toUpperCase();

  if (target === "kcal") {
    if (unit === "KCAL") return value;
    if (unit === "KJ") return value / KJ_PER_KCAL;
    return null;
  }

  const grams = MASS_IN_GRAMS[unit];
  if (grams === undefined) return null;
  return (value * grams) / TARGET_IN_GRAMS[target];
}

/**
 * Read `foodNutrients` from either FDC shape:
 *   search  → { nutrientNumber, nutrientName, unitName, value }
 *   detail  → { nutrient: { number, name, unitName }, amount }
 */
export function readFdcNutrients(foodNutrients: unknown): RawFdcNutrient[] {
  if (!Array.isArray(foodNutrients)) return [];

  return foodNutrients.flatMap((entry): RawFdcNutrient[] => {
    if (!entry || typeof entry !== "object") return [];
    const e = entry as Record<string, unknown>;
    const nested = e.nutrient && typeof e.nutrient === "object"
      ? (e.nutrient as Record<string, unknown>)
      : null;

    const source = nested ?? e;
    const number = nested ? source.number : e.nutrientNumber;
    const name = nested ? source.name : e.nutrientName;
    const unit = source.unitName ?? e.unitName;
    const value = nested ? e.amount : (e.value ?? e.amount);

    return [
      {
        number: typeof number === "string" ? number.trim() : typeof number === "number" ? String(number) : null,
        name: typeof name === "string" ? name.trim().toLowerCase() : null,
        unit: typeof unit === "string" ? unit : null,
        value: typeof value === "number" ? value : typeof value === "string" ? Number(value) : null,
      },
    ];
  });
}

/**
 * Build a per-100 g panel from an FDC food. Every value is unit-checked; keys
 * FDC didn't report (or reported in a unit we refuse) are left out entirely.
 */
export function extractPanel(foodNutrients: unknown): NutrientPanel {
  const raw = readFdcNutrients(foodNutrients);
  if (raw.length === 0) return {};

  const byNumber = new Map<string, RawFdcNutrient>();
  const byName = new Map<string, RawFdcNutrient>();
  for (const n of raw) {
    if (n.value === null || !Number.isFinite(n.value)) continue;
    if (n.number && !byNumber.has(n.number)) byNumber.set(n.number, n);
    if (n.name && !byName.has(n.name)) byName.set(n.name, n);
  }

  const panel: NutrientPanel = {};

  for (const [key, numbers] of Object.entries(FDC_NUMBERS) as [NutrientKey, readonly string[]][]) {
    for (const number of numbers) {
      const hit = byNumber.get(number);
      if (!hit || hit.value === null) continue;
      const converted = convertToAppUnit(hit.value, hit.unit, NUTRIENT_UNITS[key]);
      if (converted === null) continue; // wrong unit → try the next candidate
      panel[key] = roundNutrient(converted);
      break;
    }
  }

  // Name fallback — never overwrites a number-matched value, so the preference
  // order above still decides (e.g. "folate, total" beats "folate, dfe").
  for (const [name, key] of Object.entries(FDC_NAMES)) {
    if (panel[key] !== undefined) continue;
    const hit = byName.get(name);
    if (!hit || hit.value === null || hit.number) continue;
    const converted = convertToAppUnit(hit.value, hit.unit, NUTRIENT_UNITS[key]);
    if (converted === null) continue;
    panel[key] = roundNutrient(converted);
  }

  return panel;
}
