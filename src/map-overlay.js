/* global L */
// Leaflet map + canvas satellite overlay. Two canvases are mounted into
// Leaflet's overlayPane so they inherit the same pan/zoom transforms:
//   - bgCanvas  : background dots (every satellite). Repainted only on worker
//                 ticks and on map move/zoom/resize — NOT every animation frame.
//   - fgCanvas  : visibles + trails + selected. Repainted at 60 fps for smooth
//                 interpolated motion. Small N (hundreds), so this is cheap.

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

export function setupMapOverlay(mapDivId, fgCanvas, bgCanvas, observer) {
  const map = L.map(mapDivId, {
    center: [observer.lat, observer.lon],
    zoom: 6,
    minZoom: 2,
    maxZoom: 18,
    zoomControl: true,
    worldCopyJump: false, // canvas overlay's coords get inconsistent across wraps
    zoomAnimation: false, // canvas can't follow CSS scale during anim — stay aligned
    fadeAnimation: false,
    markerZoomAnimation: false,
  });

  L.tileLayer(TILE_URL, {
    attribution: TILE_ATTRIB,
    subdomains: 'abcd',
    maxZoom: 19,
    detectRetina: true,
    noWrap: true, // single world copy keeps overlay coords single-valued
  }).addTo(map);

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

  // Both canvases live in the overlay pane and share Leaflet's transforms.
  // bg goes in first so it sits visually behind fg.
  map.getPanes().overlayPane.appendChild(bgCanvas);
  map.getPanes().overlayPane.appendChild(fgCanvas);
  bgCanvas.classList.add('leaflet-canvas-layer');
  fgCanvas.classList.add('leaflet-canvas-layer');

  const fgCtx = fgCanvas.getContext('2d');
  const bgCtx = bgCanvas.getContext('2d');
  let cssW = 0, cssH = 0;
  let lastFgDots = [];
  let lastBgDots = [];
  let clickHandler = null;
  let showBackground = true;
  let lastAllPositions = null;

  function resetCanvas(canvas, ctx) {
    const size = map.getSize();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(size.x * dpr);
    canvas.height = Math.round(size.y * dpr);
    canvas.style.width = size.x + 'px';
    canvas.style.height = size.y + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const tl = map.containerPointToLayerPoint([0, 0]);
    L.DomUtil.setPosition(canvas, tl);
  }
  function reset() {
    const size = map.getSize();
    cssW = size.x;
    cssH = size.y;
    resetCanvas(fgCanvas, fgCtx);
    resetCanvas(bgCanvas, bgCtx);
    // Repaint bg with the last data we have, otherwise it goes blank until
    // the next worker tick (could be up to 1 s).
    if (lastAllPositions) renderBackground(lastAllPositions);
  }
  reset();
  // Repaint background on view changes — fg redraws naturally each frame.
  map.on('viewreset moveend zoomend resize', reset);

  function setShowBackground(v) {
    showBackground = !!v;
    if (lastAllPositions) renderBackground(lastAllPositions);
    else clearBackground();
  }

  function clearBackground() {
    bgCtx.clearRect(0, 0, cssW, cssH);
    lastBgDots = [];
  }

  function inViewPx(x, y) {
    return x >= -2 && x <= cssW + 2 && y >= -2 && y <= cssH + 2;
  }

  // --- Background canvas: paints once per worker tick (or map move). ---

  function renderBackground(allPositions) {
    lastAllPositions = allPositions;
    if (cssW === 0 || cssH === 0) { reset(); if (cssW === 0 || cssH === 0) return; }
    bgCtx.clearRect(0, 0, cssW, cssH);
    if (!showBackground) { lastBgDots = []; return; }

    // Cache origin once — was being read twice per sat per frame previously.
    const origin = L.DomUtil.getPosition(bgCanvas) || L.point(0, 0);
    const ox = origin.x, oy = origin.y;

    // Lat/lon viewport cull — skip sats clearly off-map BEFORE projecting.
    // With noWrap: true and worldCopyJump: false, bounds don't wrap, so a
    // simple range check is safe.
    const b = map.getBounds();
    const south = b.getSouth() - 2;
    const north = b.getNorth() + 2;
    const west = b.getWest() - 2;
    const east = b.getEast() + 2;

    const bg = STYLE.background;
    bgCtx.fillStyle = bg.fill;
    bgCtx.shadowBlur = 0;

    const dots = [];
    for (const p of allPositions) {
      if (p.lat < south || p.lat > north) continue;
      if (p.lon < west || p.lon > east) continue;
      const lp = map.latLngToLayerPoint([p.lat, p.lon]);
      const x = lp.x - ox, y = lp.y - oy;
      if (!inViewPx(x, y)) continue;
      bgCtx.fillRect(x - 0.5, y - 0.5, 1.5, 1.5);
      dots.push({ id: p.id, x, y, r: bg.radius });
    }
    lastBgDots = dots;
  }

  // --- Foreground canvas: 60 fps, only visibles + trails + selected. ---

  function render(visibles, trailHistory, selectedId) {
    if (cssW === 0 || cssH === 0) {
      reset();
      if (cssW === 0 || cssH === 0) { lastFgDots = []; return; }
    }
    fgCtx.clearRect(0, 0, cssW, cssH);

    // Cache origin and bounds for this frame.
    const origin = L.DomUtil.getPosition(fgCanvas) || L.point(0, 0);
    const ox = origin.x, oy = origin.y;
    const b = map.getBounds();
    const south = b.getSouth() - 2;
    const north = b.getNorth() + 2;
    const west = b.getWest() - 2;
    const east = b.getEast() + 2;

    function project(lat, lon) {
      const lp = map.latLngToLayerPoint([lat, lon]);
      return [lp.x - ox, lp.y - oy];
    }

    // Trails for important sats (stations + naked-eye + selected + viewport
    // brightest). Each trail is N tapered segments.
    if (trailHistory && trailHistory.size > 0) {
      fgCtx.lineCap = 'round';
      fgCtx.lineJoin = 'round';
      for (const v of visibles) {
        const trail = trailHistory.get(v.id);
        if (!trail || trail.length < 2) continue;

        const isSelected = v.id === selectedId;
        const cat = isSelected ? 'selected'
                  : v.isStation ? 'station'
                  : v.tier === 'naked' ? 'naked'
                  : v.tier === 'binocular' ? 'binocular'
                  : v.tier === 'telescope' ? 'telescope'
                  : v.tier === 'daylight' ? 'daylight'
                  : 'naked';
        const s = STYLE[cat];
        const headWidth = s.radius * 0.95;
        const headAlpha = 0.85;

        fgCtx.strokeStyle = s.fill;
        fgCtx.shadowBlur = s.blur ? s.blur * 0.35 : 0;
        fgCtx.shadowColor = s.fill;

        const TRAIL_DRAW_SEGMENTS = 60;
        const len = trail.length;
        const stride = Math.max(1, Math.floor(len / TRAIL_DRAW_SEGMENTS));

        const sampledIndexes = [];
        for (let i = 0; i < len; i += stride) sampledIndexes.push(i);
        if (sampledIndexes[sampledIndexes.length - 1] !== len - 1) {
          sampledIndexes.push(len - 1);
        }
        const slen = sampledIndexes.length;
        const coords = new Array(slen);
        for (let k = 0; k < slen; k++) {
          const i = sampledIndexes[k];
          coords[k] = project(trail[i][0], trail[i][1]);
        }

        for (let k = 1; k < slen; k++) {
          const t = k / (slen - 1);
          const tt = t * t;
          const width = headWidth * t;
          if (width < 0.4) continue;
          fgCtx.globalAlpha = headAlpha * tt;
          fgCtx.lineWidth = width;
          fgCtx.beginPath();
          fgCtx.moveTo(coords[k - 1][0], coords[k - 1][1]);
          fgCtx.lineTo(coords[k][0], coords[k][1]);
          fgCtx.stroke();
        }
      }
      fgCtx.globalAlpha = 1;
      fgCtx.shadowBlur = 0;
    }

    // Visibles bucketed by render category.
    const buckets = { shadow: [], daylight: [], telescope: [], binocular: [], naked: [], station: [], selected: [] };
    for (const v of visibles) {
      // Cull off-map visibles in lat/lon space.
      if (v.lat < south || v.lat > north) continue;
      if (v.lon < west || v.lon > east) continue;
      let cat;
      if (v.id === selectedId) cat = 'selected';
      else if (v.isStation) cat = 'station';
      else cat = v.tier;
      if (buckets[cat]) buckets[cat].push(v);
    }

    const order = ['shadow', 'daylight', 'telescope', 'binocular', 'naked', 'station', 'selected'];
    const fgDots = [];
    for (const cat of order) {
      const list = buckets[cat];
      if (list.length === 0) continue;
      const s = STYLE[cat];
      fgCtx.fillStyle = s.fill;
      if (s.blur > 0) {
        fgCtx.shadowBlur = s.blur;
        fgCtx.shadowColor = s.fill;
      } else {
        fgCtx.shadowBlur = 0;
      }
      fgCtx.beginPath();
      for (const v of list) {
        const [x, y] = project(v.lat, v.lon);
        if (!inViewPx(x, y)) continue;
        fgCtx.moveTo(x + s.radius, y);
        fgCtx.arc(x, y, s.radius, 0, Math.PI * 2);
        fgDots.push({ id: v.id, x, y, r: s.radius });
      }
      fgCtx.fill();
    }
    fgCtx.shadowBlur = 0;
    lastFgDots = fgDots;
  }

  function hitTestPx(cssX, cssY) {
    let bestId = null;
    let bestDist = Infinity;
    // Prefer foreground dots (bigger, prioritized) over background.
    for (const d of lastFgDots) {
      const dx = cssX - d.x;
      const dy = cssY - d.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const threshold = Math.max(10, d.r + 4);
      if (dist <= threshold && dist < bestDist) {
        bestDist = dist;
        bestId = d.id;
      }
    }
    if (bestId !== null) return bestId;
    for (const d of lastBgDots) {
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

  map.on('click', (e) => {
    if (!clickHandler) return;
    const origin = L.DomUtil.getPosition(fgCanvas) || L.point(0, 0);
    const containerOrigin = map.layerPointToContainerPoint(origin);
    const cx = e.containerPoint.x - containerOrigin.x;
    const cy = e.containerPoint.y - containerOrigin.y;
    const id = hitTestPx(cx, cy);
    clickHandler(id);
  });

  function onClick(cb) { clickHandler = cb; }

  function setObserver(obs) {
    observerMarker.setLatLng([obs.lat, obs.lon]);
    map.setView([obs.lat, obs.lon], map.getZoom());
  }

  // -----------------------------------------------------------------------
  // Aircraft / flights mode rendering. Single canvas (fg). bg stays cleared.
  // -----------------------------------------------------------------------

  const FLIGHT_STYLE = {
    air:       { fill: '#ffd078', stroke: '#1a1200', size: 6, blur: 0 },
    ground:    { fill: 'rgba(160, 160, 160, 0.55)', stroke: 'rgba(0,0,0,0.6)', size: 4, blur: 0 },
    selected:  { fill: '#7adba0', stroke: '#0a1810', size: 8, blur: 12 },
  };

  function drawPlane(x, y, headingDeg, size, fill, stroke) {
    const rad = ((headingDeg || 0) - 0) * Math.PI / 180;
    fgCtx.save();
    fgCtx.translate(x, y);
    fgCtx.rotate(rad);
    const s = size;
    fgCtx.beginPath();
    fgCtx.moveTo(0, -1.0 * s);
    fgCtx.lineTo(0.10 * s, -0.30 * s);
    fgCtx.lineTo(1.00 * s,  0.10 * s);
    fgCtx.lineTo(1.00 * s,  0.20 * s);
    fgCtx.lineTo(0.12 * s,  0.05 * s);
    fgCtx.lineTo(0.10 * s,  0.55 * s);
    fgCtx.lineTo(0.42 * s,  0.78 * s);
    fgCtx.lineTo(0.42 * s,  0.88 * s);
    fgCtx.lineTo(0.10 * s,  0.78 * s);
    fgCtx.lineTo(0.0  * s,  0.95 * s);
    fgCtx.lineTo(-0.10 * s,  0.78 * s);
    fgCtx.lineTo(-0.42 * s,  0.88 * s);
    fgCtx.lineTo(-0.42 * s,  0.78 * s);
    fgCtx.lineTo(-0.10 * s,  0.55 * s);
    fgCtx.lineTo(-0.12 * s,  0.05 * s);
    fgCtx.lineTo(-1.00 * s,  0.20 * s);
    fgCtx.lineTo(-1.00 * s,  0.10 * s);
    fgCtx.lineTo(-0.10 * s, -0.30 * s);
    fgCtx.closePath();
    fgCtx.fillStyle = fill;
    fgCtx.fill();
    if (stroke) {
      fgCtx.strokeStyle = stroke;
      fgCtx.lineWidth = 0.8;
      fgCtx.stroke();
    }
    fgCtx.restore();
  }

  function renderFlights(aircraft, trailHistory, selectedId) {
    if (cssW === 0 || cssH === 0) {
      reset();
      if (cssW === 0 || cssH === 0) { lastFgDots = []; return; }
    }
    fgCtx.clearRect(0, 0, cssW, cssH);

    const origin = L.DomUtil.getPosition(fgCanvas) || L.point(0, 0);
    const ox = origin.x, oy = origin.y;
    const b = map.getBounds();
    const south = b.getSouth() - 2;
    const north = b.getNorth() + 2;
    const west = b.getWest() - 2;
    const east = b.getEast() + 2;
    function project(lat, lon) {
      const lp = map.latLngToLayerPoint([lat, lon]);
      return [lp.x - ox, lp.y - oy];
    }

    if (trailHistory && trailHistory.size > 0) {
      fgCtx.lineCap = 'round';
      fgCtx.lineJoin = 'round';
      for (const a of aircraft) {
        const trail = trailHistory.get(a.id);
        if (!trail || trail.length < 2) continue;
        const isSelected = a.id === selectedId;
        const s = isSelected ? FLIGHT_STYLE.selected
                : a.onGround ? FLIGHT_STYLE.ground
                : FLIGHT_STYLE.air;
        fgCtx.strokeStyle = s.fill;
        fgCtx.shadowBlur = s.blur ? s.blur * 0.4 : 0;
        fgCtx.shadowColor = s.fill;

        const TRAIL_DRAW_SEGMENTS = 30;
        const len = trail.length;
        const stride = Math.max(1, Math.floor(len / TRAIL_DRAW_SEGMENTS));
        const sampledIndexes = [];
        for (let i = 0; i < len; i += stride) sampledIndexes.push(i);
        if (sampledIndexes[sampledIndexes.length - 1] !== len - 1) sampledIndexes.push(len - 1);
        const slen = sampledIndexes.length;
        const coords = new Array(slen);
        for (let k = 0; k < slen; k++) {
          const i = sampledIndexes[k];
          coords[k] = project(trail[i][0], trail[i][1]);
        }
        const headWidth = s.size * 0.5;
        const headAlpha = 0.85;
        for (let k = 1; k < slen; k++) {
          const t = k / (slen - 1);
          const tt = t * t;
          const width = headWidth * t;
          if (width < 0.4) continue;
          fgCtx.globalAlpha = headAlpha * tt;
          fgCtx.lineWidth = width;
          fgCtx.beginPath();
          fgCtx.moveTo(coords[k - 1][0], coords[k - 1][1]);
          fgCtx.lineTo(coords[k][0], coords[k][1]);
          fgCtx.stroke();
        }
      }
      fgCtx.globalAlpha = 1;
      fgCtx.shadowBlur = 0;
    }

    const fgDots = [];
    const order = aircraft.slice().sort((a, b) => {
      if (a.id === selectedId) return 1;
      if (b.id === selectedId) return -1;
      return 0;
    });
    for (const a of order) {
      if (a.lat < south || a.lat > north) continue;
      if (a.lon < west || a.lon > east) continue;
      const [x, y] = project(a.lat, a.lon);
      if (!inViewPx(x, y)) continue;
      const isSelected = a.id === selectedId;
      const s = isSelected ? FLIGHT_STYLE.selected
              : a.onGround ? FLIGHT_STYLE.ground
              : FLIGHT_STYLE.air;
      if (s.blur) { fgCtx.shadowBlur = s.blur; fgCtx.shadowColor = s.fill; }
      else { fgCtx.shadowBlur = 0; }
      drawPlane(x, y, a.headingDeg, s.size, s.fill, s.stroke);
      fgDots.push({ id: a.id, x, y, r: s.size });
    }
    fgCtx.shadowBlur = 0;
    lastFgDots = fgDots;
  }

  return {
    map,
    render,
    renderBackground,
    renderFlights,
    clearBackground,
    onClick,
    setObserver,
    setShowBackground,
  };
}
