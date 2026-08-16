/**
 * NUTRIENT PANEL HYGIENE — the rules from the app's own sanitizer, applied
 * server-side so the app's copy is a second opinion rather than the only one.
 *
 * Two invariants live here, and both are about honesty rather than correctness:
 *
 *   1. A key we don't recognise never reaches the app. The app drops it anyway;
 *      dropping it here means an unmapped USDA nutrient shows up in our own
 *      output as absent, not as a silently-ignored number.
 *   2. An unknown value is ABSENT, never 0. The app renders a missing key as
 *      `—` and a 0 as a measured zero, so coercing junk to 0 would invent a
 *      measurement. Every path below drops rather than defaults.
 */
import { NUTRIENT_UNITS, type NutrientKey, type NutrientPanel } from "../domain.js";

const KEYS = new Set<string>(Object.keys(NUTRIENT_UNITS));

export function isNutrientKey(key: string): key is NutrientKey {
  return KEYS.has(key);
}

/**
 * Round to a precision that reads like a food label without ever rounding a
 * real measurement down to a fake zero — 0.0004 mg of something is not 0 mg.
 */
export function roundNutrient(value: number): number {
  const magnitude = Math.abs(value);
  const dp = magnitude >= 100 ? 0 : magnitude >= 10 ? 1 : magnitude >= 1 ? 2 : 3;
  const rounded = Number(value.toFixed(dp));
  if (rounded === 0 && value > 0) return Number(value.toPrecision(2));
  return rounded;
}

/**
 * Keep only recognised keys carrying finite, non-negative numbers. Anything
 * else is dropped outright — see invariant 2 above.
 */
export function sanitizePanel(raw: unknown): NutrientPanel {
  const out: NutrientPanel = {};
  if (!raw || typeof raw !== "object") return out;

  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isNutrientKey(key)) continue;
    // Strings are tolerated because a model occasionally quotes its numbers;
    // anything that isn't a real number still falls through to `continue`.
    const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    if (!Number.isFinite(n) || n < 0) continue;
    out[key] = roundNutrient(n);
  }
  return out;
}

/** Rescale a panel (e.g. per-100 g → per-serving). Absent keys stay absent. */
export function scalePanel(panel: NutrientPanel, factor: number): NutrientPanel {
  if (!Number.isFinite(factor) || factor <= 0) return {};
  const out: NutrientPanel = {};
  for (const [key, value] of Object.entries(panel)) {
    if (!isNutrientKey(key) || typeof value !== "number") continue;
    out[key] = roundNutrient(value * factor);
  }
  return out;
}

export function isPanelEmpty(panel: NutrientPanel): boolean {
  return Object.keys(panel).length === 0;
}
