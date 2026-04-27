/* global L */
// Selected satellite's ground track as a Leaflet polyline.
// Splits at the international dateline so the line doesn't snap horizontally
// across the map when a sat wraps from +180° to -180°.

let layer = null; // L.layerGroup holding 1+ polylines

export function renderTrails(map, trailsById, selectedId) {
  if (!layer) {
    layer = L.layerGroup().addTo(map);
  }
  layer.clearLayers();
  if (selectedId == null) return;
  const points = trailsById[selectedId];
  if (!points || points.length < 2) return;

  const segments = splitAtDateline(points);
  for (const seg of segments) {
    if (seg.length < 2) continue;
    const latLngs = seg.map(([lon, lat]) => [lat, lon]);
    L.polyline(latLngs, {
      className: 'trail-selected',
      color: '#7adba0',
      weight: 2,
      opacity: 1,
      smoothFactor: 1.5,
      interactive: false,
    }).addTo(layer);
  }
}

function splitAtDateline(points) {
  if (points.length === 0) return [];
  const segments = [[points[0]]];
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
