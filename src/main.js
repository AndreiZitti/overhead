import { getLocation } from './geo.js';
import { loadGroups } from './tle-loader.js';
import { setupMapOverlay } from './map-overlay.js';
import { fetchAircraft } from './flight-loader.js';
import { lookupRoute } from './flight-routes.js';
import { renderList, renderDetail, renderFlightList, renderFlightDetail, bindUi } from './ui.js';

console.log('overhead boot');

const fmt = (n, d = 3) => Number(n).toFixed(d);

function toast(msg) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._h);
  toast._h = setTimeout(() => t.classList.remove('show'), 3000);
}

const MODE_KEY = 'overhead.mode';
const state = {
  observer: null,
  tles: [],
  groups: { active: true, starlink: true, last30: false },
  sunlitOnly: true,
  lastFetchAt: 0,
  mode: localStorage.getItem(MODE_KEY) === 'flights' ? 'flights' : 'sats',
};

// --- Boot: location first (the map needs an initial center) ---
state.observer = await getLocation();

const locNameEl = document.getElementById('locName');
if (locNameEl) locNameEl.textContent = state.observer.name;

// --- Set up the Leaflet map + canvas overlays (fg = visibles, bg = all sats) ---
const fgCanvasEl = document.getElementById('sat-overlay');
const bgCanvasEl = document.getElementById('bg-overlay');
const mapOverlay = setupMapOverlay('map', fgCanvasEl, bgCanvasEl, state.observer);

// --- Status pill handles ---
const loadDot = document.getElementById('loadDot');
const totalCountEl = document.getElementById('totalCount');
const visCountEl = document.getElementById('visCount');
const clockEl = document.getElementById('clock');

const loadingEl = document.getElementById('mapLoading');
const loadingTextEl = document.getElementById('loadingText');
function showLoading(text) {
  if (!loadingEl) return;
  if (loadingTextEl) loadingTextEl.textContent = text || 'Loading…';
  loadingEl.hidden = false;
}
function hideLoading() { if (loadingEl) loadingEl.hidden = true; }

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

// Per-satellite trail history — populated each render frame for:
//   - stations (always, even off-screen)
//   - naked-eye visibles (always)
//   - selected sat (always)
//   - ANY visible non-shadow sat whose ground point is in the current viewport
//     (capped at TRAIL_VIEWPORT_CAP brightest)
const TRAIL_MAX = 240;            // ~8 seconds at 30 fps
const TRAIL_VIEWPORT_CAP = 40;    // perf guard at low zoom
const trailHistory = new Map();

function maintainTrails(visibles) {
  const bounds = mapOverlay.map.getBounds();
  const eligible = new Set();

  // Always-eligible: stations, naked-eye, selected.
  for (const v of visibles) {
    if (v.isStation || v.tier === 'naked' || v.id === selectedId) {
      eligible.add(v.id);
    }
  }

  // Plus: top-N brightest non-shadow visibles inside the viewport.
  const inView = [];
  for (const v of visibles) {
    if (eligible.has(v.id)) continue;
    if (v.tier === 'shadow' || v.tier === 'below') continue;
    if (!bounds.contains([v.lat, v.lon])) continue;
    inView.push(v);
  }
  inView.sort((a, b) => a.mag - b.mag);
  for (const v of inView.slice(0, TRAIL_VIEWPORT_CAP)) eligible.add(v.id);

  // Append current position to each eligible sat's history.
  for (const v of visibles) {
    if (!eligible.has(v.id)) continue;
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

  // Repaint the background canvas once per worker tick. ~17K dots barely
  // move at sat scale within 1 s, so per-frame redraws are wasted work.
  if (state.mode === 'sats') {
    mapOverlay.renderBackground(frame.allPositions);
  }

  if (firstPositionsPending) {
    firstPositionsPending = false;
    hideLoading();
  }

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

let workerTickHandle = null;
function startSatTicks() {
  if (workerTickHandle) return;
  workerTickHandle = setInterval(() => worker.postMessage({ type: 'tick', timeMs: Date.now() }), 1000);
}
function stopSatTicks() {
  if (workerTickHandle) { clearInterval(workerTickHandle); workerTickHandle = null; }
}

let firstPositionsPending = false;

if (state.tles.length > 0 && state.observer) {
  for (const tle of state.tles) if (tle.isStation) stationIdSet.add(tle.id);
  // Spinner stays up until the worker returns its first positions frame —
  // worker init parses ~17K satrecs and the initial structured-clone send is
  // the part the user perceives as "first-load freeze".
  firstPositionsPending = state.mode === 'sats';
  if (firstPositionsPending) showLoading('Computing orbits');
  worker.postMessage({ type: 'init', tles: state.tles, observer: state.observer });
  worker.postMessage({ type: 'config', minElev: 5, sunlitOnly: state.sunlitOnly });
  if (state.mode === 'sats') startSatTicks();
}

// --- Flights mode -----------------------------------------------------------
const FLIGHT_POLL_MS = 10_000;
const AIRCRAFT_TRAIL_MAX = 240; // ~8s at 30fps
let aircraft = [];        // latest API snapshot
let aircraftBaseMs = 0;   // wall time of that snapshot (for dead-reckoning)
let flightPollHandle = null;
let flightSelectedId = null;
let flightSelectedRoute = null;
const aircraftTrails = new Map();

// Snap-smoothing: when a new poll lands, each aircraft's reported position
// usually differs from our dead-reckoned prediction by 50-200 m (wind, turns,
// imperfect velocity). We carry a per-aircraft offset and decay it to zero
// over SNAP_SMOOTH_MS so positions converge smoothly instead of jolting.
const SNAP_SMOOTH_MS = 1000;

function deadReckonAircraft(now) {
  if (aircraft.length === 0) return [];
  const dtSec = (now - aircraftBaseMs) / 1000;
  const out = new Array(aircraft.length);
  for (let i = 0; i < aircraft.length; i++) {
    const a = aircraft[i];
    let lat = a.lat, lon = a.lon;
    if (!a.onGround && a.velocityMs != null && a.headingDeg != null) {
      const distM = a.velocityMs * dtSec;
      const h = a.headingDeg * Math.PI / 180;
      lat += (distM * Math.cos(h)) / 111000;
      lon += (distM * Math.sin(h)) / (111000 * Math.cos(a.lat * Math.PI / 180));
    }
    if (a.snapDeltaLat || a.snapDeltaLon) {
      const decay = Math.max(0, 1 - (now - aircraftBaseMs) / SNAP_SMOOTH_MS);
      lat += a.snapDeltaLat * decay;
      lon += a.snapDeltaLon * decay;
    }
    out[i] = a.snapDeltaLat || a.snapDeltaLon ? { ...a, lat, lon } : (lat === a.lat && lon === a.lon ? a : { ...a, lat, lon });
  }
  return out;
}

function maintainAircraftTrails(rendered) {
  const live = new Set();
  for (const a of rendered) {
    if (a.onGround) continue;
    live.add(a.id);
    let arr = aircraftTrails.get(a.id);
    if (!arr) { arr = []; aircraftTrails.set(a.id, arr); }
    arr.push([a.lat, a.lon]);
    if (arr.length > AIRCRAFT_TRAIL_MAX) arr.shift();
  }
  for (const id of aircraftTrails.keys()) {
    if (!live.has(id)) aircraftTrails.delete(id);
  }
}

async function pollFlights() {
  if (state.mode !== 'flights') return;
  const b = mapOverlay.map.getBounds();
  // Show loading only on the FIRST poll (when we have nothing yet) or on a
  // user-triggered refetch (debounced moveend). Background 10s polls stay
  // silent so the spinner doesn't flash every cycle.
  const isFirstLoad = aircraft.length === 0;
  if (isFirstLoad) showLoading('Finding aircraft');
  try {
    const next = await fetchAircraft({
      south: b.getSouth(), north: b.getNorth(),
      west: b.getWest(), east: b.getEast(),
    });
    // Compute the snap-smoothing delta for each aircraft we already had,
    // comparing our last predicted position to the freshly reported one.
    // The delta decays in deadReckonAircraft over ~1 sec.
    const now = Date.now();
    const predicted = deadReckonAircraft(now);
    const predById = new Map();
    for (const p of predicted) predById.set(p.id, p);
    for (const a of next) {
      const prior = predById.get(a.id);
      if (prior) {
        a.snapDeltaLat = prior.lat - a.lat;
        a.snapDeltaLon = prior.lon - a.lon;
      } else {
        a.snapDeltaLat = 0;
        a.snapDeltaLon = 0;
      }
    }
    aircraft = next;
    aircraftBaseMs = now;
    if (totalCountEl) totalCountEl.textContent = aircraft.length.toLocaleString();
    if (visCountEl) visCountEl.textContent = '—';
    if (loadDot) loadDot.className = 'dot live';
    hideLoading();
  } catch (e) {
    console.warn('flight fetch failed', e);
    if (loadDot) loadDot.className = 'dot err';
    if (isFirstLoad) showLoading('Couldn\'t reach flight feed');
  }
}

// Debounced re-poll on map pan/zoom so rapid movement doesn't fan out fetches.
let pollPanTimer = null;
function schedulePollFlights() {
  clearTimeout(pollPanTimer);
  pollPanTimer = setTimeout(pollFlights, 800);
}

function startFlightMode() {
  stopSatTicks();
  trailHistory.clear();
  aircraftTrails.clear();
  mapOverlay.clearBackground(); // sat dots shouldn't bleed into flight view
  if (npEl) npEl.hidden = true;
  pollFlights();
  flightPollHandle = setInterval(pollFlights, FLIGHT_POLL_MS);
  // Refetch when the user pans/zooms — debounced 800ms.
  mapOverlay.map.on('moveend', schedulePollFlights);
}

function stopFlightMode() {
  if (flightPollHandle) { clearInterval(flightPollHandle); flightPollHandle = null; }
  clearTimeout(pollPanTimer);
  mapOverlay.map.off('moveend', schedulePollFlights);
  hideLoading();
  aircraft = [];
  aircraftTrails.clear();
  flightSelectedId = null;
  flightSelectedRoute = null;
  startSatTicks();
  updateNextPassChip();
}

// --- 60 fps interpolated render ---
// Interpolate BETWEEN prev and latest worker frames (not extrapolate forward).
// Trade: ~1 sec display lag — invisible at sat speed/scale and well worth the
// completely smooth motion (no snap each second when a fresh frame lands).

function lerpLon(prev, latest, t) {
  let d = latest - prev;
  if (d > 180) d -= 360;
  else if (d < -180) d += 360;
  let r = prev + d * t;
  r = ((r + 540) % 360) - 180;
  return r;
}

function interpolatePositions(prevPositions, latestPositions, t) {
  const prevById = new Map();
  for (const p of prevPositions) prevById.set(p.id, p);
  return latestPositions.map((latest) => {
    const prev = prevById.get(latest.id);
    if (!prev) return latest;
    return {
      id: latest.id,
      lon: lerpLon(prev.lon, latest.lon, t),
      lat: prev.lat + (latest.lat - prev.lat) * t,
    };
  });
}

function interpolateVisibles(prevVis, latestVis, t) {
  const prevById = new Map();
  for (const v of prevVis) prevById.set(v.id, v);
  return latestVis.map((latest) => {
    const prev = prevById.get(latest.id);
    if (!prev) return latest;
    return {
      ...latest,
      lon: lerpLon(prev.lon, latest.lon, t),
      lat: prev.lat + (latest.lat - prev.lat) * t,
    };
  });
}

// Render with a fixed lag = the worker tick interval (1 s). This way the
// interpolation always has `prev` and `latest` bracketing the render time, so
// `t` smoothly traverses 0→1 over each tick. Without the lag, t would jump to
// 1.0 the moment a new frame arrived and freeze there until the next tick —
// which looked like "just updates position" with no in-between motion.
const RENDER_LAG_MS = 1000;

function renderFrame() {
  if (state.mode === 'flights') {
    const rendered = deadReckonAircraft(Date.now());
    maintainAircraftTrails(rendered);
    mapOverlay.renderFlights(rendered, aircraftTrails, flightSelectedId);
  } else if (latestFrame) {
    // Foreground only — visibles + trails + selected. Background dots are
    // painted on a separate canvas once per worker tick (see onWorkerPositions).
    let vis;
    if (prevFrame && latestFrame.timeMs > prevFrame.timeMs) {
      const renderTime = Date.now() - RENDER_LAG_MS;
      const dtMs = latestFrame.timeMs - prevFrame.timeMs;
      const t = Math.max(0, Math.min(1, (renderTime - prevFrame.timeMs) / dtMs));
      vis = interpolateVisibles(prevFrame.visibles, latestFrame.visibles, t);
    } else {
      vis = latestFrame.visibles;
    }
    maintainTrails(vis);
    mapOverlay.render(vis, trailHistory, selectedId);
  }
  requestAnimationFrame(renderFrame);
}
requestAnimationFrame(renderFrame);

// 1Hz UI tick for the flight list/detail (decoupled from the 30fps render).
setInterval(() => {
  if (state.mode !== 'flights') return;
  const rendered = deadReckonAircraft(Date.now());
  const sel = flightSelectedId
    ? rendered.find((a) => a.id === flightSelectedId) || null
    : null;
  if (sel) {
    setSheetSummary(`<strong>${(sel.callsign || sel.id).toUpperCase()}</strong> · ${Math.round((sel.altM || 0) / 30.48) * 100} ft`);
  } else {
    setSheetSummary(`In view · <strong>${rendered.length}</strong>`);
  }
  renderFlightList(rendered, flightSelectedId);
  renderFlightDetail(sel, flightSelectedRoute, () => setFlightSelection(null));
  if (clockEl) clockEl.textContent = fmtClock(new Date());
}, 1000);

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

async function setFlightSelection(id) {
  flightSelectedId = id;
  flightSelectedRoute = null;
  if (id) {
    const a = aircraft.find((x) => x.id === id);
    if (a) {
      mapOverlay.map.flyTo([a.lat, a.lon], Math.max(mapOverlay.map.getZoom(), 7), { duration: 0.6 });
      expandSheet();
      // Lazy route lookup (origin/dest) — no auth, on-demand only.
      if (a.callsign) {
        const route = await lookupRoute(a.callsign);
        if (flightSelectedId === id) flightSelectedRoute = route;
      }
    }
  } else {
    collapseSheet();
  }
}

mapOverlay.onClick((id) => {
  if (state.mode === 'flights') {
    setFlightSelection(id !== null && id !== flightSelectedId ? id : null);
  } else {
    setSelection(id !== null && id !== selectedId ? id : null);
  }
});

bindUi((id) => {
  if (state.mode === 'flights') {
    setFlightSelection(flightSelectedId === id ? null : id);
  } else {
    setSelection(selectedId === id ? null : id);
  }
});

// Mode toggle.
const modeToggleEl = document.getElementById('modeToggle');
function applyMode(mode) {
  state.mode = mode;
  localStorage.setItem(MODE_KEY, mode);
  if (modeToggleEl) {
    for (const btn of modeToggleEl.querySelectorAll('.mode-chip')) {
      btn.classList.toggle('active', btn.dataset.mode === mode);
    }
  }
  if (mode === 'flights') {
    startFlightMode();
  } else {
    stopFlightMode();
  }
}
if (modeToggleEl) {
  modeToggleEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.mode-chip[data-mode]');
    if (!btn) return;
    if (btn.dataset.mode === state.mode) return;
    applyMode(btn.dataset.mode);
  });
}
applyMode(state.mode);

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

const NIGHT_KEY = 'overhead.night';
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
