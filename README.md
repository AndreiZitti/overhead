# Overhead

Live satellite tracker — see what's flying over your location right now.

A flightradar-style web app that propagates SGP4 orbits for ~15 000
satellites (Active + Starlink catalogues from CelesTrak) in your browser
and renders their ground positions on a real Leaflet map. Stations
(ISS, CSS, etc.) and currently-overhead naked-eye sats get short
tapered trails so you can see motion at a glance.

## Stack

- Vanilla JS (ES modules) — no framework
- [satellite.js](https://github.com/shashwatak/satellite-js) for SGP4
  propagation
- [Leaflet](https://leafletjs.com/) + CartoDB Dark Matter tiles
- A dedicated Web Worker for the propagation loop so the main thread
  stays free for the canvas overlay
- IndexedDB cache for TLE bulk data (6 h freshness window)
- Vite for dev / build

## Run locally

```bash
npm install
npm run dev
```

Then open <http://localhost:5173>.

## Build for production

```bash
npm run build
```

Output goes to `dist/`. Any static host (Vercel, Netlify, GitHub Pages)
serves it as-is — no server-side runtime required.

## Data sources

- TLEs: [CelesTrak](https://celestrak.org/) (CORS-enabled, no API key)
- Reverse-geocoding (city name): BigDataCloud client API (no key)
- Tiles: [CARTO](https://carto.com/attributions) basemaps over OpenStreetMap

All math runs in your browser. Nothing is sent to any server beyond the
TLE / tile / geocode fetches above.

## License

MIT
