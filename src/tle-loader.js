// TLE loader — cache-first fetch from CelesTrak with dedup + tagging.

import { get, put, isFresh } from './tle-cache.js';

const CELESTRAK_BASE =
  'https://celestrak.org/NORAD/elements/gp.php?FORMAT=TLE&GROUP=';
const STATION_NAME_RE = /\b(ISS|TIANHE|CSS|ZARYA)\b/i;

/** Get raw TLE text for a group, using cache when fresh. */
async function fetchGroupRaw(group, forceFetch) {
  if (!forceFetch) {
    const cached = await get(group);
    if (cached && isFresh(cached.fetchedAt)) return cached.raw;
  }
  const r = await fetch(CELESTRAK_BASE + encodeURIComponent(group));
  if (!r.ok) throw new Error('CelesTrak ' + r.status);
  const text = await r.text();
  const parsed = parseTLE(text);
  if (parsed.length === 0) {
    throw new Error(`CelesTrak ${group}: no TLE records in response`);
  }
  await put(group, text);
  return text;
}

/** Parse TLE triple-line text into {id, name, line1, line2} records. */
function parseTLE(text, group) {
  const lines = text.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length - 2; i += 3) {
    const name = lines[i] && lines[i].trim();
    const line1 = lines[i + 1];
    const line2 = lines[i + 2];
    if (!name || !line1 || !line2) continue;
    if (!line1.startsWith('1 ') || !line2.startsWith('2 ')) continue;
    const id = parseInt(line1.substring(2, 7), 10);
    if (!Number.isFinite(id)) continue;
    out.push({ id, name, line1, line2, group });
  }
  return out;
}

/**
 * Load TLE data for the requested groups (plus 'visual' and 'stations' metadata).
 * Returns deduped, tagged records.
 *
 * @param {string[]} enabledGroups e.g. ['active', 'starlink']
 * @param {object} [opts]
 * @param {boolean} [opts.forceFetch=false] bypass cache (always hit network)
 * @param {(msg:string) => void} [opts.onWarn] called when an individual group fails
 * @returns {Promise<{tles: Array, fetchedAt: number}>}
 */
export async function loadGroups(enabledGroups, opts = {}) {
  const { forceFetch = false, onWarn } = opts;

  const safeFetchParse = async (group) => {
    try {
      const raw = await fetchGroupRaw(group, forceFetch);
      return parseTLE(raw, group);
    } catch (e) {
      console.warn('Failed to load ' + group, e);
      if (onWarn) onWarn('Failed to load ' + group);
      return [];
    }
  };

  const [visualRecs, stationsRecs, ...groupResults] = await Promise.all([
    safeFetchParse('visual'),
    safeFetchParse('stations'),
    ...enabledGroups.map((g) => safeFetchParse(g)),
  ]);
  const visualSet = new Set(visualRecs.map((s) => s.id));
  const stationsSet = new Set(stationsRecs.map((s) => s.id));

  const tles = [];
  const seen = new Set();
  for (let i = 0; i < enabledGroups.length; i++) {
    const group = enabledGroups[i];
    const recs = groupResults[i];
    for (const rec of recs) {
      if (seen.has(rec.id)) continue;
      seen.add(rec.id);
      tles.push({
        id: rec.id,
        name: rec.name,
        line1: rec.line1,
        line2: rec.line2,
        group: rec.group,
        isStation:
          group === 'stations' ||
          stationsSet.has(rec.id) ||
          STATION_NAME_RE.test(rec.name),
        inVisual: visualSet.has(rec.id),
      });
    }
  }

  return { tles, fetchedAt: Date.now() };
}
