// Thin client for the Amadeus Self-Service API (https://developers.amadeus.com).
//
// This file has NOTHING to do with Claude — that separation is the point.
// Tools are ordinary functions; the agent layer (tools.ts + agent.ts) just
// exposes them to the model. You could swap Amadeus for any other API without
// touching the agent loop.

const BASE_URL =
  process.env.AMADEUS_ENV === "production"
    ? "https://api.amadeus.com"
    : "https://test.api.amadeus.com";

// ---------------------------------------------------------------------------
// OAuth2 client-credentials flow. Tokens live ~30 min; we cache one in memory
// and refresh 60s before expiry.
// ---------------------------------------------------------------------------

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getToken(): Promise<string> {
  const id = process.env.AMADEUS_CLIENT_ID;
  const secret = process.env.AMADEUS_CLIENT_SECRET;
  if (!id || !secret) {
    // This error becomes a tool_result with is_error: true, so the model can
    // explain to the user how to fix their setup instead of crashing.
    throw new Error(
      "Amadeus credentials are not configured. Create a free app at " +
        "https://developers.amadeus.com and put AMADEUS_CLIENT_ID and " +
        "AMADEUS_CLIENT_SECRET in a .env file (see .env.example).",
    );
  }

  if (cachedToken && Date.now() < cachedToken.expiresAt) {
    return cachedToken.token;
  }

  const res = await fetch(`${BASE_URL}/v1/security/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: id,
      client_secret: secret,
    }),
  });
  if (!res.ok) {
    throw new Error(`Amadeus auth failed (HTTP ${res.status}): ${await res.text()}`);
  }

  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in - 60) * 1000,
  };
  return cachedToken.token;
}

async function amadeusGet(
  path: string,
  params: Record<string, string>,
): Promise<any> {
  const token = await getToken();
  const url = new URL(BASE_URL + path);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    throw new Error(`Amadeus ${path} failed (HTTP ${res.status}): ${await res.text()}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Flights
// ---------------------------------------------------------------------------

export interface FlightQuery {
  origin: string;
  destination: string;
  departureDate: string;
  returnDate?: string;
  adults?: number;
  maxResults?: number;
}

export async function searchFlights(q: FlightQuery) {
  const params: Record<string, string> = {
    originLocationCode: q.origin.toUpperCase(),
    destinationLocationCode: q.destination.toUpperCase(),
    departureDate: q.departureDate,
    adults: String(q.adults ?? 1),
    currencyCode: "EUR",
    max: String(Math.min(q.maxResults ?? 5, 10)),
  };
  if (q.returnDate) params.returnDate = q.returnDate;

  const data = await amadeusGet("/v2/shopping/flight-offers", params);
  const carrierNames: Record<string, string> = data.dictionaries?.carriers ?? {};

  // Amadeus offers are huge (fare details, baggage, segment ids...). We map
  // them down to only what the model needs to compare prices. Trimming tool
  // output is one of the highest-leverage things you can do in an agent:
  // it cuts cost AND improves answer quality by removing noise.
  return (data.data ?? []).map((offer: any) => ({
    priceTotal: `${offer.price.grandTotal} ${offer.price.currency}`,
    airlines: (offer.validatingAirlineCodes ?? []).map(
      (code: string) => carrierNames[code] ?? code,
    ),
    itineraries: offer.itineraries.map((itinerary: any) => ({
      duration: itinerary.duration,
      stops: itinerary.segments.length - 1,
      segments: itinerary.segments.map(
        (s: any) =>
          `${s.carrierCode}${s.number} ${s.departure.iataCode} ${s.departure.at}` +
          ` -> ${s.arrival.iataCode} ${s.arrival.at}`,
      ),
    })),
    bookableSeats: offer.numberOfBookableSeats,
  }));
}

export interface FlexQuery {
  origin: string;
  destination: string;
  earliestDeparture: string;
  latestDeparture: string;
  tripLengthDays?: number;
  adults?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// "I'm flexible" search: one flight-offers call per candidate departure date,
// keeping only the cheapest offer of each. Doing this loop in TOOL CODE
// instead of letting the model call search_flights seven times is a core
// agent-design lesson: push mechanical iteration into deterministic code and
// save the model for judgment.
export async function findCheapestDates(q: FlexQuery) {
  const start = new Date(`${q.earliestDeparture}T00:00:00Z`).getTime();
  const end = new Date(`${q.latestDeparture}T00:00:00Z`).getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) {
    throw new Error("Invalid date window: use YYYY-MM-DD with earliest <= latest.");
  }
  const days = Math.round((end - start) / DAY_MS) + 1;
  if (days > 7) {
    throw new Error(
      `Window of ${days} departure dates is too wide (max 7). ` +
        "Ask the user to narrow the range, or scan it in two passes.",
    );
  }

  const results = [];
  for (let i = 0; i < days; i++) {
    const departureDate = new Date(start + i * DAY_MS).toISOString().slice(0, 10);
    const returnDate = q.tripLengthDays
      ? new Date(start + (i + q.tripLengthDays) * DAY_MS).toISOString().slice(0, 10)
      : undefined;
    try {
      const offers = await searchFlights({
        origin: q.origin,
        destination: q.destination,
        departureDate,
        returnDate,
        adults: q.adults,
        maxResults: 1,
      });
      results.push({
        departureDate,
        returnDate,
        cheapest: offers[0] ?? "no offers found for this date",
      });
    } catch (err) {
      // One bad date shouldn't sink the whole scan.
      results.push({
        departureDate,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Hotels — two-step flow: list hotels in a city, then price a batch of them.
// ---------------------------------------------------------------------------

export interface HotelQuery {
  cityCode: string;
  checkInDate: string;
  checkOutDate: string;
  adults?: number;
  maxResults?: number;
}

export async function searchHotels(q: HotelQuery) {
  const list = await amadeusGet("/v1/reference-data/locations/hotels/by-city", {
    cityCode: q.cityCode.toUpperCase(),
    radius: "10",
    radiusUnit: "KM",
  });
  const hotelIds = (list.data ?? [])
    .slice(0, 30)
    .map((h: any) => h.hotelId as string);
  if (hotelIds.length === 0) {
    throw new Error(
      `No hotels found for city code "${q.cityCode}". ` +
        "Make sure it is a 3-letter IATA city code (PAR, BER, MAD...).",
    );
  }

  const offers = await amadeusGet("/v3/shopping/hotel-offers", {
    hotelIds: hotelIds.join(","),
    checkInDate: q.checkInDate,
    checkOutDate: q.checkOutDate,
    adults: String(q.adults ?? 1),
    currency: "EUR",
    bestRateOnly: "true",
  });

  return (offers.data ?? [])
    .filter((h: any) => h.available !== false && h.offers?.[0]?.price?.total)
    .map((h: any) => ({
      name: h.hotel?.name,
      price: `${h.offers[0].price.total} ${h.offers[0].price.currency}`,
      roomCategory: h.offers[0].room?.typeEstimated?.category,
      board: h.offers[0].boardType,
    }))
    .sort(
      (a: any, b: any) => parseFloat(a.price) - parseFloat(b.price),
    )
    .slice(0, q.maxResults ?? 8);
}
