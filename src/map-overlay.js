/* global L */
// Leaflet map + canvas satellite overlay. Renders a CartoDB Dark Matter base
// map and projects satellite ground positions onto a transparent canvas
// layered above. Hit-testing dispatches map clicks to the nearest sat.

const TILE_URL =
  'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
const TILE_ATTRIB =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> ' +
  '&copy; <a href="https://carto.com/attributions">CARTO</a>';

const STYLE = {
  background: { fill: 'rgba(160, 180, 220, 0.18)', radius: 0.8 },
  shadow:     { fill: 'rgba(80, 100, 140, 0.65)', radius: 1.6, blur: 0 },
  daylight:   { fill: 'rgba(160, 150, 130, 0.85)', radius: 2.0, blur: 0 },
  telescope:  { fill: 'rgba(140, 175, 220, 0.95)', radius: 2.0, blur: 0 },
  binocular:  { fill: 'rgba(220, 215, 195, 1.0)',  radius: 2.6, blur: 0 },
  naked:      { fill: '#ffd078', radius: 3.5, blur: 8 },
  station:    { fill: '#ff9bd0', radius: 5,   blur: 14 },
  selected:   { fill: '#7adba0', radius: 6,   blur: 16 },
};

/**
 * Initialize Leaflet map + canvas overlay.
 *
 * @param {string} mapDivId  id of the <div> that will host the Leaflet map
 * @param {HTMLCanvasElement} canvasEl  overlay canvas (sized to map container)
 * @param {{lat:number, lon:number}} observer  initial center
 * @returns {{
 *   map: L.Map,
 *   render: (allPositions, visibles, selectedId) => void,
 *   onClick: (cb: (id|null) => void) => void,
 *   setObserver: (obs) => void
 * }}
 */
export function setupMapOverlay(mapDivId, canvasEl, observer) {
  const map = L.map(mapDivId, {
    center: [observer.lat, observer.lon],
    zoom: 10,
    minZoom: 3,
    maxZoom: 18,
    zoomControl: true,
    worldCopyJump: true, // smoother dateline pan
  });

  L.tileLayer(TILE_URL, {
    attribution: TILE_ATTRIB,
    subdomains: 'abcd',
    maxZoom: 19,
    detectRetina: true,
  }).addTo(map);

  // Observer marker via custom divIcon (CSS-animated pulse).
  const observerIcon = L.divIcon({
    className: '',
    html: '<div class="observer-marker"></div>',
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  });
  let observerMarker = L.marker([observer.lat, observer.lon], {
    icon: observerIcon,
    interactive: false,
    keyboard: false,
  }).addTo(map);

  const ctx = canvasEl.getContext('2d');
  let cssW = 0, cssH = 0;
  let lastDots = []; // {id, x, y, r} in CSS pixels — for hitTest
  let clickHandler = null;

  function resize() {
    const rect = canvasEl.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    cssW = rect.width;
    cssH = rect.height;
    canvasEl.width = Math.round(cssW * dpr);
    canvasEl.height = Math.round(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resize();
  window.addEventListener('resize', resize);

  // Project lat/lon → CSS pixel via Leaflet.
  function toCss(lat, lon) {
    const p = map.latLngToContainerPoint([lat, lon]);
    return [p.x, p.y];
  }

  function render(allPositions, visibles, selectedId) {
    if (cssW === 0 || cssH === 0) {
      resize();
      if (cssW === 0 || cssH === 0) {
        lastDots = [];
        return;
      }
    }

    ctx.clearRect(0, 0, cssW, cssH);

    // Use map.getBounds() for cheap bbox cull before projection.
    const b = map.getBounds();
    const south = b.getSouth(), north = b.getNorth();
    const west = b.getWest(), east = b.getEast();
    // Lon may wrap when worldCopyJump pans across dateline. Normalize a bit.
    function inBounds(lat, lon) {
      if (lat < south || lat > north) return false;
      // Cheap longitude check — if bounds don't cross dateline.
      if (west <= east) return lon >= west && lon <= east;
      return lon >= west || lon <= east;
    }

    // 1. Background layer: any sat (very faint).
    const bg = STYLE.background;
    ctx.fillStyle = bg.fill;
    ctx.shadowBlur = 0;
    for (const p of allPositions) {
      if (!inBounds(p.lat, p.lon)) continue;
      const [x, y] = toCss(p.lat, p.lon);
      ctx.fillRect(x - 0.5, y - 0.5, 1.5, 1.5);
    }

    // 2. Visibles colored by tier.
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
        if (!inBounds(v.lat, v.lon)) continue;
        const [x, y] = toCss(v.lat, v.lon);
        ctx.moveTo(x + s.radius, y);
        ctx.arc(x, y, s.radius, 0, Math.PI * 2);
        lastDots.push({ id: v.id, x, y, r: s.radius });
      }
      ctx.fill();
    }
    ctx.shadowBlur = 0;

    // Add background-only sats to hit-test list (in viewport only).
    const visibleIdSet = new Set();
    for (const d of lastDots) visibleIdSet.add(d.id);
    for (const p of allPositions) {
      if (visibleIdSet.has(p.id)) continue;
      if (!inBounds(p.lat, p.lon)) continue;
      const [x, y] = toCss(p.lat, p.lon);
      lastDots.push({ id: p.id, x, y, r: bg.radius });
    }
  }

  function hitTestPx(cssX, cssY) {
    let bestId = null;
    let bestDist = Infinity;
    for (const d of lastDots) {
      const dx = cssX - d.x;
      const dy = cssY - d.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const threshold = Math.max(10, d.r + 4);
      if (dist <= threshold && dist < bestDist) {
        bestDist = dist;
        bestId = d.id;
      }
    }
    return bestId;
  }

  // Map click → hit-test against current dot positions.
  map.on('click', (e) => {
    if (!clickHandler) return;
    const id = hitTestPx(e.containerPoint.x, e.containerPoint.y);
    clickHandler(id);
  });

  function onClick(cb) { clickHandler = cb; }

  function setObserver(obs) {
    observerMarker.setLatLng([obs.lat, obs.lon]);
    map.setView([obs.lat, obs.lon], map.getZoom());
  }

  return { map, render, onClick, setObserver };
}
