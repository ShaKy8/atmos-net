/**
 * TONIGHT — is tonight worth going outside for, and if not, which night is.
 *
 * Pure rules. No DOM, no network, no zero-argument `new Date()`: everything
 * comes in as arguments so this can be run and checked in Node, the same way
 * ONE PUTT's holes and SLINGSHOT's levels are.
 *
 * Calibrated for the NAKED EYE. That is not a simplification, it is a
 * different question: a telescope owner cares about seeing, transparency and
 * whether the optics will dew up, and none of those decide whether it is
 * worth stepping outside to look at the sky. Two things do — whether there is
 * cloud in the way, and whether the moon has washed everything out — plus how
 * long the sky is actually dark for. So those are what this measures, and the
 * headline number is the one a person would ask for: how many hours of clear,
 * moonless dark are there.
 *
 * The output is small on purpose. It is the whole input a language model
 * needs to write the verdict, which keeps that call to a few hundred tokens
 * and means the model can only phrase numbers it was handed, never invent
 * them.
 */

/** How many nights ahead to rank. The forecast supports more; nobody plans on it. */
export const NIGHTS = 7;

/* A naked-eye sky tolerates some cloud; past this it is not worth the coat. */
const CLEAR_CLOUD = 30;        // percent cover at or below which an hour counts as clear
/* Below a quarter lit, the moon stops mattering to anything but the faintest objects. */
const MOON_IGNORE = 0.25;      // illuminated fraction below which moonlight is irrelevant

const HOUR = 3600e3;

/** The nearest hourly record to an instant, or null if the forecast is short. */
function hourAt(hours, t) {
  if (!hours?.length) return null;
  let best = null, bestGap = Infinity;
  for (const h of hours) {
    const gap = Math.abs(h.t - t);
    if (gap < bestGap) { bestGap = gap; best = h; }
  }
  return bestGap <= HOUR ? best : null;
}

/**
 * Astronomical twilight if this latitude and date have any, else nautical,
 * else civil. Above about 49° there are summer weeks with no astronomical
 * night at all, and returning nothing for those would be wrong — the sky is
 * still worth looking at, it is just never fully dark.
 */
function darkEdge(times, keys) {
  for (const k of keys) {
    const v = times[k];
    if (v instanceof Date && !Number.isNaN(+v)) return { at: +v, kind: k };
  }
  return null;
}

/**
 * One night's worth of judgement.
 *
 * @param hours   normalised hourly series ({t, cloud, ...}), any length
 * @param sun     sunTimes() for the day the night begins on
 * @param sunNext sunTimes() for the following day
 * @param moonAlt (tMs) => degrees above the horizon
 * @param moonLit (tMs) => illuminated fraction, 0..1
 */
export function assessNight(hours, sun, sunNext, moonAlt, moonLit) {
  const start = darkEdge(sun, ['night', 'nauticalDusk', 'dusk']);
  const end = darkEdge(sunNext, ['nightEnd', 'nauticalDawn', 'dawn']);
  if (!start || !end || end.at <= start.at) {
    return { dark: null, samples: [], goodHours: 0, score: 0, reason: 'no darkness' };
  }

  /*
   * Sample on the hour, because that is the resolution the forecast has.
   * Anything finer would be interpolation dressed up as knowledge.
   */
  const samples = [];
  const first = Math.ceil(start.at / HOUR) * HOUR;
  for (let t = first; t <= end.at; t += HOUR) {
    const h = hourAt(hours, t);
    if (!h) continue;
    const lit = moonLit(t);
    const up = moonAlt(t) > 0;
    samples.push({
      t,
      cloud: h.cloud ?? null,
      moonUp: up,
      moonLit: lit,
      // Moonlight only spoils the view when the moon is both up and bright.
      washed: up && lit >= MOON_IGNORE,
      clear: h.cloud != null && h.cloud <= CLEAR_CLOUD,
    });
  }
  if (!samples.length) {
    return { dark: { from: start.at, to: end.at, kind: start.kind }, samples: [], goodHours: 0, score: 0, reason: 'beyond the forecast' };
  }

  const good = (s) => s.clear && !s.washed;
  const goodHours = samples.filter(good).length;
  const clearHours = samples.filter((s) => s.clear).length;
  const withCloud = samples.filter((s) => s.cloud != null);
  const cloudMean = withCloud.length
    ? withCloud.reduce((n, s) => n + s.cloud, 0) / withCloud.length : null;

  // The longest unbroken run, because four scattered hours is not an evening.
  let best = null, run = null;
  for (const s of samples.concat([null])) {
    if (s && good(s)) { run = run || { from: s.t, to: s.t }; run.to = s.t + HOUR; continue; }
    if (run && (!best || run.to - run.from > best.to - best.from)) best = run;
    run = null;
  }

  const darkHours = (end.at - start.at) / HOUR;
  const lit = moonLit(start.at + (end.at - start.at) / 2);
  const moonUpFrac = samples.filter((s) => s.moonUp).length / samples.length;

  /*
   * Weighted towards the run rather than the total: one four-hour window
   * beats four hours scattered through a night of passing cloud, because you
   * only go outside once. Each term is clamped on its own -- clamping only
   * the sum let any night with a four-hour run reach 100, which made five
   * consecutive clear nights indistinguishable.
   */
  const runH = best ? (best.to - best.from) / HOUR : 0;
  const raw = 0.65 * Math.min(1, runH / 4)
    + 0.25 * Math.min(1, goodHours / Math.max(darkHours, 1))
    + 0.10 * Math.min(1, darkHours / 6);
  /*
   * A small continuous moon term on top. The cliff at MOON_IGNORE decides
   * whether an hour counts as good; this decides which of two good nights
   * wins, so a new moon still beats a quarter moon in the ranking.
   */
  const score = Math.round(100 * Math.max(0, Math.min(1, raw) - 0.08 * moonUpFrac * lit));

  return {
    dark: { from: start.at, to: end.at, kind: start.kind, hours: darkHours },
    samples,
    goodHours,
    clearHours,
    cloudMean,
    moonLit: lit,
    moonUpHours: samples.filter((s) => s.moonUp).length,
    best,
    score,
  };
}

/**
 * The next `count` nights, ranked. Index 0 is tonight — or, if you are asking
 * in the small hours before dawn, still tonight, because the night you are
 * standing in is the one you care about.
 */
export function assessNights(hours, lat, lon, nowMs, deps, count = NIGHTS, offsetMs = null) {
  const { sunTimes, moonPosition, moonIllumination, toDeg } = deps;
  const out = [];

  /*
   * Noon anchors each day unambiguously: a sunset always belongs to the day
   * whose noon precedes it, which midnight cannot promise.
   *
   * And noon in the PLACE's day, not the viewer's. For the console those are
   * the same and `offsetMs` can be left out; for somewhere on the other side
   * of the world they are not, and "tonight" has to mean tonight there.
   */
  const noon = offsetMs == null
    ? (() => { const d = new Date(nowMs); d.setHours(12, 0, 0, 0); return +d; })()
    : Math.floor((nowMs + offsetMs) / (24 * HOUR)) * 24 * HOUR + 12 * HOUR - offsetMs;

  const moonAlt = (t) => toDeg(moonPosition(new Date(t), lat, lon).altitude);
  const moonLit = (t) => moonIllumination(new Date(t)).fraction;

  for (let i = 0; i < count; i++) {
    const day = new Date(noon + i * 24 * HOUR);
    const next = new Date(noon + (i + 1) * 24 * HOUR);
    const night = assessNight(hours, sunTimes(day, lat, lon), sunTimes(next, lat, lon), moonAlt, moonLit);
    out.push({ ...night, index: i, day: +day });
  }
  return out;
}

/** The best night that is not tonight, for "if not now, when". */
export function bestOther(nights) {
  return nights.slice(1).reduce((a, b) => (b.score > (a?.score ?? -1) ? b : a), null);
}

/**
 * A verdict in words, with no model involved.
 *
 * This is the floor the feature stands on: it ships before any API key
 * exists, it is what gets served when the model is unreachable or the month's
 * budget is spent, and it is what the model's output is judged against. If an
 * LLM cannot beat this, it has not earned the call.
 */
export function verdict(nights, tf) {
  const t = nights[0];
  const hm = (x) => tf.hm(x);
  if (!t || !t.dark) return 'No real darkness tonight at this latitude.';
  if (!t.samples.length) return 'Tonight is beyond the forecast.';

  const other = bestOther(nights);
  const better = other && other.score > t.score + 15 ? other : null;
  const when = (n) => (n.index === 1 ? 'Tomorrow' : tf.weekday(n.day));
  /*
   * Said in both branches, not just the bad one. A serviceable two-hour gap
   * tonight is still worth knowing you could have all of Thursday instead.
   */
  /*
   * One helper for both sites. The run branch pluralised and this one did
   * not, so a one-hour night at Tromso read "1 clear moonless hours".
   */
  const plural = (n, noun) => `${n} ${noun}${n === 1 ? '' : 's'}`;
  const alt = better
    ? ` ${when(better)} is the better night: ${plural(better.goodHours, 'clear moonless hour')}.` : '';

  if (t.best && t.best.to - t.best.from >= 2 * HOUR) {
    const runH = (t.best.to - t.best.from) / HOUR;
    const run = Math.round(runH);
    const moon = t.moonLit >= MOON_IGNORE && t.moonUpHours
      ? `, and the moon is ${Math.round(t.moonLit * 100)}% lit` : '';

    /*
     * A run that fills the dark window is not a window, it is the night:
     * nothing is given up by going out early or late. Phrasing it the same
     * way as a two-hour gap throws that away, and it is the difference
     * between "any time" and "be outside by 23:00".
     */
    if (t.dark.hours - runH < 1) {
      return `Clear and moonless all night — about ${plural(run, 'hour')},`
        + ` ${hm(t.best.from)} to ${hm(t.best.to)}${moon}.` + alt;
    }

    /*
     * A short run is the only case where the reader has a real decision, so
     * say what closes it. The window on its own does not tell you whether it
     * is worth going out for, which is the entire question.
     */
    if (run < 3) {
      const limit = t.cloudMean != null && t.cloudMean > CLEAR_CLOUD
        ? `, in a night averaging ${Math.round(t.cloudMean)}% cloud`
        : t.dark.hours < 4
          ? `, which is most of the ${plural(Math.round(t.dark.hours), 'hour')} of darkness`
          : '';
      return `A ${run}-hour window from ${hm(t.best.from)}${limit}${moon}.` + alt;
    }

    return `Clear and moonless from ${hm(t.best.from)} to ${hm(t.best.to)}`
      + ` — about ${plural(run, 'hour')}${moon}.` + alt;
  }

  const why = t.cloudMean != null && t.cloudMean > CLEAR_CLOUD
    ? `${Math.round(t.cloudMean)}% cloud through the dark hours`
    : t.moonUpHours && t.moonLit >= MOON_IGNORE
      ? `a ${Math.round(t.moonLit * 100)}% moon up for most of it`
      : 'not much dark sky to work with';
  return `Not tonight — ${why}.` + alt;
}
