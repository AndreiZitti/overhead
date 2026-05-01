// Lazy origin/destination lookup via adsbdb.com — free, no auth required.
// Cached in-memory per callsign for the session (the API answer rarely changes
// during a flight).

const ROUTE_BASE = 'https://api.adsbdb.com/v0/callsign/';
const cache = new Map(); // callsign -> {airline, origin, destination} | null

// Airline callsigns are an ICAO 3-letter prefix followed by a flight number,
// e.g., RYR1234, BAW286, EZY42AB. Aircraft registrations stripped of hyphens
// (EIDCL, GEUUU, 9HQAA) don't match this shape — guarding against them avoids
// spurious matches from adsbdb when the upstream feed reports a tail number
// in place of the live callsign.
const AIRLINE_CALLSIGN = /^[A-Z]{3}[0-9][A-Z0-9]*$/;

function airport(a) {
  if (!a) return null;
  const code = a.iata_code || a.icao_code || null;
  if (!code) return null;
  return {
    code,
    name: a.name || null,
    country: a.country_iso_name || a.country_name || null,
  };
}

export async function lookupRoute(callsign) {
  if (!callsign) return null;
  const key = callsign.replace(/\s+/g, '').toUpperCase();
  if (!AIRLINE_CALLSIGN.test(key)) { cache.set(key, null); return null; }
  if (cache.has(key)) return cache.get(key);
  try {
    const r = await fetch(ROUTE_BASE + encodeURIComponent(key));
    if (!r.ok) { cache.set(key, null); return null; }
    const j = await r.json();
    const fr = j && j.response && j.response.flightroute;
    if (!fr) { cache.set(key, null); return null; }
    const result = {
      airline: fr.airline ? fr.airline.name : null,
      callsignIata: fr.callsign_iata || null,
      origin: airport(fr.origin),
      destination: airport(fr.destination),
    };
    cache.set(key, result);
    return result;
  } catch {
    cache.set(key, null);
    return null;
  }
}
