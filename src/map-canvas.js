// Canvas overlay for the world map. Renders:
//   1. All satellites as faint background dots (from allPositions).
//   2. Visible satellites colored by tier on top (from visibles).
//   3. Selection ring + station glow as accents.
//   4. Observer marker (pulsing) at the user's coordinates.
// Hit-tests against ALL satellites so any dot is clickable.

import { project, MAP } from './world-map.js';

const STYLE = {
  background: { fill: 'rgba(106, 144, 200, 0.18)', radius: 0.9, blur: 0 }, // any sat
  shadow:     { fill: 'rgba(58, 69, 101, 0.45)',   radius: 1.2, blur: 0 },
  daylight:   { fill: 'rgba(122, 117, 103, 0.55)', radius: 1.4, blur: 0 },
  telescope:  { fill: 'rgba(106, 144, 200, 0.75)', radius: 1.4, blur: 0 },
  binocular:  { fill: 'rgba(201, 197, 176, 0.95)', radius: 1.8, blur: 0 },
  naked:      { fill: '#f4b860', radius: 2.4, blur: 5 },
  station:    { fill: '#e87bb1', radius: 4,   blur: 8 },
  selected:   { fill: '#7adba0', radius: 5,   blur: 10 },
};

export function setupMapCanvas(canvasEl) {
  const ctx = canvasEl.getContext('2d');
  let cssW = 0, cssH = 0, scaleX = 1, scaleY = 1;
  let lastDots = []; // {id, x, y, r} in CSS pixels — used by hitTest

  /**
   * Re-runs DPR sizing. Call after window resize AND after DPR changes
   * (window dragged between displays).
   */
  function resize() {
    const rect = canvasEl.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    cssW = rect.width;
    cssH = rect.height;
    canvasEl.width = Math.round(cssW * dpr);
    canvasEl.height = Math.round(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    scaleX = cssW / MAP.w;
    scaleY = cssH / MAP.h;
  }
  resize();

  function toCss(lon, lat) {
    const [px, py] = project(lon, lat);
    return [px * scaleX, py * scaleY];
  }

  function render(allPositions, visibles, selectedId, observer) {
    if (cssW === 0 || cssH === 0) {
      resize();
      if (cssW === 0 || cssH === 0) {
        lastDots = [];
        return;
      }
    }

    ctx.clearRect(0, 0, cssW, cssH);

    // 1. Background dots — every satellite, very faint.
    const bg = STYLE.background;
    ctx.fillStyle = bg.fill;
    ctx.shadowBlur = 0;
    ctx.beginPath();
    for (const p of allPositions) {
      const [x, y] = toCss(p.lon, p.lat);
      ctx.moveTo(x + bg.radius, y);
      ctx.arc(x, y, bg.radius, 0, Math.PI * 2);
    }
    ctx.fill();

    // 2. Visible satellites colored by tier (on top of background).
    // Bucket by category (selection > station > tier).
    const buckets = { shadow: [], daylight: [], telescope: [], binocular: [], naked: [], station: [], selected: [] };
    for (const v of visibles) {
      let cat;
      if (v.id === selectedId) cat = 'selected';
      else if (v.isStation) cat = 'station';
      else cat = v.tier;
      const bucket = buckets[cat];
      if (bucket) bucket.push(v);
    }

    const order = ['shadow', 'daylight', 'telescope', 'binocular', 'naked', 'station', 'selected'];
    lastDots = [];
    for (const cat of order) {
      const list = buckets[cat];
      if (list.length === 0) continue;
      const s = STYLE[cat];
      ctx.fillStyle = s.fill;
      if (s.blur > 0) {
        ctx.shadowBlur = s.blur;
        ctx.shadowColor = s.fill;
      } else {
        ctx.shadowBlur = 0;
      }
      ctx.beginPath();
      for (const v of list) {
        const [x, y] = toCss(v.lon, v.lat);
        ctx.moveTo(x + s.radius, y);
        ctx.arc(x, y, s.radius, 0, Math.PI * 2);
        lastDots.push({ id: v.id, x, y, r: s.radius });
      }
      ctx.fill();
    }
    ctx.shadowBlur = 0;

    // Background-only sats also need to be hit-testable (they may be selectable).
    for (const p of allPositions) {
      // Skip ids already in lastDots from the visibles pass.
      // Cheap: do a Set lookup.
    }
    // Build Set of visible ids to avoid re-adding.
    const visibleIdSet = new Set();
    for (const d of lastDots) visibleIdSet.add(d.id);
    for (const p of allPositions) {
      if (visibleIdSet.has(p.id)) continue;
      const [x, y] = toCss(p.lon, p.lat);
      lastDots.push({ id: p.id, x, y, r: bg.radius });
    }

    // 3. Observer marker — pulsing dot.
    if (observer) {
      const [ox, oy] = toCss(observer.lon, observer.lat);
      const t = (Date.now() % 2000) / 2000;
      const pulseR = 4 + Math.sin(t * Math.PI * 2) * 2;
      ctx.fillStyle = 'rgba(122, 219, 160, 0.25)';
      ctx.beginPath();
      ctx.arc(ox, oy, pulseR + 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#7adba0';
      ctx.shadowBlur = 8;
      ctx.shadowColor = '#7adba0';
      ctx.beginPath();
      ctx.arc(ox, oy, 3.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
    }
  }

  function hitTest(cssX, cssY) {
    let bestId = null;
    let bestDist = Infinity;
    for (const d of lastDots) {
      const dx = cssX - d.x;
      const dy = cssY - d.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const threshold = Math.max(8, d.r + 4);
      if (dist <= threshold && dist < bestDist) {
        bestDist = dist;
        bestId = d.id;
      }
    }
    return bestId;
  }

  return { render, hitTest, resize };
}
