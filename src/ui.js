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
 * Wire delegated click handlers on #satList.
 */
export function bindUi(onSelect) {
  const list = document.getElementById('satList');
  if (list) {
    list.addEventListener('click', (e) => {
      const row = e.target.closest('.sat-row');
      if (!row) return;
      const id = parseInt(row.dataset.id, 10);
      if (Number.isFinite(id)) onSelect(id);
    });
  }
}
