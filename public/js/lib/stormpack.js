/**
 * STORM ARCHIVE — the compact form of NHC's best-track history, and the way
 * back out of it.
 *
 * Pure, like sats.js and tonight.js: no DOM, no network, no clock. The build
 * script (scripts/fetch-storms.mjs in the site repo) encodes HURDAT2 with
 * this file and the console decodes it with the same file, so the two halves
 * cannot disagree about the format.
 *
 * HURDAT2 is 0.1 degree and 1 knot to begin with, so storing tenths of a
 * degree as integers loses nothing, and storing each fix as a difference from
 * the last turns a long run of nearly equal numbers into small ones that gzip
 * flattens. A storm is one row of columns:
 *
 *   [id, name, t0, dts, lat, lon, wind, status, land]
 *
 *   t0      first fix, minutes since the epoch (UTC)
 *   dts     minutes since the previous fix (360 almost always; a landfall
 *           record sits at its own odd time)
 *   lat     tenths of a degree: the first value, then differences
 *   lon     tenths, east-positive and UNWRAPPED: a storm that crosses the
 *           dateline carries on past 180 (181, 182...) instead of jumping to
 *           -179, so differences stay small and a track is one polyline.
 *           Drawing wraps with modulo.
 *   wind    knots: first value, then differences; NO_WIND where unknown
 *   status  one character per fix, see STATUS
 *   land    indices of the 'L' (landfall) records
 */

export const NO_WIND = -99;

/** HURDAT2 status -> the one character stored. */
export const STATUS = { TD: 'T', TS: 'S', HU: 'H', EX: 'E', SD: 'U', SS: 'X', LO: 'L', WV: 'W', DB: 'D' };
export const STATUS_NAME = {
  T: 'Tropical depression', S: 'Tropical storm', H: 'Hurricane', E: 'Extratropical',
  U: 'Subtropical depression', X: 'Subtropical storm', L: 'Low', W: 'Tropical wave', D: 'Disturbance',
  '?': 'Unclassified',
};

const MIN = 60000;

/** Shift lon by a multiple of 360 so it lies within 180 of the previous one. */
export function unwrapLon(prev, lon) {
  let d = lon - prev;
  while (d > 180) { lon -= 360; d = lon - prev; }
  while (d < -180) { lon += 360; d = lon - prev; }
  return lon;
}

/** Storms as the parser makes them -> the columnar archive object. */
export function encodeArchive(storms, meta = {}) {
  return {
    v: 1,
    ...meta,
    storms: storms.map((s) => {
      const f = s.fixes;
      const dts = [], lat = [], lon = [], wind = [], land = [];
      let status = '';
      let pLat = 0, pLon = 0, pWind = 0, pT = 0, uLon = 0;
      f.forEach((x, i) => {
        const la = Math.round(x.lat * 10);
        uLon = i === 0 ? x.lon : unwrapLon(uLon, x.lon);
        const lo = Math.round(uLon * 10);
        const w = x.wind == null ? NO_WIND : Math.round(x.wind);
        const t = Math.round(x.t / MIN);
        dts.push(i === 0 ? 0 : t - pT);
        lat.push(i === 0 ? la : la - pLat);
        lon.push(i === 0 ? lo : lo - pLon);
        wind.push(i === 0 ? w : w - pWind);
        status += STATUS[x.status] || '?';
        if (x.rec === 'L') land.push(i);
        pLat = la; pLon = lo; pWind = w; pT = t;
      });
      return [s.id, s.name, Math.round(f[0].t / MIN), dts, lat, lon, wind, status, land];
    }),
  };
}

/**
 * The archive object -> storms with typed, absolute columns. `t` is in
 * milliseconds so it feeds `new Date(t)` and the cursor directly; `lon` is
 * the unwrapped degrees.
 */
export function decodeArchive(archive) {
  const out = [];
  for (const row of Array.isArray(archive && archive.storms) ? archive.storms : []) {
    // One bad row must not blank the archive: it is dropped, like a bad OMM record in sats.js.
    if (!Array.isArray(row)) continue;
    const [id, name, t0, dts, lat, lon, wind, status, land] = row;
    if (!id || ![dts, lat, lon, wind].every(Array.isArray) || typeof status !== 'string') continue;
    const n = lat.length;
    if (!n || dts.length !== n || lon.length !== n || wind.length !== n || status.length !== n) continue;
    const t = new Float64Array(n), la = new Float32Array(n), lo = new Float32Array(n), w = new Int16Array(n);
    let tm = t0, a = 0, b = 0, c = 0;
    for (let i = 0; i < n; i++) {
      tm += dts[i]; a += lat[i]; b += lon[i]; c += wind[i];
      t[i] = tm * MIN; la[i] = a / 10; lo[i] = b / 10; w[i] = c;
    }
    out.push({
      id, name, basin: id.slice(0, 2), year: Number(id.slice(4)),
      n, t, lat: la, lon: lo, wind: w, status, land: land || [],
    });
  }
  return out;
}

/*
 * WIND RADII — a second, lazy file per basin (stormradii).
 *
 * HURDAT2 carries the 34, 50 and 64 knot wind radii for each fix from 2004 on
 * (nautical miles, per quadrant NE SE SW NW, 0 = no wind that strong), and
 * the radius of maximum wind from 2021. Most of the archive has neither, so
 * they are not in the track file: the console fetches this one only when it is
 * asked to draw the wind of a storm from 2004 or later.
 *
 *   { v: 1, basin, radii: { AL122005: [[fix, rmw, r34 x4, r50 x4, r64 x4], [fix], ...] } }
 *
 * `fix` indexes the storm's fixes in the track file. Three states, because
 * "none" and "not measured" must never blur: a full row is a measured field; a
 * bare `[fix]` is measured and NONE (every radius zero); a fix with no row was
 * not measured (HURDAT2's -999: Katrina's two landfall records have no radii,
 * and treating them as zero would shrink its wind field to nothing mid-landfall).
 * -1 inside a row stands for a single quadrant that was not given.
 */

const NONE = -1;

/** Storms as the parser makes them -> the radii object. */
export function encodeRadii(storms, meta = {}) {
  const radii = {};
  for (const s of storms) {
    const rows = [];
    s.fixes.forEach((f, i) => {
      if (!f.radii) return;                                            // not measured
      if (!f.radii.some((r) => r != null && r > 0)) { rows.push([i]); return; }   // measured: none
      rows.push([i, f.rmw == null ? NONE : Math.round(f.rmw), ...f.radii.map((r) => (r == null ? NONE : Math.round(r)))]);
    });
    if (rows.length) radii[s.id] = rows;
  }
  return { v: 1, ...meta, radii };
}

/**
 * The radii object -> Map(storm id -> Map(fix index -> { rmw, r })). r is
 * { 34: [NE, SE, SW, NW], 50: [...], 64: [...] } in nautical miles, a quadrant
 * that was not given is null, and a fix measured as "none" has r all zeros. A
 * fix that was not measured is simply absent from the Map.
 */
export function decodeRadii(obj) {
  const out = new Map();
  const src = obj && obj.radii && typeof obj.radii === 'object' ? obj.radii : {};
  for (const [id, rows] of Object.entries(src)) {
    if (!Array.isArray(rows)) continue;
    const byFix = new Map();
    for (const row of rows) {
      if (!Array.isArray(row) || !row.every(Number.isFinite)) continue;
      if (row.length === 1) { byFix.set(row[0], { rmw: null, r: { 34: [0, 0, 0, 0], 50: [0, 0, 0, 0], 64: [0, 0, 0, 0] } }); continue; }
      if (row.length !== 14) continue;
      const v = row.slice(2).map((x) => (x === NONE ? null : x));
      byFix.set(row[0], { rmw: row[1] === NONE ? null : row[1], r: { 34: v.slice(0, 4), 50: v.slice(4, 8), 64: v.slice(8, 12) } });
    }
    if (byFix.size) out.set(id, byFix);
  }
  return out;
}
