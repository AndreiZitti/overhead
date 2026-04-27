// Classic Web Worker — owns all SGP4 propagation off the main thread.
// Loaded by main.js via `new Worker(new URL('./worker.js', import.meta.url))`.
// We use importScripts (not import) so we can pull the satellite.js UMD vendor
// bundle directly; module workers can't use importScripts.

/* eslint-env worker */
/* global importScripts, self */

importScripts('/vendor/satellite.min.js');
// After this, `self.satellite` is the SGP4 library.

// ---------- Worker-scoped state ----------
let satrecs = [];        // [{id, name, satrec, isStation, inVisual}]
let observerGd = null;   // {longitude, latitude, height} in radians/km
let config = { minElev: 5, sunlitOnly: true };

// Two-tier propagation state.
let candidateIds = new Set();   // NORAD ids that might be above horizon
let lastCoarseAt = 0;            // ms (timeMs of last coarse pass)
const COARSE_INTERVAL_MS = 5000;

// ---------- Inlined astro helpers ----------
// Duplicated from src/astro.js intentionally: the worker is a separate module
// graph and importing across the classic/module boundary is more pain than
// the duplication is worth. Source-of-truth is docs/reference/orbitarium-reference.html.

// Sun ECI direction (unit vector). Standard low-precision formula, ~1' accurate.
// Reference lines 572-587.
function sunECI(date) {
  const jd = (date.getTime() / 86400000) + 2440587.5;
  const T = (jd - 2451545.0) / 36525;
  const L = ((280.46646 + 36000.76983 * T + 0.0003032 * T * T) % 360) * Math.PI / 180;
  const M = ((357.52911 + 35999.05029 * T - 0.0001537 * T * T) % 360) * Math.PI / 180;
  const C = (1.914602 - 0.004817 * T - 0.000014 * T * T) * Math.sin(M)
          + (0.019993 - 0.000101 * T) * Math.sin(2 * M)
          + 0.000289 * Math.sin(3 * M);
  const lambda = L + C * Math.PI / 180;
  const eps = (23.439291 - 0.0130042 * T) * Math.PI / 180;
  return {
    x: Math.cos(lambda),
    y: Math.cos(eps) * Math.sin(lambda),
    z: Math.sin(eps) * Math.sin(lambda)
  };
}

// Is the satellite (ECI position in km) sunlit? Earth-shadow cylinder test.
// Reference lines 619-627.
function isSunlit(satEci, sunDir) {
  const dot = satEci.x * sunDir.x + satEci.y * sunDir.y + satEci.z * sunDir.z;
  if (dot >= 0) return true; // on day side
  const px = satEci.x - dot * sunDir.x;
  const py = satEci.y - dot * sunDir.y;
  const pz = satEci.z - dot * sunDir.z;
  const perp = Math.sqrt(px * px + py * py + pz * pz);
  return perp > 6378.137; // Earth radius km — if perp distance > Re, sat clears the shadow
}

// Rough apparent magnitude estimate. Reference lines 673-678.
function estimateMag(s, rangeKm) {
  const m0 = s.isStation ? -1.0       // ISS/CSS — very large structures
           : s.inVisual  ? 2.0         // CelesTrak visual catalog — known bright
           : 4.5;                      // typical Starlink / generic LEO
  return m0 + 5 * Math.log10(rangeKm / 1000);
}

// Visibility tier. Reference lines 686-693.
function tierOf(s, sunlit, observerDark, mag) {
  if (!sunlit) return 'shadow';
  if (!observerDark) return 'daylight';
  if (s.isStation) return 'naked';
  if (mag <= 4.5) return 'naked';
  if (mag <= 7.5) return 'binocular';
  return 'telescope';
}

// Convert an ECI direction vector to topocentric look angles.
// Local helper (not in astro.js export list — duplication scope is just this worker).
function eciDirToAzEl(dir, obsGd, gmst) {
  const R = 1e9;
  const pos = { x: dir.x * R, y: dir.y * R, z: dir.z * R };
  const ecf = self.satellite.eciToEcf(pos, gmst);
  const look = self.satellite.ecfToLookAngles(obsGd, ecf);
  return { az: look.azimuth, el: look.elevation, range: look.rangeSat };
}

// Tier sort rank for the final ordering.
const TIER_RANK = { naked: 0, binocular: 1, telescope: 2, daylight: 3, shadow: 4 };

// ---------- Message handlers ----------

function handleInit({ tles, observer }) {
  satrecs = [];
  for (const tle of tles) {
    const satrec = self.satellite.twoline2satrec(tle.line1, tle.line2);
    if (satrec.error) continue;

    // Inclination pre-prune: a satellite at inclination i can only be visible
    // (above the horizon) from observers within roughly |lat| <= i + horizon-slop.
    // Skip for low-latitude observers where everything is potentially visible.
    const inclinationDeg = satrec.inclo * 180 / Math.PI;
    if (Math.abs(observer.lat) >= 5 && inclinationDeg + 5 < Math.abs(observer.lat)) {
      continue;
    }

    satrecs.push({
      id: tle.id,
      name: tle.name,
      satrec,
      isStation: tle.isStation,
      inVisual: tle.inVisual
    });
  }

  observerGd = {
    longitude: observer.lon * Math.PI / 180,
    latitude:  observer.lat * Math.PI / 180,
    height:    observer.alt
  };

  // Reset two-tier state so the first tick triggers a fresh coarse pass.
  candidateIds = new Set();
  lastCoarseAt = 0;

  self.postMessage({
    type: 'ready',
    total: tles.length,
    retained: satrecs.length,
    pruned: tles.length - satrecs.length
  });
}

function handleObserver({ lat, lon, alt }) {
  // Don't re-init satrecs — caller can resend `init` if their latitude
  // shifted enough to invalidate the inclination prune.
  observerGd = {
    longitude: lon * Math.PI / 180,
    latitude:  lat * Math.PI / 180,
    height:    alt
  };

  // Observer changed: candidate set is invalid, force a coarse pass next tick.
  candidateIds = new Set();
  lastCoarseAt = 0;
}

function handleConfig(payload) {
  if (typeof payload.minElev === 'number' && payload.minElev !== config.minElev) {
    config.minElev = payload.minElev;
    // Cutoff changed — invalidate candidate set so the next tick refreshes it.
    candidateIds = new Set();
    lastCoarseAt = 0;
  }
  if (typeof payload.sunlitOnly === 'boolean') config.sunlitOnly = payload.sunlitOnly;
}

// Coarse pass: cheap propagation across ALL satrecs to find candidates whose
// elevation is within (minElev - 5°). Returns a Set of NORAD ids.
function runCoarsePass(now, gmst) {
  const buffer = 5;
  const cutoff = (config.minElev - buffer) * Math.PI / 180;
  const out = new Set();
  for (const sat of satrecs) {
    const pv = self.satellite.propagate(sat.satrec, now);
    if (!pv.position || isNaN(pv.position.x)) continue;
    const ecf = self.satellite.eciToEcf(pv.position, gmst);
    const look = self.satellite.ecfToLookAngles(observerGd, ecf);
    if (look.elevation > cutoff) out.add(sat.id);
  }
  return out;
}

/**
 * Two-tier propagation:
 *   - Coarse pass every 5s: propagate ALL satrecs, compute elevation only,
 *     mark those with el > (minElev - 5°) as candidates. ~200ms for 17k sats.
 *   - Fine pass every 1s: propagate candidates only, full visibility math.
 *     ~30ms for ~few hundred candidates.
 * This keeps the per-tick cost dominated by the cheap coarse pass cadence
 * rather than the expensive fine pass running over everything.
 */
function handleTick({ timeMs }) {
  if (!observerGd || satrecs.length === 0) {
    self.postMessage({
      type: 'positions',
      timeMs: timeMs,
      items: [],
      counts: { visible: 0, naked: 0, binocular: 0, telescope: 0, daylight: 0, shadow: 0 }
    });
    return;
  }

  const now = new Date(timeMs);
  const gmst = self.satellite.gstime(now);

  // Coarse pass — recompute candidate set every COARSE_INTERVAL_MS or if empty.
  if (timeMs - lastCoarseAt > COARSE_INTERVAL_MS || candidateIds.size === 0) {
    candidateIds = runCoarsePass(now, gmst);
    lastCoarseAt = timeMs;
  }

  const sunDir = sunECI(now);

  // Observer darkness from the sun's altitude.
  const sunLook = eciDirToAzEl(sunDir, observerGd, gmst);
  const sunAltDeg = sunLook.el * 180 / Math.PI;
  const observerDark = sunAltDeg < -6;

  const items = [];
  const tierCounts = { naked: 0, binocular: 0, telescope: 0, daylight: 0, shadow: 0 };

  for (const sat of satrecs) {
    if (!candidateIds.has(sat.id)) continue;
    const pv = self.satellite.propagate(sat.satrec, now);
    if (!pv.position || isNaN(pv.position.x)) continue;

    const ecf = self.satellite.eciToEcf(pv.position, gmst);
    const look = self.satellite.ecfToLookAngles(observerGd, ecf);
    const elDeg = look.elevation * 180 / Math.PI;
    if (elDeg < config.minElev) continue;

    const sunlit = isSunlit(pv.position, sunDir);
    const mag = estimateMag(sat, look.rangeSat);
    const tier = tierOf(sat, sunlit, observerDark, mag);

    // Tier counts include shadow so the status bar reflects total tier presence,
    // even when the user has hidden shadow sats. Matches reference behavior.
    tierCounts[tier]++;

    if (config.sunlitOnly && tier === 'shadow') continue;

    const gd = self.satellite.eciToGeodetic(pv.position, gmst);
    const eciSpeed = Math.sqrt(
      pv.velocity.x * pv.velocity.x +
      pv.velocity.y * pv.velocity.y +
      pv.velocity.z * pv.velocity.z
    );

    items.push({
      id: sat.id,
      name: sat.name,
      isStation: sat.isStation,
      az: look.azimuth,
      el: look.elevation,
      elDeg,
      azDeg: look.azimuth * 180 / Math.PI,
      range: look.rangeSat,
      altKm: gd.height,
      sunlit,
      mag,
      tier,
      eciSpeed
    });
  }

  // Sort: stations first, then by tier rank, then by magnitude ascending.
  items.sort((a, b) => {
    if (a.isStation !== b.isStation) return a.isStation ? -1 : 1;
    const tr = TIER_RANK[a.tier] - TIER_RANK[b.tier];
    if (tr !== 0) return tr;
    return a.mag - b.mag;
  });

  const visibleCount = items.length;
  const capped = items.length > 1500 ? items.slice(0, 1500) : items;

  self.postMessage({
    type: 'positions',
    timeMs,
    items: capped,
    counts: { visible: visibleCount, ...tierCounts }
  });
}

self.onmessage = (e) => {
  const msg = e.data;
  switch (msg.type) {
    case 'init':     return handleInit(msg);
    case 'observer': return handleObserver(msg);
    case 'config':   return handleConfig(msg);
    case 'tick':     return handleTick(msg);
    default:
      // Unknown message types are ignored — main thread may add new ones.
      break;
  }
};
