/**
 * GROUP CLASSIFICATION — which of the app's nine Foods-screen buckets a food
 * belongs in.
 *
 * USDA's own categories don't line up with the app's ("Dairy and Egg Products"
 * spans two buckets; "Soups, Sauces, and Gravies" spans none), so this is a
 * best-effort keyword pass over the food's description with the USDA category
 * as a backstop. Order is load-bearing: the first rule that matches wins, and
 * the rules are sequenced so the specific case beats the general one —
 * "peanut butter" must reach the fats rule rather than stopping at dairy.
 *
 * Getting this wrong is cosmetic: the food lands in a neighbouring bucket. The
 * one thing that must NOT happen is returning a string outside the nine, which
 * the app would remap to "Your foods" and lose the categorisation entirely —
 * so every path here returns a `FoodGroup`.
 */
import { FOOD_GROUPS, type FoodGroup } from "../domain.js";

const GROUP_SET = new Set<string>(FOOD_GROUPS);

/**
 * Mixed and prepared dishes — which is most of what reaches this endpoint —
 * are carbohydrate-led far more often than not, so that's the fallback.
 */
const DEFAULT_GROUP: FoodGroup = "Grains & Starches";

/**
 * Every pattern ends in an optional plural, because FDC writes its descriptions
 * plural-first: "Bananas, raw", "Peppers, sweet". Matching only the singular
 * silently drops the most common form and the food falls through to a category
 * guess.
 */
const RULES: readonly (readonly [FoodGroup, RegExp])[] = [
  // First, because SR Legacy spice entries read "Spices, pepper, black" and
  // would otherwise be caught by the vegetable rule's "pepper".
  ["Herbs, Aromatics & Seasonings", /\b(spices?|herbs?|seasoning|bouillon)s?\b/],

  ["Proteins", /\b(egg|eggs|beef|pork|chicken|turkey|lamb|veal|goat|game|fish|salmon|tuna|tilapia|sardine|cod|shrimp|prawn|crab|lobster|shellfish|seafood|meat|bacon|sausage|ham|liver|gizzard|offal|poultry|jerky|snail)s?\b/],

  // "milk"/"cream" before the nut rule so "almond milk" is an alternative, not
  // a nut. "butter" is deliberately NOT here — see the fats rule below.
  ["Dairy & Alternatives", /\b(milk|cheese|yogh?urt|yoghourt|cream|kefir|dairy|whey|custard|paneer|curd)s?\b/],

  ["Beverages", /\b(beverage|drink|juice|soda|cola|coffee|tea|beer|wine|liquor|vodka|whisk(?:e)?y|rum|gin|cider|lemonade|nectar|water|kunu|zobo|smoothie|infusion)s?\b/],

  // After dairy so plain butter lands here as a fat, and before legumes so
  // "peanut butter" doesn't read as a bean.
  ["Nuts, Seeds, Fats & Oils", /\b(nut|nuts|peanut|groundnut|almond|cashew|walnut|pecan|pistachio|hazelnut|macadamia|coconut|seed|seeds|sesame|tahini|chia|flax|oil|olive|lard|tallow|shortening|margarine|mayonnaise|ghee|butter)s?\b/],

  ["Legumes & Plant Protein", /\b(bean|beans|lentil|lentils|chickpea|garbanzo|soy|soya|tofu|tempeh|edamame|hummus|pea|peas|legume|cowpea|moi moi|akara|seitan)s?\b/],

  ["Fruits", /\b(fruit|apple|banana|orange|tangerine|berry|berries|grape|mango|melon|peach|pear|plum|pineapple|citrus|lemon|lime|avocado|date|dates|fig|papaya|pawpaw|guava|cherry|apricot|kiwi|raisin|prune|pomegranate)s?\b/],

  ["Vegetables", /\b(vegetable|lettuce|spinach|kale|broccoli|cauliflower|cabbage|carrot|onion|tomato|tomatoes|pepper|peppers|cucumber|squash|zucchini|pumpkin|mushroom|celery|okra|eggplant|aubergine|asparagus|greens|ugu|bitterleaf|seaweed|sprouts)s?\b/],

  ["Grains & Starches", /\b(grain|rice|wheat|bread|pasta|noodle|cereal|oat|oats|corn|maize|flour|tortilla|cracker|cookie|biscuit|cake|pastry|bagel|bun|pie|granola|potato|potatoes|yam|cassava|garri|gari|fufu|plantain|starch|quinoa|barley|millet|sorghum|couscous|semolina|chips|pancake|waffle)s?\b/],

  ["Herbs, Aromatics & Seasonings", /\b(salt|garlic|ginger|basil|thyme|oregano|parsley|cilantro|coriander|cinnamon|nutmeg|paprika|cumin|curry|turmeric|sauce|vinegar|mustard|ketchup|stock)s?\b/],
];

/**
 * USDA/branded category names that map cleanly onto a bucket. Consulted only
 * when the description itself said nothing.
 *
 * Order matters as much as it does in RULES. Fruits and Vegetables come first
 * because USDA's category is "Fruits and Fruit Juices" — a Beverages rule
 * matching a bare "juice" swallows every raw banana in the database.
 */
const CATEGORY_MAP: readonly (readonly [FoodGroup, RegExp])[] = [
  ["Fruits", /fruit/i],
  ["Vegetables", /vegetable/i],
  ["Proteins", /poultry|beef|pork|lamb|veal|game|sausage|luncheon|finfish|shellfish|meat|egg/i],
  ["Dairy & Alternatives", /dairy|cheese|yogurt|milk|cream/i],
  ["Legumes & Plant Protein", /legume/i],
  ["Nuts, Seeds, Fats & Oils", /nut|seed|fats and oils|oils/i],
  ["Grains & Starches", /cereal|grain|pasta|baked|bakery|snack|sweets|candy|chips|bread|rice/i],
  ["Herbs, Aromatics & Seasonings", /spice|herb|sauce|gravy|condiment|seasoning|dressing/i],
  // Last, and deliberately narrow: only categories that are actually drinks.
  ["Beverages", /\bbeverages?\b|soft drink|energy drink|soda|coffee|\btea\b|bottled water/i],
];

export function isFoodGroup(value: unknown): value is FoodGroup {
  return typeof value === "string" && GROUP_SET.has(value);
}

/** Best-effort bucket for a food. Always returns one of the nine. */
export function classifyGroup(description: string, category?: string | null): FoodGroup {
  const text = description.toLowerCase();

  for (const [group, pattern] of RULES) {
    if (pattern.test(text)) return group;
  }

  if (category) {
    for (const [group, pattern] of CATEGORY_MAP) {
      if (pattern.test(category)) return group;
    }
  }

  return DEFAULT_GROUP;
}

/** Coerce a model-supplied group onto the enum without ever inventing a new one. */
export function coerceGroup(value: unknown, fallbackDescription: string): FoodGroup {
  if (isFoodGroup(value)) return value;
  return classifyGroup(
    `${fallbackDescription} ${typeof value === "string" ? value : ""}`.trim(),
  );
}
