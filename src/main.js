import { getLocation } from './geo.js';
import { loadGroups } from './tle-loader.js';
import { drawGrid, updateCelestial, updateLabels } from './sky-svg.js';
import { setupSkyCanvas } from './sky-canvas.js';
import { sunECI, moonECI, eciDirToAzEl } from './astro.js';
import { renderList, renderDetail, bindUi } from './ui.js';

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

const state = {
  observer: null,
  tles: [],
  groups: { active: true, starlink: true, last30: false },
  minElev: 5,
  sunlitOnly: true,
};

state.observer = await getLocation();

const locNameEl = document.getElementById('locName');
const coordsEl = document.getElementById('coords');
const groupChipsEl = document.getElementById('groupChips');
const sunlitToggleEl = document.getElementById('sunlitToggle');
const elSliderEl = document.getElementById('elSlider');
const elValEl = document.getElementById('elVal');
const redModeEl = document.getElementById('redMode');
const locBtnEl = document.getElementById('locBtn');
if (locNameEl) locNameEl.textContent = state.observer.name;
if (coordsEl) coordsEl.textContent = fmtLatLon(state.observer);

// --- Sky plot setup (Tasks 6 + 8) ---
const svg = document.getElementById('sky');
const canvasEl = document.getElementById('sky-canvas');
drawGrid(svg);
const skyCanvas = setupSkyCanvas(canvasEl);
window.addEventListener('resize', () => skyCanvas.resize());

// Status-bar handles, looked up once.
const loadDot = document.getElementById('loadDot');
const tleCountEl = document.getElementById('tleCount');
const visCountEl = document.getElementById('visCount');
const sunlitCountEl = document.getElementById('sunlitCount');
const nearestEl = document.getElementById('nearest');
const clockEl = document.getElementById('clock');
const solarEl = document.getElementById('solar');

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
const worker = new Worker(new URL('./worker.js', import.meta.url));

// --- Render state ---
// `latestFrame` / `prevFrame` are the two most recent worker payloads. The RAF
// loop extrapolates between them so motion looks smooth at 30+ fps despite the
// 1 Hz worker cadence. Selection lives here so click + list panel can share it.
let latestFrame = null;   // {timeMs, items, counts}
let prevFrame = null;     // {timeMs, items, counts}
let selectedId = null;

// Geodetic observer in radians for astro helpers — lat/lon mapping matters!
// `let` so re-locate can reassign (Object.assign also works for non-null cases).
let observerGd = state.observer ? {
  longitude: state.observer.lon * Math.PI / 180,
  latitude:  state.observer.lat * Math.PI / 180,
  height:    state.observer.alt
} : null;

function pad2(n){ return n < 10 ? '0' + n : '' + n; }
function fmtClock(date){
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

function sunPhaseLabel(altDeg){
  if (altDeg > 0)   return '(day)';
  if (altDeg > -6)  return '(civil twilight)';
  if (altDeg > -12) return '(nautical)';
  if (altDeg > -18) return '(astro twilight)';
  return '(night)';
}

function onWorkerPositions(frame){
  prevFrame = latestFrame;
  latestFrame = frame;

  // 1 Hz UI updates that don't need to interpolate.
  const now = new Date(frame.timeMs);
  if (clockEl) clockEl.textContent = fmtClock(now);

  const c = frame.counts;
  if (visCountEl) visCountEl.textContent = c.visible.toLocaleString();
  if (sunlitCountEl) {
    const sunlit = c.naked + c.binocular + c.telescope + c.daylight;
    sunlitCountEl.textContent = sunlit.toLocaleString();
  }
  if (nearestEl) {
    nearestEl.textContent = frame.items.length > 0
      ? `${Math.round(frame.items[0].range)} km`
      : '—';
  }

  // Sun + moon — computed on main thread (worker doesn't propagate the moon).
  if (observerGd && typeof window.satellite !== 'undefined'){
    const gmst = window.satellite.gstime(now);
    const sunDir = sunECI(now);
    const moonDir = moonECI(now);
    const sunLook = eciDirToAzEl(sunDir, observerGd, gmst);
    const moonLook = eciDirToAzEl(moonDir, observerGd, gmst);
    updateCelestial(svg, sunLook, moonLook);
    if (solarEl) {
      const altDeg = sunLook.el * 180 / Math.PI;
      solarEl.textContent = `sun: ${altDeg.toFixed(1)}° ${sunPhaseLabel(altDeg)}`;
    }
  }

  updateLabels(svg, frame.items, selectedId);

  // List + detail panel (Task 11). Both rebuild from the freshest frame.
  renderList(frame.items, selectedId, state.minElev);
  renderDetail(frame.items.find((it) => it.id === selectedId) || null);
}

// Helper: look up the current selection in the latest frame.
function selectedItem() {
  if (!latestFrame || selectedId == null) return null;
  return latestFrame.items.find((it) => it.id === selectedId) || null;
}

worker.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'ready') {
    // Pruning info isn't surfaced in v1 UI; status bar shows the post-prune
    // count via tleCount already. Re-enable a console line here if debugging.
  } else if (msg.type === 'positions') {
    onWorkerPositions(msg);
  }
};

if (state.tles.length > 0 && state.observer) {
  worker.postMessage({ type: 'init', tles: state.tles, observer: state.observer });
  worker.postMessage({ type: 'config', minElev: state.minElev, sunlitOnly: state.sunlitOnly });
  // Single-tier 1Hz fine pass over ALL retained sats. Task 13 will replace this
  // with a coarse 0.2Hz + fine 1Hz two-tier scheme to avoid jank on big payloads.
  setInterval(() => worker.postMessage({ type: 'tick', timeMs: Date.now() }), 1000);
}

// --- Interpolation ---
// The worker emits positions at ~1 Hz. RAF runs at the display rate. We
// extrapolate forward from `latestFrame` using the (latest - prev) velocity:
//   pos(now) = latest + (latest - prev) * t
// where t is fractional intervals past `latest.timeMs`. t = 0 at the moment
// the latest frame is valid; t grows until the next frame replaces both.
// We cap at 2 to bound the extrapolation if the worker stalls.

function lerpAngle(prev, latest, t) {
  // Wrap-aware az lerp: pick the short way around the 0/2π seam.
  let d = latest - prev;
  if (d > Math.PI) d -= 2 * Math.PI;
  else if (d < -Math.PI) d += 2 * Math.PI;
  let result = latest + d * t;
  // Normalize to [0, 2π).
  result = ((result % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  return result;
}

const HALF_PI = Math.PI / 2;

function interpolateItems(prevItems, latestItems, t) {
  if (t <= 0) return latestItems;
  const prevById = new Map();
  for (let i = 0; i < prevItems.length; i++) prevById.set(prevItems[i].id, prevItems[i]);
  return latestItems.map((latest) => {
    const prev = prevById.get(latest.id);
    if (!prev) return latest;
    const extrapEl = latest.el + (latest.el - prev.el) * t;
    const clampedEl = extrapEl < 0 ? 0 : extrapEl > HALF_PI ? HALF_PI : extrapEl;
    return {
      ...latest,
      az: lerpAngle(prev.az, latest.az, t),
      el: clampedEl,
    };
  });
}

function renderFrame(){
  if (latestFrame) {
    let interpolated;
    if (prevFrame && latestFrame.timeMs > prevFrame.timeMs) {
      const dt = (latestFrame.timeMs - prevFrame.timeMs) / 1000;
      const t = (Date.now() - latestFrame.timeMs) / 1000 / dt;
      const tClamped = Math.max(0, Math.min(2, t));
      interpolated = interpolateItems(prevFrame.items, latestFrame.items, tClamped);
    } else {
      interpolated = latestFrame.items;
    }
    skyCanvas.render(interpolated, selectedId);
  }
  requestAnimationFrame(renderFrame);
}
requestAnimationFrame(renderFrame);

// --- Click selection on canvas ---
// Hit-test runs against the dots painted in the LAST canvas frame, so it stays
// in sync with whatever the user actually sees (interpolated positions).
canvasEl.addEventListener('click', (e) => {
  const rect = canvasEl.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const hit = skyCanvas.hitTest(x, y);
  if (hit !== null) {
    selectedId = (selectedId === hit) ? null : hit;
  } else {
    selectedId = null;
  }
  // Refresh labels + detail immediately — feels snappier than waiting for the next tick.
  if (latestFrame) {
    updateLabels(svg, latestFrame.items, selectedId);
    renderList(latestFrame.items, selectedId, state.minElev);
    renderDetail(selectedItem());
  }
});

// List-row clicks toggle the same selection state as canvas clicks.
bindUi((id) => {
  selectedId = (selectedId === id) ? null : id;
  if (latestFrame) {
    updateLabels(svg, latestFrame.items, selectedId);
    renderList(latestFrame.items, selectedId, state.minElev);
    renderDetail(selectedItem());
  }
});

// --- Controls (Task 12) ---
// Reload TLEs from currently-enabled groups and re-init worker. Slightly
// duplicates boot's load+init dance, but boot has the awaited top-level path
// while this runs async on demand — kept separate for clarity.
async function reloadTles() {
  const enabled = [];
  if (state.groups.active) enabled.push('active');
  if (state.groups.starlink) enabled.push('starlink');
  if (state.groups.last30) enabled.push('last-30-days');

  if (loadDot) loadDot.className = 'dot warn';
  if (tleCountEl) tleCountEl.textContent = 'loading…';
  try {
    const { tles } = await loadGroups(enabled, { onWarn: toast });
    state.tles = tles;
    if (tleCountEl) tleCountEl.textContent = tles.length.toLocaleString();
    if (loadDot) loadDot.className = 'dot live';
    worker.postMessage({ type: 'init', tles, observer: state.observer });
    worker.postMessage({ type: 'config', minElev: state.minElev, sunlitOnly: state.sunlitOnly });
  } catch (err) {
    console.error('TLE reload failed', err);
    if (loadDot) loadDot.className = 'dot err';
  }
}

// Group chips — delegated click on the row.
if (groupChipsEl) {
  groupChipsEl.addEventListener('click', async (e) => {
    const btn = e.target.closest('.chip[data-group]');
    if (!btn) return;
    const g = btn.dataset.group; // 'active' | 'starlink' | 'last30'
    state.groups[g] = !state.groups[g];
    btn.classList.toggle('active', state.groups[g]);
    if (g === 'starlink' && state.groups[g]) toast('Loading ~7000 Starlink — may be slow');
    else if (g === 'active' && state.groups[g]) toast('Loading ~10000 active satellites…');
    await reloadTles();
  });
}

// Sunlit-only toggle.
if (sunlitToggleEl) {
  sunlitToggleEl.addEventListener('click', () => {
    state.sunlitOnly = !state.sunlitOnly;
    sunlitToggleEl.classList.toggle('active', state.sunlitOnly);
    worker.postMessage({ type: 'config', sunlitOnly: state.sunlitOnly });
  });
}

// Min-elevation slider — debounce worker messages so dragging doesn't flood it.
if (elSliderEl) {
  let elDebounce;
  elSliderEl.addEventListener('input', (e) => {
    state.minElev = +e.target.value;
    if (elValEl) elValEl.textContent = state.minElev + '°';
    clearTimeout(elDebounce);
    elDebounce = setTimeout(() => {
      worker.postMessage({ type: 'config', minElev: state.minElev });
    }, 150);
  });
}

// Night vision — toggles `body.night` and persists across reloads.
const NIGHT_KEY = 'orbitarium.night';
function applyNight(on) {
  document.body.classList.toggle('night', on);
  if (redModeEl) redModeEl.classList.toggle('active', on);
}
applyNight(localStorage.getItem(NIGHT_KEY) === '1');
if (redModeEl) {
  redModeEl.addEventListener('click', () => {
    const on = !document.body.classList.contains('night');
    applyNight(on);
    localStorage.setItem(NIGHT_KEY, on ? '1' : '0');
  });
}

// Re-locate — re-acquire observer and push to worker + astro helpers.
if (locBtnEl) {
  locBtnEl.addEventListener('click', async () => {
    toast('Re-acquiring location…');
    state.observer = await getLocation();
    if (locNameEl) locNameEl.textContent = state.observer.name;
    if (coordsEl) coordsEl.textContent = fmtLatLon(state.observer);
    const next = {
      longitude: state.observer.lon * Math.PI / 180,
      latitude:  state.observer.lat * Math.PI / 180,
      height:    state.observer.alt,
    };
    if (observerGd) Object.assign(observerGd, next);
    else observerGd = next;
    worker.postMessage({
      type: 'observer',
      lat: state.observer.lat,
      lon: state.observer.lon,
      alt: state.observer.alt,
    });
  });
}
