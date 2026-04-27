// SVG polyline trails for stations + naked-eye visibles. Splits at the
// international dateline so polylines don't draw a horizontal slash across
// the map when a satellite wraps from +180° to -180°.

import { project } from './world-map.js';

/**
 * Render trails into <g id="trails">.
 * trailsById: { [id: number]: [[lon, lat], ...] }
 * stationIdSet: Set<number> for trail-station styling
 */
export function renderTrails(svg, trailsById, stationIdSet, selectedId) {
  const g = svg.querySelector('#trails');
  if (!g) return;

  const parts = [];
  for (const [idStr, points] of Object.entries(trailsById)) {
    const id = +idStr;
    const segments = splitAtDateline(points);
    const cls = id === selectedId
      ? 'trail trail-selected'
      : stationIdSet.has(id)
      ? 'trail trail-station'
      : 'trail';
    for (const seg of segments) {
      if (seg.length < 2) continue;
      const pts = seg.map(([lon, lat]) => {
        const [x, y] = project(lon, lat);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      }).join(' ');
      parts.push(`<polyline class="${cls}" points="${pts}" />`);
    }
  }
  g.innerHTML = parts.join('');
}

function splitAtDateline(points) {
  if (points.length === 0) return [];
  const segments = [[]];
  segments[0].push(points[0]);
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const cur = points[i];
    if (Math.abs(cur[0] - prev[0]) > 180) {
      segments.push([cur]);
    } else {
      segments[segments.length - 1].push(cur);
    }
  }
  return segments;
}
