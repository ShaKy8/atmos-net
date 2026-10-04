/**
 * ELSEWHERE — is it better somewhere you have been?
 *
 * Ranks a handful of places against where the visitor is now. The answer is a
 * comparison, not a report: "+6° warmer, clear" says something a bare "17°C"
 * does not, because the reader already knows what it is like out of their own
 * window.
 *
 * Pure rules, like putt.js and orbit.js: no DOM, no network, no zero-argument
 * `new Date()`. Everything time-dependent is passed in, so the same inputs
 * always give the same ranking and the whole thing can be exercised from Node
 * against live forecasts.
 *
 * WHAT "BETTER" MEANS IS A DECISION, and it is made here rather than in a
 * chart nobody reads. Warmer is not automatically better — 39°C is not an
 * improvement on 21°C — so temperature is scored as a distance from
 * comfortable rather than as a magnitude. Rain outranks cloud, cloud outranks
 * wind, and every term is clamped on its own: clamping only the sum is what
 * made TONIGHT's five clear nights score identically.
 */

/** Where the temperature curve peaks, in Celsius. Everything is distance from here. */
export const IDEAL_C = 21;
/** Degrees away from IDEAL_C at which the temperature term reaches zero. */
export const TEMP_SPAN = 18;
/** mm/h of precipitation that zeroes the dry term. */
export const SOAKED_MM = 2;
/** km/h above which wind starts costing, and the span over which it costs all of it. */
export const BREEZY_KMH = 20;
export const GALE_SPAN = 40;

const clamp01 = (n) => (n < 0 ? 0 : n > 1 ? 1 : n);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Normalise one place's `current` block to the metric the scoring uses.
 *
 * THE UNITS COME FROM THE PAYLOAD, never from an assumption. This API serves
 * °F, mp/h and inches, and the scoring curve is Celsius — hand 91.5 °F to a
 * function expecting Celsius and it scores a pleasant afternoon as unbearable
 * with no error anywhere. Open-Meteo ships a `current_units` block precisely
 * so nobody has to guess, so it is read.
 */
export function fromCurrent(name, current, units = {}, extra = {}) {
  if (!current) return null;
  const t = num(current.temperature_2m);
  const f = String(units.temperature_2m || '').includes('F');
  const w = num(current.wind_speed_10m);
  const mph = /mp\/?h|mph/i.test(String(units.wind_speed_10m || ''));
  const p = num(current.precipitation);
  const inches = /inch/i.test(String(units.precipitation || ''));
  return {
    name,
    /*
     * Scoring is metric; DISPLAY is whatever the API gave. Keeping the raw
     * number means "5° colder" can be said in the reader's own units without
     * this module knowing which those are, and without a second conversion to
     * get wrong.
     */
    tempRaw: t,
    tempC: t === null ? null : (f ? (t - 32) / 1.8 : t),
    windKmh: w === null ? null : (mph ? w * 1.609344 : w),
    precipMm: p === null ? null : (inches ? p * 25.4 : p),
    cloudPct: num(current.cloud_cover),
    night: current.is_day === 0,
    ...extra,
  };
}

/**
 * How pleasant it is to be outside, 0-100.
 *
 * The weights say what this feature believes: being rained on ruins an
 * afternoon faster than cloud does, and wind is the least of it until it is a
 * lot of wind.
 */
export function comfort(c) {
  const t = num(c?.tempC);
  if (t === null) return null;
  const warmth = clamp01(1 - Math.abs(t - IDEAL_C) / TEMP_SPAN);
  const dry = clamp01(1 - (num(c?.precipMm) ?? 0) / SOAKED_MM);
  const bright = clamp01(1 - ((num(c?.cloudPct) ?? 0) / 100) * 0.6);
  const calm = clamp01(1 - Math.max(0, (num(c?.windKmh) ?? 0) - BREEZY_KMH) / GALE_SPAN);
  return Math.round(100 * (0.40 * warmth + 0.30 * dry + 0.20 * bright + 0.10 * calm));
}

/** The single condition worth naming, in the order a person would notice it. */
export function headline(c) {
  const precip = num(c?.precipMm) ?? 0;
  const cloud = num(c?.cloudPct);
  const wind = num(c?.windKmh) ?? 0;
  if (precip >= 0.5) return 'raining';
  if (precip > 0) return 'drizzling';
  if (wind >= BREEZY_KMH + GALE_SPAN / 2) return 'blowing hard';
  if (cloud === null) return null;
  if (cloud <= 15) return 'clear';
  if (cloud <= 45) return 'some cloud';
  if (cloud <= 80) return 'cloudy';
  return 'overcast';
}

/**
 * One place, measured against here.
 *
 * `deltaC` is the number the reader actually wants; the score decides the
 * order. Both are kept because they disagree usefully — somewhere can be
 * warmer and still worse, which is the interesting case.
 */
export function compareTo(here, there) {
  const hs = comfort(here);
  const ts = comfort(there);
  if (ts === null) return null;
  const dt = num(there.tempC) !== null && num(here?.tempC) !== null
    ? Math.round(there.tempC - here.tempC) : null;
  // The same difference in the units the page is showing.
  const dRaw = num(there.tempRaw) !== null && num(here?.tempRaw) !== null
    ? Math.round(there.tempRaw - here.tempRaw) : null;
  return {
    name: there.name,
    score: ts,
    deltaScore: hs === null ? null : ts - hs,
    deltaC: dt,
    deltaShown: dRaw === null ? dt : dRaw,
    better: hs !== null && ts > hs,
    headline: headline(there),
    tempC: num(there.tempC),
    localHour: num(there.localHour),
    night: there.night === true,
  };
}

/**
 * Everywhere, best first.
 *
 * Ties break on the temperature delta and then on name, so the same conditions
 * always produce the same order — a list that reshuffles between refreshes
 * looks broken even when every row is correct.
 */
export function rank(here, places) {
  const rows = (Array.isArray(places) ? places : [])
    .map((p) => compareTo(here, p))
    .filter(Boolean);
  rows.sort((a, b) => b.score - a.score
    || (b.deltaC ?? 0) - (a.deltaC ?? 0)
    || String(a.name).localeCompare(String(b.name)));
  return rows;
}

/** "+6° warmer, clear" — the row, in words. */
export function phrase(row) {
  if (!row) return '';
  const parts = [];
  const d = row.deltaShown ?? row.deltaC;
  if (d !== null && d !== 0) {
    // The word carries the sign. "-5° colder" says it twice and reads as a
    // typo; the magnitude is what the reader wants next to it.
    parts.push(`${Math.abs(d)}° ${d > 0 ? 'warmer' : 'colder'}`);
  } else if (d === 0) {
    parts.push('same temperature');
  }
  if (row.headline) parts.push(row.headline);
  // A place is not "better" at four in the morning in any way the reader can
  // act on, so the hour is said rather than scored.
  if (row.night && row.localHour !== null) parts.push(`${row.localHour}:00 there`);
  return parts.join(', ');
}

/**
 * The deterministic summary. Ships with no API key, and is what gets served
 * when the model is unreachable — the same floor TONIGHT stands on.
 */
export function verdict(hereName, rows) {
  if (!rows.length) return 'Nowhere to compare against right now.';
  const better = rows.filter((r) => r.better);
  if (!better.length) {
    return `Nowhere on the list beats ${hereName} right now.`;
  }
  const top = better[0];
  const rest = better.length - 1;
  return `${top.name} is better than ${hereName} right now — ${phrase(top)}.`
    + (rest > 0 ? ` So ${rest === 1 ? 'is one other' : `are ${rest} others`}.` : '');
}
