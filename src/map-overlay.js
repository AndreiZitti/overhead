/* global L */
// Leaflet map + canvas satellite overlay. Renders CartoDB Dark Matter tiles
// and projects satellite ground positions onto a transparent canvas placed
// inside Leaflet's overlayPane — so the canvas inherits Leaflet's pan/zoom
// transforms and stays aligned with the map at every zoom level.

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

export function setupMapOverlay(mapDivId, canvasEl, observer) {
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

  // Move the canvas into Leaflet's overlay pane. It now receives the same
  // CSS transforms applied to the map's tile layers during pan/zoom.
  map.getPanes().overlayPane.appendChild(canvasEl);
  canvasEl.classList.add('leaflet-canvas-layer');

  const ctx = canvasEl.getContext('2d');
  let cssW = 0, cssH = 0;
  let lastDots = [];
  let clickHandler = null;
  let showBackground = true;

  function reset() {
    const size = map.getSize();
    const dpr = window.devicePixelRatio || 1;
    cssW = size.x;
    cssH = size.y;
    canvasEl.width = Math.round(cssW * dpr);
    canvasEl.height = Math.round(cssH * dpr);
    canvasEl.style.width = cssW + 'px';
    canvasEl.style.height = cssH + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Position the canvas top-left at the layer-pane coords corresponding to
    // the map's current top-left container point. This keeps it aligned even
    // when overlayPane has a non-zero CSS transform.
    const tl = map.containerPointToLayerPoint([0, 0]);
    L.DomUtil.setPosition(canvasEl, tl);
  }
  reset();
  map.on('viewreset moveend zoomend resize', reset);

  function setShowBackground(v) { showBackground = !!v; }

  // Convert lat/lon to canvas-local CSS pixels using the layer-point system
  // (matches the canvas's L.DomUtil position).
  function toCanvasPx(lat, lon) {
    const lp = map.latLngToLayerPoint([lat, lon]);
    const origin = L.DomUtil.getPosition(canvasEl) || L.point(0, 0);
    return [lp.x - origin.x, lp.y - origin.y];
  }

  function inViewPx(x, y) {
    return x >= -2 && x <= cssW + 2 && y >= -2 && y <= cssH + 2;
  }

  function render(allPositions, visibles, trailHistory, selectedId) {
    if (cssW === 0 || cssH === 0) {
      reset();
      if (cssW === 0 || cssH === 0) {
        lastDots = [];
        return;
      }
    }

    // Full clear each frame. Per-sat trails are drawn from cached histories
    // (see Section 1.5) — much cleaner than the destination-out fade trick,
    // which suffered density artifacts where many sats overlap.
    ctx.clearRect(0, 0, cssW, cssH);

    // 1. Background dots (very faint, every satellite).
    const bg = STYLE.background;
    if (showBackground) {
      ctx.fillStyle = bg.fill;
      ctx.shadowBlur = 0;
      for (const p of allPositions) {
        const [x, y] = toCanvasPx(p.lat, p.lon);
        if (!inViewPx(x, y)) continue;
        ctx.fillRect(x - 0.5, y - 0.5, 1.5, 1.5);
      }
    }

    // 1.5 Trails for important sats (stations + naked-eye + selected).
    // Each trail is drawn as N short segments with quadratically tapering
    // alpha and width — opaque + thick at the head, transparent + thin at
    // the tail. Quadratic ramp emphasizes the head so it reads as the dot's
    // direction of motion. Sub-pixel segments at the tail are skipped.
    if (trailHistory && trailHistory.size > 0) {
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (const v of visibles) {
        const trail = trailHistory.get(v.id);
        if (!trail || trail.length < 2) continue;

        // Color category mirrors dot category (selected > station > tier).
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

        ctx.strokeStyle = s.fill;
        ctx.shadowBlur = s.blur ? s.blur * 0.35 : 0;
        ctx.shadowColor = s.fill;

        // Subsample to at most TRAIL_DRAW_SEGMENTS visible segments — for an
        // 8-second history we'd otherwise blow the per-frame stroke budget.
        const TRAIL_DRAW_SEGMENTS = 60;
        const len = trail.length;
        const stride = Math.max(1, Math.floor(len / TRAIL_DRAW_SEGMENTS));

        // Pre-project the points we'll actually use.
        const sampledIndexes = [];
        for (let i = 0; i < len; i += stride) sampledIndexes.push(i);
        if (sampledIndexes[sampledIndexes.length - 1] !== len - 1) {
          sampledIndexes.push(len - 1); // always include the head
        }
        const slen = sampledIndexes.length;
        const coords = new Array(slen);
        for (let k = 0; k < slen; k++) {
          const i = sampledIndexes[k];
          coords[k] = toCanvasPx(trail[i][0], trail[i][1]);
        }

        for (let k = 1; k < slen; k++) {
          const t = k / (slen - 1); // 0 at tail, 1 at head
          const tt = t * t;          // quadratic emphasis
          const width = headWidth * t;
          if (width < 0.4) continue;
          ctx.globalAlpha = headAlpha * tt;
          ctx.lineWidth = width;
          ctx.beginPath();
          ctx.moveTo(coords[k - 1][0], coords[k - 1][1]);
          ctx.lineTo(coords[k][0], coords[k][1]);
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
      ctx.shadowBlur = 0;
    }

    // 2. Visibles bucketed by render category (selection > station > tier).
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
        const [x, y] = toCanvasPx(v.lat, v.lon);
        if (!inViewPx(x, y)) continue;
        ctx.moveTo(x + s.radius, y);
        ctx.arc(x, y, s.radius, 0, Math.PI * 2);
        lastDots.push({ id: v.id, x, y, r: s.radius });
      }
      ctx.fill();
    }
    ctx.shadowBlur = 0;

    // Background-only sats in viewport are still hit-testable.
    const visibleIdSet = new Set();
    for (const d of lastDots) visibleIdSet.add(d.id);
    for (const p of allPositions) {
      if (visibleIdSet.has(p.id)) continue;
      const [x, y] = toCanvasPx(p.lat, p.lon);
      if (!inViewPx(x, y)) continue;
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

  // Map clicks: hit-test in container-point space, then map back to canvas
  // coords (cssX/cssY) by subtracting the canvas's current layer-point origin
  // relative to the container.
  map.on('click', (e) => {
    if (!clickHandler) return;
    const origin = L.DomUtil.getPosition(canvasEl) || L.point(0, 0);
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
  // Aircraft / flights mode rendering. Triangles rotated by heading. Same
  // canvas, same trail mechanism — just a different draw routine.
  // -----------------------------------------------------------------------

  const FLIGHT_STYLE = {
    // shadowBlur is expensive at canvas-2d scale × N planes. Drop it on the
    // common case (air); only the selected plane glows.
    air:       { fill: '#ffd078', stroke: '#1a1200', size: 6, blur: 0 },
    ground:    { fill: 'rgba(160, 160, 160, 0.55)', stroke: 'rgba(0,0,0,0.6)', size: 4, blur: 0 },
    selected:  { fill: '#7adba0', stroke: '#0a1810', size: 8, blur: 12 },
  };

  // Plane silhouette — fuselage, swept wings, horizontal stabilizer.
  // Drawn pointing up (north), then rotated by heading. Path coords are in
  // a unit square scaled by `size`.
  function drawPlane(x, y, headingDeg, size, fill, stroke) {
    const rad = ((headingDeg || 0) - 0) * Math.PI / 180; // 0° = north (up)
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rad);
    const s = size;
    ctx.beginPath();
    // Nose
    ctx.moveTo(0, -1.0 * s);
    // Right side fuselage taper to wing root
    ctx.lineTo(0.10 * s, -0.30 * s);
    // Right wingtip (swept back)
    ctx.lineTo(1.00 * s,  0.10 * s);
    ctx.lineTo(1.00 * s,  0.20 * s);
    // Back to fuselage at wing trailing edge
    ctx.lineTo(0.12 * s,  0.05 * s);
    // Right side fuselage to tail root
    ctx.lineTo(0.10 * s,  0.55 * s);
    // Right tail (horizontal stabilizer)
    ctx.lineTo(0.42 * s,  0.78 * s);
    ctx.lineTo(0.42 * s,  0.88 * s);
    ctx.lineTo(0.10 * s,  0.78 * s);
    // Tail tip (rear of fuselage)
    ctx.lineTo(0.0  * s,  0.95 * s);
    // Mirror left side
    ctx.lineTo(-0.10 * s,  0.78 * s);
    ctx.lineTo(-0.42 * s,  0.88 * s);
    ctx.lineTo(-0.42 * s,  0.78 * s);
    ctx.lineTo(-0.10 * s,  0.55 * s);
    ctx.lineTo(-0.12 * s,  0.05 * s);
    ctx.lineTo(-1.00 * s,  0.20 * s);
    ctx.lineTo(-1.00 * s,  0.10 * s);
    ctx.lineTo(-0.10 * s, -0.30 * s);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 0.8;
      ctx.stroke();
    }
    ctx.restore();
  }

  function renderFlights(aircraft, trailHistory, selectedId) {
    if (cssW === 0 || cssH === 0) {
      reset();
      if (cssW === 0 || cssH === 0) { lastDots = []; return; }
    }
    ctx.clearRect(0, 0, cssW, cssH);

    // Trails (same per-craft tapered approach as sats).
    if (trailHistory && trailHistory.size > 0) {
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (const a of aircraft) {
        const trail = trailHistory.get(a.id);
        if (!trail || trail.length < 2) continue;
        const isSelected = a.id === selectedId;
        const s = isSelected ? FLIGHT_STYLE.selected
                : a.onGround ? FLIGHT_STYLE.ground
                : FLIGHT_STYLE.air;
        ctx.strokeStyle = s.fill;
        ctx.shadowBlur = s.blur ? s.blur * 0.4 : 0;
        ctx.shadowColor = s.fill;

        // Aircraft trails: 30 segments (vs 60 for sats) — saves ~half the
        // stroke calls per frame at the cost of slight tail blockiness.
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
          coords[k] = toCanvasPx(trail[i][0], trail[i][1]);
        }
        const headWidth = s.size * 0.5;
        const headAlpha = 0.85;
        for (let k = 1; k < slen; k++) {
          const t = k / (slen - 1);
          const tt = t * t;
          const width = headWidth * t;
          if (width < 0.4) continue;
          ctx.globalAlpha = headAlpha * tt;
          ctx.lineWidth = width;
          ctx.beginPath();
          ctx.moveTo(coords[k - 1][0], coords[k - 1][1]);
          ctx.lineTo(coords[k][0], coords[k][1]);
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
      ctx.shadowBlur = 0;
    }

    // Aircraft icons. Selected drawn last so it sits on top.
    lastDots = [];
    const order = aircraft.slice().sort((a, b) => {
      if (a.id === selectedId) return 1;
      if (b.id === selectedId) return -1;
      return 0;
    });
    for (const a of order) {
      const [x, y] = toCanvasPx(a.lat, a.lon);
      if (!inViewPx(x, y)) continue;
      const isSelected = a.id === selectedId;
      const s = isSelected ? FLIGHT_STYLE.selected
              : a.onGround ? FLIGHT_STYLE.ground
              : FLIGHT_STYLE.air;
      if (s.blur) { ctx.shadowBlur = s.blur; ctx.shadowColor = s.fill; }
      else { ctx.shadowBlur = 0; }
      drawPlane(x, y, a.headingDeg, s.size, s.fill, s.stroke);
      lastDots.push({ id: a.id, x, y, r: s.size });
    }
    ctx.shadowBlur = 0;
  }

  return { map, render, renderFlights, onClick, setObserver, setShowBackground };
}
