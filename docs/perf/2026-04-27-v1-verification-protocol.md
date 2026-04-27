# v1 Performance Verification Protocol

Manual checklist to run in a real browser before declaring v1 done.
The agent harness can syntax-check and confirm Vite serves; it cannot exercise
SGP4 propagation, render an actual canvas, or open DevTools.

## Setup

```bash
cd /Users/zitti/Documents/GitHub/orbitarium
npm run dev
```

Open `http://localhost:5173/` in Chrome/Edge. Allow geolocation (or accept Munich fallback after 8 s).

## Functional checklist

- [ ] Header shows your coords + a ticking clock.
- [ ] Status bar fills in: tle count (~17 000 with active+starlink default), above-horizon count (hundreds), sunlit count (subset), nearest km.
- [ ] Sky plot grid renders (rings at 30°/60°, N/E/S/W cardinal labels).
- [ ] Dots appear within 1–2 s of TLE load.
- [ ] Dots move smoothly (RAF interpolation between worker ticks).
- [ ] Sun marker visible if sun above horizon (yellow glow). Moon marker visible when above horizon.
- [ ] Right panel lists visible sats sorted by station → tier → mag.
- [ ] Click a list row → row highlights, detail card appears, dot turns green.
- [ ] Click a dot in the canvas → same selection sync.
- [ ] Click selected again → deselect.
- [ ] Group chip clicks reload TLEs (dot goes warn → live).
- [ ] Sunlit-only toggle hides shadow-side sats instantly.
- [ ] Min-elev slider updates count within ~1 s of release.
- [ ] Night-vision turns the page deep red. Reload → still red.
- [ ] Re-locate fires the geolocation prompt again.

## Performance budgets (DevTools → Performance → Record 10 s)

Targets from `docs/plans/2026-04-27-v1-design-and-plan.md`:

| Metric                  | Target          | Where to look                                                      |
| ----------------------- | --------------- | ------------------------------------------------------------------ |
| Worker init             | < 2 s laptop, < 5 s phone | Worker thread, the long block right after page load                |
| Coarse pass (per 5 s)   | < 200 ms        | Worker thread, every 5 s — the long task vs the short ones         |
| Fine pass (per 1 s)     | < 30 ms         | Worker thread, the short tick tasks between coarse passes          |
| Main-thread frame       | < 8 ms          | Main thread, RAF render frames                                     |

If any budget overruns:
- **Worker init slow:** check inclination prune is dropping enough sats (console-log the `pruned` count from the `'ready'` message).
- **Coarse pass slow:** consider raising the buffer (5°) or interval (5 s) trade-off.
- **Fine pass slow:** check candidateIds size — if it's regularly > 1000, the prune isn't doing its job at low elevation.
- **Main frame jank:** confirm canvas is rendering, not SVG (Task 9). Check `setupSkyCanvas` is using DPR < 3 to keep backing-store size sane.

## Phone test

Vite host flag exposes the server on the LAN:

```bash
npm run dev -- --host
```

Open the printed Network URL on a phone on the same WiFi. Repeat the functional + perf checklist.

## Save the trace

If anything overruns, save the Performance trace to `docs/perf/2026-04-27-v1-baseline/` for future reference.

## Done criteria

If all functional items pass and all perf budgets hit, v1 is shippable. Tag the commit (`git tag v1.0.0`) and proceed to v2 (orbit trail lines, pass alerts).
