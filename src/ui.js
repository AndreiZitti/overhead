// List rows + detail card for the bottom sheet. One delegated click listener.
// Layout adapted for mobile-first sheet (no in-list mini-detail; detail card
// is a separate block above the list).

const fmt = (n, d = 2) => Number(n).toFixed(d);

const COMPASS = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
function compassFromAz(azRad) {
  return COMPASS[Math.round((azRad / (Math.PI * 2)) * 16) % 16];
}

const TIER_CLASS = {
  naked: 'bright',
  binocular: 'mid',
  telescope: 'faint',
  daylight: 'day',
  shadow: 'shadow',
  below: 'below',
};

const TIER_LABEL = {
  naked: 'Naked-eye visible ★',
  binocular: 'Binocular range',
  telescope: 'Telescope only',
  daylight: 'Sunlit but bright sky',
  shadow: 'In Earth shadow',
  below: 'Below horizon (waiting for next pass)',
};

const MAX_ROWS = 60;

/**
 * Render the visible-sat list. Single innerHTML write.
 */
export function renderList(items, selectedId) {
  const list = document.getElementById('satList');
  if (!list) return;

  if (!items.length) {
    list.innerHTML = `<div class="empty">No satellites currently above your horizon.<br>Try toggling shadow-side sats in Filters.</div>`;
    return;
  }

  const slice = items.length > MAX_ROWS ? items.slice(0, MAX_ROWS) : items;
  let html = '';
  for (let i = 0; i < slice.length; i++) {
    const v = slice[i];
    const cls = v.isStation ? 'station' : (TIER_CLASS[v.tier] || 'shadow');
    const sel = v.id === selectedId ? ' selected' : '';
    const elText = v.tier === 'below' ? 'below' : `${fmt(v.elDeg, 0)}°`;
    const magText = v.tier === 'below' ? '—' : `mag ${fmt(v.mag, 1)}`;
    html += `<div class="sat-row ${cls}${sel}" data-id="${v.id}">`
          + `<div class="name">${v.name}</div>`
          + `<div class="el-badge">${elText}</div>`
          + `<div class="coords">`
          +   `<span>${magText}</span>`
          +   `<span>az ${fmt(v.azDeg, 0)}° ${compassFromAz(v.az)}</span>`
          +   `<span>${fmt(v.range, 0)} km</span>`
          + `</div>`
          + `</div>`;
  }
  list.innerHTML = html;
}

/**
 * Render the detail card (or hide it). Includes a deselect button.
 */
export function renderDetail(item, onDeselect) {
  const detail = document.getElementById('detail');
  if (!detail) return;
  if (!item) {
    detail.hidden = true;
    return;
  }
  const tierLabel = TIER_LABEL[item.tier] || item.tier;
  detail.hidden = false;
  detail.innerHTML =
      `<div class="detail-head">`
    +   `<h3>${item.name}</h3>`
    +   `<button class="deselect" type="button">Deselect</button>`
    + `</div>`
    + `<div class="verdict">${tierLabel}</div>`
    + `<div class="meta-grid">`
    +   `<div><b>${fmt(item.elDeg, 1)}°</b>elevation</div>`
    +   `<div><b>${fmt(item.azDeg, 1)}° ${compassFromAz(item.az)}</b>azimuth</div>`
    +   `<div><b>${fmt(item.altKm, 0)} km</b>orbital altitude</div>`
    +   `<div><b>${fmt(item.range, 0)} km</b>range from you</div>`
    +   `<div><b>${fmt(item.eciSpeed, 2)} km/s</b>orbital speed</div>`
    +   `<div><b>~mag ${fmt(item.mag, 1)}</b>est. brightness</div>`
    + `</div>`;
  const btn = detail.querySelector('.deselect');
  if (btn && onDeselect) {
    btn.addEventListener('click', (e) => { e.stopPropagation(); onDeselect(); });
  }
}

/**
 * Wire delegated click handlers on #satList. Row data-id may be a number
 * (sat NORAD id) or a string (aircraft icao24 hex). Caller decides parsing.
 */
export function bindUi(onSelect) {
  const list = document.getElementById('satList');
  if (list) {
    list.addEventListener('click', (e) => {
      const row = e.target.closest('.sat-row');
      if (!row) return;
      const raw = row.dataset.id;
      if (!raw) return;
      // Try number first (sat); fall back to string (aircraft icao24).
      const num = parseInt(raw, 10);
      onSelect(Number.isFinite(num) && String(num) === raw ? num : raw);
    });
  }
}

// === Flights ============================================================

const fmtAlt = (m) => m == null ? '—' : `${Math.round(m / 30.48) * 100} ft`;
const fmtSpd = (mps) => mps == null ? '—' : `${Math.round(mps * 1.94384)} kt`;

function compassFromDeg(deg) {
  if (deg == null) return '';
  const d = ((deg % 360) + 360) % 360;
  return COMPASS[Math.round(d / 22.5) % 16];
}

export function renderFlightList(aircraft, selectedId) {
  const list = document.getElementById('satList');
  const countEl = document.getElementById('listCount');
  if (countEl) countEl.textContent = aircraft.length.toLocaleString();
  if (!list) return;

  if (!aircraft.length) {
    list.innerHTML = `<div class="empty">No aircraft in the visible map area.<br>Pan / zoom out to broaden coverage.</div>`;
    return;
  }

  // Sort: airborne first, then highest first (rough proxy for "most interesting").
  const sorted = aircraft.slice().sort((a, b) => {
    if (a.onGround !== b.onGround) return a.onGround ? 1 : -1;
    return (b.altM || 0) - (a.altM || 0);
  });
  const slice = sorted.length > MAX_ROWS ? sorted.slice(0, MAX_ROWS) : sorted;

  let html = '';
  for (const a of slice) {
    const cls = a.onGround ? 'day' : 'bright';
    const sel = a.id === selectedId ? ' selected' : '';
    const name = a.callsign || a.id.toUpperCase();
    html += `<div class="sat-row ${cls}${sel}" data-id="${a.id}">`
          + `<div class="name">${name}</div>`
          + `<div class="el-badge">${fmtAlt(a.altM)}</div>`
          + `<div class="coords">`
          +   `<span>${fmtSpd(a.velocityMs)}</span>`
          +   `<span>hdg ${a.headingDeg == null ? '—' : Math.round(a.headingDeg) + '° ' + compassFromDeg(a.headingDeg)}</span>`
          +   `<span>${a.country || ''}</span>`
          + `</div>`
          + `</div>`;
  }
  list.innerHTML = html;
}

export function renderFlightDetail(aircraft, route, onDeselect) {
  const detail = document.getElementById('detail');
  if (!detail) return;
  if (!aircraft) {
    detail.hidden = true;
    return;
  }
  detail.hidden = false;
  const name = aircraft.callsign || aircraft.id.toUpperCase();
  const fmtAirport = (a) =>
    !a ? '?' : a.country ? `${a.code} (${a.country})` : a.code;
  let routeLine;
  if (route && (route.origin || route.destination)) {
    routeLine = `<div class="verdict">${route.airline || 'Flight'} · ${fmtAirport(route.origin)} → ${fmtAirport(route.destination)}</div>`;
  } else if (route && route.airline) {
    routeLine = `<div class="verdict">${route.airline}</div>`;
  } else {
    routeLine = `<div class="verdict">${aircraft.country || 'Aircraft'}</div>`;
  }
  detail.innerHTML =
      `<div class="detail-head">`
    +   `<h3>${name}</h3>`
    +   `<button class="deselect" type="button">Deselect</button>`
    + `</div>`
    + routeLine
    + `<div class="meta-grid">`
    +   `<div><b>${fmtAlt(aircraft.altM)}</b>altitude</div>`
    +   `<div><b>${fmtSpd(aircraft.velocityMs)}</b>ground speed</div>`
    +   `<div><b>${aircraft.headingDeg == null ? '—' : Math.round(aircraft.headingDeg) + '° ' + compassFromDeg(aircraft.headingDeg)}</b>heading</div>`
    +   `<div><b>${aircraft.onGround ? 'on ground' : 'airborne'}</b>state</div>`
    +   `<div><b>${aircraft.id.toUpperCase()}</b>icao24</div>`
    +   `<div><b>${aircraft.country || '—'}</b>registry</div>`
    + `</div>`;
  const btn = detail.querySelector('.deselect');
  if (btn && onDeselect) {
    btn.addEventListener('click', (e) => { e.stopPropagation(); onDeselect(); });
  }
}
