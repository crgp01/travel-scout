# travel-scout

A terminal agent that hunts for cheap flights and hotels. You chat with it in
plain language ("I'm flexible — cheapest day to fly Berlin→Madrid in early
November?"); Claude decides which tools to call, the tools hit the real
[Amadeus](https://developers.amadeus.com) travel API, and Claude turns the raw
offers into a recommendation.

This is deliberately a **learning project**: the agent loop is hand-written in
~100 readable lines instead of hidden behind a framework, so you can see
exactly how an LLM agent works.

## How an agent actually works

There is no magic. An "agentic workflow" is a while-loop around a stateless
chat API:

```
            ┌─────────────────────────────────────────────┐
            │                                             │
            ▼                                             │
   POST /v1/messages ──► stop_reason == "tool_use"? ──► run the tools locally,
   (full history +                │                     append results to the
    tool definitions)             │                     history, go again
                                  ▼
                        stop_reason == "end_turn"
                                  │
                                  ▼
                        final text answer
```

Three ideas carry everything:

1. **The API is stateless.** Every request re-sends the whole conversation
   (`messages`). "Memory" is just an array you keep appending to.
2. **Tools are declared, not connected.** You send the model a name, a
   description, and a JSON Schema. When the model wants a tool, it doesn't
   *run* anything — it replies with a `tool_use` block (`{name, input, id}`)
   and stops. *Your* code runs the function and appends a `tool_result` block.
   The model never touches your systems directly; you always sit in between.
3. **`stop_reason` is the control flow.** `tool_use` → execute and loop;
   `end_turn` → done. Everything else (guardrails, approvals, logging,
   retries) hangs off this one switch statement.

## Code tour (read in this order)

| File | What it teaches |
|---|---|
| [`src/agent.ts`](src/agent.ts) | The loop above, ~100 lines. Start here. |
| [`src/tools.ts`](src/tools.ts) | Tool *definitions* (what the model sees — this is prompt engineering) vs. *dispatch* (running the call, returning errors as `is_error` results instead of crashing). Also shows a **server tool** (`web_search`) that Anthropic runs, next to client tools that we run. |
| [`src/amadeus.ts`](src/amadeus.ts) | Tool implementations are ordinary code — OAuth, `fetch`, mapping. Note how responses are trimmed to just what the model needs, and how `find_cheapest_dates` pushes mechanical iteration into deterministic code instead of burning model calls. |
| [`src/systemPrompt.ts`](src/systemPrompt.ts) | Behavior rules: never invent prices, ask before searching, when to prefer which tool. Also why we inject today's *date* but not a timestamp (prompt caching). |
| [`src/index.ts`](src/index.ts) | The chat shell: owns the history array, rolls back failed turns so the history never ends in an unanswered `tool_use`. |

## Setup

You need two free accounts:

1. **Anthropic API key** — <https://console.anthropic.com/settings/keys>
2. **Amadeus Self-Service app** (free test tier, no credit card) —
   <https://developers.amadeus.com> → register → *My Self-Service Workspace* →
   *Create New App* → copy the API Key and API Secret.

Then:

```bash
npm install
cp .env.example .env    # paste your three values in
npm run chat
```

### About the Amadeus test environment

The free tier serves a cached subset of real data: major routes/cities work
well (MUC, FRA, MAD, PAR, LON, NYC...), smaller ones may return nothing, and
prices are indicative. The code is production-ready in shape — setting
`AMADEUS_ENV=production` with production keys is the only change.

## Example session

```
you › cheapest day to fly BER to MAD in the first week of November, ~4 nights
  → find_cheapest_dates {"origin":"BER","destination":"MAD","earliestDeparture":"2026-11-02","latestDeparture":"2026-11-08","tripLengthDays":4}

scout › Cheapest is Tue Nov 3 → Sat Nov 7 at 96.40 EUR round trip on Iberia
        (direct, ~3h each way). Flying a day earlier costs 41 EUR more. ...
```

The `→` lines are the agent's tool calls, printed so you can watch it think.

## Things worth studying in the code

- **Error handling as conversation** — a failing tool returns
  `is_error: true` instead of throwing. The model reads the error text and
  recovers: retries with fixed input, or tells the user what to configure.
- **Parallel tool use** — the model may emit several `tool_use` blocks in one
  turn. All results must go back in **one** user message.
- **`pause_turn`** — long server-tool turns (web search) can pause; re-sending
  the history resumes them.
- **Refusal fallbacks** — Opus 5 can decline a request for safety reasons
  (`stop_reason: "refusal"`); the `fallbacks` parameter re-runs it on another
  model server-side.

## Exercises (roughly in order)

1. **Add a tool**: `save_price_watch` that appends `{route, dates, price}` to a
   local JSON file, and `list_price_watches`. Teaches: agents + persistent
   state.
2. **Strict tool inputs**: add `strict: true` +
   `additionalProperties: false` to the tool schemas and see what changes.
3. **Streaming**: swap `client.beta.messages.create` for `.stream()` and print
   tokens as they arrive (`stream.on("text", ...)`, then `finalMessage()`).
4. **A tiny eval**: write 10 scripted user messages with the tool calls you
   *expect* (e.g. "flexible dates" must trigger `find_cheapest_dates`, a
   missing origin must trigger a question, never a search). Run them after
   every prompt change. This habit is what separates demos from products.
5. **Tool runner**: rebuild `agent.ts` with the SDK's
   `client.beta.messages.toolRunner()` + `betaZodTool` and compare — that's
   what you'd use in production once you understand the loop.
6. **React UI**: move the loop behind a small HTTP endpoint (Express/Hono)
   that takes `messages` and returns the updated history, then build a chat
   page on top. The agent code needs zero changes — that separation is the
   payoff of keeping the loop pure.
