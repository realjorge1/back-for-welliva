import Anthropic from "@anthropic-ai/sdk";
import { CLAUDE_MODEL, config } from "./config.js";
import { ApiError } from "./http.js";

export const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });

export interface ToolCallParams {
  system: string;
  user: string;
  toolName: string;
  toolDescription: string;
  /** JSON Schema for the tool input (what the model must emit). */
  inputSchema: Record<string, unknown>;
  maxTokens?: number;
}

/**
 * Force the model to answer through a single tool call. This is the most
 * portable way to get schema-shaped JSON out of any Claude model (works on
 * Haiku, no structured-output beta required) — the returned `tool_use.input`
 * follows the provided JSON Schema.
 *
 * The model is ALWAYS {@link CLAUDE_MODEL} (Haiku) — never overridable.
 */
export async function callTool<T = unknown>(p: ToolCallParams): Promise<T> {
  const msg = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: p.maxTokens ?? 4096,
    system: p.system,
    tools: [
      {
        name: p.toolName,
        description: p.toolDescription,
        input_schema: p.inputSchema as Anthropic.Tool.InputSchema,
      },
    ],
    tool_choice: { type: "tool", name: p.toolName },
    messages: [{ role: "user", content: p.user }],
  });

  const block = msg.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") {
    throw new ApiError(502, "model_no_tool_use", "Model did not return a tool call");
  }
  return block.input as T;
}

/**
 * Call the tool, validate the result, and on validation failure make ONE
 * repair attempt that feeds the validation error back to the model.
 */
export async function callToolValidated<T>(
  p: ToolCallParams,
  validate: (raw: unknown) => T,
): Promise<T> {
  const first = await callTool(p);
  try {
    return validate(first);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    const repaired = await callTool({
      ...p,
      user: `${p.user}\n\nYour previous response failed validation:\n${reason}\nReturn corrected data that exactly matches the tool schema.`,
    });
    return validate(repaired); // if still invalid, this throws → 502 upstream
  }
}

/** Plain text completion (used by the coach). Model is always Haiku. */
export async function callText(p: {
  system: string;
  user: string;
  maxTokens?: number;
}): Promise<string> {
  const msg = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: p.maxTokens ?? 1024,
    system: p.system,
    messages: [{ role: "user", content: p.user }],
  });
  return msg.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("")
    .trim();
}
