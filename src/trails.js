/* global L */
// Renders ground tracks for stations + naked-eye visibles + the selected sat.
// Splits at the dateline so a polyline never snaps horizontally across the map.
//
// Style tiers:
//   selected → bright green, thick, glowing
//   station  → soft magenta, medium
//   other    → faint amber, thin

let layer = null;

const STYLE = {
  selected: { color: '#7adba0', weight: 2.5, opacity: 1,    className: 'trail-selected' },
  station:  { color: '#ff9bd0', weight: 1.5, opacity: 0.7,  className: 'trail-station'  },
  naked:    { color: '#ffd078', weight: 1.2, opacity: 0.55, className: 'trail-naked'    },
};

export function renderTrails(map, trailsById, stationIdSet, selectedId) {
  if (!layer) layer = L.layerGroup().addTo(map);
  layer.clearLayers();

  for (const [idStr, points] of Object.entries(trailsById)) {
    const id = +idStr;
    if (!points || points.length < 2) continue;

    let s;
    if (id === selectedId) s = STYLE.selected;
    else if (stationIdSet.has(id)) s = STYLE.station;
    else s = STYLE.naked;

    const segments = splitAtDateline(points);
    for (const seg of segments) {
      if (seg.length < 2) continue;
      const latLngs = seg.map(([lon, lat]) => [lat, lon]);
      L.polyline(latLngs, {
        color: s.color,
        weight: s.weight,
        opacity: s.opacity,
        className: s.className,
        smoothFactor: 1.5,
        interactive: false,
      }).addTo(layer);
    }
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
