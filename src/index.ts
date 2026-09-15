// CLI entry point: a readline chat around the agent loop.
// This file owns the conversation history; agent.ts appends to it each turn.

import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type Anthropic from "@anthropic-ai/sdk";
import { runAgentTurn } from "./agent.js";

console.log(`
✈  travel-scout — cheap flights & hotels, agent-style
   Try: "cheapest round trip MUC to LIS, out around Oct 9, back ~5 days later"
        "I'm flexible: cheapest day to fly BER -> MAD in the first week of November"
        "hotels in PAR under 150/night, Nov 21-23"
   Type "exit" to quit.
`);

const rl = readline.createInterface({ input: stdin, output: stdout });
const messages: Anthropic.Beta.BetaMessageParam[] = [];

while (true) {
  const line = (await rl.question("\nyou › ")).trim();
  if (line === "") continue;
  if (line.toLowerCase() === "exit" || line.toLowerCase() === "quit") break;

  // Snapshot so a failed turn can be rolled back — otherwise history could be
  // left ending in tool_use blocks with no results, which the API rejects on
  // the next turn.
  const checkpoint = messages.length;
  messages.push({ role: "user", content: line });

  try {
    const reply = await runAgentTurn(messages, (status) => console.log(status));
    console.log(`\nscout › ${reply}`);
  } catch (err) {
    messages.length = checkpoint;
    console.error(
      `\n[error] ${err instanceof Error ? err.message : String(err)}`,
    );
    console.error("That turn was rolled back — you can just ask again.");
  }
}

rl.close();
