// List panel + selection detail card.
// One delegated click listener on #satList; one innerHTML write per render call.
// Source-of-truth layout/copy lives in docs/reference/orbitarium-reference.html
// (renderList ~803-831, renderDetail ~834-859).

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
  shadow: 'shadow'
};

const TIER_LABEL = {
  naked: 'naked-eye visible \u2605',
  binocular: 'binocular range',
  telescope: 'telescope only (Seestar territory)',
  daylight: 'sunlit but bright sky',
  shadow: 'in Earth shadow'
};

const MAX_ROWS = 80;

/**
 * Render the visible-sat list. Single innerHTML write to #satList. Caps at 80 rows.
 * @param {Array} items - sorted brightest-first by the worker
 * @param {number|null} selectedId
 * @param {number} minElev - degrees, used in the empty-state copy
 */
export function renderList(items, selectedId, minElev) {
  const list = document.getElementById('satList');
  const countEl = document.getElementById('listCount');
  if (countEl) countEl.textContent = items.length.toLocaleString();
  if (!list) return;

  if (!items.length) {
    list.innerHTML = `<div class="empty">Nothing matching above ${minElev}\u00b0 right now.<br>Try lowering elevation or toggling shadow-side sats.</div>`;
    return;
  }

  const slice = items.length > MAX_ROWS ? items.slice(0, MAX_ROWS) : items;
  let html = '';
  for (let i = 0; i < slice.length; i++) {
    const v = slice[i];
    const cls = v.isStation ? 'station' : (TIER_CLASS[v.tier] || 'shadow');
    const sel = v.id === selectedId ? ' selected' : '';
    html += `<div class="sat-row ${cls}${sel}" data-id="${v.id}">`
          + `<div class="name">${v.name}</div>`
          + `<div class="el-badge">${fmt(v.elDeg, 0)}\u00b0</div>`
          + `<div class="coords">`
          +   `<span>mag ${fmt(v.mag, 1)}</span>`
          +   `<span>az ${fmt(v.azDeg, 0)}\u00b0 ${compassFromAz(v.az)}</span>`
          +   `<span>${fmt(v.range, 0)} km</span>`
          + `</div>`
          + `</div>`;
  }
  list.innerHTML = html;
}

/**
 * Show or hide the detail card for the currently selected sat.
 * Pass null/undefined to hide (we only toggle the .show class — no innerHTML clear).
 */
export function renderDetail(item) {
  const detail = document.getElementById('detail');
  if (!detail) return;
  if (!item) {
    detail.classList.remove('show');
    return;
  }
  const tierLabel = TIER_LABEL[item.tier] || item.tier;
  detail.classList.add('show');
  detail.innerHTML =
      `<h3>${item.name}</h3>`
    + `<div class="meta-grid">`
    +   `<div><b>${fmt(item.elDeg, 1)}\u00b0</b>elevation</div>`
    +   `<div><b>${fmt(item.azDeg, 1)}\u00b0 ${compassFromAz(item.az)}</b>azimuth</div>`
    +   `<div><b>${fmt(item.altKm, 0)} km</b>orbital altitude</div>`
    +   `<div><b>${fmt(item.range, 0)} km</b>range from you</div>`
    +   `<div><b>${fmt(item.eciSpeed, 2)} km/s</b>orbital speed</div>`
    +   `<div><b>~mag ${fmt(item.mag, 1)}</b>est. brightness</div>`
    +   `<div style="grid-column:1/-1"><b>${tierLabel}</b>visibility</div>`
    + `</div>`;
}

/**
 * Wire delegated click handlers on #satList.
 * @param {(id: number|null) => void} onSelect - id=null when click missed any row
 */
export function bindUi(onSelect) {
  const list = document.getElementById('satList');
  if (list) {
    list.addEventListener('click', (e) => {
      const row = e.target.closest('.sat-row');
      if (!row) return; // .empty / dead space — ignore
      const id = parseInt(row.dataset.id, 10);
      if (Number.isFinite(id)) onSelect(id);
    });
  }
  // Detail card clicks are informational — swallow nothing, do nothing.
}
