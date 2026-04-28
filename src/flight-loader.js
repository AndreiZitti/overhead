// Live aircraft state vectors from the OpenSky Network.
// Anonymous access works (CORS-enabled) but is rate-limited to ~10s resolution
// and 100 req/day per IP. Free account upgrades the limit; we don't auth here.

const OPENSKY_BASE = 'https://opensky-network.org/api/states/all';

/**
 * Fetch aircraft inside the given lat/lon bounding box.
 * Returns an array of normalized aircraft records.
 *
 * @param {{south:number, north:number, west:number, east:number}} bounds
 * @returns {Promise<Array<Aircraft>>}
 */
export async function fetchAircraft(bounds) {
  const url =
    `${OPENSKY_BASE}?lamin=${bounds.south.toFixed(4)}` +
    `&lomin=${bounds.west.toFixed(4)}` +
    `&lamax=${bounds.north.toFixed(4)}` +
    `&lomax=${bounds.east.toFixed(4)}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('OpenSky ' + r.status);
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
