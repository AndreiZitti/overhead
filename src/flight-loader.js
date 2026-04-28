// Live aircraft state vectors from the OpenSky Network, via our same-origin
// /api/flights proxy. Direct browser fetches are blocked because OpenSky's
// Access-Control-Allow-Origin restricts to their own domain.

const FLIGHTS_BASE = '/api/flights';

/**
 * Fetch aircraft inside the given lat/lon bounding box.
 * Returns an array of normalized aircraft records.
 *
 * @param {{south:number, north:number, west:number, east:number}} bounds
 * @returns {Promise<Array<Aircraft>>}
 */
export async function fetchAircraft(bounds) {
  const url =
    `${FLIGHTS_BASE}?lamin=${bounds.south.toFixed(4)}` +
    `&lomin=${bounds.west.toFixed(4)}` +
    `&lamax=${bounds.north.toFixed(4)}` +
    `&lomax=${bounds.east.toFixed(4)}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('flights API ' + r.status);
  const data = await r.json();
  if (!data || !Array.isArray(data.states)) return [];
  const out = [];
  for (const s of data.states) {
    const lon = s[5], lat = s[6];
    if (lon == null || lat == null) continue;
    out.push({
      id: s[0],                                 // icao24 hex (unique)
      callsign: (s[1] || '').trim() || null,
      country: s[2] || '',
      lon, lat,
      altM: s[7],                               // baro altitude, meters
      onGround: !!s[8],
      velocityMs: s[9],                         // m/s
      headingDeg: s[10],                        // 0 = north
      verticalRateMs: s[11],
      geoAltM: s[13],
    });
  }
  return out;
}
