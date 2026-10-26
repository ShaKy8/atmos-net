/**
 * SATELLITES — where things in orbit are, computed here from published
 * orbital elements.
 *
 * Pure rules, in the spirit of tonight.js: no DOM, no network, no
 * zero-argument `new Date()`. Elements come in as CelesTrak OMM JSON (never
 * TLE: catalogue numbers passed 99999, and the stations group already holds
 * ones that a two-line element set cannot write). Time is always a
 * millisecond argument, so the time scrubber can drive it.
 *
 * SGP4 itself is the vendored satellite.js (MIT, see satellite/LICENSE.md);
 * nothing in this file knows how it works.
 */

import { json2satrec } from './satellite/io.js';
import { propagate, gstime } from './satellite/propagation.js';
import { eciToGeodetic, radiansToDegrees } from './satellite/transforms.js';
import { topocentric } from './astro.js';

export { CATEGORIES, kindOf } from './satcats.js';

/**
 * OMM records -> propagatable entries. A record that will not initialise is
 * dropped, not thrown: one bad row must not blank a category.
 */
export function prepare(records, category) {
  const out = [];
  for (const r of Array.isArray(records) ? records : []) {
    try {
      if (!r || r.NORAD_CAT_ID == null || typeof r.EPOCH !== 'string') continue;
      const rec = json2satrec(r);
      if (rec.error) continue;
      out.push({
        id: Number(r.NORAD_CAT_ID),
        name: String(r.OBJECT_NAME || r.NORAD_CAT_ID),
        intl: r.OBJECT_ID ? String(r.OBJECT_ID) : null,
        epoch: Date.parse(r.EPOCH.endsWith('Z') ? r.EPOCH : `${r.EPOCH}Z`),
        category,
        rec,
      });
    } catch { /* skip */ }
  }
  return out;
}

/** Sub-satellite point and height at `ms`, or null if SGP4 gives up. */
export function positionAt(sat, ms) {
  const date = new Date(ms);
  let r;
  try { r = propagate(sat.rec, date); } catch { return null; }
  if (!r || !r.position || typeof r.position === 'boolean') return null;
  const g = eciToGeodetic(r.position, gstime(date));
  const lat = radiansToDegrees(g.latitude), lon = radiansToDegrees(g.longitude);
  if (![lat, lon, g.height].every(Number.isFinite)) return null;
  return { lat, lon, altKm: g.height };
}

/** Altitude, azimuth and ground range from an observer. */
export function lookAt(sat, ms, obs) {
  const p = positionAt(sat, ms);
  if (!p) return null;
  return { ...p, ...topocentric(obs.lat, obs.lon, p.lat, p.lon, p.altKm) };
}

/**
 * The ground track from `ms` for `minutes`, as polylines split wherever it
 * crosses the antimeridian (a line drawn across the seam would span the
 * map). Longitudes are in -180..180.
 */
export function groundTrack(sat, ms, minutes = 90, stepSec = 60) {
  const lines = [];
  let cur = [];
  let prev = null;
  for (let t = 0; t <= minutes * 60; t += stepSec) {
    const p = positionAt(sat, ms + t * 1000);
    if (!p) { prev = null; if (cur.length > 1) lines.push(cur); cur = []; continue; }
    if (prev && Math.abs(p.lon - prev.lon) > 180) {
      if (cur.length > 1) lines.push(cur);
      cur = [];
    }
    cur.push([p.lat, p.lon]);
    prev = p;
  }
  if (cur.length > 1) lines.push(cur);
  return lines;
}

/** Age of the elements at `ms`, in hours. Stale ones drift by kilometres a day. */
export const elementAgeHours = (sat, ms) => (ms - sat.epoch) / 3.6e6;
