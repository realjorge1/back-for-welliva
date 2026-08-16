/**
 * GOZLIN — tool SCHEMAS. Declarations only; no implementations live here.
 *
 * Every one of these executes ON THE USER'S PHONE against their local history
 * (services/gozlin/agent/tools.ts in the app). The server never sees the data a
 * tool reads — only the short result the app chooses to send back. That is what
 * keeps app/privacy.tsx's "your raw history never leaves it" promise true now
 * that a model is in the loop.
 *
 * ⚠️  Order is load-bearing. Tools render at position 0 of the cached prefix, so
 * a reordered array invalidates every cache entry we have. The list is sorted
 * by name and must stay that way — hence the assertion at the bottom.
 *
 * ⚠️  Must stay in sync with the app's TOOL_SCHEMAS. Bump GOZLIN_PROMPT_VERSION
 * in ./system.ts when either side changes.
 */

import type Anthropic from "@anthropic-ai/sdk";

type ToolSchema = {
  name: string;
  description: string;
  input_schema: Anthropic.Beta.BetaTool.InputSchema;
  strict: true;
};

const NO_ARGS = {
  type: "object" as const,
  properties: {},
  required: [],
  additionalProperties: false,
};

export const TOOL_SCHEMAS: ToolSchema[] = [
  {
    name: "analyze_nutrition",
    description:
      "Analyze the user's recent eating and return ranked, evidence-backed nutrition " +
      "adjustments plus inferred food avoidances. Call this when the user asks about " +
      "their macros, calories, protein, diet quality, or wants their eating tuned, " +
      "optimized, or rebalanced. Do NOT call it to log a food — use log_food.",
    input_schema: NO_ARGS,
    strict: true,
  },
  {
    name: "analyze_training",
    description:
      "Analyze recent training performance per exercise and return ranked programming " +
      "adjustments (volume, intensity, rest, substitutions). Call this when the user " +
      "asks whether they're ready to progress, says a workout is too easy or too hard, " +
      "or wants their training tuned, adapted, or made harder/easier.",
    input_schema: NO_ARGS,
    strict: true,
  },
  {
    name: "get_daily_briefing",
    description:
      "Today's full coaching brief: yesterday's record, today's focus, workout and " +
      "nutrition targets, risk alerts, and the single smallest next win. Call this " +
      "when the user asks what to do today, what to focus on, for a plan for today, " +
      "or opens with a bare greeting and no specific question.",
    input_schema: NO_ARGS,
    strict: true,
  },
  {
    name: "get_forecast",
    description:
      "Project where the user's body is heading: rate of change, expected goal date, " +
      "likelihood of success, and the highest-leverage change. Call this when the user " +
      "asks when they'll hit a goal, how long something will take, whether they're on " +
      "track, or what they're on course to achieve. Use investigate_progress instead " +
      "when they're asking WHY rather than WHEN.",
    input_schema: NO_ARGS,
    strict: true,
  },
  {
    name: "get_habit_report",
    description:
      "Read the user's behavioural patterns: per-domain scores, learned habits, " +
      "predicted at-risk habits, and rescue strategies. Call this when the user asks " +
      "what habits or patterns you've noticed about them, about their consistency, or " +
      "about their sleep, mood, or stress.",
    input_schema: NO_ARGS,
    strict: true,
  },
  {
    name: "get_recovery_status",
    description:
      "Current recovery/readiness: a 0–100 score, its level, what drove it, and a " +
      "training recommendation. Call this when the user asks whether they should train " +
      "today, says they're sore, tired, drained, or asks about rest and readiness. " +
      "ALWAYS call this before advising on training intensity.",
    input_schema: NO_ARGS,
    strict: true,
  },
  {
    name: "get_weekly_review",
    description:
      "The structured review of the current week: adherence score, wins, watch-outs, " +
      "trajectory, and the single focus for next week. Call this when the user asks " +
      "how their week went, for a recap, a review, or a summary of the last 7 days.",
    input_schema: NO_ARGS,
    strict: true,
  },
  {
    name: "investigate_progress",
    description:
      "Root-cause analysis of why a metric is or isn't moving. Call this whenever the " +
      "user asks why something is happening, mentions a plateau, says they're stuck, " +
      "says nothing is working, or expresses confusion about their results. Returns " +
      "ranked candidate causes with the evidence behind each. Prefer this over " +
      "get_forecast when the question is 'why', not 'when'.",
    input_schema: {
      type: "object",
      properties: {
        focus: {
          type: "string",
          enum: ["weight", "strength", "energy", "adherence"],
          description: "Which outcome the user is asking about.",
        },
      },
      required: ["focus"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "log_food",
    description:
      "Log a whole food onto today's plan as a consumed snack. Call this ONLY when the " +
      "user clearly states they ate or drank something and wants it recorded — never " +
      "to answer a question about a food, and never speculatively. Requires the user's " +
      "confirmation. Returns the macros actually logged; cite those, never your own " +
      "estimate.",
    input_schema: {
      type: "object",
      properties: {
        food: {
          type: "string",
          description: "The food's common name, singular. e.g. 'banana', 'jollof rice'.",
        },
        servings: {
          type: "number",
          description: "How many standard servings. Default 1 when unstated.",
        },
      },
      required: ["food", "servings"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "recall_memory",
    description:
      "Retrieve what you already know about this user: their stated reason for being " +
      "here, preferences, constraints, past milestones, and learned behaviours. Call " +
      "this when the user asks what you know or remember about them, references " +
      "something they told you before, or when personalising advice would benefit from " +
      "their history.",
    input_schema: NO_ARGS,
    strict: true,
  },
  {
    name: "remember_fact",
    description:
      "Save a durable fact about the user: their motivation ('my why'), a preference, " +
      "or a constraint. Call this ONLY when the user states something about themselves " +
      "they'd expect you to remember later — not for passing remarks and not for " +
      "anything you inferred. Requires the user's confirmation before it is saved.",
    input_schema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["motivation", "preference", "constraint"],
          description:
            "motivation = why they're here; preference = what they like/dislike; " +
            "constraint = a limit on what they can do.",
        },
        value: {
          type: "string",
          description:
            "The fact in the user's own framing, third person, one clause. " +
            "e.g. 'wants to be strong enough to carry their kid upstairs'.",
        },
      },
      required: ["kind", "value"],
      additionalProperties: false,
    },
    strict: true,
  },
];

/**
 * Fail fast at boot rather than silently serving a cache-busting tool order.
 * A reordered array costs real money and is invisible in every other way.
 */
const names = TOOL_SCHEMAS.map((t) => t.name);
const sorted = [...names].sort((a, b) => a.localeCompare(b));
if (names.join("|") !== sorted.join("|")) {
  throw new Error(
    "TOOL_SCHEMAS must stay sorted by name — tools render at position 0 of the " +
      "cached prefix, so reordering invalidates every prompt cache entry.",
  );
}

export const TOOL_NAMES = new Set(names);
