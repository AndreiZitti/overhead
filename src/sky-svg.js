// SVG static layer for the sky polar plot. Presentation-only: no observer or
// satellite data is fetched here — callers pass in az/el values.
// Each updater performs a single innerHTML write into its target <g> (one
// write per frame, per the v1 perf rule). Ported from
// docs/reference/orbitarium-reference.html.

/** Geometry of the sky plot — center & radius in SVG user units. */
export const PLOT = { cx: 200, cy: 200, r: 175 };

/**
 * Convert (azimuth, elevation) in radians to [x, y] in SVG coords.
 * 0 az = north (top), 90 az = east (right). Reference lines 631-637.
 */
export function azElToXY(azRad, elRad){
  const r = PLOT.r * (1 - elRad / (Math.PI/2));
  const x = PLOT.cx + r * Math.sin(azRad);
  const y = PLOT.cy - r * Math.cos(azRad);
  return [x, y];
}

/**
 * Draw the static polar grid (rings, cardinal lines, axis labels, zenith dot)
 * into the <g id="grid"> child of `svg`. Called once on boot.
 * Reference lines 639-659.
 */
export function drawGrid(svg){
  const g = svg.querySelector('#grid');
  let s = '';
  // Elevation rings (every 30°)
  for (const el of [0, 30, 60]){
    const r = PLOT.r * (1 - el/90);
    s += `<circle class="${el===0?'horizon':'sky-grid'}" cx="${PLOT.cx}" cy="${PLOT.cy}" r="${r}" />`;
    if (el>0) s += `<text class="ring-label" x="${PLOT.cx+3}" y="${PLOT.cy - r + 9}">${el}°</text>`;
  }
  // Cardinal lines
  s += `<line class="sky-grid-soft" x1="${PLOT.cx}" y1="${PLOT.cy-PLOT.r}" x2="${PLOT.cx}" y2="${PLOT.cy+PLOT.r}" />`;
  s += `<line class="sky-grid-soft" x1="${PLOT.cx-PLOT.r}" y1="${PLOT.cy}" x2="${PLOT.cx+PLOT.r}" y2="${PLOT.cy}" />`;
  // Cardinal labels
  s += `<text class="axis-label" x="${PLOT.cx}" y="${PLOT.cy-PLOT.r-10}">N</text>`;
  s += `<text class="axis-label" x="${PLOT.cx}" y="${PLOT.cy+PLOT.r+12}">S</text>`;
  s += `<text class="axis-label" x="${PLOT.cx+PLOT.r+10}" y="${PLOT.cy}">E</text>`;
  s += `<text class="axis-label" x="${PLOT.cx-PLOT.r-10}" y="${PLOT.cy}">W</text>`;
  // Zenith dot
  s += `<circle cx="${PLOT.cx}" cy="${PLOT.cy}" r="1.2" fill="var(--ink-2)" />`;
  g.innerHTML = s;
}

/**
 * Update sun + moon markers in <g id="celestial">.
 * sunLook/moonLook = {az, el} radians from astro.eciDirToAzEl.
 * Hide marker if el < -3°. Pin to horizon if -3° < el < 0°.
 * Reference lines 791-801.
 */
export function updateCelestial(svg, sunLook, moonLook){
  const cutoff = -3 * Math.PI / 180;
  let cel = '';
  if (sunLook.el > cutoff) {
    const [sx, sy] = azElToXY(sunLook.az, Math.max(0, sunLook.el));
    cel += `<circle class="sun-marker" cx="${sx}" cy="${sy}" r="6" />`;
  }
  if (moonLook.el > cutoff) {
    const [mx, my] = azElToXY(moonLook.az, Math.max(0, moonLook.el));
    cel += `<circle class="moon-marker" cx="${mx}" cy="${my}" r="5" />`;
  }
  svg.querySelector('#celestial').innerHTML = cel;
}

/**
 * Update text labels for visible sats in <g id="labels">.
 * items: array of {id, name, az, el, isStation, tier}.
 * selectedId: number or null.
 * Label rules: stations always; naked-tier capped at 8 total non-station;
 * selected always. Reference lines 778-789.
 */
export function updateLabels(svg, items, selectedId){
  let labels = '';
  let labeled = 0;
  for (const v of items){
    const isLabelable = v.isStation || v.tier === 'naked' || v.id === selectedId;
    if (!isLabelable) continue;
    if (labeled >= 8 && !v.isStation && v.id !== selectedId) continue;
    const [x, y] = azElToXY(v.az, v.el);
    const short = v.name.replace(/\s*\(.*?\)\s*/g,'').slice(0, 14);
    labels += `<text class="sat-label" x="${x+6}" y="${y+3}">${short}</text>`;
    labeled++;
  }
  svg.querySelector('#labels').innerHTML = labels;
}
