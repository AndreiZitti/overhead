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
