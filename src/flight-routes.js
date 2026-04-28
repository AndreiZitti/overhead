// Lazy origin/destination lookup via adsbdb.com — free, no auth required.
// Cached in-memory per callsign for the session (the API answer rarely changes
// during a flight).

const ROUTE_BASE = 'https://api.adsbdb.com/v0/callsign/';
const cache = new Map(); // callsign -> {airline, origin, destination} | null

export async function lookupRoute(callsign) {
  if (!callsign) return null;
  const key = callsign.replace(/\s+/g, '').toUpperCase();
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
      origin: fr.origin
        ? { code: fr.origin.iata_code || fr.origin.icao_code, name: fr.origin.name }
        : null,
      destination: fr.destination
        ? { code: fr.destination.iata_code || fr.destination.icao_code, name: fr.destination.name }
        : null,
    };
    cache.set(key, result);
    return result;
  } catch {
    cache.set(key, null);
    return null;
  }
}
