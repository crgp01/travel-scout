// The agent loop — the heart of the project.
//
// An "agent" is nothing more than this cycle:
//
//        ┌──────────────────────────────────────────────┐
//        │                                              │
//        ▼                                              │
//   call the model ── stop_reason? ──► "tool_use" ── run the tools,
//        │                              append results as a user message
//        │
//        └──► "end_turn" ── extract the text, done.
//
// The API is STATELESS: every request sends the full `messages` history, and
// the model's tool calls + our tool results are appended to that history like
// any other turn. That's the whole trick.

import Anthropic from "@anthropic-ai/sdk";
import { TOOL_DEFINITIONS, executeTool } from "./tools.js";
import { buildSystemPrompt } from "./systemPrompt.js";

// Zero-arg constructor: the SDK reads ANTHROPIC_API_KEY from the environment.
const client = new Anthropic();

const MODEL = "claude-opus-5";

/**
 * Run one full agent turn: from the user's latest message to the model's
 * final text answer, executing however many tool rounds happen in between.
 * Mutates `messages` so the caller keeps the growing conversation history.
 */
export async function runAgentTurn(
  messages: Anthropic.Beta.BetaMessageParam[],
  onStatus: (line: string) => void = () => {},
): Promise<string> {
  while (true) {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      system: buildSystemPrompt(),
      tools: TOOL_DEFINITIONS,
      messages,
      // Opus 5's safety layer can decline a request (stop_reason "refusal").
      // Server-side fallbacks re-run the same request on another model inside
      // the same API call, so the user still gets an answer.
      betas: ["server-side-fallback-2026-06-01"],
      fallbacks: [{ model: "claude-opus-4-8" }],
    });

    // Whatever the model produced becomes part of history — including its
    // tool_use blocks. Forgetting this push is the classic agent-loop bug:
    // the API rejects tool_result blocks that don't follow their tool_use.
    messages.push({ role: "assistant", content: response.content });

    switch (response.stop_reason) {
      // The model wants at least one tool run before it can answer.
      case "tool_use": {
        const toolCalls = response.content.filter(
          (block): block is Anthropic.Beta.BetaToolUseBlock =>
            block.type === "tool_use",
        );

        const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
        for (const call of toolCalls) {
          onStatus(`  → ${call.name} ${JSON.stringify(call.input)}`);
          results.push(await executeTool(call));
        }

        // All results go back in ONE user message. Splitting them across
        // several messages breaks the model's parallel tool calling.
        messages.push({ role: "user", content: results });
        continue; // around the loop: the model now sees the results
      }

      // A server tool (web_search) ran long and the turn was paused
      // server-side. Re-sending the history resumes it.
      case "pause_turn":
        continue;

      // The whole fallback chain declined. Surface it honestly.
      case "refusal":
        return (
          "I can't help with that request." +
          (response.stop_details?.explanation
            ? ` (${response.stop_details.explanation})`
            : "")
        );

      case "max_tokens":
        return extractText(response.content) + "\n[response truncated: hit max_tokens]";

      // "end_turn": the model is done and has answered in plain text.
      default:
        return extractText(response.content);
    }
  }
}

function extractText(content: Anthropic.Beta.BetaContentBlock[]): string {
  return content
    .filter(
      (block): block is Anthropic.Beta.BetaTextBlock => block.type === "text",
    )
    .map((block) => block.text)
    .join("\n");
}
