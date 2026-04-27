// Canvas overlay for satellite dot rendering. Pure presentation: no events,
// no DOM access beyond the passed canvas, no state outside the closure.
// Batches dots by tier so each frame issues ~7 fills regardless of dot count.

import { azElToXY } from './sky-svg.js';

// Render order: faintest first so brightest categories sit on top.
// Tier colors mirror the .sat-* classes in styles.css (see :root --amber, --magenta, --emerald).
const CATEGORIES = ['shadow', 'daylight', 'telescope', 'binocular', 'naked', 'station', 'selected'];

const STYLE = {
  shadow:    { fill: 'rgba(58,69,101,0.35)',   r: 1.4, blur: 0 },
  daylight:  { fill: 'rgba(122,117,103,0.45)', r: 2.0, blur: 0 },
  telescope: { fill: 'rgba(106,144,200,0.55)', r: 1.8, blur: 0 },
  binocular: { fill: 'rgba(201,197,176,0.85)', r: 2.5, blur: 0 },
  naked:     { fill: '#f4b860',                r: 3.5, blur: 6 },
  station:   { fill: '#e87bb1',                r: 5,   blur: 8 },
  selected:  { fill: '#7adba0',                r: 5,   blur: 10 },
};

/**
 * Set up a canvas overlay for rendering satellite dots.
 *
 * @param {HTMLCanvasElement} canvasEl  the <canvas id="sky-canvas">
 * @returns {{
 *   render: (items: Array, selectedId: number|null) => void,
 *   hitTest: (cssX: number, cssY: number) => number|null,
 *   resize: () => void
 * }}
 */
export function setupSkyCanvas(canvasEl){
  const ctx = canvasEl.getContext('2d');
  let cssW = 0;
  let cssH = 0;
  let scale = 1;
  // CSS-pixel positions of the last render, used by hitTest.
  const lastDots = [];

  /**
   * Re-runs DPR-aware sizing. Call after window resize AND after DPR changes
   * (window dragged between 1x and 2x displays). DPR changes can be observed
   * via `window.matchMedia(`(resolution: ${devicePixelRatio}dppx)`).addEventListener('change', ...)`.
   */
  function resize(){
    const dpr = window.devicePixelRatio || 1;
    const rect = canvasEl.getBoundingClientRect();
    cssW = rect.width;
    cssH = rect.height;
    canvasEl.width = Math.round(cssW * dpr);
    canvasEl.height = Math.round(cssH * dpr);
    // After setTransform, all draw calls operate in CSS pixels.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Plot coords live in a 400x400 logical viewBox; map to CSS pixels.
    scale = cssW / 400;
  }

  // Initial sizing.
  resize();

  function categoryFor(item, selectedId){
    if (item.id === selectedId) return 'selected';
    if (item.isStation) return 'station';
    return item.tier; // shadow | daylight | telescope | binocular | naked
  }

  function render(items, selectedId){
    if (cssW === 0 || cssH === 0) {
      // Layout not ready — try to (re)size. If still zero, bail rather than corrupt lastDots.
      resize();
      if (cssW === 0 || cssH === 0) {
        lastDots.length = 0;
        return;
      }
    }
    ctx.clearRect(0, 0, cssW, cssH);
    lastDots.length = 0;

    // Bucket items by category.
    const buckets = {
      shadow: [], daylight: [], telescope: [], binocular: [],
      naked: [], station: [], selected: [],
    };
    for (let i = 0; i < items.length; i++){
      const v = items[i];
      const cat = categoryFor(v, selectedId);
      const bucket = buckets[cat];
      if (!bucket) continue; // unknown tier — skip rather than crash
      const [px, py] = azElToXY(v.az, v.el);
      const cssX = px * scale;
      const cssY = py * scale;
      bucket.push({ id: v.id, x: cssX, y: cssY });
    }

    // Draw each category as a single batched path.
    for (const cat of CATEGORIES){
      const list = buckets[cat];
      if (list.length === 0) continue;
      const style = STYLE[cat];
      const r = style.r;
      ctx.fillStyle = style.fill;
      if (style.blur > 0){
        ctx.shadowBlur = style.blur;
        ctx.shadowColor = style.fill;
      } else {
        ctx.shadowBlur = 0;
      }
      ctx.beginPath();
      for (let i = 0; i < list.length; i++){
        const d = list[i];
        ctx.moveTo(d.x + r, d.y);
        ctx.arc(d.x, d.y, r, 0, 2 * Math.PI);
        lastDots.push({ id: d.id, x: d.x, y: d.y, r });
      }
      ctx.fill();
    }
    // Reset shadow so unrelated draws on this ctx (none expected) aren't tinted.
    ctx.shadowBlur = 0;
  }

  function hitTest(cssX, cssY){
    let bestId = null;
    let bestDist = Infinity;
    for (let i = 0; i < lastDots.length; i++){
      const d = lastDots[i];
      const dx = d.x - cssX;
      const dy = d.y - cssY;
      const dist = Math.sqrt(dx*dx + dy*dy);
      const threshold = Math.max(8, d.r + 4);
      if (dist <= threshold && dist < bestDist){
        bestDist = dist;
        bestId = d.id;
      }
    }
    return bestId;
  }

  return { render, hitTest, resize };
}
