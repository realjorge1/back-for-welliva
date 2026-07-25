import { callText } from "../anthropic.js";
import { CLAUDE_MODEL } from "../config.js";
import type { CoachChatInput } from "../domain.js";

/**
 * GOZLIN COACH — conversational replies.
 *
 * The app's deterministic engines stay the source of truth for any structured
 * coaching (forecasts, briefings, the real numbers). They hand us a grounding
 * system prompt containing ONLY real facts about the user; this endpoint turns
 * an open-ended message into a warm, on-voice reply. The model never invents
 * numbers — it can only use what the grounding prompt provides.
 */

const DEFAULT_SYSTEM =
  "You are Gozlin, a persistent, warm, observant health coach inside the Welliva app. " +
  "Be brief (1–3 sentences), supportive, never robotic, never shaming, never guilt-tripping.";

const SAFETY =
  "\n\nYou are NOT a doctor: defer red-flag medical symptoms to a professional. " +
  "Use ONLY facts provided in this prompt — never invent specific numbers. If you don't know, say so.";

export interface CoachReplyResult {
  reply: string;
  model: string;
}

export async function coachReply(input: CoachChatInput): Promise<CoachReplyResult> {
  const user = (input.user ?? input.message ?? "").trim();
  const system = (input.system?.trim() || DEFAULT_SYSTEM) + SAFETY;

  const reply = await callText({ system, user, maxTokens: 600 });
  return { reply, model: CLAUDE_MODEL };
}
