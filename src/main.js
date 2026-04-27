import { getLocation } from './geo.js';
import { loadGroups } from './tle-loader.js';

console.log('orbitarium boot');
console.log('satellite.js loaded:', typeof window.satellite !== 'undefined');

const fmt = (n, d = 3) => Number(n).toFixed(d);
const fmtLatLon = (obs) =>
  `${fmt(Math.abs(obs.lat))}°${obs.lat >= 0 ? 'N' : 'S'} • ` +
  `${fmt(Math.abs(obs.lon))}°${obs.lon >= 0 ? 'E' : 'W'}`;

// Tiny inline toast — second usage; consolidate to a util module on third (rule of three).
function toast(msg) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._h);
  toast._h = setTimeout(() => t.classList.remove('show'), 3000);
}

const state = { observer: null, tles: [] };

state.observer = await getLocation();

const locNameEl = document.getElementById('locName');
const coordsEl = document.getElementById('coords');
if (locNameEl) locNameEl.textContent = state.observer.name;
if (coordsEl) coordsEl.textContent = fmtLatLon(state.observer);

const loadDot = document.getElementById('loadDot');
const tleCountEl = document.getElementById('tleCount');

if (loadDot) loadDot.className = 'dot warn';
if (tleCountEl) tleCountEl.textContent = 'loading…';

try {
  const { tles } = await loadGroups(['active', 'starlink'], { onWarn: toast });
  state.tles = tles;
  if (tleCountEl) tleCountEl.textContent = tles.length.toLocaleString();
  if (loadDot) loadDot.className = 'dot live';
} catch (e) {
  console.error('TLE load failed', e);
  if (loadDot) loadDot.className = 'dot err';
}

// --- SGP4 worker (Task 7) ---
// Vite resolves `new Worker(new URL('./worker.js', import.meta.url))` and serves
// the file. Worker is CLASSIC so it can `importScripts('/vendor/satellite.min.js')`.
//
// NOTE: console logs below are temporary smoke-test wiring. Tasks 9-12 wire the
// `positions` payload into the polar plot, table, and status bar.
const worker = new Worker(new URL('./worker.js', import.meta.url));

worker.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'ready') {
    console.log(`[worker] ready: kept ${msg.retained} of ${msg.total} (pruned ${msg.pruned})`);
  } else if (msg.type === 'positions') {
    console.log(`[worker] positions: ${msg.items.length} items, counts:`, msg.counts);
  }
};

if (state.tles.length > 0 && state.observer) {
  worker.postMessage({ type: 'init', tles: state.tles, observer: state.observer });
  worker.postMessage({ type: 'config', minElev: 5, sunlitOnly: true });
  // Single-tier 1Hz fine pass over ALL retained sats. Task 13 will replace this
  // with a coarse 0.2Hz + fine 1Hz two-tier scheme to avoid jank on big payloads.
  setInterval(() => worker.postMessage({ type: 'tick', timeMs: Date.now() }), 1000);
}
