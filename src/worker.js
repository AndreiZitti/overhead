/* eslint-env worker */
/* global self, importScripts, satellite */

// Classic worker — uses importScripts so satellite.js attaches to `self`.
// Module workers can't use importScripts; module form would also need a
// satellite.js ESM build, which the vendor file isn't.

importScripts('/vendor/satellite.min.js');

// --- Worker-scoped state ---

let satrecs = [];          // [{id, name, satrec, isStation, inVisual}]
let stationIds = new Set();
let observerGd = null;     // {longitude, latitude, height} radians/km
let config = { minElev: 5, sunlitOnly: true };

// Trails: recomputed every TRAIL_INTERVAL_MS, ±30 min window, 1 sample/min.
const TRAIL_INTERVAL_MS = 15_000;
const TRAIL_HALF_WINDOW_MIN = 30;
const TRAIL_STEP_MIN = 1;
let selectedTrailId = null;
let lastTrailAt = 0;
let trailCache = {};

// Next-pass predictions: scan forward up to 24 h, find next time each station
// rises above PASS_MIN_ELEV. Recomputed every PASS_INTERVAL_MS.
const PASS_LOOKAHEAD_MS = 24 * 60 * 60 * 1000;
const PASS_COARSE_STEP_MS = 60_000; // 1-min coarse step
const PASS_MIN_ELEV = 10;            // degrees — comfortably visible
let lastPassesAt = 0;
let passesCache = [];                // sorted by riseTimeMs ascending
const PASS_INTERVAL_MS = 5 * 60_000;

// --- Astronomy helpers (inlined; can't import from astro.js in classic worker) ---

function sunECI(date) {
  const jd = date.getTime() / 86400000 + 2440587.5;
  const T = (jd - 2451545.0) / 36525;
  const L = (((280.46646 + 36000.76983 * T + 0.0003032 * T * T) % 360) * Math.PI) / 180;
  const M = (((357.52911 + 35999.05029 * T - 0.0001537 * T * T) % 360) * Math.PI) / 180;
  const C =
    (1.914602 - 0.004817 * T - 0.000014 * T * T) * Math.sin(M) +
    (0.019993 - 0.000101 * T) * Math.sin(2 * M) +
    0.000289 * Math.sin(3 * M);
  const lambda = L + (C * Math.PI) / 180;
  const eps = ((23.439291 - 0.0130042 * T) * Math.PI) / 180;
  return {
    x: Math.cos(lambda),
    y: Math.cos(eps) * Math.sin(lambda),
    z: Math.sin(eps) * Math.sin(lambda),
  };
}

function isSunlit(satEci, sunDir) {
  const dot = satEci.x * sunDir.x + satEci.y * sunDir.y + satEci.z * sunDir.z;
  if (dot >= 0) return true;
  const px = satEci.x - dot * sunDir.x;
  const py = satEci.y - dot * sunDir.y;
  const pz = satEci.z - dot * sunDir.z;
  const perp = Math.sqrt(px * px + py * py + pz * pz);
  return perp > 6378.137;
}

function estimateMag(sat, rangeKm) {
  const m0 = sat.isStation ? -1.0 : sat.inVisual ? 2.0 : 4.5;
  return m0 + 5 * Math.log10(rangeKm / 1000);
}

function tierOf(sat, sunlit, observerDark, mag) {
  if (!sunlit) return 'shadow';
  if (!observerDark) return 'daylight';
  if (sat.isStation) return 'naked';
  if (mag <= 4.5) return 'naked';
  if (mag <= 7.5) return 'binocular';
  return 'telescope';
}

function eciDirToAzEl(dir, obsGd, gmst) {
  const R = 1e9;
  const pos = { x: dir.x * R, y: dir.y * R, z: dir.z * R };
  const ecf = self.satellite.eciToEcf(pos, gmst);
  const look = self.satellite.ecfToLookAngles(obsGd, ecf);
  return { az: look.azimuth, el: look.elevation, range: look.rangeSat };
}

const TIER_RANK = { naked: 0, binocular: 1, telescope: 2, daylight: 3, shadow: 4 };
const RAD2DEG = 180 / Math.PI;

// --- Init / observer / config ---

function handleInit({ tles, observer }) {
  satrecs = [];
  stationIds = new Set();

  // No inclination prune in v2 — the map shows ALL sats globally, not just
  // those that could be seen from the observer.
  for (const tle of tles) {
    const satrec = self.satellite.twoline2satrec(tle.line1, tle.line2);
    if (satrec.error) continue;
    satrecs.push({
      id: tle.id,
      name: tle.name,
      satrec,
      isStation: !!tle.isStation,
      inVisual: !!tle.inVisual,
    });
    if (tle.isStation) stationIds.add(tle.id);
  }

  observerGd = {
    longitude: (observer.lon * Math.PI) / 180,
    latitude: (observer.lat * Math.PI) / 180,
    height: observer.alt,
  };

  trailCache = {};
  lastTrailAt = 0;
  passesCache = [];
  lastPassesAt = 0;

  self.postMessage({ type: 'ready', total: tles.length, retained: satrecs.length });
}

function handleObserver({ lat, lon, alt }) {
  observerGd = {
    longitude: (lon * Math.PI) / 180,
    latitude: (lat * Math.PI) / 180,
    height: alt,
  };
  trailCache = {};
  lastTrailAt = 0;
  passesCache = [];
  lastPassesAt = 0;
}

function handleConfig(payload) {
  if (typeof payload.minElev === 'number') config.minElev = payload.minElev;
  if (typeof payload.sunlitOnly === 'boolean') config.sunlitOnly = payload.sunlitOnly;
}

// --- Trail computation ---

function computeTrail(satrec, nowMs) {
  const points = [];
  const stepMs = TRAIL_STEP_MIN * 60_000;
  const start = nowMs - TRAIL_HALF_WINDOW_MIN * 60_000;
  const end = nowMs + TRAIL_HALF_WINDOW_MIN * 60_000;
  for (let t = start; t <= end; t += stepMs) {
    const date = new Date(t);
    const pv = self.satellite.propagate(satrec, date);
    if (!pv.position || isNaN(pv.position.x)) continue;
    const gmst = self.satellite.gstime(date);
    const gd = self.satellite.eciToGeodetic(pv.position, gmst);
    const lon = ((gd.longitude * RAD2DEG + 540) % 360) - 180; // normalize to [-180, 180]
    const lat = gd.latitude * RAD2DEG;
    points.push([lon, lat]);
  }
  return points;
}

// --- Next-pass prediction ---

function lookAngleAt(satrec, timeMs) {
  const date = new Date(timeMs);
  const pv = self.satellite.propagate(satrec, date);
  if (!pv.position || isNaN(pv.position.x)) return null;
  const gmst = self.satellite.gstime(date);
  const ecf = self.satellite.eciToEcf(pv.position, gmst);
  const look = self.satellite.ecfToLookAngles(observerGd, ecf);
  return { elDeg: look.elevation * RAD2DEG, azDeg: look.azimuth * RAD2DEG };
}

function findNextRise(satrec, startMs) {
  // Coarse scan: find first 1-min sample where elevation crosses up through cutoff.
  let prev = lookAngleAt(satrec, startMs);
  if (!prev) return null;
  for (let t = startMs + PASS_COARSE_STEP_MS; t < startMs + PASS_LOOKAHEAD_MS; t += PASS_COARSE_STEP_MS) {
    const cur = lookAngleAt(satrec, t);
    if (!cur) { prev = null; continue; }
    if (prev && prev.elDeg < PASS_MIN_ELEV && cur.elDeg >= PASS_MIN_ELEV) {
      // Refine to ~5-second resolution via binary search.
      let lo = t - PASS_COARSE_STEP_MS, hi = t;
      while (hi - lo > 5_000) {
        const mid = (lo + hi) / 2;
        const m = lookAngleAt(satrec, mid);
        if (!m || m.elDeg < PASS_MIN_ELEV) lo = mid;
        else hi = mid;
      }
      const at = lookAngleAt(satrec, hi);
      if (!at) return null;
      return { timeMs: hi, azDeg: at.azDeg };
    }
    prev = cur;
  }
  return null;
}

function refreshPasses(nowMs) {
  if (!observerGd) return;
  const passes = [];
  for (const sat of satrecs) {
    if (!sat.isStation) continue;
    const next = findNextRise(sat.satrec, nowMs);
    if (next) {
      passes.push({
        id: sat.id,
        name: sat.name,
        riseTimeMs: next.timeMs,
        riseAzDeg: next.azDeg,
      });
    }
  }
  passes.sort((a, b) => a.riseTimeMs - b.riseTimeMs);
  passesCache = passes;
  lastPassesAt = nowMs;
  self.postMessage({ type: 'passes', passes: passesCache });
}

// --- Trails ---

function refreshTrails(nowMs, eligibleIds) {
  const next = {};
  // Index satrecs by id for O(1) lookup; eligible set is small (~10-50).
  const byId = new Map();
  for (const s of satrecs) byId.set(s.id, s);
  for (const id of eligibleIds) {
    const sat = byId.get(id);
    if (!sat) continue;
    next[id] = computeTrail(sat.satrec, nowMs);
  }
  // Always include selected trail even if not in the eligible set.
  if (selectedTrailId != null && !next[selectedTrailId]) {
    const sat = byId.get(selectedTrailId);
    if (sat) next[selectedTrailId] = computeTrail(sat.satrec, nowMs);
  }
  trailCache = next;
  lastTrailAt = nowMs;
}

// --- Tick (single pass over all satrecs) ---

function handleTick({ timeMs }) {
  if (!observerGd || satrecs.length === 0) {
    self.postMessage({
      type: 'positions',
      timeMs,
      allPositions: [],
      visibles: [],
      counts: { total: 0, visible: 0, naked: 0, binocular: 0, telescope: 0, daylight: 0, shadow: 0 },
    });
    return;
  }

  const now = new Date(timeMs);
  const gmst = self.satellite.gstime(now);
  const sunDir = sunECI(now);

  // Observer darkness (for tier classification).
  const sunLook = eciDirToAzEl(sunDir, observerGd, gmst);
  const sunAltDeg = sunLook.el * RAD2DEG;
  const observerDark = sunAltDeg < -6;

  const allPositions = [];
  const visibles = [];
  const tierCounts = { naked: 0, binocular: 0, telescope: 0, daylight: 0, shadow: 0 };

  for (const sat of satrecs) {
    const pv = self.satellite.propagate(sat.satrec, now);
    if (!pv.position || isNaN(pv.position.x)) continue;

    const gd = self.satellite.eciToGeodetic(pv.position, gmst);
    const lon = ((gd.longitude * RAD2DEG + 540) % 360) - 180;
    const lat = gd.latitude * RAD2DEG;
    const altKm = gd.height;

    // Always: ground point for the map.
    allPositions.push({ id: sat.id, lon, lat });

    // Visibility: only if above the observer's horizon.
    const ecf = self.satellite.eciToEcf(pv.position, gmst);
    const look = self.satellite.ecfToLookAngles(observerGd, ecf);
    const elDeg = look.elevation * RAD2DEG;
    if (elDeg < config.minElev) continue;

    const sunlit = isSunlit(pv.position, sunDir);
    const mag = estimateMag(sat, look.rangeSat);
    const tier = tierOf(sat, sunlit, observerDark, mag);
    tierCounts[tier]++;
    if (config.sunlitOnly && tier === 'shadow') continue;

    const eciSpeed = Math.sqrt(
      pv.velocity.x * pv.velocity.x +
      pv.velocity.y * pv.velocity.y +
      pv.velocity.z * pv.velocity.z
    );

    visibles.push({
      id: sat.id,
      name: sat.name,
      isStation: sat.isStation,
      lon,
      lat,
      altKm,
      az: look.azimuth,
      el: look.elevation,
      elDeg,
      azDeg: look.azimuth * RAD2DEG,
      range: look.rangeSat,
      sunlit,
      mag,
      tier,
      eciSpeed,
    });
  }

  // Sort visibles for the side panel: stations → tier → magnitude.
  visibles.sort((a, b) => {
    if (a.isStation !== b.isStation) return a.isStation ? -1 : 1;
    const tr = TIER_RANK[a.tier] - TIER_RANK[b.tier];
    if (tr !== 0) return tr;
    return a.mag - b.mag;
  });

  // Trails: every station + every naked-eye visible. Selected always included.
  if (timeMs - lastTrailAt > TRAIL_INTERVAL_MS || lastTrailAt === 0) {
    const eligible = new Set(stationIds);
    for (const v of visibles) if (v.tier === 'naked') eligible.add(v.id);
    refreshTrails(timeMs, eligible);
  }

  // Next-pass predictions: refresh every 5 min.
  if (timeMs - lastPassesAt > PASS_INTERVAL_MS || lastPassesAt === 0) {
    refreshPasses(timeMs);
  }

  self.postMessage({
    type: 'positions',
    timeMs,
    allPositions,
    visibles,
    counts: {
      total: satrecs.length,
      visible: visibles.length,
      ...tierCounts,
    },
    trails: trailCache,
  });
}

function handleSelect({ id }) {
  selectedTrailId = id;
  // Force trail refresh on next tick (the selection may have changed mid-window).
  lastTrailAt = 0;
}

self.onmessage = (e) => {
  const msg = e.data;
  switch (msg.type) {
    case 'init':     return handleInit(msg);
    case 'observer': return handleObserver(msg);
    case 'config':   return handleConfig(msg);
    case 'select':   return handleSelect(msg);
    case 'tick':     return handleTick(msg);
  }
};
