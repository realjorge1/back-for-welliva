/**
 * GOZLIN COACH — the agent-turn relay.
 *
 * The phone drives the loop; this is a thin authenticated pipe to the Messages
 * API. It holds the API key, the system prompt, and the tool SCHEMAS — and no
 * tool logic whatsoever. Every tool executes on the device against local data,
 * so the user's raw history never reaches this process.
 *
 * Wire format out is NDJSON, one JSON object per line:
 *
 *   {"type":"delta","text":"…"}                     0..n, as tokens arrive
 *   {"type":"done","content":[…],"stop_reason":"…"} exactly once on success
 *   {"type":"error","message":"…"}                  terminal failure
 *
 * NDJSON rather than SSE because the client is React Native: `expo/fetch` gives
 * a byte stream, and line-delimited JSON is trivial to parse off it without an
 * EventSource polyfill.
 *
 * The `done` frame carries the FULL content array — not just text — because the
 * client has to echo `tool_use` and `thinking` blocks back verbatim on the next
 * iteration of the loop.
 */

import type { Response } from "express";
import type Anthropic from "@anthropic-ai/sdk";
import { anthropic } from "../anthropic.js";
import { MODELS } from "../config.js";
import { log } from "../logger.js";
import { GOZLIN_PROMPT_VERSION, GOZLIN_SYSTEM } from "../gozlin/system.js";
import { TOOL_SCHEMAS } from "../gozlin/tools.js";
import type { CoachTurnInput } from "../domain.js";

/**
 * Sized for a one-liner PLUS its thinking. On Opus 5 thinking is on by default
 * and `max_tokens` caps thinking and response text TOGETHER — size this for the
 * visible answer alone and replies truncate mid-sentence with no error.
 */
const MAX_TOKENS = 4000;

function writeFrame(res: Response, frame: unknown): void {
  res.write(JSON.stringify(frame) + "\n");
}

export async function streamCoachTurn(
  input: CoachTurnInput,
  res: Response,
): Promise<void> {
  if (input.promptVersion && input.promptVersion !== GOZLIN_PROMPT_VERSION) {
    // Not fatal — an older build still gets correct coaching, just without any
    // prompt change shipped since. Worth knowing about before it's a mystery.
    log.warn(
      `gozlin prompt drift: client=${input.promptVersion} server=${GOZLIN_PROMPT_VERSION}`,
    );
  }

  res.status(200);
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("X-Accel-Buffering", "no"); // don't let a proxy buffer the stream
  res.flushHeaders?.();

  try {
    const stream = anthropic.beta.messages.stream({
      model: MODELS.coach,
      max_tokens: MAX_TOKENS,

      // Cache breakpoint. Render order is tools → system → messages, so a
      // breakpoint on the last system block caches the tool definitions AND the
      // system prompt together. Both are byte-identical for every user, so this
      // one entry is shared across the whole install base.
      system: [
        {
          type: "text",
          text: GOZLIN_SYSTEM,
          cache_control: { type: "ephemeral" },
        },
      ],

      // Schemas only — the implementations live on the phone.
      tools: TOOL_SCHEMAS as unknown as Anthropic.Beta.BetaToolUnion[],

      messages: input.messages as unknown as Anthropic.Beta.BetaMessageParam[],

      // Thinking stays ON. Disabling it to save tokens is the single most
      // dangerous config choice available to a tool-using agent on Opus 5: with
      // thinking disabled the model occasionally writes a tool call into its
      // visible text instead of emitting a tool_use block. The turn succeeds,
      // the tool never runs, nothing errors — and that bogus text then poisons
      // every later turn in the loop. Use low effort to control cost instead.
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },

      // A health coach brushes against injury and body-composition topics, so
      // an occasional classifier decline is expected. Route it rather than
      // failing the turn. (The newer `fallbacks: "default"` scalar form needs an
      // SDK bump past 0.105 — this typed array form is the same routing today.)
      betas: ["server-side-fallback-2026-06-01"],
      fallbacks: [{ model: "claude-opus-4-8" }],
    });

    stream.on("text", (delta) => {
      if (delta) writeFrame(res, { type: "delta", text: delta });
    });

    const final = await stream.finalMessage();

    writeFrame(res, {
      type: "done",
      content: final.content,
      stop_reason: final.stop_reason,
      model: final.model,
      usage: {
        input: final.usage?.input_tokens ?? 0,
        output: final.usage?.output_tokens ?? 0,
        cacheRead: final.usage?.cache_read_input_tokens ?? 0,
        cacheWrite: final.usage?.cache_creation_input_tokens ?? 0,
      },
    });
    res.end();
  } catch (err) {
    const message = err instanceof Error ? err.message : "Upstream model error";
    log.error("coach turn failed", message);
    // Headers are already sent, so an HTTP status is no longer available —
    // the client falls back to its deterministic path on this frame.
    writeFrame(res, { type: "error", message });
    res.end();
  }
}
