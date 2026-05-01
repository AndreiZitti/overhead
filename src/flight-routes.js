// Lazy origin/destination lookup, cross-checked across two community sources:
//   - adsbdb.com  → rich data (airline, IATA, country, airport name)
//   - hexdb.io    → ICAO endpoints only, but a different community DB
//
// Letter-suffixed callsigns (DLH1CN, BAW2A, etc.) get reused with the schedule
// and either source can lag. We trust the airport pair only when both agree;
// on disagreement we drop the pair and keep the airline (honest > confidently
// wrong). Both APIs are CORS-friendly and free, no auth required.

const ADSBDB_BASE = 'https://api.adsbdb.com/v0/callsign/';
const HEXDB_BASE = 'https://hexdb.io/api/v1/route/icao/';
const cache = new Map(); // callsign -> {airline, origin, destination} | null

// Airline callsigns are an ICAO 3-letter prefix followed by a flight number,
// e.g., RYR1234, BAW286, EZY42AB. Aircraft registrations stripped of hyphens
// (EIDCL, GEUUU, 9HQAA) don't match this shape — guarding against them avoids
// spurious matches when the upstream feed reports a tail number in place of
// the live callsign.
const AIRLINE_CALLSIGN = /^[A-Z]{3}[0-9][A-Z0-9]*$/;

function airport(a) {
  if (!a) return null;
  const code = a.iata_code || a.icao_code || null;
  if (!code) return null;
  return {
    code,
    icao: a.icao_code || null,
    name: a.name || null,
    country: a.country_iso_name || a.country_name || null,
  };
}

async function fetchAdsbdb(key) {
  try {
    const r = await fetch(ADSBDB_BASE + encodeURIComponent(key));
    if (!r.ok) return null;
    const j = await r.json();
    const fr = j && j.response && j.response.flightroute;
    if (!fr) return null;
    return {
      airline: fr.airline ? fr.airline.name : null,
      callsignIata: fr.callsign_iata || null,
      origin: airport(fr.origin),
      destination: airport(fr.destination),
    };
  } catch {
    return null;
  }
}

// hexdb returns { flight, route: "EDDM-EGPF" } (dash-separated ICAO; can have
// intermediate stops — we only compare the endpoints).
async function fetchHexdb(key) {
  try {
    const r = await fetch(HEXDB_BASE + encodeURIComponent(key));
    if (!r.ok) return null;
    const j = await r.json();
    if (!j || typeof j.route !== 'string') return null;
    const parts = j.route.split('-').map((s) => s.trim().toUpperCase()).filter(Boolean);
    if (parts.length < 2) return null;
    return { origin: parts[0], destination: parts[parts.length - 1] };
  } catch {
    return null;
  }
}

export async function lookupRoute(callsign) {
  if (!callsign) return null;
  const key = callsign.replace(/\s+/g, '').toUpperCase();
  if (!AIRLINE_CALLSIGN.test(key)) { cache.set(key, null); return null; }
  if (cache.has(key)) return cache.get(key);

  const [primary, check] = await Promise.all([fetchAdsbdb(key), fetchHexdb(key)]);
  if (!primary) { cache.set(key, null); return null; }

  // If hexdb has a definitive answer that disagrees with adsbdb on either
  // endpoint, the schedule data is stale on at least one side — strip the
  // pair, keep the airline. If hexdb has no entry at all, trust adsbdb.
  let result = primary;
  if (check && primary.origin && primary.destination) {
    const a = primary.origin.icao;
    const b = primary.destination.icao;
    if (a && b && (a !== check.origin || b !== check.destination)) {
      result = { airline: primary.airline, callsignIata: primary.callsignIata, origin: null, destination: null };
    }
  }
  cache.set(key, result);
  return result;
}
