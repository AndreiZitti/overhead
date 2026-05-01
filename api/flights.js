// Vercel serverless function — proxies adsb.lol's free community API.
// Originally tried OpenSky but their endpoint is too slow from Vercel's shared
// IPs (>10s, exceeds hobby-tier function timeout). adsb.lol responds in ~200ms
// and has no rate limit for casual use.
//
// Input: bbox query params (lamin, lomin, lamax, lomax) — same shape as
// OpenSky for client compatibility. We convert to (lat, lon, dist_nm).

export default async function handler(req, res) {
  const { lamin, lomin, lamax, lomax } = req.query || {};
  if (!lamin || !lomin || !lamax || !lomax) {
    return res.status(400).json({ error: 'bbox params required: lamin, lomin, lamax, lomax' });
  }
  const south = +lamin, north = +lamax, west = +lomin, east = +lomax;
  const lat = (south + north) / 2;
  const lon = (west + east) / 2;
  // Distance from center to viewport corner, in nautical miles. Cap at 250 nm.
  const dLatKm = ((north - south) / 2) * 111;
  const dLonKm = ((east - west) / 2) * 111 * Math.cos((lat * Math.PI) / 180);
  const radiusKm = Math.max(20, Math.sqrt(dLatKm * dLatKm + dLonKm * dLonKm));
  const radiusNm = Math.min(250, Math.round(radiusKm / 1.852));

  const url = `https://api.adsb.lol/v2/lat/${lat.toFixed(3)}/lon/${lon.toFixed(3)}/dist/${radiusNm}`;
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 9000);
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Overhead/1.0 (+https://overhead-zitti.vercel.app)',
        'Accept': 'application/json',
      },
      signal: ac.signal,
    });
    clearTimeout(t);
    if (!r.ok) {
      return res.status(r.status).json({ error: `adsb.lol ${r.status}` });
    }
    const data = await r.json();
    // Translate to OpenSky-like { time, states: [...] } so the client parser
    // doesn't have to know about the upstream change.
    const states = (data.ac || []).map((a) => [
      a.hex || '',                                  // 0  icao24
      a.flight || '',                               // 1  callsign (NOT a.r — registration ≠ callsign)
      a.country || '',                              // 2  origin country (often blank)
      a.seen_pos != null ? Math.floor(Date.now() / 1000 - a.seen_pos) : null, // 3
      Math.floor(Date.now() / 1000),                // 4  last_contact
      a.lon ?? null,                                // 5  longitude
      a.lat ?? null,                                // 6  latitude
      a.alt_baro != null && a.alt_baro !== 'ground' // 7  baro_alt (m)
        ? a.alt_baro * 0.3048
        : null,
      a.alt_baro === 'ground' || a.gs === 0,        // 8  on_ground
      a.gs != null ? a.gs * 0.5144 : null,          // 9  velocity (m/s, was kt)
      a.track ?? null,                              // 10 true_track (deg)
      a.baro_rate != null ? a.baro_rate * 0.00508 : null, // 11 vert rate m/s
      null,                                          // 12 sensors
      a.alt_geom != null ? a.alt_geom * 0.3048 : null, // 13 geo_alt m
      a.squawk || null,                             // 14
      false, 0,                                      // 15, 16
    ]);
    res.setHeader('Cache-Control', 's-maxage=10, stale-while-revalidate=20');
    return res.status(200).json({ time: Math.floor(Date.now() / 1000), states });
  } catch (e) {
    return res.status(502).json({
      error: 'upstream fetch failed',
      detail: (e && (e.cause && e.cause.code || e.message)) || String(e),
    });
  }
}
