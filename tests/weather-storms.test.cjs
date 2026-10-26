'use strict';

// The hurricane atlas's pure rules (lib/storms.js, lib/stormpack.js), on
// hand-built storms. The real-data tests, against NHC's own HURDAT2 rows, live
// in the site repo beside the build script that produces the archive.
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');
const lib = (name) => import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'lib', name)).href);

const MIN = 60000;
const HOUR = 3600000;

/** A storm in stormpack's input form (what the HURDAT2 parser makes). */
function storm(id, fixes) {
  return { id, name: 'TEST', basin: id.slice(0, 2), year: Number(id.slice(4)), fixes };
}
const fix = (t, lat, lon, wind, status = 'HU', rec = '') => ({ t, lat, lon, wind, status, rec, pres: null, radii: null });

test('category follows the Saffir-Simpson thresholds and is null without a wind', async () => {
  const S = await lib('storms.js');
  const keys = [0, 33, 34, 63, 64, 82, 83, 95, 96, 112, 113, 136, 137, 200].map((k) => S.category(k).key);
  assert.deepEqual(keys, ['TD', 'TD', 'TS', 'TS', 'C1', 'C1', 'C2', 'C2', 'C3', 'C3', 'C4', 'C4', 'C5', 'C5']);
  assert.equal(S.category(null), null);
});

test('an archive round-trips every fix, and a dateline crossing is carried past 180', async () => {
  const P = await lib('stormpack.js');
  const t0 = Date.UTC(2010, 7, 1);
  const crossing = storm('CP012010', [
    fix(t0, 25.0, 178.5, 40, 'TS'), fix(t0 + 6 * HOUR, 25.6, 179.7, 55, 'TS'),
    fix(t0 + 12 * HOUR, 26.1, -179.4, 70, 'HU'), fix(t0 + 13 * HOUR + 15 * MIN, 26.3, -178.9, null, 'HU', 'L'),
  ]);
  const plain = storm('AL122005', [fix(t0, 23.1, -75.1, 30, 'TD'), fix(t0 + 6 * HOUR, 23.4, -76.0, 30, 'TD')]);
  const dec = P.decodeArchive(JSON.parse(JSON.stringify(P.encodeArchive([crossing, plain]))));
  assert.equal(dec.length, 2);
  const c = dec[0];
  assert.deepEqual(Array.from(c.lon), [178.5, 179.7, 180.6, 181.1].map((v) => Math.fround(v)), 'longitude carries on past 180');
  assert.deepEqual(Array.from(c.wind), [40, 55, 70, -99], 'a missing wind is the sentinel, not zero');
  assert.deepEqual(Array.from(c.t), crossing.fixes.map((f) => f.t));
  assert.deepEqual(c.land, [3], 'the landfall record is kept by index');
  assert.equal(c.status, 'SSHH');
  assert.equal(dec[1].basin, 'AL');
  assert.equal(dec[1].year, 2005);
});

test('a malformed storm row is skipped, not thrown', async () => {
  const P = await lib('stormpack.js');
  const out = P.decodeArchive({ storms: [['AL012000', 'X', 0, [0], [10], [10], [30], 'TT', []], null, ['AL022000']] });
  assert.equal(out.length, 0, 'length mismatches and short rows are dropped');
  assert.deepEqual(P.decodeArchive(null), []);
});

test('the nearest point on a track is found between fixes', async () => {
  const S = await lib('storms.js');
  const P = await lib('stormpack.js');
  const t0 = Date.UTC(2000, 8, 1);
  const [s] = P.decodeArchive(P.encodeArchive([storm('AL012000', [fix(t0, 10, -100, 50), fix(t0 + 6 * HOUR, 10, -98, 70)])]));
  const c = S.closestApproach(s, 11, -99);
  assert.ok(Math.abs(c.km - 111) < 3, `about 111 km, got ${c.km}`);
  assert.ok(S.gcKm(11, -99, 10, -100) > 150, 'the nearest fix alone would be further');
  assert.ok(Math.abs(c.u - 0.5) < 0.02);
  assert.ok(Math.abs(c.wind - 60) < 1);
});

test('a point across the dateline is still on the track', async () => {
  const S = await lib('storms.js');
  const P = await lib('stormpack.js');
  const t0 = Date.UTC(2010, 7, 1);
  const [s] = P.decodeArchive(P.encodeArchive([storm('CP012010', [fix(t0, 25, 179.5, 60), fix(t0 + 6 * HOUR, 25, -179.5, 60)])]));
  assert.ok(S.closestApproach(s, 25, 180).km < 1, 'the track runs through 180');
  assert.equal(S.nearbyStorms([s], 25, -179.8, 30).length, 1);
});

test('season progress and this-date use the clock they are given', async () => {
  const S = await lib('storms.js');
  const mk = (id, y, m, d, basin) => {
    const t = Date.UTC(y, m - 1, d);
    return { id, name: id, basin, year: y, n: 2, t: Float64Array.of(t, t + 6 * HOUR), lat: Float32Array.of(20, 21), lon: Float32Array.of(-60, -61), wind: Int16Array.of(50, 70), status: 'SH', land: [] };
  };
  const storms = [mk('AL011990', 1990, 9, 10, 'AL'), mk('AL021991', 1991, 9, 12, 'AL'), mk('AL031992', 1992, 8, 1, 'AL'), mk('EP011990', 1990, 6, 1, 'EP')];
  assert.equal(S.seasonProgress(storms, 'AL', Date.UTC(2026, 0, 1)).behind, 0);
  assert.equal(S.seasonProgress(storms, 'AL', Date.UTC(2026, 11, 31)).behind, 1);
  const mid = S.seasonProgress(storms, 'AL', Date.UTC(2026, 8, 11)).behind;
  assert.ok(mid > 0.3 && mid < 0.9, `part way through in September: ${mid}`);
  assert.deepEqual(S.onThisDate(storms, Date.UTC(2026, 8, 11), 3).map((x) => x.storm.id).sort(), ['AL011990', 'AL021991']);
});

test('the pure libs have no DOM, network, storage or hidden clock', async () => {
  const fs = require('node:fs');
  for (const f of ['storms.js', 'stormpack.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'lib', f), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    assert.ok(!/new Date\(\s*\)|Date\.now|document\.|window\.|fetch\(|localStorage/.test(src), f);
  }
});

test('NHC\'s word is aged from its newest signal, with a missed update stale and an old forecast out of date', async () => {
  const S = await lib('storms.js');
  const T = Date.UTC(2026, 9, 20, 12);
  const st = (o) => ({ forecast: { cycle: new Date(T).toISOString() }, updated: null, best: [], ...o });
  assert.equal(S.advisoryAge(st(), T + 3 * HOUR), 3);
  assert.equal(S.advisoryAge(st({ updated: new Date(T + 2 * HOUR).toISOString() }), T + 3 * HOUR), 1, 'the newest signal wins');
  assert.equal(S.advisoryAge({}, T), null);
  assert.equal(S.advisoryAge(st(), T - 5 * HOUR), 0, 'never negative');
  assert.deepEqual([0, 7, 7.01, 12, 12.01, null].map(S.staleness), ['fresh', 'fresh', 'stale', 'stale', 'old', 'unknown']);
});

test('a point is inside a cone, a hole takes it out, and a cone past 180 holds -179', async () => {
  const S = await lib('storms.js');
  const sq = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
  const cone = (geometry) => ({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry }] });
  const holed = cone({ type: 'Polygon', coordinates: [sq(-110, 18, -105, 24), sq(-108, 20, -107, 22)] });
  assert.equal(S.pointInCone(holed, 19, -107.5), true);
  assert.equal(S.pointInCone(holed, 21, -107.5), false, 'in the hole');
  assert.equal(S.pointInCone(holed, 30, -107.5), false);
  const seam = cone({ type: 'Polygon', coordinates: [sq(178, 10, 182, 14)] });
  assert.equal(S.pointInCone(seam, 12, -179), true);
  assert.equal(S.pointInCone(null, 1, 1), false);
});

test('a place is measured against the official forecast and worded as a forecast, never a verdict', async () => {
  const S = await lib('storms.js');
  const T = Date.UTC(2026, 9, 20, 0);
  const points = [0, 12, 24, 36, 48].map((tau, i) => ({ tau, t: T + tau * HOUR, lat: 19.5 + i * 1.2, lon: -108 - i * 0.6, wind: 50 }));
  const fc = { cycle: new Date(T).toISOString(), points };
  const fmt = { weekday: () => 'Tue', hm12: () => '6:00 PM' };
  const near = S.youCard(fc, { lat: 21, lon: -108 }, null, T + 10 * HOUR);
  assert.ok(near.mi > 30 && near.mi < 60 && near.hoursFromNow > 0);
  assert.equal(near.insideCone, null, 'no cone is unknown, never outside');
  const far = S.youCard(fc, { lat: 40, lon: -70 }, null, T);
  assert.equal(far.far, true);
  const text = JSON.stringify([S.youText(near, fmt), S.youText(far, fmt)]);
  assert.match(text, /Closest forecast approach/);
  assert.match(text, /Far from the forecast track/);
  assert.doesNotMatch(text, /\bsafe\b|arriv|will hit|no threat|no risk/i);
  assert.equal(S.youCard(null, { lat: 1, lon: 1 }, null, T), null);
});

test('wind radii keep "measured none" apart from "not measured", and round-trip', async () => {
  const P = await lib('stormpack.js');
  const fix = (t, radii, rmw = null) => ({ t, lat: 25, lon: -80, wind: 90, status: 'HU', rec: '', radii, rmw });
  const t0 = Date.UTC(2010, 8, 1);
  const storm = { id: 'AL052010', name: 'X', basin: 'AL', year: 2010, fixes: [
    fix(t0, [100, 90, 80, 70, 50, 40, 30, 20, 20, 10, 5, 0], 15),   // measured
    fix(t0 + 6 * HOUR, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),         // measured: none
    fix(t0 + 12 * HOUR, null),                                          // not measured
  ] };
  const rad = P.decodeRadii(JSON.parse(JSON.stringify(P.encodeRadii([storm]))));
  const by = rad.get('AL052010');
  assert.deepEqual(by.get(0).r, { 34: [100, 90, 80, 70], 50: [50, 40, 30, 20], 64: [20, 10, 5, 0] });
  assert.equal(by.get(0).rmw, 15);
  assert.deepEqual(by.get(1).r[34], [0, 0, 0, 0], 'measured: none');
  assert.equal(by.has(2), false, 'not measured: absent, never zero');
  assert.equal(P.decodeRadii({ radii: { AL1: [[0, 1, 2]], AL2: 'x' } }).size, 0, 'a malformed row is dropped');
});

test('radii are interpolated between measured fixes, a record without radii is skipped, and nothing is drawn before 2004', async () => {
  const S = await lib('storms.js');
  const T0 = Date.UTC(2005, 7, 29, 12);
  const mk = (year, hours) => ({ id: 'AL122005', basin: 'AL', year, n: hours.length, t: Float64Array.from(hours.map((h) => T0 + h * HOUR)),
    lat: new Float32Array(hours.length).fill(28), lon: new Float32Array(hours.length).fill(-90), wind: new Int16Array(hours.length).fill(100) });
  const r = (n) => ({ rmw: null, r: { 34: [n, n, n, n], 50: [0, 0, 0, 0], 64: [0, 0, 0, 0] } });
  const katrina = mk(2005, [0, 2.75, 6]);
  const by = new Map([[0, r(200)], [2, r(100)]]);                      // the 14:45 landfall record has none
  const at = (st, m, h) => S.radiiAt(st, m, T0 + h * HOUR);
  assert.ok(Math.abs(at(katrina, by, 2).r[34][0] - 166.7) < 0.1, 'a third of the way from 200 to 100');
  assert.deepEqual(at(mk(1999, [0, 6]), by, 1), { known: false, r: null });
  assert.deepEqual(at(katrina, null, 2), { known: false, r: null }, 'not loaded yet');
  assert.deepEqual(at(mk(2005, [0, 6, 12]), new Map([[0, r(80)]]), 4), { known: false, r: null }, 'one side only, more than three hours away');
});

test('a threshold outline is four quarter circles in their own quadrants, 100 nm out, unwrapped at the dateline', async () => {
  const S = await lib('storms.js');
  const ring = S.radiiRing(30, -90, [100, 0, 0, 0]);
  assert.equal(ring.length, 64);
  assert.ok(Math.abs(ring[0][0] - (30 + 100 / 60)) < 1e-6 && Math.abs(ring[0][1] + 90) < 1e-6, 'bearing 0 is due north');
  assert.ok(ring[7][0] > 30 && ring[7][1] > -90, 'the NE quadrant is north and east');
  const sw = S.radiiRing(30, -90, [0, 0, 100, 0])[39];
  assert.ok(sw[0] < 30 && sw[1] < -90, 'the SW quadrant is south and west');
  assert.deepEqual(S.radiiRing(30, -90, [0, 0, 0, 0]), []);
  assert.ok(Math.max(...S.radiiRing(10, 179.5, [100, 100, 100, 100]).map((p) => p[1])) > 180, 'longitude carries on past 180');
  assert.equal(S.normRadii({ 34: [0, 0, 0, 0] }), null);
  assert.deepEqual(S.radiiText({ 34: [10, 20, 30, 40] }), ['34 kt: NE 10, SE 20, SW 30, NW 40 nm']);
});

test('the five models are named in the order shown, a run is labelled by its UTC hour, and a run 12 h behind NHC is old', async () => {
  const S = await lib('storms.js');
  assert.deepEqual(S.MODELS.map((m) => m.key), ['AVNO', 'EMXI', 'HFSA', 'HFSB', 'CTCX']);
  assert.deepEqual(S.MODELS.map((m) => m.name), ['GFS', 'ECMWF', 'HAFS-A', 'HAFS-B', 'COAMPS-TC']);
  assert.equal(S.runLabel('2026-10-20T06:00:00.000Z'), '06Z');
  assert.equal(S.runLabel('x'), '');
  const T = Date.UTC(2026, 9, 20, 12);
  assert.equal(S.runLag(new Date(T - 6 * HOUR).toISOString(), new Date(T).toISOString()), 6);
  assert.equal(S.runLag(new Date(T + 6 * HOUR).toISOString(), new Date(T).toISOString()), 0);
  assert.equal(S.runLag('x', new Date(T).toISOString()), null);
  assert.deepEqual([11.9, 12, null].map(S.isOldRun), [false, true, false]);
});

test('a run with no time is labelled nothing, not 00Z', async () => {
  const S = await lib('storms.js');
  assert.equal(S.runLabel(null), '');
  assert.equal(S.runLabel(undefined), '');
  assert.equal(S.runLabel(''), '');
});

// ------------------------------------------------------------------ analogs
const HR6 = 6 * HOUR;
const track = (id, t0, pts, land = []) => ({ id, name: id, basin: 'AL', year: new Date(t0).getUTCFullYear(), n: pts.length,
  t: Float64Array.from(pts, (_, i) => t0 + i * HR6), lat: Float32Array.from(pts, (p) => p[0]), lon: Float32Array.from(pts, (p) => p[1]),
  wind: Int16Array.from(pts, (p) => (p[2] == null ? -99 : p[2])), status: 'H'.repeat(pts.length), land });
const straight = (lat0, lon0, dlat, dlon, n, w0 = 40, dw = 3) => Array.from({ length: n }, (_, i) => [lat0 + dlat * i, lon0 + dlon * i, w0 + dw * i]);
const headOf = (s, n) => ({ n, t: s.t.slice(0, n), lat: s.lat.slice(0, n), lon: s.lon.slice(0, n), wind: s.wind.slice(0, n) });

test('a storm matches itself exactly and ranks first; a look-alike beats an unrelated one; a far one is not scored', async () => {
  const S = await lib('storms.js');
  const T0 = Date.UTC(2010, 8, 10);
  const A = track('AL011999', T0, straight(15, -50, 0.4, -0.8, 24));
  const B = track('AL021999', T0, straight(15.2, -49.8, 0.4, -0.8, 24, 45));
  const C = track('AL031999', T0 + 150 * 24 * 3600000, straight(19, -57, -0.4, 0.8, 24, 70, -2));
  const D = track('AL041999', T0, straight(40, 10, 0.4, -0.8, 24));
  const r = S.analogs(headOf(A, 10), [A, B, C, D], { k: 10 });
  assert.deepEqual(r.results.map((x) => x.storm.id).slice(0, 2), ['AL011999', 'AL021999']);
  assert.ok(r.results[0].score < 1e-6 && r.results[0].endIndex === 9);
  assert.ok(!r.results.some((x) => x.storm.id === 'AL041999'), 'too far to rank');
  assert.ok(!S.analogs(headOf(A, 10), [A, B], { excludeId: 'AL011999' }).results.some((x) => x.storm.id === 'AL011999'));
});

test('under 18 hours of track is "too early", and what a matched storm did next is worded as what happened', async () => {
  const S = await lib('storms.js');
  const T0 = Date.UTC(2010, 8, 10);
  const A = track('AL011999', T0, straight(15, -50, 0.4, -0.8, 24));
  assert.equal(S.analogs(headOf(A, 3), [A]).tooShort, true);
  assert.equal(S.analogs(headOf(A, 4), [A]).tooShort, false);
  const pts = straight(20, -60, 0.1, -0.9, 30, 50, 0).map((p, i) => [p[0], p[1], i <= 16 ? 50 + i * 4 : 114 - (i - 16) * 5]);
  const s1 = track('AL011999', T0, pts, [20]);
  const nx = S.nextAfter({ storm: s1, endIndex: 9, endT: s1.t[9] });
  assert.equal(nx.i1, 29);
  assert.ok(nx.lines.some((l) => /^Its wind peaked at 114 kt \(Category 4\), 42 h later\.$/.test(l)), nx.lines.join(' | '));
  assert.ok(nx.lines.includes('A landfall is recorded in this stretch.'));
  assert.deepEqual(S.nextAfter({ storm: s1, endIndex: 29, endT: s1.t[29] }).lines, ['Its track ends at this point.']);
  assert.doesNotMatch(nx.lines.join(' '), /\b(will|likely|expected|predict)\b/i);
  assert.deepEqual([0, 90, 180, 270].map((d) => S.bearing(0, 0, Math.cos(d * Math.PI / 180), Math.sin(d * Math.PI / 180))).map(Math.round), [0, 90, 180, 270]);
  assert.equal(S.compass(315), 'northwest');
});
