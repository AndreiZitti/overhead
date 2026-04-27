// SVG world basemap (equirectangular projection). Loads Natural Earth 110m
// land polygons once and renders as a single <path> element. Also exports
// the projection helpers used by the canvas overlay and trail layer so all
// three layers stay aligned.

export const MAP = { w: 720, h: 360 };

/** Equirectangular: longitude/latitude (degrees) -> SVG/canvas pixel coords. */
export function project(lonDeg, latDeg) {
  const x = ((lonDeg + 180) / 360) * MAP.w;
  const y = ((90 - latDeg) / 180) * MAP.h;
  return [x, y];
}

/** Inverse of project — pixel coord -> (lon, lat) degrees. Used for hit testing. */
export function unproject(x, y) {
  const lon = (x / MAP.w) * 360 - 180;
  const lat = 90 - (y / MAP.h) * 180;
  return [lon, lat];
}

/** Fetch the basemap, build a single SVG path, inject into <g id="land">. */
export async function drawBasemap(svg) {
  const r = await fetch('/vendor/world-110m.geojson');
  if (!r.ok) throw new Error('basemap ' + r.status);
  const geo = await r.json();

  const parts = [];
  for (const feat of geo.features) {
    const geom = feat.geometry;
    if (!geom) continue;
    if (geom.type === 'Polygon') {
      parts.push(polygonToPath(geom.coordinates));
    } else if (geom.type === 'MultiPolygon') {
      for (const poly of geom.coordinates) parts.push(polygonToPath(poly));
    }
  }

  const land = svg.querySelector('#land');
  if (land) land.innerHTML = `<path d="${parts.join(' ')}" />`;
}

function polygonToPath(rings) {
  let d = '';
  for (const ring of rings) {
    if (ring.length === 0) continue;
    const [x0, y0] = project(ring[0][0], ring[0][1]);
    d += `M${x0.toFixed(1)},${y0.toFixed(1)}`;
    for (let i = 1; i < ring.length; i++) {
      const [x, y] = project(ring[i][0], ring[i][1]);
      d += `L${x.toFixed(1)},${y.toFixed(1)}`;
    }
    d += 'Z';
  }
  return d;
}

/** Draw graticule (lat/lon grid lines every 30°) into <g id="graticule">. */
export function drawGraticule(svg) {
  const g = svg.querySelector('#graticule');
  if (!g) return;
  let s = '';
  // Meridians (lon lines).
  for (let lon = -180; lon <= 180; lon += 30) {
    const [x] = project(lon, 0);
    s += `<line class="grat" x1="${x}" y1="0" x2="${x}" y2="${MAP.h}" />`;
  }
  // Parallels (lat lines).
  for (let lat = -60; lat <= 60; lat += 30) {
    const [, y] = project(0, lat);
    s += `<line class="grat" x1="0" y1="${y}" x2="${MAP.w}" y2="${y}" />`;
  }
  // Equator emphasized.
  const [, eqY] = project(0, 0);
  s += `<line class="grat-eq" x1="0" y1="${eqY}" x2="${MAP.w}" y2="${eqY}" />`;
  g.innerHTML = s;
}
