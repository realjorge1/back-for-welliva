/**
 * USDA FOODDATA CENTRAL — rung 1, and the only rung that yields MEASURED
 * numbers.
 *
 * Every lookup starts here. If FDC has the food, the model is never asked; a
 * measured figure with a citable `fdcId` beats a good guess every time. The
 * model rung exists for what composition tables genuinely don't cover, not as a
 * convenience.
 *
 * `FDC_API_KEY` is read from the environment and never leaves this process —
 * it is not echoed in results, errors or logs. Keeping it off the device is the
 * reason this endpoint lives on the server at all.
 *
 * Three calls per uncached lookup, the first two in parallel:
 *   1. GET /foods/search ×2 — general foods and branded foods as SEPARATE
 *                             queries. See SEARCH_TIERS below for why one
 *                             combined query cannot work.
 *   2. POST /foods          — one bulk detail fetch for the shortlist, purely
 *                             to get `foodPortions` so a result can say
 *                             "1 cup" instead of "100 g". Best-effort: if it
 *                             fails we still return the search data.
 * Results are cached for a week, keyed on the normalised query. USDA's data
 * effectively never changes and the default key allows 1,000 requests/hour.
 */
import { config } from "../config.js";
import type { FdcDataset, FoodLookupResult, NutrientPanel } from "../domain.js";
import { log } from "../logger.js";
import { extractPanel } from "./fdcNutrients.js";
import { classifyGroup } from "./foodGroups.js";
import { roundNutrient, scalePanel } from "./panel.js";

const SEARCH_URL = "https://api.nal.usda.gov/fdc/v1/foods/search";
const DETAIL_URL = "https://api.nal.usda.gov/fdc/v1/foods";

/**
 * General foods and branded foods are searched SEPARATELY, then merged and
 * re-ranked so Foundation/SR Legacy sort above Branded.
 *
 * One combined query cannot do this. FDC ranks by its own relevance score, and
 * for a staple like "cheddar cheese" every one of the first ten hits is a
 * manufacturer's "CHEDDAR CHEESE" — the canonical Foundation entry
 * ("Cheese, cheddar", fdcId 328637) is buried far past any page size worth
 * fetching. Asking each dataset its own question is what makes "prefer general
 * foods over one brand's product" actually hold, rather than being a sort key
 * with nothing to sort.
 */
const SEARCH_TIERS = ["Foundation,SR Legacy", "Branded"] as const;
const PAGE_SIZE = 10;
const MAX_RESULTS = 8;
const TIMEOUT_MS = 8_000;

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 500;

/* ── small readers, so nothing below has to trust the payload's shape ─────── */

function rec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

/**
 * The cache key, and what we actually send to FDC — so a hit is always for the
 * exact search that produced it. Accents are decomposed and stripped, which is
 * what FDC's own index does anyway ("jalapeño" → "jalapeno").
 */
export function normalizeQuery(query: string): string {
  return query
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/* ── cache ────────────────────────────────────────────────────────────────── */

interface CacheEntry {
  expiresAt: number;
  results: FoodLookupResult[];
}

const cache = new Map<string, CacheEntry>();

function cacheGet(key: string): FoodLookupResult[] | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  // Re-insert so the eviction below is least-recently-used, not oldest-written.
  cache.delete(key);
  cache.set(key, hit);
  return hit.results;
}

function cacheSet(key: string, results: FoodLookupResult[]): void {
  cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, results });
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

/* ── HTTP ─────────────────────────────────────────────────────────────────── */

async function fdcRequest(url: URL, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) {
    // The URL carries the api_key, so it is deliberately not in this message.
    throw new Error(`FoodData Central responded ${res.status}`);
  }
  return (await res.json()) as unknown;
}

function endpoint(base: string, apiKey: string): URL {
  const url = new URL(base);
  url.searchParams.set("api_key", apiKey);
  return url;
}

async function searchFoods(
  query: string,
  dataType: string,
  apiKey: string,
): Promise<Record<string, unknown>[]> {
  const url = endpoint(SEARCH_URL, apiKey);
  url.searchParams.set("query", query);
  url.searchParams.set("pageSize", String(PAGE_SIZE));
  url.searchParams.set("dataType", dataType);

  const body = rec(await fdcRequest(url));
  const foods = body?.foods;
  return Array.isArray(foods) ? foods.flatMap((f) => (rec(f) ? [rec(f) as Record<string, unknown>] : [])) : [];
}

/**
 * Full records for the shortlist, in ONE request. Only `foodPortions` needs
 * this — so a failure here costs a household serving label, not the lookup.
 */
async function fetchDetails(
  fdcIds: number[],
  apiKey: string,
): Promise<Map<number, Record<string, unknown>>> {
  const out = new Map<number, Record<string, unknown>>();
  if (fdcIds.length === 0) return out;

  try {
    const payload = await fdcRequest(endpoint(DETAIL_URL, apiKey), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fdcIds, format: "full" }),
    });
    if (!Array.isArray(payload)) return out;
    for (const entry of payload) {
      const food = rec(entry);
      const id = food ? num(food.fdcId) : null;
      if (food && id !== null) out.set(id, food);
    }
  } catch (err) {
    log.warn("FDC detail fetch failed, falling back to search data:", (err as Error).message);
  }
  return out;
}

/* ── relevance ────────────────────────────────────────────────────────────── */

const STOPWORDS = new Set(["and", "the", "with", "raw", "fresh", "cooked", "food", "for"]);

function queryTokens(normalized: string): string[] {
  return [...new Set(normalized.split(" "))].filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

/**
 * Whole words, with room for inflection but not for coincidence.
 *
 * Substring matching is the obvious implementation and it is wrong: searching
 * "pop tarts" matches "Snacks, popcorn, air-popped" on "pop", which then
 * outranks the food the user actually meant. Requiring a four-character shared
 * stem keeps "tomato"/"tomatoes" and "tart"/"tarts" while dropping
 * "pop"/"popcorn" and "cheese"/"cheeseburger".
 */
function tokensMatch(descToken: string, queryToken: string): boolean {
  if (descToken === queryToken) return true;
  const [shorter, longer] =
    descToken.length <= queryToken.length ? [descToken, queryToken] : [queryToken, descToken];
  return shorter.length >= 4 && longer.startsWith(shorter) && longer.length - shorter.length <= 3;
}

/**
 * How many of the query's words the description actually contains. FDC will
 * happily return a loose match for a food it has never heard of, and a loose
 * match shown under the app's green "Measured" heading is a measured number
 * attached to the wrong food — worse than no result at all.
 */
function overlapScore(description: string, tokens: string[]): number {
  const descTokens = normalizeQuery(description).split(" ").filter(Boolean);
  let score = 0;
  for (const token of tokens) {
    if (descTokens.some((d) => tokensMatch(d, token))) score += 1;
  }
  return score;
}

const DATASET_RANK: Record<string, number> = {
  Foundation: 0,
  "SR Legacy": 1,
  "Survey (FNDDS)": 2,
  FNDDS: 2,
  Branded: 3,
};

function mapDataset(dataType: string | null): FdcDataset | undefined {
  switch (dataType) {
    case "Foundation":
      return "Foundation";
    case "SR Legacy":
      return "SR Legacy";
    case "Survey (FNDDS)":
    case "FNDDS":
      return "FNDDS";
    case "Branded":
      return "Branded";
    default:
      return undefined;
  }
}

/* ── serving size ─────────────────────────────────────────────────────────── */

interface Serving {
  label: string;
  grams: number;
}

const FALLBACK_SERVING: Serving = { label: "100 g", grams: 100 };

function formatAmount(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)));
}

/** FDC unit codes that appear verbatim in branded household serving text. */
const UNIT_CODES: Record<string, string> = {
  ONZ: "oz",
  GRM: "g",
  MLT: "ml",
  LTR: "L",
  CUP: "cup",
  TBSP: "tbsp",
  TBS: "tbsp",
  TSP: "tsp",
  PCE: "piece",
  SLC: "slice",
  PKG: "package",
  CTN: "carton",
};

/**
 * Branded serving text comes straight off the manufacturer's submission, so it
 * arrives shouting and sometimes in FDC's own unit codes — "1 ONZ", "1 CUP
 * UNCOOKED". The user reads this string, so translate the codes and stop the
 * shouting; anything already lowercase is left alone.
 */
function humanizeServing(text: string): string {
  return text.replace(/\b[A-Z]{2,}\b/g, (word) => UNIT_CODES[word] ?? word.toLowerCase());
}

/**
 * Trim a parenthetical that only restates the item's dimensions — SR Legacy
 * writes `medium (7" to 7-7/8" long)`, which is precision the user doesn't need
 * in a list they're tapping through. A parenthetical carrying a weight
 * (`slice (1 oz)`) is kept, because that one is telling them something.
 */
function trimDimensions(label: string): string {
  const trimmed = label.replace(/\s*\([^)]*(?:"|inch|cm|long)[^)]*\)/gi, "").trim();
  return trimmed || label;
}

function portionLabel(portion: Record<string, unknown>, grams: number): string {
  // FNDDS writes a ready-made phrase; SR Legacy composes one from parts.
  const description = str(portion.portionDescription);
  if (description && !/^undetermined$/i.test(description)) return trimDimensions(description);

  const amount = num(portion.amount);
  const unitName = str(rec(portion.measureUnit)?.name);
  const modifier = str(portion.modifier);

  const parts: string[] = [];
  if (amount !== null && amount > 0) parts.push(formatAmount(amount));
  if (unitName && !/^undetermined$/i.test(unitName)) parts.push(unitName);
  // Some SR Legacy modifiers are internal measure codes ("10205"), not words.
  if (modifier && !/^\d+$/.test(modifier)) parts.push(modifier);

  const label = parts.join(" ").trim();
  return trimDimensions(label) || `${formatAmount(grams)} g`;
}

/** Text of a portion, for choosing between them. */
function portionText(portion: Record<string, unknown>): string {
  return `${str(portion.portionDescription) ?? ""} ${str(portion.modifier) ?? ""}`.toLowerCase();
}

/**
 * A household measure the user would recognise, with its weight. Falls back to
 * 100 g — the basis FDC reports in — rather than guessing at a portion.
 */
function deriveServing(food: Record<string, unknown>): Serving {
  // Branded foods carry the label's own serving.
  const servingSize = num(food.servingSize);
  const servingUnit = str(food.servingSizeUnit)?.toLowerCase();
  if (servingSize !== null && servingSize > 0 && (servingUnit === "g" || servingUnit === "grm")) {
    const household = str(food.householdServingFullText);
    return {
      label: household ? humanizeServing(household) : `${formatAmount(servingSize)} g`,
      grams: servingSize,
    };
  }

  const portions = Array.isArray(food.foodPortions) ? food.foodPortions : [];
  const usable = portions
    .flatMap((p) => (rec(p) ? [rec(p) as Record<string, unknown>] : []))
    .map((p) => ({ portion: p, grams: num(p.gramWeight) }))
    .filter((p): p is { portion: Record<string, unknown>; grams: number } =>
      p.grams !== null && p.grams > 0 && p.grams <= 2000)
    // FDC returns portions in arbitrary array order but numbers them; its own
    // sequence puts the most representative measure first.
    .sort((a, b) => (num(a.portion.sequenceNumber) ?? 99) - (num(b.portion.sequenceNumber) ?? 99));

  if (usable.length > 0) {
    const plausible = usable.filter((p) => p.grams >= 15 && p.grams <= 600);
    const pool = plausible.length > 0 ? plausible : usable;

    // Prefer how a person would actually say it. FDC's own sequence puts volume
    // measures first, so a banana defaults to "1 cup, mashed" (225 g) when
    // "1 medium" (118 g) is three entries further down — accurate, and not what
    // anyone logging a banana means. "NLEA serving" is the FDA's reference
    // amount and the next best standard. Foods with neither (cheese slices,
    // rice) keep FDC's order, which for them is already right.
    const preferred =
      pool.find((p) => /\bmedium\b/.test(portionText(p.portion))) ??
      pool.find((p) => /\bnlea serving\b/.test(portionText(p.portion))) ??
      pool[0];
    if (preferred) {
      return {
        label: portionLabel(preferred.portion, preferred.grams),
        grams: roundNutrient(preferred.grams),
      };
    }
  }

  return FALLBACK_SERVING;
}

/* ── naming ───────────────────────────────────────────────────────────────── */

function titleCase(text: string): string {
  return text.toLowerCase().replace(/(^|[\s(/-])([a-z])/g, (_m, lead: string, ch: string) => lead + ch.toUpperCase());
}

function displayName(food: Record<string, unknown>): string | null {
  const raw = str(food.description);
  if (!raw) return null;

  // Branded descriptions are shouted ("POP-TARTS, FROSTED STRAWBERRY").
  let name = raw === raw.toUpperCase() ? titleCase(raw) : raw;

  const brand = str(food.brandName) ?? str(food.brandOwner);
  if (brand) {
    const brandWord = (brand.split(/[,\s]+/)[0] ?? "").toLowerCase();
    if (brandWord.length > 2 && !name.toLowerCase().includes(brandWord)) {
      name = `${name} (${titleCase(brand)})`;
    }
  }

  return name.slice(0, 120);
}

/* ── result assembly ──────────────────────────────────────────────────────── */

/**
 * @param food     the record to describe the food from — the detail record
 *                 when we have one, since only it carries `foodPortions`.
 * @param fallback the search record, used to fill nutrients the detail
 *                 response left out. Same fdcId, same food, same per-100 g
 *                 basis, so this merges two views of one measurement rather
 *                 than two sources.
 */
function buildResult(
  food: Record<string, unknown>,
  fallback?: Record<string, unknown>,
): FoodLookupResult | null {
  const fdcId = num(food.fdcId);
  const name = displayName(food) ?? (fallback ? displayName(fallback) : null);
  if (fdcId === null || !Number.isInteger(fdcId) || !name) return null;

  const per100g: NutrientPanel = {
    ...(fallback ? extractPanel(fallback.foodNutrients) : {}),
    ...extractPanel(food.foodNutrients),
  };
  // Without energy the app discards the result anyway — and a "measured" food
  // with no calories is not a usable match, so it must not block the model rung.
  if (per100g.calories === undefined) return null;

  const serving = deriveServing(food);
  const category = str(food.foodCategory) ?? str(rec(food.foodCategory)?.description) ?? str(food.brandedFoodCategory);

  return {
    name,
    serving: serving.label,
    servingGrams: serving.grams,
    group: classifyGroup(name, category),
    nutrients: scalePanel(per100g, serving.grams / 100),
    per100g,
    origin: "usda",
    fdcId,
    ...(mapDataset(str(food.dataType)) ? { dataset: mapDataset(str(food.dataType)) } : {}),
    ...(category ? { description: category } : {}),
  };
}

let warnedMissingKey = false;

/**
 * Search FDC for a food.
 *
 * @returns the matches (possibly empty — meaning "asked, USDA doesn't have
 *   it"), or `null` when USDA could not be consulted at all. The caller treats
 *   both as a miss and falls through to the model rung; they are distinguished
 *   only so the difference is visible in the logs.
 */
export async function lookupUsda(query: string): Promise<FoodLookupResult[] | null> {
  const apiKey = config.fdcApiKey;
  if (!apiKey) {
    if (!warnedMissingKey) {
      warnedMissingKey = true;
      log.warn(
        "FDC_API_KEY is not set — /v1/nutrition/lookup cannot reach USDA and will " +
          "return AI estimates for everything. Get a free key at " +
          "https://fdc.nal.usda.gov/api-key-signup.html",
      );
    }
    return null;
  }

  const normalized = normalizeQuery(query);
  if (!normalized) return [];

  const cached = cacheGet(normalized);
  if (cached) return cached;

  // Both tiers in parallel: two round-trips' worth of coverage for one
  // round-trip of latency, with someone waiting on the other end.
  const tiers = await Promise.all(
    SEARCH_TIERS.map(async (dataType) => {
      try {
        return await searchFoods(normalized, dataType, apiKey);
      } catch (err) {
        log.error(`FDC search failed (${dataType}):`, (err as Error).message);
        return null;
      }
    }),
  );

  if (tiers.every((t) => t === null)) {
    // Not fatal. A USDA outage must not take the endpoint down with it — the
    // model rung still answers, and it answers labelled as an estimate, so a
    // degraded lookup is honest rather than wrong. Not cached: this says
    // nothing about whether USDA has the food.
    return null;
  }

  const tokens = queryTokens(normalized);
  const seen = new Set<number>();
  const ranked = tiers
    .flatMap((foods, tier) => (foods ?? []).map((food, index) => ({ food, tier, index })))
    .filter(({ food }) => {
      const id = num(food.fdcId);
      if (id === null || seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .map((candidate) => ({
      ...candidate,
      // A one- or two-letter query leaves no usable tokens; trust FDC's own
      // relevance rather than filtering everything out.
      score: tokens.length === 0 ? 1 : overlapScore(str(candidate.food.description) ?? "", tokens),
      rank: DATASET_RANK[str(candidate.food.dataType) ?? ""] ?? 9,
    }))
    .filter((c) => c.score > 0)
    // Most query words matched wins; then general foods over branded; then the
    // order FDC itself returned them in.
    .sort((a, b) => b.score - a.score || a.rank - b.rank || a.tier - b.tier || a.index - b.index)
    .slice(0, MAX_RESULTS);

  if (ranked.length === 0) {
    cacheSet(normalized, []);
    return [];
  }

  const details = await fetchDetails(
    ranked.flatMap((c) => {
      const id = num(c.food.fdcId);
      return id === null ? [] : [id];
    }),
    apiKey,
  );

  const results = ranked.flatMap((candidate) => {
    const id = num(candidate.food.fdcId);
    // The detail record is richer (it is the only one with portions); the
    // search record backs it up, and stands in entirely if the bulk fetch
    // didn't come back.
    const detail = id !== null ? details.get(id) : undefined;
    const built = detail ? buildResult(detail, candidate.food) : buildResult(candidate.food);
    return built ? [built] : [];
  });

  cacheSet(normalized, results);
  return results;
}
