// The tool layer: what Claude sees, and how its calls are dispatched.
//
// A tool has two halves:
//   1. The DEFINITION (name + description + JSON Schema) — this is prompt
//      engineering. The model chooses tools based only on this text, so the
//      descriptions should say when to use the tool, not how it works.
//   2. The IMPLEMENTATION — ordinary code, dispatched in executeTool().

import type Anthropic from "@anthropic-ai/sdk";
import {
  findCheapestDates,
  searchFlights,
  searchHotels,
  type FlexQuery,
  type FlightQuery,
  type HotelQuery,
} from "./amadeus.js";

export const TOOL_DEFINITIONS: Anthropic.Beta.BetaToolUnion[] = [
  {
    name: "search_flights",
    description:
      "Search flight offers for a fixed origin/destination and dates, cheapest " +
      "first, priced in EUR. Use when the user has specific dates. Requires " +
      "3-letter IATA airport or city codes (e.g. MUC, MAD, NYC).",
    input_schema: {
      type: "object",
      properties: {
        origin: { type: "string", description: "IATA code of origin, e.g. MUC" },
        destination: { type: "string", description: "IATA code of destination, e.g. LIS" },
        departureDate: { type: "string", description: "YYYY-MM-DD" },
        returnDate: {
          type: "string",
          description: "YYYY-MM-DD. Omit for a one-way search.",
        },
        adults: { type: "integer", description: "Number of adult passengers, default 1" },
        maxResults: { type: "integer", description: "Max offers to return, default 5, cap 10" },
      },
      required: ["origin", "destination", "departureDate"],
    },
  },
  {
    name: "find_cheapest_dates",
    description:
      "Scan a window of departure dates (max 7) and return the cheapest offer " +
      "for each date, so you can tell the user which day is cheapest to fly. " +
      "Use when the user is flexible about dates. For round trips pass " +
      "tripLengthDays instead of a fixed return date.",
    input_schema: {
      type: "object",
      properties: {
        origin: { type: "string", description: "IATA code of origin" },
        destination: { type: "string", description: "IATA code of destination" },
        earliestDeparture: { type: "string", description: "YYYY-MM-DD, start of the window" },
        latestDeparture: { type: "string", description: "YYYY-MM-DD, end of the window (max 6 days after start)" },
        tripLengthDays: {
          type: "integer",
          description: "Nights until the return flight. Omit for one-way scans.",
        },
        adults: { type: "integer", description: "Number of adult passengers, default 1" },
      },
      required: ["origin", "destination", "earliestDeparture", "latestDeparture"],
    },
  },
  {
    name: "search_hotels",
    description:
      "Find the cheapest available hotel offers in a city for given dates, " +
      "priced in EUR, cheapest first. Requires a 3-letter IATA CITY code " +
      "(PAR, BER, MAD) — not an airport code like CDG or TXL.",
    input_schema: {
      type: "object",
      properties: {
        cityCode: { type: "string", description: "IATA city code, e.g. PAR" },
        checkInDate: { type: "string", description: "YYYY-MM-DD" },
        checkOutDate: { type: "string", description: "YYYY-MM-DD" },
        adults: { type: "integer", description: "Guests per room, default 1" },
        maxResults: { type: "integer", description: "Max hotels to return, default 8" },
      },
      required: ["cityCode", "checkInDate", "checkOutDate"],
    },
  },
  // A SERVER tool: it runs on Anthropic's infrastructure during the model's
  // turn. No `run` function, no dispatch case below — results appear in the
  // response automatically. Compare with the client tools above, which WE run.
  { type: "web_search_20260209", name: "web_search", max_uses: 3 },
];

// Dispatch one tool_use block from the model to the matching implementation.
// Always return a tool_result — even on failure. A thrown error becomes
// is_error: true, which the model reads and recovers from (retry with fixed
// input, tell the user what's misconfigured...). Swallowing the failure or
// crashing the process would leave the conversation in a broken state.
export async function executeTool(
  call: Anthropic.Beta.BetaToolUseBlock,
): Promise<Anthropic.Beta.BetaToolResultBlockParam> {
  try {
    const input = call.input as Record<string, unknown>;
    let result: unknown;
    switch (call.name) {
      case "search_flights":
        result = await searchFlights(input as unknown as FlightQuery);
        break;
      case "find_cheapest_dates":
        result = await findCheapestDates(input as unknown as FlexQuery);
        break;
      case "search_hotels":
        result = await searchHotels(input as unknown as HotelQuery);
        break;
      default:
        throw new Error(`Unknown tool: ${call.name}`);
    }
    return {
      type: "tool_result",
      tool_use_id: call.id,
      content: JSON.stringify(result),
    };
  } catch (err) {
    return {
      type: "tool_result",
      tool_use_id: call.id,
      is_error: true,
      content: err instanceof Error ? err.message : String(err),
    };
  }
}
