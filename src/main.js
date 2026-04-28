import { getLocation } from './geo.js';
import { loadGroups } from './tle-loader.js';
import { setupMapOverlay } from './map-overlay.js';
import { renderList, renderDetail, bindUi } from './ui.js';

console.log('orbitarium v4 boot');

const fmt = (n, d = 3) => Number(n).toFixed(d);

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
  sunlitOnly: true,
  lastFetchAt: 0,
};

// --- Boot: location first (the map needs an initial center) ---
state.observer = await getLocation();

const locNameEl = document.getElementById('locName');
if (locNameEl) locNameEl.textContent = state.observer.name;

// --- Set up the Leaflet map + canvas overlay ---
const canvasEl = document.getElementById('sat-overlay');
const mapOverlay = setupMapOverlay('map', canvasEl, state.observer);

// --- Status pill handles ---
const loadDot = document.getElementById('loadDot');
const totalCountEl = document.getElementById('totalCount');
const visCountEl = document.getElementById('visCount');
const clockEl = document.getElementById('clock');

if (loadDot) loadDot.className = 'dot warn';
if (totalCountEl) totalCountEl.textContent = '…';

try {
  const { tles, fetchedAt } = await loadGroups(['active', 'starlink'], { onWarn: toast });
  state.tles = tles;
  state.lastFetchAt = fetchedAt;
  if (loadDot) loadDot.className = 'dot live';
} catch (e) {
  console.error('TLE load failed', e);
  if (loadDot) loadDot.className = 'dot err';
}

// --- SGP4 worker ---
const worker = new Worker(new URL('./worker.js', import.meta.url));

let latestFrame = null;
let prevFrame = null;
let selectedId = null;
let stationIdSet = new Set();
let nextPasses = [];

// Per-satellite trail history — populated each render frame for stations,
// naked-eye visibles, and the selected sat. Other sats don't trail.
const TRAIL_MAX = 30; // ~1 second at 30 fps
const trailHistory = new Map();
function maintainTrails(visibles) {
  const eligible = new Set();
  for (const v of visibles) {
    if (!(v.isStation || v.tier === 'naked' || v.id === selectedId)) continue;
    eligible.add(v.id);
    let arr = trailHistory.get(v.id);
    if (!arr) { arr = []; trailHistory.set(v.id, arr); }
    arr.push([v.lat, v.lon]);
    if (arr.length > TRAIL_MAX) arr.shift();
  }
  // Drop trails for sats that fell out of eligibility.
  for (const id of trailHistory.keys()) {
    if (!eligible.has(id)) trailHistory.delete(id);
  }
}

function pad2(n) { return n < 10 ? '0' + n : '' + n; }
function fmtClock(d) {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

// --- Sheet (bottom drawer) ---
const sheetEl = document.getElementById('sheet');
const sheetToggleEl = document.getElementById('sheetToggle');
const sheetSummaryEl = document.getElementById('sheetSummary');

function setSheetSummary(text) {
  if (sheetSummaryEl) sheetSummaryEl.innerHTML = text;
}

function expandSheet() { if (sheetEl) sheetEl.classList.add('expanded'); }
function collapseSheet() { if (sheetEl) sheetEl.classList.remove('expanded'); }
function toggleSheet() { if (sheetEl) sheetEl.classList.toggle('expanded'); }

if (sheetToggleEl) sheetToggleEl.addEventListener('click', toggleSheet);

// --- Drawer (right-side filters) ---
const drawerEl = document.getElementById('drawer');
const drawerCloseEl = document.getElementById('drawerClose');
const fabEl = document.getElementById('fabFilters');
const scrimEl = document.getElementById('scrim');

function openDrawer() {
  if (!drawerEl || !scrimEl) return;
  drawerEl.classList.add('open');
  drawerEl.setAttribute('aria-hidden', 'false');
  scrimEl.hidden = false;
  requestAnimationFrame(() => scrimEl.classList.add('open'));
}
function closeDrawer() {
  if (!drawerEl || !scrimEl) return;
  drawerEl.classList.remove('open');
  drawerEl.setAttribute('aria-hidden', 'true');
  scrimEl.classList.remove('open');
  setTimeout(() => { scrimEl.hidden = true; }, 250);
}
if (fabEl) fabEl.addEventListener('click', openDrawer);
if (drawerCloseEl) drawerCloseEl.addEventListener('click', closeDrawer);
if (scrimEl) scrimEl.addEventListener('click', closeDrawer);

function onWorkerPositions(frame) {
  prevFrame = latestFrame;
  latestFrame = frame;

  const now = new Date(frame.timeMs);
  if (clockEl) clockEl.textContent = fmtClock(now);

  const c = frame.counts;
  if (totalCountEl) totalCountEl.textContent = (c.total || 0).toLocaleString();
  if (visCountEl) visCountEl.textContent = c.visible.toLocaleString();

  // Update sheet content based on selection state.
  const sel = selectedId != null
    ? frame.visibles.find((v) => v.id === selectedId)
    : null;
  if (sel) {
    setSheetSummary(`<strong>${sel.name}</strong> · ${Math.round(sel.elDeg)}° ${azDegToCompass(sel.azDeg)}`);
  } else {
    setSheetSummary(`Above you · <strong>${c.visible}</strong>`);
  }
  renderList(frame.visibles, selectedId);
  renderDetail(sel || null, () => setSelection(null));
}

worker.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'positions') onWorkerPositions(msg);
  else if (msg.type === 'passes') {
    nextPasses = msg.passes || [];
    updateNextPassChip();
  }
};

// --- Next-pass chip ---
const npEl = document.getElementById('nextPass');
const npNameEl = document.getElementById('npName');
const npWhenEl = document.getElementById('npWhen');
const npDirEl = document.getElementById('npDir');

const COMPASS_16 = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
function azDegToCompass(deg) {
  const d = ((deg % 360) + 360) % 360;
  return COMPASS_16[Math.round(d / 22.5) % 16];
}

function fmtCountdown(ms) {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `in ${h}h ${m}m`;
  if (m > 0) return `in ${m}m ${String(s).padStart(2, '0')}s`;
  return `in ${s}s`;
}

function updateNextPassChip() {
  if (!npEl) return;
  const now = Date.now();
  while (nextPasses.length > 0 && nextPasses[0].riseTimeMs <= now) {
    nextPasses.shift();
  }
  if (nextPasses.length === 0) {
    npEl.hidden = true;
    return;
  }
  const next = nextPasses[0];
  npEl.hidden = false;
  if (npNameEl) npNameEl.textContent = next.name.replace(/\s*\(.*?\)\s*/g, '').slice(0, 18);
  if (npWhenEl) npWhenEl.textContent = fmtCountdown(next.riseTimeMs - now);
  if (npDirEl) npDirEl.textContent = `rises ${azDegToCompass(next.riseAzDeg)}`;
}
setInterval(updateNextPassChip, 1000);

if (state.tles.length > 0 && state.observer) {
  for (const tle of state.tles) if (tle.isStation) stationIdSet.add(tle.id);
  worker.postMessage({ type: 'init', tles: state.tles, observer: state.observer });
  worker.postMessage({ type: 'config', minElev: 5, sunlitOnly: state.sunlitOnly });
  setInterval(() => worker.postMessage({ type: 'tick', timeMs: Date.now() }), 1000);
}

// --- 30 fps interpolated render ---
function lerpLon(prev, latest, t) {
  let d = latest - prev;
  if (d > 180) d -= 360;
  else if (d < -180) d += 360;
  let r = latest + d * t;
  r = ((r + 540) % 360) - 180;
  return r;
}

function interpolatePositions(prevPositions, latestPositions, t) {
  if (t <= 0) return latestPositions;
  const prevById = new Map();
  for (const p of prevPositions) prevById.set(p.id, p);
  return latestPositions.map((latest) => {
    const prev = prevById.get(latest.id);
    if (!prev) return latest;
    return {
      id: latest.id,
      lon: lerpLon(prev.lon, latest.lon, t),
      lat: latest.lat + (latest.lat - prev.lat) * t,
    };
  });
}

function interpolateVisibles(prevVis, latestVis, t) {
  if (t <= 0) return latestVis;
  const prevById = new Map();
  for (const v of prevVis) prevById.set(v.id, v);
  return latestVis.map((latest) => {
    const prev = prevById.get(latest.id);
    if (!prev) return latest;
    return {
      ...latest,
      lon: lerpLon(prev.lon, latest.lon, t),
      lat: latest.lat + (latest.lat - prev.lat) * t,
    };
  });
}

function renderFrame() {
  if (latestFrame) {
    let allPos, vis;
    if (prevFrame && latestFrame.timeMs > prevFrame.timeMs) {
      const dt = (latestFrame.timeMs - prevFrame.timeMs) / 1000;
      const tRaw = (Date.now() - latestFrame.timeMs) / 1000 / dt;
      const t = Math.max(0, Math.min(2, tRaw));
      allPos = interpolatePositions(prevFrame.allPositions, latestFrame.allPositions, t);
      vis = interpolateVisibles(prevFrame.visibles, latestFrame.visibles, t);
    } else {
      allPos = latestFrame.allPositions;
      vis = latestFrame.visibles;
    }
    maintainTrails(vis);
    mapOverlay.render(allPos, vis, trailHistory, selectedId);
  }
  requestAnimationFrame(renderFrame);
}
requestAnimationFrame(renderFrame);

// --- Selection ---
function setSelection(id) {
  selectedId = id;
  worker.postMessage({ type: 'select', id });
  if (latestFrame) {
    const sel = id != null
      ? latestFrame.visibles.find((v) => v.id === id)
      : null;
    renderList(latestFrame.visibles, selectedId);
    renderDetail(sel || null, () => setSelection(null));
    if (sel) {
      // Center the map on the selected sat so its trail is in view, and
      // open the sheet so the detail panel is immediately readable.
      mapOverlay.map.flyTo([sel.lat, sel.lon], Math.max(mapOverlay.map.getZoom(), 4), {
        duration: 0.6,
      });
      expandSheet();
    } else {
      collapseSheet();
    }
  }
}

mapOverlay.onClick((id) => {
  setSelection(id !== null && id !== selectedId ? id : null);
});

bindUi((id) => {
  setSelection(selectedId === id ? null : id);
});

// --- Filters drawer controls ---
const groupChipsEl = document.getElementById('groupChips');
const sunlitToggleEl = document.getElementById('sunlitToggle');
const redModeEl = document.getElementById('redMode');
const locBtnEl = document.getElementById('locBtn');

async function reloadTles() {
  const enabled = [];
  if (state.groups.active) enabled.push('active');
  if (state.groups.starlink) enabled.push('starlink');
  if (state.groups.last30) enabled.push('last-30-days');

  if (loadDot) loadDot.className = 'dot warn';
  try {
    const { tles, fetchedAt } = await loadGroups(enabled, { onWarn: toast });
    state.tles = tles;
    state.lastFetchAt = fetchedAt;
    if (loadDot) loadDot.className = 'dot live';
    stationIdSet = new Set();
    for (const tle of tles) if (tle.isStation) stationIdSet.add(tle.id);
    worker.postMessage({ type: 'init', tles, observer: state.observer });
    worker.postMessage({ type: 'config', minElev: 5, sunlitOnly: state.sunlitOnly });
  } catch (err) {
    console.error('TLE reload failed', err);
    if (loadDot) loadDot.className = 'dot err';
  }
}

if (groupChipsEl) {
  groupChipsEl.addEventListener('click', async (e) => {
    const btn = e.target.closest('.chip[data-group]');
    if (!btn) return;
    const g = btn.dataset.group;
    state.groups[g] = !state.groups[g];
    btn.classList.toggle('active', state.groups[g]);
    if (g === 'starlink' && state.groups[g]) toast('Loading ~7000 Starlink — may be slow');
    else if (g === 'active' && state.groups[g]) toast('Loading ~10000 active satellites…');
    await reloadTles();
  });
}

if (sunlitToggleEl) {
  sunlitToggleEl.addEventListener('click', () => {
    state.sunlitOnly = !state.sunlitOnly;
    sunlitToggleEl.classList.toggle('active', state.sunlitOnly);
    worker.postMessage({ type: 'config', sunlitOnly: state.sunlitOnly });
  });
}

const bgDotsToggleEl = document.getElementById('bgDotsToggle');
if (bgDotsToggleEl) {
  bgDotsToggleEl.addEventListener('click', () => {
    const on = !bgDotsToggleEl.classList.contains('active');
    bgDotsToggleEl.classList.toggle('active', on);
    mapOverlay.setShowBackground(on);
  });
}

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

if (locBtnEl) {
  locBtnEl.addEventListener('click', async () => {
    toast('Re-acquiring location…');
    state.observer = await getLocation();
    if (locNameEl) locNameEl.textContent = state.observer.name;
    mapOverlay.setObserver(state.observer);
    worker.postMessage({
      type: 'observer',
      lat: state.observer.lat,
      lon: state.observer.lon,
      alt: state.observer.alt,
    });
    closeDrawer();
  });
}

// --- 6h refresh cycle ---
const FRESH_WINDOW_MS = 6 * 60 * 60 * 1000;
setInterval(() => {
  if (!state.lastFetchAt) return;
  if (Date.now() - state.lastFetchAt > FRESH_WINDOW_MS) reloadTles();
}, 60_000);

// Suppress unused-import warnings for fmt (kept for future formatters).
void fmt;
