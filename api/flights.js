// Vercel serverless function — proxies OpenSky's /states/all to bypass CORS.
// OpenSky's Access-Control-Allow-Origin only allows their own domain, so
// browsers can't call them directly from our origin. Server-to-server is fine.
//
// Caches at the edge for 10s + 20s stale-while-revalidate so multiple users
// (or rapid pans) don't fan out to OpenSky's rate limit.

export default async function handler(req, res) {
  const { lamin, lomin, lamax, lomax } = req.query || {};
  if (!lamin || !lomin || !lamax || !lomax) {
    return res.status(400).json({ error: 'bbox params required: lamin, lomin, lamax, lomax' });
  }
  const url =
    'https://opensky-network.org/api/states/all' +
    `?lamin=${encodeURIComponent(lamin)}` +
    `&lomin=${encodeURIComponent(lomin)}` +
    `&lamax=${encodeURIComponent(lamax)}` +
    `&lomax=${encodeURIComponent(lomax)}`;
  try {
    const r = await fetch(url);
    if (!r.ok) {
      return res.status(r.status).json({ error: `OpenSky ${r.status}` });
    }
    const data = await r.json();
    res.setHeader('Cache-Control', 's-maxage=10, stale-while-revalidate=20');
    return res.status(200).json(data);
  } catch (e) {
    return res.status(502).json({ error: 'upstream fetch failed: ' + (e && e.message) });
  }
}
