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

// Trails are recomputed at TRAIL_INTERVAL_MS, cached, posted with the next tick.
const TRAIL_INTERVAL_MS = 15_000;
const TRAIL_HALF_WINDOW_MIN = 30; // minutes before/after now
const TRAIL_STEP_MIN = 1;          // 1 sample/min → 61 points per trail
let lastTrailAt = 0;
let trailCache = {};               // {[id]: [[lon, lat], ...]}

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

function refreshTrails(nowMs, trailEligibleIds) {
  const next = {};
  for (const id of trailEligibleIds) {
    // Find the satrec by id (linear; trail-eligible set is tiny).
    const sat = satrecs.find((s) => s.id === id);
    if (!sat) continue;
    next[id] = computeTrail(sat.satrec, nowMs);
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

  // Refresh trails periodically. Eligible = stations OR naked-eye visibles.
  if (timeMs - lastTrailAt > TRAIL_INTERVAL_MS || lastTrailAt === 0) {
    const trailIds = new Set(stationIds);
    for (const v of visibles) if (v.tier === 'naked') trailIds.add(v.id);
    refreshTrails(timeMs, trailIds);
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

self.onmessage = (e) => {
  const msg = e.data;
  switch (msg.type) {
    case 'init':     return handleInit(msg);
    case 'observer': return handleObserver(msg);
    case 'config':   return handleConfig(msg);
    case 'tick':     return handleTick(msg);
  }
};
