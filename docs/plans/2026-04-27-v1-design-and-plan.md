# Orbitarium v1 — Design & Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a live in-browser satellite sky tracker that propagates ~17k SGP4 orbits at 1 Hz, visualises the visible subset on a polar plot, and stays responsive on a phone.

**Architecture:** Static ES-module web app. Main thread owns the UI and a 30 fps render loop with interpolated positions. A dedicated Web Worker holds all parsed `satrec` objects and runs SGP4 propagation in a two-tier cadence (0.2 Hz coarse over all sats → 1 Hz fine over candidates above the horizon). TLEs are cached in IndexedDB with a 6-hour freshness window so cold start is instant. Dot layer renders to `<canvas>`; static grid, labels, sun/moon markers stay as SVG.

**Tech Stack:** Vanilla JS (ES modules), satellite.js v5 (SGP4), IndexedDB (TLE cache), Canvas 2D + SVG, Vite (dev server only — prod is plain static files).

---

## Design Reference

The reference HTML in conversation is the v1 feature target. v1 = reference parity + perf foundation:

- Web Worker for all SGP4 work (no main-thread propagation, ever).
- IndexedDB cache for TLE text, 6 h refresh.
- Canvas dot layer (replaces SVG `<g id="sats">`).
- Two-tier propagation in worker (0.2 Hz coarse / 1 Hz fine).
- 30 fps interpolated render between worker ticks.
- Inclination-based pre-prune at TLE load.

Out of scope for v1 (deferred to v2/v3):
- Orbit trail lines, pass alerts, phase-angle magnitude, SATCAT cross-ref, PWA manifest.

## Project Layout

```
orbitarium/
├── index.html
├── styles.css
├── package.json              # only for vite dev dep
├── .gitignore
├── src/
│   ├── main.js               # entry, UI events, render loop
│   ├── worker.js             # SGP4, sunlit, candidate filter
│   ├── tle-cache.js          # IndexedDB
│   ├── tle-loader.js         # CelesTrak fetch + cache wiring
│   ├── astro.js              # sun/moon ECI, sunlit, az/el helpers
│   ├── sky-canvas.js         # dot rendering on <canvas>
│   ├── sky-svg.js            # grid, sun/moon, labels
│   ├── geo.js                # geolocation
│   └── ui.js                 # list panel, detail card, controls
├── vendor/
│   └── satellite.min.js      # bundled v5 (worker can't import from CDN reliably)
└── docs/
    └── plans/
        └── 2026-04-27-v1-design-and-plan.md
```

## Verification Strategy

This is a real-time browser app with no easy unit-test harness for SGP4 + DOM + Worker integration. Verification is **manual + measured**, not automated tests. Each task ends with a concrete browser check and (where relevant) a perf measurement using the Performance panel.

The single perf budget that matters for v1:
- Worker init (parse ~17 k TLEs): < 2 s on laptop, < 5 s on phone.
- Coarse pass (every 5 s): < 200 ms.
- Fine pass (every 1 s): < 30 ms.
- Main thread frame: < 8 ms (60 fps headroom).

Each task ends with a commit.

---

## Task 1: Project scaffold

**Files:**
- Create: `package.json`, `.gitignore`, `index.html` (empty shell), `styles.css` (empty), `vendor/satellite.min.js` (downloaded)
- `git init`

**Steps:**

1. `cd /Users/zitti/Documents/GitHub/orbitarium && npm init -y`
2. `npm install --save-dev vite`
3. Add `"scripts": {"dev": "vite", "preview": "vite preview"}` to `package.json`.
4. Download satellite.js v5 to `vendor/satellite.min.js`:
   ```
   curl -fsSL https://cdnjs.cloudflare.com/ajax/libs/satellite.js/5.0.0/satellite.min.js -o vendor/satellite.min.js
   ```
5. Write `.gitignore`:
   ```
   node_modules/
   dist/
   .DS_Store
   .vite/
   ```
6. Write a stub `index.html` that just loads `src/main.js` as a module so we can confirm Vite works.
7. Write a stub `src/main.js` that does `console.log('orbitarium boot')`.
8. `npm run dev` — open browser, confirm log fires.
9. `git init && git add -A && git commit -m "scaffold: vite + satellite.js + empty shell"`

**Verification:** Browser console shows "orbitarium boot".

---

## Task 2: HTML shell + styles port

**Files:**
- Modify: `index.html`, `styles.css`

**Steps:**

1. Port the full HTML body structure from the reference: header, status bar, grid (sky-card + panel), detail, controls, legend, footer, toast.
2. Replace the SVG `<g id="sats">` element with a `<canvas id="sky-canvas">` overlay positioned absolute on top of the SVG (SVG keeps grid/labels/sun/moon).
3. Port the entire `<style>` block from the reference into `styles.css` verbatim. Add `.sky-card { position: relative; }` and absolute positioning for the canvas overlay.
4. Link `styles.css`, satellite.js (`vendor/`), and `src/main.js` (as module) from `index.html`.
5. `npm run dev` — confirm the page renders with the dark observatory aesthetic, "Locating…" placeholder, empty sky plot grid.
6. `git add -A && git commit -m "feat: port HTML shell and styles, swap dot layer to canvas"`

**Verification:** Page renders identically to the reference visually except no satellites or grid yet (grid drawn in Task 8). Status bar reads em-dashes.

---

## Task 3: Geolocation module

**Files:**
- Create: `src/geo.js`
- Modify: `src/main.js`

**Steps:**

1. `src/geo.js` exports `getLocation()` returning `{lat, lon, alt, name}`. 8 s timeout, falls back to Munich `{48.183, 11.539, 0.52, 'Munich (default)'}`. Toast on permission deny.
2. `main.js` imports it, awaits on boot, writes lat/lon into the header DOM (`#locName`, `#coords`).
3. `git add -A && git commit -m "feat: geolocation with Munich fallback"`

**Verification:** Refresh, allow location → header shows your coords. Block location → header shows Munich after ~8 s plus toast.

---

## Task 4: IndexedDB TLE cache

**Files:**
- Create: `src/tle-cache.js`

**Steps:**

1. Open DB `orbitarium`, store `tles` keyed by `group`. Each record: `{group, fetchedAt, raw}`.
2. Export `get(group)` → `{fetchedAt, raw}` or null. Export `put(group, raw)` → writes with `fetchedAt = Date.now()`. Export `isFresh(fetchedAt, maxAgeMs = 6h)`.
3. In browser console manually verify: `import('/src/tle-cache.js').then(m => m.put('test', 'hello'))` then `m.get('test')`.
4. `git add -A && git commit -m "feat: IndexedDB TLE cache with 6h freshness check"`

**Verification:** Console smoke test reads back the value. DevTools → Application → IndexedDB shows the record.

---

## Task 5: TLE loader

**Files:**
- Create: `src/tle-loader.js`
- Modify: `src/main.js`

**Steps:**

1. `tle-loader.js` exports `loadGroups(enabledGroups, {forceFetch=false})`:
   - For each of `['visual', 'stations']` (always) + `enabledGroups` (e.g. `['active', 'starlink']`):
     - Read cache. If fresh and not forced, use cached `raw`.
     - Else fetch `https://celestrak.org/NORAD/elements/gp.php?FORMAT=tle&GROUP=${group}` and write to cache.
   - Returns `{tles: [{id, name, line1, line2, group, isStation, inVisual}]}` deduped by NORAD ID.
   - `id` parsed from line 1 cols 3-7. `isStation` = group is 'stations' OR name matches `/\b(ISS|TIANHE|CSS|ZARYA)\b/i`. `inVisual` = id appears in the 'visual' group.
2. `main.js` calls `loadGroups(['active', 'starlink'])` after geo, updates `#tleCount` and the load dot.
3. Toast on failure, do not block UI.
4. `git add -A && git commit -m "feat: TLE loader with cache-first fetch and dedup"`

**Verification:** Fresh load: status shows ~17 000 after a few seconds. Hard refresh within 6 h: status updates instantly (no network in DevTools Network panel for the TLE URLs).

---

## Task 6: Astronomy helpers

**Files:**
- Create: `src/astro.js`

**Steps:**

1. Port `sunECI(date)`, `moonECI(date)`, `eciDirToAzEl(dir, observerGd, gmst)`, `isSunlit(satEci, sunDir)` from the reference, unchanged.
2. Add `estimateMag(sat, rangeKm)` and `tierOf(sat, sunlit, observerDark, mag)` — same logic as reference.
3. Add JSDoc comments only where the formula source matters (e.g. cite Meeus chapter for sun/moon).
4. No DOM, no globals. Pure functions, all exported.
5. `git add -A && git commit -m "feat: astronomy helpers (sun, moon, sunlit, mag, tier)"`

**Verification:** Console smoke test: `import('/src/astro.js').then(m => console.log(m.sunECI(new Date())))` returns a unit-ish vector.

---

## Task 7: Worker — init and basic 1 Hz fine pass

**Files:**
- Create: `src/worker.js`

**Steps:**

1. Worker is an ES module worker (`new Worker(url, {type:'module'})`). Import satellite.js inside via `importScripts` is not allowed in module workers — instead `import` the satellite.js as a module by hosting the lib file with an `export` shim, OR use a classic worker. **Decision:** classic worker with `importScripts('/vendor/satellite.min.js')` to keep things simple. Confirm satellite.js exposes `self.satellite`.
2. Message handler:
   - `init`: receive `{tles, observer}`. Parse each TLE to `satrec` via `satellite.twoline2satrec`. Drop those with `satrec.error`. Apply inclination pre-prune: drop if `inclinationDeg + 5 < |observer.lat|` (skip prune if `|lat| < 5°`). Post `{type:'ready', total, pruned}`.
   - `observer`: update stored observer geodetic.
   - `config`: update `{minElev, sunlitOnly}`.
   - `tick {timeMs}`: propagate every retained sat at that time, compute az/el/range/sunlit/mag/tier, post `{type:'positions', timeMs, items, counts}`. Filter by `minElev` and (if `sunlitOnly`) by tier ≠ 'shadow' before posting.
3. Cap `items` to 1500 (sorted brightest-first before slicing).
4. `git add -A && git commit -m "feat: worker with single-tier 1Hz propagation"`

**Verification:** Defer browser verification to Task 10 (need render loop wired). For now: in main.js add a temporary `worker.onmessage = e => console.log(e.data)` and confirm `ready` arrives, then `positions` arrives once per second after wiring a stub `tick` sender.

---

## Task 8: SVG static layer (grid, sun/moon, labels)

**Files:**
- Create: `src/sky-svg.js`
- Modify: `src/main.js`

**Steps:**

1. `sky-svg.js` exports:
   - `drawGrid(svgEl)` — port the reference `drawGrid()` to write into the `<g id="grid">` node. Drawn once on boot.
   - `updateCelestial(svgEl, sunLook, moonLook)` — draws sun + moon markers at 1 Hz.
   - `updateLabels(svgEl, items, selectedId)` — draws labels for stations + naked-eye top 8 + selected, called at 1 Hz.
   - `azElToXY(az, el, plot)` shared helper exported.
2. `main.js` calls `drawGrid` on boot.
3. `git add -A && git commit -m "feat: SVG static layer for grid, sun, moon, labels"`

**Verification:** Polar grid renders (rings at 30° / 60°, cardinal labels N/E/S/W). No dots yet.

---

## Task 9: Canvas dot layer

**Files:**
- Create: `src/sky-canvas.js`

**Steps:**

1. Export `setupCanvas(canvasEl, plot)` — sets DPR, returns a `{render(items, selectedId), hitTest(x, y) → id|null}` object.
2. `render`:
   - `clearRect`.
   - Group items by tier. Iterate tiers in order `[shadow, daylight, telescope, binocular, mid, naked, station, selected]` (faintest first so brightest end up on top).
   - For each tier: set fillStyle + shadowBlur once, loop sats, `arc()` + `fill()`. Use `beginPath()` per tier batch.
   - Maintain internal `lastDots = [{id, x, y, r}, ...]` for hit testing.
3. `hitTest(x, y)` — linear scan, returns nearest dot within 8 px or null.
4. Tier → color mapping mirrors the CSS classes from the reference.
5. `git add -A && git commit -m "feat: canvas dot layer with batched tier rendering and hit test"`

**Verification:** Defer to Task 10.

---

## Task 10: Main render loop with interpolation

**Files:**
- Modify: `src/main.js`

**Steps:**

1. Spawn worker on boot. Send `init` after TLE load. Send `observer` and `config` after geo + UI ready.
2. 1 Hz timer: send `tick` with current time.
3. On worker `positions`: stash as `latestFrame`, move previous to `prevFrame`. Update list panel + status bar + SVG sun/moon/labels (Task 11 wires the panel, this task just wires the canvas).
4. 30 fps `requestAnimationFrame` loop:
   - Compute `t` = (now − latestFrame.timeMs) / 1000 (seconds since latest worker tick).
   - For each item in `latestFrame`, look up the matching id in `prevFrame`. If found, lerp `(az, el)` by `t / Δt_frames`. Else use latest as-is.
   - Pass interpolated array to `skyCanvas.render`.
5. Click handler on canvas: hit-test, set `selectedId`, force a render and SVG label refresh.
6. `git add -A && git commit -m "feat: main render loop with worker-driven 1Hz + 30fps interpolation"`

**Verification:** Open page. Once TLEs load, sky plot fills with dots. Dots move smoothly (no judder). Status bar updates every second. ~hundreds of dots above horizon for a typical mid-latitude observer.

---

## Task 11: List panel, selection, detail card

**Files:**
- Create: `src/ui.js`
- Modify: `src/main.js`

**Steps:**

1. `ui.js` exports:
   - `renderList(items, selectedId)` — single `innerHTML` write to `#satList`. Caps at 80 rows. Same row layout as reference.
   - `renderDetail(item)` — toggles `.show` class, fills `#detail`. Tier label map from reference.
   - `bindSelection(onSelect)` — delegates clicks on `[data-id]` in both list and canvas (canvas click handled in main, this just wires list).
2. `main.js` calls `renderList` + `renderDetail` once per second after each worker frame.
3. Status bar: `#listCount`, `#visCount`, `#sunlitCount`, `#nearest` updated from `counts` in the worker payload.
4. `git add -A && git commit -m "feat: list panel, selection, detail card"`

**Verification:** Stations and bright sats appear at top. Click a row → detail card appears with altitude, range, mag, verdict. Click again → deselects. Click a canvas dot → same selection behavior.

---

## Task 12: Controls

**Files:**
- Modify: `src/main.js`, `src/ui.js`

**Steps:**

1. Group chips (`#groupChips`): on click, toggle group in state, call `loadGroups(...)` (cache makes this near-instant if fresh), then send fresh `init` to worker. Toast warns about Starlink size.
2. Sunlit toggle: flip state, send `config` to worker.
3. Min-elev slider: debounce 150 ms, then send `config` to worker. Update `#elVal` immediately.
4. Night-vision: toggle `body.night` class. Persist to `localStorage`.
5. Re-locate: re-run `getLocation`, send `observer` to worker.
6. `git add -A && git commit -m "feat: controls (groups, sunlit, min elev, night vision, relocate)"`

**Verification:** All chips behave per reference. Min-elev slider visibly culls dots within ~1 s. Night-vision survives reload.

---

## Task 13: Two-tier propagation optimization

**Files:**
- Modify: `src/worker.js`

**Steps:**

1. Add internal state `candidateIds: Set<number>` and `lastCoarseAt: number`.
2. On `tick`: if `now - lastCoarseAt > 5000` ms (or `candidateIds` empty), run **coarse pass** — propagate ALL retained sats, set `candidateIds` = sats with `el > minElev - 5°`. Update `lastCoarseAt`.
3. **Fine pass** — propagate only `candidateIds`, full visibility math, post `positions` as before.
4. The coarse pass time is added to whichever fine-pass tick triggered it; that's fine because it only fires once per 5 s.
5. Measure: open Performance panel, confirm fine pass < 30 ms, coarse pass < 200 ms on the active+starlink corpus.
6. `git add -A && git commit -m "perf: two-tier propagation (0.2Hz coarse / 1Hz fine)"`

**Verification:** Performance panel shows worker fine-pass tasks well under 30 ms. Visible-sat list still updates every second with no missed sats (compare against a single-tier run by toggling a flag).

---

## Task 14: 6 h refresh cycle

**Files:**
- Modify: `src/main.js`

**Steps:**

1. `setInterval(() => { if (!isFresh(lastFetchAt)) reloadAndReinit(); }, 60_000)` on main.
2. `reloadAndReinit()` calls `loadGroups(..., {forceFetch:true})`, then sends a new `init` to the worker. Brief status indicator while reloading.
3. `git add -A && git commit -m "feat: 6h TLE refresh in background"`

**Verification:** Manually set a TLE record's `fetchedAt` to 7 h ago in DevTools, wait < 60 s, confirm a new fetch fires and worker re-inits without a visible glitch.

---

## Task 15: Performance verification + budget enforcement

**Files:**
- None (measurement + small fixes only)

**Steps:**

1. Open DevTools Performance panel. Record 10 s of steady-state with active + starlink loaded.
2. Confirm:
   - Worker init < 2 s on laptop.
   - Coarse pass < 200 ms.
   - Fine pass < 30 ms.
   - Main-thread frame < 8 ms.
3. Test on a phone via local network (Vite host flag). Note any budget overruns.
4. If anything's over budget, open a follow-up issue (or fix in this task if trivial — e.g. reducing label count, tightening the inclination prune buffer).
5. `git add -A && git commit -m "perf: verify v1 budgets and fix any overruns"` (only if commits made).

**Verification:** Performance trace screenshots saved to `docs/perf/2026-04-27-v1-baseline/` (create folder if needed).

---

## Done criteria for v1

- All reference features work (group chips, sunlit toggle, min-elev slider, night vision, relocate, list, detail card, sun/moon).
- Cold start renders cached TLEs within 1 s.
- Smooth 30 fps motion of dots.
- Worker thread isolates all SGP4; main thread frame budget held.
- IndexedDB cache populated; 6 h refresh cycle observable.
- Pre-prune drops a measurable chunk of sats for high-latitude observers (log the number).

## Out of scope (v2/v3)

- v2: orbit trail lines, pass alerts (next-rise notifications), tap-to-pin with persistent trail, "next 10 min" timeline strip, smoother label collision.
- v3: phase-angle magnitude model, SATCAT cross-reference for object size/class, rise/set/peak times, doppler, PWA manifest + offline.
