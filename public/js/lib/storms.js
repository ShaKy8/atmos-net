/**
 * STORMS — what tropical cyclones have done near a place, from NHC's
 * best-track archive.
 *
 * Pure rules, in the spirit of sats.js and tonight.js: no DOM, no network, no
 * zero-argument `new Date()`. Storms come in as stormpack.js's decoded
 * columns; "today" is always a millisecond argument.
 *
 * Wording is part of the rules. The archive records where a storm's centre
 * was every six hours, not what a place felt, so nothing here says "hit" or
 * "felt": a storm *passed within* some distance, and its wind is the wind
 * *when it was nearest*. The distances are to the straight line between
 * fixes, which is how a track is drawn and the best the data allows.
 */

export const KM_PER_MI = 1.609344;
const EARTH_KM = 6371;
const RAD = Math.PI / 180;
const DAY = 86400000;

/** Saffir-Simpson thresholds, knots. Below 34 is a depression (or unknown). */
export const CATEGORIES = [
  { key: 'TD', min: 0, label: 'Tropical depression', color: '#7fb2f0', width: 1.2 },
  { key: 'TS', min: 34, label: 'Tropical storm', color: '#3fd0d8', width: 1.6 },
  { key: 'C1', min: 64, label: 'Category 1', color: '#8fdc6a', width: 2 },
  { key: 'C2', min: 83, label: 'Category 2', color: '#f2b45a', width: 2.4 },
  { key: 'C3', min: 96, label: 'Category 3', color: '#f09a5a', width: 2.8 },
  { key: 'C4', min: 113, label: 'Category 4', color: '#f47171', width: 3.2 },
  { key: 'C5', min: 137, label: 'Category 5', color: '#f07aa6', width: 3.6 },
];

/** The category for a wind in knots, or null when the archive has no wind. */
export function category(kt) {
  if (kt == null || !(kt >= 0)) return null;
  let c = CATEGORIES[0];
  for (const x of CATEGORIES) if (kt >= x.min) c = x;
  return c;
}

/** Great-circle distance, km. */
export function gcKm(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * RAD, dLon = (lon2 - lon1) * RAD;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Degrees of longitude difference folded into [-180, 180]. */
const wrap180 = (d) => ((((d + 180) % 360) + 360) % 360) - 180;

/** Wind in knots at fix i, or null. */
export const windAt = (storm, i) => (storm.wind[i] === -99 ? null : storm.wind[i]);

/**
 * The nearest the storm's track came to a point: the closest point on the
 * straight lines between fixes, with position, time and wind interpolated to
 * it. Not limited to the fixes themselves, because a six-hour step is 100 km
 * or more and the track passes between them.
 */
export function closestApproach(storm, lat, lon) {
  const cosLat = Math.cos(lat * RAD);
  let best = null;
  const n = storm.n;
  for (let i = 0; i < n; i++) {
    const x1 = wrap180(storm.lon[i] - lon) * cosLat * 111.32, y1 = (storm.lat[i] - lat) * 110.574;
    let u = 0, x = x1, y = y1;
    if (i + 1 < n) {
      const x2 = x1 + wrap180(storm.lon[i + 1] - storm.lon[i]) * cosLat * 111.32;
      const y2 = (storm.lat[i + 1] - lat) * 110.574;
      const dx = x2 - x1, dy = y2 - y1, len2 = dx * dx + dy * dy;
      u = len2 > 0 ? Math.max(0, Math.min(1, -(x1 * dx + y1 * dy) / len2)) : 0;
      x = x1 + u * dx; y = y1 + u * dy;
    }
    const approx = Math.hypot(x, y);
    if (!best || approx < best.approx) best = { i, u, approx };
  }
  const { i, u } = best;
  const j = Math.min(i + 1, n - 1);
  const pLat = storm.lat[i] + u * (storm.lat[j] - storm.lat[i]);
  const pLon = storm.lon[i] + u * (storm.lon[j] - storm.lon[i]);
  const w1 = windAt(storm, i), w2 = windAt(storm, j);
  const wind = w1 == null ? w2 : w2 == null ? w1 : w1 + u * (w2 - w1);
  return {
    km: gcKm(lat, lon, pLat, wrap180(pLon)),
    i, u, lat: pLat, lon: wrap180(pLon),
    t: storm.t[i] + u * (storm.t[j] - storm.t[i]),
    wind,
  };
}

/** Storms whose track came within `radiusKm` of a point, nearest first. */
export function nearbyStorms(storms, lat, lon, radiusKm) {
  const out = [];
  for (const storm of storms) {
    const c = closestApproach(storm, lat, lon);
    if (c.km <= radiusKm) out.push({ storm, ...c });
  }
  return out.sort((a, b) => a.km - b.km);
}

/** Display name: "Katrina 2005", or "Unnamed 1851" for the early storms. */
export function titleOf(storm) {
  const name = storm.name ? storm.name.toLowerCase().replace(/(^|[ -])([a-z])/g, (_, a, b) => a + b.toUpperCase()) : 'Unnamed';
  return `${name} ${storm.year}`;
}

/**
 * The headline facts for a place. `near` is nearbyStorms() output for a
 * radius of at least 150 miles.
 *   closest   - the storm that passed nearest, with its wind when nearest
 *   within100 - how many passed within 100 miles
 *   strongest - the greatest wind-when-nearest among those within 150 miles
 */
export function facts(near) {
  const mi = (x) => x.km / KM_PER_MI;
  const within150 = near.filter((x) => mi(x) <= 150);
  const strongest = within150.reduce((b, x) => (x.wind != null && (!b || x.wind > b.wind) ? x : b), null);
  return {
    closest: near[0] || null,
    within100: near.filter((x) => mi(x) <= 100).length,
    within150: within150.length,
    strongest,
  };
}

/** Day of the year (1-366) in UTC for a millisecond time. */
export function dayOfYear(ms) {
  const d = new Date(ms);
  return Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 1)) / DAY) + 1;
}

/**
 * Where `todayMs` falls in a basin's season, from every storm in the archive:
 * each (storm, day) with tropical-storm winds counts once. `behind` is the
 * share of those days that fall on or before today's date, `peakDoy` the
 * busiest day. A season ring needs nothing else.
 */
export function seasonProgress(storms, basin, todayMs) {
  const hist = new Float64Array(367);
  for (const s of storms) {
    if (s.basin !== basin) continue;
    const seen = new Set();
    for (let i = 0; i < s.n; i++) {
      const w = windAt(s, i);
      if (w == null || w < 34) continue;
      seen.add(dayOfYear(s.t[i]));
    }
    for (const d of seen) hist[d]++;
  }
  const total = hist.reduce((a, b) => a + b, 0);
  const doy = dayOfYear(todayMs);
  let upTo = 0, peakDoy = 1;
  for (let d = 1; d <= 366; d++) {
    if (d <= doy) upTo += hist[d];
    if (hist[d] > hist[peakDoy]) peakDoy = d;
  }
  return { doy, peakDoy, behind: total ? upTo / total : 0, days: total, hist };
}

/**
 * Storms that were active within `window` days of today's month and day, in
 * any year, strongest first. Each carries the matched fix date.
 */
export function onThisDate(storms, todayMs, window = 3) {
  const today = new Date(todayMs);
  const out = [];
  for (const s of storms) {
    let peak = null;
    for (let i = 0; i < s.n; i++) {
      const d = new Date(s.t[i]);
      const target = Date.UTC(d.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
      if (Math.abs(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - target) > window * DAY) continue;
      const w = windAt(s, i) ?? 0;
      if (!peak || w > peak.wind) peak = { i, wind: w };
    }
    if (peak) out.push({ storm: s, ...peak });
  }
  return out.sort((a, b) => b.wind - a.wind);
}

/** Position and wind along a storm at time t (ms), clamped to its life. */
export function positionAt(storm, t) {
  const n = storm.n;
  if (t <= storm.t[0]) return { lat: storm.lat[0], lon: storm.lon[0], wind: windAt(storm, 0), i: 0, u: 0 };
  if (t >= storm.t[n - 1]) return { lat: storm.lat[n - 1], lon: storm.lon[n - 1], wind: windAt(storm, n - 1), i: n - 1, u: 0 };
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (storm.t[mid] <= t) lo = mid; else hi = mid; }
  const u = (t - storm.t[lo]) / (storm.t[hi] - storm.t[lo]);
  const w1 = windAt(storm, lo), w2 = windAt(storm, hi);
  return {
    lat: storm.lat[lo] + u * (storm.lat[hi] - storm.lat[lo]),
    lon: storm.lon[lo] + u * (storm.lon[hi] - storm.lon[lo]),
    wind: w1 == null ? w2 : w2 == null ? w1 : w1 + u * (w2 - w1),
    i: lo, u,
  };
}

/**
 * A caveat for how far to trust a storm's track and strength, by year, or
 * null for the modern record. The archive says so itself: its early years are
 * reconstructions.
 */
export function eraNote(year) {
  if (year < 1900) return 'Reconstructed from ship reports and coastal records: position and strength are uncertain.';
  if (year < 1966) return 'Before weather satellites: the track is reconstructed and the strength estimated.';
  return null;
}

/* ===================================================================== LIVE
 *
 * The rules for a storm that is happening now, from /api/storms. Same
 * discipline as above: pure, the clock and the time formatter are arguments.
 * The words matter here more than anywhere: this is what a person reads
 * about a storm that may be coming, so it says "closest forecast approach",
 * never "arrival" or "impact", and it never calls a place safe.
 */

const HOUR = 3600000;
export const STALE_HOURS = 7;      // NHC speaks every 6 h: past 7 it has missed one
export const OLD_HOURS = 12;       // past 12 the forecast is out of date
export const FAR_MI = 500;

/**
 * Hours since NHC last said anything about a storm: the newest of its forecast
 * issue time, its advisory time and its latest best-track fix. Null when none
 * of them can be read.
 */
export function advisoryAge(storm, nowMs) {
  const when = [
    Date.parse(storm && storm.forecast && storm.forecast.cycle),
    Date.parse(storm && storm.updated),
    storm && storm.best && storm.best.length ? storm.best[storm.best.length - 1].t : NaN,
  ].filter(Number.isFinite);
  return when.length ? Math.max(0, (nowMs - Math.max(...when)) / HOUR) : null;
}

/** 'fresh' | 'stale' (a missed advisory) | 'old' (forecast out of date) | 'unknown'. */
export function staleness(hours) {
  if (hours == null || !Number.isFinite(hours)) return 'unknown';
  return hours > OLD_HOURS ? 'old' : hours > STALE_HOURS ? 'stale' : 'fresh';
}

/** Is a point inside any polygon of a GeoJSON cone? Even-odd, and seam-safe. */
export function pointInCone(cone, lat, lon) {
  const inRing = (ring, x, y) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  for (const f of (cone && cone.features) || []) {
    const g = f && f.geometry;
    if (!g) continue;
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    for (const rings of polys) {
      for (const x of [lon, lon + 360, lon - 360]) {
        // A ring contains the point; a hole inside it takes it out again.
        if (rings.reduce((n, r) => n + (inRing(r, x, lat) ? 1 : 0), 0) % 2 === 1) return true;
      }
    }
  }
  return false;
}

/**
 * Where a place stands against NHC's official forecast: the closest the
 * forecast track comes, when, and whether the place is inside the cone. Only
 * the official points are used; nothing here forecasts. `cone` may be null
 * (then insideCone is null, "unknown", never false).
 */
export function youCard(forecast, loc, cone, nowMs) {
  const pts = forecast && Array.isArray(forecast.points) ? forecast.points.filter((p) => Number.isFinite(p.t)) : [];
  if (!pts.length || !loc) return null;
  const n = pts.length;
  const track = {
    n,
    t: Float64Array.from(pts, (p) => p.t),
    lat: Float32Array.from(pts, (p) => p.lat),
    lon: Float32Array.from(pts, (p) => p.lon),
    wind: Int16Array.from(pts, (p) => (p.wind == null ? -99 : p.wind)),
  };
  const c = closestApproach(track, loc.lat, loc.lon);
  return {
    km: c.km, mi: c.km / KM_PER_MI, t: c.t, wind: c.wind,
    hoursFromNow: (c.t - nowMs) / HOUR,
    far: c.km > FAR_MI * KM_PER_MI,
    atEnd: c.t >= pts[n - 1].t - 60000,        // the closest point is where the forecast stops
    lastTau: pts[n - 1].tau,
    insideCone: cone ? pointInCone(cone, loc.lat, loc.lon) : null,
  };
}

/** "in 38 h", "4 h ago", "within the hour". */
function relative(hours) {
  const h = Math.round(Math.abs(hours));
  return h < 1 ? 'within the hour' : hours > 0 ? `in ${h} h` : `${h} h ago`;
}

/**
 * The words for a YOU card: { headline, lines, cone }. `fmt` is the console's
 * time formatter for the place (weekday, hm12), so times are the place's own.
 */
export function youText(card, fmt) {
  if (!card) return null;
  const mi = Math.round(card.mi);
  const when = `${fmt.weekday(card.t)} ${fmt.hm12(card.t)}, ${relative(card.hoursFromNow)}`;
  const lines = [];
  if (card.far) lines.push(`Far from the forecast track: the closest it comes is ${mi} mi.`);
  if (card.atEnd) lines.push(`NHC's forecast stops ${card.lastTau} h out, so the track may come closer than this.`);
  const cone = card.insideCone === true ? 'This place is inside the forecast cone.'
    : card.insideCone === false ? 'This place is outside the forecast cone. That does not mean outside the storm\'s reach: wind and rain extend well beyond the cone.'
    : 'The forecast cone is not available right now.';
  return {
    headline: `Closest forecast approach: ${mi} mi, ${when}`,
    lines,
    cone,
    note: 'The cone shows where the centre is expected to stay about two-thirds of the time. It is not the size of the storm or its impacts.',
  };
}

/* ============================================================ WIND RADII
 *
 * NHC measures, for each storm and time, how far winds of 34, 50 and 64 knots
 * reach in each quadrant (NE SE SW NW, nautical miles). That is the wind
 * field here: a quarter circle per quadrant at each threshold, exactly what
 * the numbers say and no smoother. Nothing is modelled. HURDAT2 only has
 * them from 2004, so an older storm has no wind field at all and says so
 * rather than being given an invented one.
 */

export const THRESHOLDS = [34, 50, 64];
export const RADII_FROM_YEAR = 2004;
const NM_PER_DEG = 60;
const QUAD0 = [0, 0, 0, 0];

/** Radii in any of the shapes they arrive in -> { 34: [4], 50: [4], 64: [4] } or null when none is above zero. */
export function normRadii(r) {
  if (!r || typeof r !== 'object') return null;
  const out = {};
  let any = false;
  for (const k of THRESHOLDS) {
    const q = r[k] || r[String(k)];
    out[k] = Array.isArray(q) && q.length === 4 ? q.map((v) => (Number.isFinite(v) && v > 0 ? v : 0)) : QUAD0;
    if (out[k].some((v) => v > 0)) any = true;
  }
  return any ? out : null;
}

/**
 * The wind radii of a replayed storm at time t, from its decoded radii
 * (stormpack's decodeRadii: Map of fix index to { r }). Returns
 * { known, r }: known false when NHC did not measure them (before 2004, or
 * the fixes either side have no radii); known true with r null when they were
 * measured and there is no wind that strong; otherwise r is
 * { 34: [NE SE SW NW], 50: [...], 64: [...] }.
 *
 * Fixes that were not measured are skipped, not read as zero: the landfall
 * records HURDAT2 puts between the six-hourly fixes often have no radii, and
 * counting them as zero shrank Katrina's field to nothing during landfall.
 * Between the nearest measured fix on each side each quadrant is interpolated
 * by time; with only one side measured it is used within three hours of it.
 */
export function radiiAt(storm, byFix, t) {
  const unknown = { known: false, r: null };
  if (!storm || !byFix || storm.year < RADII_FROM_YEAR) return unknown;
  const n = storm.n;
  if (t < storm.t[0] || t > storm.t[n - 1]) return unknown;
  let hi = 0;
  while (hi < n - 1 && storm.t[hi] < t) hi++;
  // before: the nearest measured fix at or before t; after: at or after t
  let before = storm.t[hi] === t || hi === 0 ? hi : hi - 1, after = hi;
  while (before >= 0 && !byFix.has(before)) before--;
  while (after < n && !byFix.has(after)) after++;
  const a = before >= 0 ? normRadii(byFix.get(before).r) || { 34: QUAD0, 50: QUAD0, 64: QUAD0 } : null;
  const b = after < n ? normRadii(byFix.get(after).r) || { 34: QUAD0, 50: QUAD0, 64: QUAD0 } : null;
  const ta = before >= 0 ? storm.t[before] : null, tb = after < n ? storm.t[after] : null;
  let out;
  if (a && b) {
    const u = tb === ta ? 0 : (t - ta) / (tb - ta);
    out = {};
    for (const k of THRESHOLDS) out[k] = a[k].map((v, q) => v + u * (b[k][q] - v));
  } else if (a && t - ta <= 3 * 3600000) out = a;
  else if (b && tb - t <= 3 * 3600000) out = b;
  else return unknown;
  return { known: true, r: normRadii(out) };
}

/**
 * The outline of one threshold as [lat, lon] points around a centre: four
 * quarter circles, NE (bearing 0-90) clockwise to NW, each at its own radius,
 * so where two quadrants differ the outline steps along the radial line, as
 * NHC draws it. Longitudes continue from the centre's (nothing is wrapped).
 * Empty when every quadrant is zero.
 */
export function radiiRing(lat, lon, quad, stepDeg = 6) {
  if (!quad || !quad.some((v) => v > 0)) return [];
  const cos = Math.max(0.05, Math.cos(lat * RAD));
  const ring = [];
  for (let q = 0; q < 4; q++) {
    const r = quad[q] > 0 ? quad[q] : 0;
    for (let d = q * 90; d <= (q + 1) * 90; d += stepDeg) {
      const th = d * RAD;
      ring.push([lat + (r * Math.cos(th)) / NM_PER_DEG, lon + (r * Math.sin(th)) / (NM_PER_DEG * cos)]);
    }
  }
  return ring;
}

/** "34 kt: NE 120 SE 60 SW 60 NW 100 nm" for each threshold that has a wind. */
export function radiiText(r) {
  const n = normRadii(r);
  if (!n) return [];
  return THRESHOLDS.filter((k) => n[k].some((v) => v > 0))
    .map((k) => `${k} kt: NE ${Math.round(n[k][0])}, SE ${Math.round(n[k][1])}, SW ${Math.round(n[k][2])}, NW ${Math.round(n[k][3])} nm`);
}

/* ===================================================================== MODELS
 *
 * Model guidance: each line on the map is one computer model's own forecast of
 * where the storm goes. They disagree, and the spread is the point, but it is
 * a spread of models, not a probability, and it is not NHC's forecast: NHC's
 * (the official line) weighs these and more. The words say so.
 */

/** In the order shown. `name` is what the model is; `group` is where it comes from. */
export const MODELS = [
  { key: 'AVNO', name: 'GFS', note: 'NOAA global model' },
  { key: 'EMXI', name: 'ECMWF', note: 'European global model' },
  { key: 'HFSA', name: 'HAFS-A', note: 'NOAA hurricane model' },
  { key: 'HFSB', name: 'HAFS-B', note: 'NOAA hurricane model' },
  { key: 'CTCX', name: 'COAMPS-TC', note: 'US Navy hurricane model' },
];

/** The run's own time, in UTC, as "18Z". */
export function runLabel(cycle) {
  const t = Date.parse(cycle);              // null and undefined are NaN here; new Date(null) would be 1970
  return Number.isFinite(t) ? `${String(new Date(t).getUTCHours()).padStart(2, '0')}Z` : '';
}

/** Hours by which a model's run is older than the official forecast's (0 when it is as new or newer, null when either is unreadable). */
export function runLag(modelCycle, officialCycle) {
  const m = Date.parse(modelCycle), o = Date.parse(officialCycle);
  return Number.isFinite(m) && Number.isFinite(o) ? Math.max(0, (o - m) / HOUR) : null;
}

/** A model whose run is 12 or more hours older than NHC's latest forecast is old guidance. */
export const OLD_RUN_HOURS = 12;
export const isOldRun = (lag) => lag != null && lag >= OLD_RUN_HOURS;

/* ==================================================================== ANALOGS
 *
 * Which past storms did the last two days of this one look like, and what did
 * they do next? A similarity search over NHC's best tracks, and nothing more:
 * it compares where a storm was, how strong, which way it was heading and what
 * time of year it is. It knows nothing of steering winds, wind shear or sea
 * temperature, which are what actually decide where a storm goes, and the
 * archive holds a few thousand storms in 175 years, thin in any one place.
 * A similarity score is not a probability and has never been checked against
 * what happened. So this module returns tracks, and the words around it say
 * "similar", never "will".
 *
 * Pure, like the rest: tracks in, ranked matches out, no clock.
 */

const STEP = 6 * HOUR;
export const ANALOG_WINDOW = 8;           // fixes: 42 hours of six-hourly track
export const ANALOG_MIN = 4;              // fewer is too little track to match: 18 hours
export const ANALOG_REACH_KM = 1500;      // a window ending farther than this from the live storm cannot rank
export const ANALOG_NEXT_HOURS = 120;
/** The score is a weighted sum of each difference over its scale: lower is more alike. */
export const ANALOG_WEIGHTS = { pos: 0.6, wind: 0.2, head: 0.1, season: 0.1 };
export const ANALOG_SCALES = { pos: 150, wind: 20, head: 45, season: 30 };   // km, kt, degrees, days

/** Initial bearing, degrees clockwise from north, from one point to another (longitudes may be unwrapped). */
export function bearing(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * RAD, p2 = lat2 * RAD, dl = (lon2 - lon1) * RAD;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}

const COMPASS = ['north', 'north-northeast', 'northeast', 'east-northeast', 'east', 'east-southeast', 'southeast', 'south-southeast',
  'south', 'south-southwest', 'southwest', 'west-southwest', 'west', 'west-northwest', 'northwest', 'north-northwest'];
/** 'northwest' for 315 degrees. */
export const compass = (deg) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];

/** Smallest angle between two bearings, 0-180. */
const angleDiff = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

/** The track sampled every six hours back from `endT`, `count` points, as { lat, lon, wind } (wind null when unknown). */
function gridOf(track, endT, count) {
  const out = [];
  for (let k = 0; k < count; k++) {
    const p = positionAt(track, endT - STEP * (count - 1 - k));
    out.push({ lat: p.lat, lon: p.lon, wind: p.wind });
  }
  return out;
}

/**
 * The past storms whose track, over the same stretch of time, looked most like
 * `query` ({ n, t, lat, lon, wind }: the live storm's best track so far).
 *
 * The query's last `window` fixes (at most 42 h, at least 18 h) are laid
 * against every window of every storm that ends on a synoptic fix, and each
 * window is scored on how far apart the two tracks run (RMS km), how different
 * their winds are (RMS kt), how different their headings are (degrees) and how
 * far apart in the year they are (days). Each storm contributes its best
 * window; the top `k` come back, best first, as
 *   { storm, score, parts: { posKm, windKt, headDeg, seasonDays }, window, startT, endT, endIndex }.
 * `tooShort` is true when the query has less than 18 h of track. `excludeId`
 * keeps a storm from matching itself.
 */
export function analogs(query, storms, { k = 5, window = ANALOG_WINDOW, excludeId = null } = {}) {
  const none = { tooShort: false, window: 0, results: [] };
  if (!query || !(query.n >= 2)) return { ...none, tooShort: true };
  const tEnd = query.t[query.n - 1];
  const W = Math.min(window, Math.floor((tEnd - query.t[0]) / STEP) + 1);
  if (W < ANALOG_MIN) return { ...none, tooShort: true, window: W };
  const q = gridOf(query, tEnd, W);
  const qLast = q[W - 1];
  const qHead = bearing(q[0].lat, q[0].lon, qLast.lat, qLast.lon);
  const qDoy = dayOfYear(tEnd);
  const { pos: wp, wind: ww, head: wh, season: ws } = ANALOG_WEIGHTS;
  const sc = ANALOG_SCALES;
  const results = [];
  for (const s of storms) {
    if (s.id === excludeId || s.n < W) continue;
    let best = null;
    for (let j = W - 1; j < s.n; j++) {
      if (s.t[j] % STEP !== 0) continue;                              // windows end on a synoptic fix (00, 06, 12, 18 Z)
      const start = s.t[j] - STEP * (W - 1);
      if (start < s.t[0]) continue;
      if (gcKm(qLast.lat, qLast.lon, s.lat[j], s.lon[j]) > ANALOG_REACH_KM) continue;
      let sq = 0, wsq = 0, wn = 0;
      const first = positionAt(s, start);
      for (let i = 0; i < W; i++) {
        const p = i === 0 ? first : positionAt(s, start + STEP * i);
        const d = gcKm(q[i].lat, q[i].lon, p.lat, p.lon);
        sq += d * d;
        if (q[i].wind != null && p.wind != null) { const dw = q[i].wind - p.wind; wsq += dw * dw; wn++; }
      }
      const last = positionAt(s, s.t[j]);
      const posKm = Math.sqrt(sq / W);
      const windKt = wn ? Math.sqrt(wsq / wn) : 0;
      const moved = gcKm(first.lat, first.lon, last.lat, last.lon) > 10 && gcKm(q[0].lat, q[0].lon, qLast.lat, qLast.lon) > 10;
      const headDeg = moved ? angleDiff(qHead, bearing(first.lat, first.lon, last.lat, last.lon)) : 0;
      const dd = Math.abs(qDoy - dayOfYear(s.t[j]));
      const seasonDays = Math.min(dd, 365 - dd);
      const score = wp * posKm / sc.pos + ww * windKt / sc.wind + wh * headDeg / sc.head + ws * seasonDays / sc.season;
      if (!best || score < best.score) best = { storm: s, score, parts: { posKm, windKt, headDeg, seasonDays }, window: W, startT: start, endT: s.t[j], endIndex: j };
    }
    if (best) results.push(best);
  }
  results.sort((a, b) => a.score - b.score);
  return { ...none, window: W, results: results.slice(0, k) };
}

/**
 * What the matched storm went on to do: the indices of its fixes after the
 * match, up to `hours` later (or to where its track ends), with the plain
 * facts of that stretch as lines of text. These are things that HAPPENED to a
 * different storm. `hoursAvailable` says how much of the stretch the record has.
 */
export function nextAfter(match, hours = ANALOG_NEXT_HOURS) {
  const s = match.storm, j = match.endIndex;
  let i1 = j;
  while (i1 + 1 < s.n && s.t[i1 + 1] <= match.endT + hours * HOUR) i1++;
  const hoursAvailable = (s.t[s.n - 1] - match.endT) / HOUR;
  const lines = [];
  if (i1 === j) {
    lines.push('Its track ends at this point.');
    return { i0: j, i1, hoursAvailable, lines };
  }
  let peak = null;
  for (let i = j + 1; i <= i1; i++) {
    const w = windAt(s, i);
    if (w != null && (!peak || w > peak.w)) peak = { w, h: (s.t[i] - match.endT) / HOUR };
  }
  const here = windAt(s, j);
  if (peak) {
    const c = category(peak.w);
    lines.push(here != null && peak.w <= here
      ? `Its wind did not rise above ${Math.round(here)} kt.`
      : `Its wind peaked at ${Math.round(peak.w)} kt${c && c.min >= 64 ? ` (${c.label})` : ''}, ${Math.round(peak.h)} h later.`);
  }
  if (s.land.some((i) => i > j && i <= i1)) lines.push('A landfall is recorded in this stretch.');
  const km = gcKm(s.lat[j], s.lon[j], s.lat[i1], s.lon[i1]);
  if (km > 20) lines.push(`It moved ${Math.round(km / KM_PER_MI)} mi toward the ${compass(bearing(s.lat[j], s.lon[j], s.lat[i1], s.lon[i1]))} over ${Math.round((s.t[i1] - match.endT) / HOUR)} h.`);
  if (hoursAvailable < hours) lines.push(`Its track ends ${Math.round(hoursAvailable)} h after this point.`);
  return { i0: j, i1, hoursAvailable, lines };
}
