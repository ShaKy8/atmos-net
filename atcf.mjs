/**
 * ATCF — the format NHC publishes live storm tracks in.
 *
 * Pure: text in, objects out, no network and no clock.
 *
 * Two files matter:
 *
 *   b-deck  (btk/b<id>.dat)       the best track: where the storm has been,
 *                                  one row per six hours, with wind radii.
 *   a-deck  (aid_public/a<id>.dat.gz)  every forecast and every model's guess,
 *                                  one row per (cycle, technique, hour ahead).
 *                                  OFCL is NHC's official forecast.
 *
 * Rows are comma separated. The ones used here, by position:
 *
 *   0 basin  1 storm number  2 YYYYMMDDHH  4 technique  5 hours ahead (tau)
 *   6 lat in tenths, N/S  7 lon in tenths, E/W  8 wind kt  9 pressure mb
 *   10 status  11 radius threshold (34, 50 or 64 kt)  13-16 radii NE SE SW NW, nm
 *   27 storm name (b-deck)
 *
 * A wind radii threshold is its own row: one (time, hour) has up to three
 * rows differing only in field 11, so rows are merged on time (and tau).
 */

/** A live storm's id: basin, two-digit number, four-digit year, lower case. */
export const STORM_ID = /^(al|ep|cp)(\d{2})(\d{4})$/;

/** Numbers 90 and up are invests (areas being watched), not named cyclones. */
export const stormNumber = (id) => {
  const m = STORM_ID.exec(id);
  return m ? Number(m[2]) : null;
};

const num = (s) => {
  if (s == null || s === '') return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
};

/** '195N' -> 19.5, '1079W' -> -107.9; NaN when it is not a coordinate. */
export function atcfCoord(text) {
  const m = /^(\d+)([NSEW])$/.exec(String(text).trim());
  if (!m) return NaN;
  const v = Number(m[1]) / 10;
  return m[2] === 'S' || m[2] === 'W' ? -v : v;
}

/** 'YYYYMMDDHH' -> milliseconds since the epoch (UTC); NaN when it is not a time. */
export function atcfTime(dtg) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})$/.exec(String(dtg).trim());
  if (!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4]);
}

function rowsOf(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    const f = line.split(',').map((s) => s.trim());
    if (f.length >= 12) out.push(f);
  }
  return out;
}

/** The fields every row shares, or null when the row is not usable. */
function pointOf(f) {
  const t = atcfTime(f[2]);
  const lat = atcfCoord(f[6]);
  const lon = atcfCoord(f[7]);
  if (!Number.isFinite(t) || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const wind = num(f[8]);
  const pres = num(f[9]);
  return { lat, lon, wind: wind != null && wind > 0 ? wind : null, pres: pres != null && pres > 0 ? pres : null, status: f[10] || '' };
}

/** Fold a threshold row's four radii into point.r[34|50|64]; no-op for a base row. */
function addRadii(point, f) {
  const rad = num(f[11]);
  if (rad !== 34 && rad !== 50 && rad !== 64) return;
  const q = [13, 14, 15, 16].map((i) => num(f[i]));
  if (q.every((v) => v != null && v >= 0)) (point.r ||= {})[rad] = q;
}

const NOT_A_NAME = /^(INVEST|NONAME|GENESIS\d*)$/;

/**
 * A best-track file -> { name, fixes }, oldest first. Only BEST rows at hour
 * zero count; the three radii rows of one time are merged into one fix.
 * `name` is the last real name in the file ('' for a storm not yet named).
 */
export function parseBtk(text) {
  const byTime = new Map();
  let name = '';
  for (const f of rowsOf(text)) {
    if (f[4] !== 'BEST' || num(f[5]) !== 0) continue;
    const p = pointOf(f);
    if (!p) continue;
    const t = atcfTime(f[2]);
    let fix = byTime.get(t);
    if (!fix) { fix = { t, ...p }; byTime.set(t, fix); }
    addRadii(fix, f);
    if (f[27] && !NOT_A_NAME.test(f[27])) name = f[27];
  }
  return { name, fixes: [...byTime.values()].sort((a, b) => a.t - b.t) };
}

/**
 * An a-deck -> { TECH: { cycle, points } } for the techniques asked for, each
 * at its own latest cycle (models run at different times: OFCL may be a cycle
 * ahead of a model). `cycle` is the issue time in ms and `points` are by hour
 * ahead, each with a time `t` = cycle + tau. A technique with no usable row
 * is absent.
 */
export function parseADeck(text, techs = ['OFCL']) {
  const want = new Set(techs);
  const byRun = new Map();            // `${tech}|${cycle}` -> Map(tau -> point)
  const latest = new Map();           // tech -> newest cycle
  for (const f of rowsOf(text)) {
    const tech = f[4];
    if (!want.has(tech)) continue;
    const tau = num(f[5]);
    if (tau == null || tau < 0 || tau > 240 || !Number.isInteger(tau)) continue;
    const p = pointOf(f);
    if (!p) continue;
    const cycle = atcfTime(f[2]);
    const key = `${tech}|${cycle}`;
    let run = byRun.get(key);
    if (!run) { run = new Map(); byRun.set(key, run); }
    let point = run.get(tau);
    if (!point) { point = { tau, t: cycle + tau * 3600000, ...p }; run.set(tau, point); }
    addRadii(point, f);
    if (!(latest.get(tech) >= cycle)) latest.set(tech, cycle);
  }
  const out = {};
  for (const [tech, cycle] of latest) {
    out[tech] = { cycle, points: [...byRun.get(`${tech}|${cycle}`).values()].sort((a, b) => a.tau - b.tau) };
  }
  return out;
}

/**
 * Keep a forecast's points at hour zero and at every `step` hours up to
 * `maxTau`, in order, as new objects: a model's run is six-hourly out to ten
 * days, and a map line needs far fewer points than that.
 */
export function thinPoints(points, { step = 12, maxTau = 120 } = {}) {
  return (Array.isArray(points) ? points : [])
    .filter((p) => p && Number.isInteger(p.tau) && p.tau >= 0 && p.tau <= maxTau && p.tau % step === 0)
    .sort((a, b) => a.tau - b.tau)
    .map((p) => ({ ...p }));
}
