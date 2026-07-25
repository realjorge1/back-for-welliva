import { z } from "zod";
import { callToolValidated } from "../anthropic.js";
import { CLAUDE_MODEL } from "../config.js";
import type { WorkoutGenerateInput } from "../domain.js";

/**
 * AI WORKOUT GENERATOR
 *
 * Builds a full weekly plan for any user — honoring equipment, training days,
 * experience level, injuries (avoid loading the injured area) and medical
 * conditions (e.g. pregnancy-safe modifications). Returned via the
 * `emit_workout_plan` tool, then assembled into the app's
 * `GeneratedWorkoutPlan` shape (models/workout.ts).
 */

const CATEGORIES = ["push", "pull", "legs", "core", "cardio", "flexibility"] as const;
const PATTERNS = ["push", "pull", "squat", "hinge", "core", "cardio", "flexibility"] as const;
const DIFFICULTY = ["beginner", "intermediate", "advanced"] as const;

const ExerciseOut = z.object({
  name: z.string().min(1),
  category: z.enum(CATEGORIES),
  movementPattern: z.enum(PATTERNS),
  sets: z.number().int().positive(),
  reps: z.string().min(1),
  restSeconds: z.number().nonnegative(),
  durationMinutes: z.number().nonnegative(),
  difficulty: z.enum(DIFFICULTY),
  description: z.string().default(""),
  setupPosition: z.string().default(""),
  steps: z.array(z.string()).default([]),
  targetMuscles: z.array(z.string()).default([]),
  coachCues: z.array(z.string()).default([]),
});

const SessionOut = z.object({
  dayOfWeek: z.number().int().min(0).max(6),
  dayLabel: z.string().min(1),
  focus: z.string().min(1),
  isRestDay: z.boolean().default(false),
  warmupMinutes: z.number().nonnegative().default(5),
  cooldownMinutes: z.number().nonnegative().default(5),
  exercises: z.array(ExerciseOut).default([]),
});

const PlanOut = z.object({
  splitType: z.string().min(1),
  rationale: z.string().default(""),
  coachNote: z.string().default(""),
  sessions: z.array(SessionOut).min(1),
});

type Plan = z.infer<typeof PlanOut>;
type ExerciseDraft = z.infer<typeof ExerciseOut>;
type SessionDraft = z.infer<typeof SessionOut>;

const exerciseSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "name",
    "category",
    "movementPattern",
    "sets",
    "reps",
    "restSeconds",
    "durationMinutes",
    "difficulty",
    "description",
    "setupPosition",
    "steps",
    "targetMuscles",
    "coachCues",
  ],
  properties: {
    name: { type: "string" },
    category: { type: "string", enum: [...CATEGORIES] },
    movementPattern: { type: "string", enum: [...PATTERNS] },
    sets: { type: "integer" },
    reps: { type: "string", description: "e.g. '8-12' or '30 sec'" },
    restSeconds: { type: "number" },
    durationMinutes: { type: "number" },
    difficulty: { type: "string", enum: [...DIFFICULTY] },
    description: { type: "string", description: "One sentence: what the move is + its main benefit" },
    setupPosition: { type: "string", description: "Starting position / how to set up" },
    steps: {
      type: "array",
      description: "Ordered how-to-perform steps (3-6 short, clear steps)",
      items: { type: "string" },
    },
    targetMuscles: {
      type: "array",
      description: "Primary muscles worked",
      items: { type: "string" },
    },
    coachCues: {
      type: "array",
      description: "1-3 short form/safety cues",
      items: { type: "string" },
    },
  },
} as const;

const WORKOUT_TOOL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["splitType", "rationale", "coachNote", "sessions"],
  properties: {
    splitType: { type: "string", description: "e.g. 'Full Body 3-Day', 'Upper/Lower 4-Day'" },
    rationale: { type: "string" },
    coachNote: { type: "string", description: "Short, warm coach note (Gozlin voice)" },
    sessions: {
      type: "array",
      description: "One entry per TRAINING day (do not include rest days)",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "dayOfWeek",
          "dayLabel",
          "focus",
          "isRestDay",
          "warmupMinutes",
          "cooldownMinutes",
          "exercises",
        ],
        properties: {
          dayOfWeek: { type: "integer", description: "0=Mon, 1=Tue ... 6=Sun" },
          dayLabel: { type: "string", description: "e.g. 'Day 1 – Push'" },
          focus: { type: "string", description: "e.g. 'Upper Body Push'" },
          isRestDay: { type: "boolean" },
          warmupMinutes: { type: "number" },
          cooldownMinutes: { type: "number" },
          exercises: { type: "array", items: exerciseSchema },
        },
      },
    },
  },
} as const;

const SYSTEM = `You are Welliva's strength & conditioning engine. You design a weekly workout plan for one person.

You are NOT limited to any fixed exercise database — choose the best movements for this user's goal, level, and available equipment.

Hard rules:
- Build exactly the number of TRAINING days the user wants (workoutDaysPerWeek). Spread them sensibly across the week (dayOfWeek 0=Mon..6=Sun). Do not emit rest days.
- Only use equipment the user has. If equipment is ["none"], use bodyweight only.
- Match volume/intensity to exerciseLevel (beginner/intermediate/advanced).
- Program balanced movement patterns across the week for the goal (lose_weight, build_muscle, improve_fitness, increase_energy, better_health, athletic_performance).
- INJURIES: never load an injured area. If injuries mention a body area (knee, shoulder, back, wrist, ankle, hip, neck...), avoid exercises that stress it and offer a safe alternative.
- MEDICAL: pregnancy → avoid supine core after 1st trimester, heavy valsalva, and high fall-risk moves; keep intensity moderate, emphasize mobility/pelvic-floor-safe work. hypertension → avoid prolonged overhead isometrics/heavy straining. Be sensible for any condition.
- Give each exercise realistic sets, reps ("8-12" or "30 sec"), rest seconds, an estimated durationMinutes, and a difficulty.
- TEACH every exercise so the app can guide someone who has never done it: a one-sentence description, a setupPosition, 3-6 ordered "steps" for how to perform it safely with good form, the targetMuscles, and 1-3 short coachCues.

Return your answer ONLY by calling the emit_workout_plan tool.`;

// ── App-compatible output types (mirror models/workout.ts) ─────────────────
interface PlannedExercise {
  exerciseId: string;
  name: string;
  category: (typeof CATEGORIES)[number];
  movementPattern: (typeof PATTERNS)[number];
  sets: number;
  reps: string;
  restSeconds: number;
  durationMinutes: number;
  difficulty: (typeof DIFFICULTY)[number];
  setupPosition?: string;
  steps?: string[];
  targetMuscles?: string[];
  coachCues?: string[];
  description?: string;
}
interface WorkoutSession {
  id: string;
  dayLabel: string;
  dayOfWeek?: number;
  focus: string;
  warmupMinutes: number;
  exercises: PlannedExercise[];
  cooldownMinutes: number;
  totalDurationMinutes: number;
  isRestDay: boolean;
}
interface GeneratedWorkoutPlan {
  id: string;
  createdAt: string;
  weekStart: string;
  splitType: string;
  sessions: WorkoutSession[];
  inputHash: string;
}

export interface WorkoutGenerateResult {
  plan: GeneratedWorkoutPlan;
  rationale: string;
  coachNote: string;
  model: string;
  source: "ai";
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "ex";
}

function toExercise(e: ExerciseDraft, sIdx: number, eIdx: number): PlannedExercise {
  return {
    exerciseId: `ai_${sIdx}_${eIdx}_${slug(e.name)}`,
    name: e.name,
    category: e.category,
    movementPattern: e.movementPattern,
    sets: e.sets,
    reps: e.reps,
    restSeconds: Math.round(e.restSeconds),
    durationMinutes: Math.round(e.durationMinutes),
    difficulty: e.difficulty,
    setupPosition: e.setupPosition || undefined,
    steps: e.steps.length ? e.steps : undefined,
    targetMuscles: e.targetMuscles.length ? e.targetMuscles : undefined,
    coachCues: e.coachCues.length ? e.coachCues : undefined,
    description: e.description || undefined,
  };
}

function toSession(s: SessionDraft, idx: number): WorkoutSession {
  const exercises = s.exercises.map((e, i) => toExercise(e, idx, i));
  const exerciseMinutes = exercises.reduce((sum, e) => sum + e.durationMinutes, 0);
  return {
    id: `ai_session_${idx}_${s.dayOfWeek}`,
    dayLabel: s.dayLabel,
    dayOfWeek: s.dayOfWeek,
    focus: s.focus,
    warmupMinutes: Math.round(s.warmupMinutes),
    exercises,
    cooldownMinutes: Math.round(s.cooldownMinutes),
    totalDurationMinutes: Math.round(s.warmupMinutes + exerciseMinutes + s.cooldownMinutes),
    isRestDay: false,
  };
}

export async function generateWorkout(
  input: WorkoutGenerateInput,
): Promise<WorkoutGenerateResult> {
  const days = input.bio.workoutDaysPerWeek ?? 3;
  const equipment = input.bio.equipment ?? ["none"];
  const userPayload = {
    weekStart: input.weekStart,
    workoutDaysPerWeek: days,
    equipment,
    user: input.bio,
  };

  const plan = await callToolValidated<Plan>(
    {
      system: SYSTEM,
      user:
        `Design a ${days}-day training week for this user.\n\n` + JSON.stringify(userPayload),
      toolName: "emit_workout_plan",
      toolDescription: "Emit the user's weekly workout plan.",
      inputSchema: WORKOUT_TOOL_SCHEMA as unknown as Record<string, unknown>,
      maxTokens: 5000,
    },
    (raw) => PlanOut.parse(raw),
  );

  const sessions = plan.sessions
    .filter((s) => !s.isRestDay && s.exercises.length > 0)
    .sort((a, b) => a.dayOfWeek - b.dayOfWeek)
    .map(toSession);

  const generatedPlan: GeneratedWorkoutPlan = {
    id: `ai_plan_${input.weekStart}_${Date.now()}`,
    createdAt: new Date().toISOString(),
    weekStart: input.weekStart,
    splitType: plan.splitType,
    sessions,
    // Marks this as an AI plan + ties it to the inputs that produced it, so the
    // app's weekly regen check can treat it as current for the week.
    inputHash: `ai:${input.weekStart}:${days}:${equipment.slice().sort().join(",")}:${input.bio.primaryGoal ?? ""}:${input.bio.exerciseLevel ?? ""}`,
  };

  return {
    plan: generatedPlan,
    rationale: plan.rationale,
    coachNote: plan.coachNote,
    model: CLAUDE_MODEL,
    source: "ai",
  };
}
