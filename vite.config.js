// Local dev only: run the same Vercel function code that production uses
// for /api/flights so dev and prod stay in sync (handles bbox→radius +
// adsb.lol → OpenSky-shape translation identically).

import handler from './api/flights.js';

export default {
  server: {
    middlewareMode: false,
  },
  plugins: [
    {
      name: 'api-flights-dev',
      configureServer(server) {
        server.middlewares.use('/api/flights', async (req, res) => {
          // Build a Vercel-shaped req.query from the URL.
          const url = new URL(req.url, 'http://localhost');
          const query = Object.fromEntries(url.searchParams);
          const fakeReq = { query };
          const fakeRes = {
            statusCode: 200,
            _headers: {},
            status(c) { this.statusCode = c; return this; },
            setHeader(k, v) { this._headers[k] = v; return this; },
            json(body) {
              res.statusCode = this.statusCode;
              for (const [k, v] of Object.entries(this._headers)) res.setHeader(k, v);
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify(body));
            },
          };
          try {
            await handler(fakeReq, fakeRes);
          } catch (e) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: String(e) }));
          }
        });
      },
    },
  ],
};
