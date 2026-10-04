/**
 * Activity intelligence.
 *
 * Turns raw numbers into the thing you actually wanted to know: when to go
 * outside. Each activity declares which conditions matter and how much, then
 * every forecast hour is scored 0-100 and the best windows are extracted.
 *
 * Scores are deliberately opinionated — a "perfect" run is 45-60°F, dry, low
 * wind, low UV — and every score ships with the reason it lost points, so the
 * number is never the only output.
 *
 * SENSIBLE HOURS. Each activity also declares when it can happen at all
 * (`hours`). Darkness only costs a run about four points, so without this a
 * run's "good window" happily ran 8 PM to 9 AM straight through 3 AM - true
 * of the weather, useless as advice. An hour outside an activity's hours
 * cannot be its best hour, cannot sit inside its window (the window stops at
 * the boundary), and is not counted as a great hour.
 *
 * GREAT HOURS. On a good day in a mild climate every activity's best hour
 * scores 95-100, so the best-hour number stopped telling activities apart.
 * The panel's number is now how many of the next 36 hours are great (90+)
 * for it - Grill 33 and Run 9 say something that 100 and 99 did not.
 */

/** Waking hours in the place's own time zone. */
const waking = (h, ctx, hod) => hod >= 6 && hod < 22;

import { clamp } from './lib/util.js';

/**
 * Triangular preference: 1.0 inside [best0,best1], ramping to 0 at min and
 * max. When max === best1 the band is open-ended above (more is simply
 * better) — without that case a "higher is better" band collapses to 0 for
 * any value past best1, which is the opposite of what it means.
 */
function band(v, min, best0, best1, max) {
  if (v == null) return 0.5;
  if (v >= best0 && v <= best1) return 1;
  if (v < best0) {
    if (min >= best0) return 1;                 // open-ended below
    return clamp((v - min) / (best0 - min), 0, 1);
  }
  if (max <= best1) return 1;                   // open-ended above
  return clamp((max - v) / (max - best1), 0, 1);
}

const ACTIVITIES = {
  walk: {
    label: 'WALK', icon: '🚶', color: '#3fd0d8',
    hours: waking,
    score(h) {
      return [
        // A wider comfortable band than a run's: nobody overheats strolling at 72°F.
        ['temperature', band(h.feels ?? h.temp, 30, 50, 75, 95), 0.30],
        ['dry', 1 - clamp((h.pop ?? 0) / 100, 0, 1) * 0.9, 0.24],
        ['wind', band(h.wind, -1, 0, 12, 30), 0.12],
        ['humidity', band(h.dew, -20, 20, 60, 76), 0.10],
        ['UV', band(h.uv, -1, 0, 5, 11), 0.07],
        ['air quality', band(h.air?.aqi, -1, 0, 50, 160), 0.07],
        // A nudge: an evening walk is common, a midnight one is not the pick.
        ['daylight', h.isDay ? 1 : 0.5, 0.10],
      ];
    },
  },
  bike: {
    label: 'BIKE', icon: '🚲', color: '#8fdc6a',
    hours: waking,
    score(h) {
      return [
        ['temperature', band(h.feels ?? h.temp, 25, 58, 78, 98), 0.26],
        ['dry', 1 - clamp((h.pop ?? 0) / 100, 0, 1), 0.22],
        // Wind matters far more on a bike than on foot.
        ['wind', band(h.gust ?? h.wind, -1, 0, 8, 24), 0.24],
        ['visibility', band(h.vis, 0, 8000, Infinity, Infinity), 0.08],
        ['UV', band(h.uv, -1, 0, 5, 11), 0.05],
        ['air quality', band(h.air?.aqi, -1, 0, 50, 150), 0.05],
        // Riding in the dark is doable but rarely the best hour of the day.
        ['daylight', h.isDay ? 1 : 0.35, 0.10],
      ];
    },
  },
  grill: {
    label: 'GRILL', icon: '🔥', color: '#f2b45a',
    hours: waking,
    score(h) {
      return [
        ['dry', 1 - clamp((h.pop ?? 0) / 100, 0, 1) * 1.0, 0.34],
        ['temperature', band(h.temp, 35, 62, 88, 104), 0.24],
        ['wind', band(h.wind, -1, 0, 10, 22), 0.24],
        ['daylight or dusk', h.isDay ? 1 : 0.55, 0.10],
        ['humidity', band(h.dew, -20, 20, 64, 78), 0.08],
      ];
    },
  },
  stargaze: {
    label: 'STARGAZE', icon: '✦', color: '#b39dfa',
    hours: (h) => !h.isDay,
    score(h, ctx) {
      // Only meaningful after astronomical dusk.
      const dark = h.isDay ? 0 : 1;
      return [
        ['darkness', dark, 0.26],
        ['clear sky', 1 - clamp((h.cloud ?? 0) / 100, 0, 1), 0.32],
        ['no moon', 1 - clamp(ctx?.moonFraction ?? 0.5, 0, 1) * (ctx?.moonUp ? 1 : 0.15), 0.18],
        ['transparency', band(h.vis, 0, 20000, Infinity, Infinity), 0.10],
        ['low humidity', band(h.rh, -1, 0, 65, 100), 0.08],
        ['calm', band(h.wind, -1, 0, 8, 28), 0.06],
      ];
    },
  },
  photo: {
    label: 'PHOTO', icon: '◎', color: '#f07aa6',
    // Daylight plus the edges: golden light lives in the hour either side.
    hours: (h, ctx) => !!h.isDay || (ctx?.sunAltDeg != null && ctx.sunAltDeg > -8),
    score(h, ctx) {
      // Golden hour with texture in the sky is the goal; flat blue is boring.
      const goldenness = ctx?.sunAltDeg == null ? 0.4
        : Math.exp(-Math.pow((ctx.sunAltDeg - 3) / 7, 2));
      const drama = 1 - Math.abs((h.cloud ?? 50) / 100 - 0.45) * 1.6;
      return [
        ['golden light', clamp(goldenness, 0, 1), 0.40],
        ['sky texture', clamp(drama, 0, 1), 0.26],
        ['dry', 1 - clamp((h.pop ?? 0) / 100, 0, 1) * 0.7, 0.18],
        ['clarity', band(h.vis, 0, 15000, Infinity, Infinity), 0.16],
      ];
    },
  },
  swim: {
    label: 'SWIM', icon: '🏊', color: '#7fb2f0',
    // Outdoors, in daylight, at an hour people swim.
    hours: (h, ctx, hod) => !!h.isDay && hod >= 7 && hod < 20,
    score(h) {
      const thunder = [95, 96, 99].includes(Number(h.code));
      return [
        // Warm air is what makes getting out of the water bearable.
        ['temperature', band(h.feels ?? h.temp, 65, 80, 95, 105), 0.34],
        ['dry', 1 - clamp((h.pop ?? 0) / 100, 0, 1), 0.18],
        // Lightning is the one real hazard; not a nudge.
        ['no thunder', thunder ? 0 : 1, 0.10],
        ['sunshine', band(h.cloud, -1, 0, 40, 100), 0.12],
        ['wind', band(h.wind, -1, 0, 10, 25), 0.12],
        ['UV', band(h.uv, -1, 2, 7, 11), 0.08],
        ['air quality', band(h.air?.aqi, -1, 0, 50, 150), 0.06],
      ];
    },
  },
  openWindows: {
    label: 'OPEN UP', icon: '🪟', color: '#5cd6bc',
    hours: waking,
    score(h) {
      return [
        ['comfortable air', band(h.temp, 40, 62, 76, 90), 0.34],
        ['dry air', band(h.dew, -20, 25, 58, 70), 0.24],
        ['clean air', band(h.air?.aqi, -1, 0, 50, 130), 0.22],
        ['no rain', 1 - clamp((h.pop ?? 0) / 100, 0, 1), 0.12],
        ['calm', band(h.wind, -1, 0, 14, 34), 0.08],
      ];
    },
  },
};

export const ACTIVITY_KEYS = Object.keys(ACTIVITIES);
export const activityMeta = (k) => ACTIVITIES[k];

/** Score one hour, returning the number plus its worst contributing factor. */
export function scoreHour(key, h, ctx) {
  const act = ACTIVITIES[key];
  if (!act || !h) return null;
  const parts = act.score(h, ctx);
  let total = 0;
  for (const [, v, w] of parts) total += clamp(v, 0, 1) * w;
  // Identify the limiting factor: the largest weighted shortfall.
  let worst = null, worstLoss = 0;
  for (const [name, v, w] of parts) {
    const loss = (1 - clamp(v, 0, 1)) * w;
    if (loss > worstLoss) { worstLoss = loss; worst = name; }
  }
  return {
    score: Math.round(clamp(total, 0, 1) * 100),
    limiter: worstLoss > 0.06 ? worst : null,
    parts: parts.map(([name, v, w]) => ({ name, value: clamp(v, 0, 1), weight: w })),
  };
}

/**
 * Best contiguous windows for an activity over the next `hours` hours.
 * Returns at most `limit` windows, sorted by quality.
 */
/** Hour of day in the place's time zone (the store's), else the browser's. */
function hourOf(store, t) {
  const v = store.fmt?.hourOfDay ? store.fmt.hourOfDay(t) : NaN;
  return Number.isFinite(v) ? v : new Date(t).getHours();
}

/**
 * Every hour of the next `hours`, scored for one activity, with whether it
 * falls inside the activity's sensible hours. One scoring path for the
 * windows and the great-hours count, so the two can never disagree.
 */
export function scoredHours(key, store, hours = 36) {
  const act = ACTIVITIES[key];
  if (!act) return [];
  const now = Date.now();
  const end = now + hours * 3600e3;
  return store.hours.filter((h) => h.t >= now - 1800e3 && h.t <= end).map((h) => {
    const ctx = contextFor(store, h.t);
    const eligible = act.hours ? !!act.hours(h, ctx, hourOf(store, h.t)) : true;
    return { t: h.t, eligible, ...scoreHour(key, { ...h, air: sampleAir(store, h.t) }, ctx) };
  });
}

/** How many of the next `hours` are great (score >= `at`) and eligible. */
export function greatHours(key, store, { hours = 36, at = 90 } = {}) {
  const rows = scoredHours(key, store, hours);
  const eligible = rows.filter((r) => r.eligible);
  return { great: eligible.filter((r) => r.score >= at).length, eligible: eligible.length };
}

export function bestWindows(key, store, { hours = 36, limit = 3, minScore = 55 } = {}) {
  const scored = scoredHours(key, store, hours);
  if (!scored.length) return [];
  // An hour outside the activity's sensible hours is simply not available:
  // it cannot be a peak, and a window cannot grow through it.
  for (const r of scored) if (!r.eligible) r.score = -Infinity;

  /*
   * Grow windows outward from local peaks rather than reporting every
   * contiguous run above the threshold. A run can span twelve hours whose
   * quality varies enormously — reporting "19:00-07:00" for grilling because
   * one hour of it scored well is useless. A window here stays within
   * NEAR_PEAK points of its own peak, so it describes hours you would
   * actually use.
   */
  const NEAR_PEAK = 12;
  const used = new Array(scored.length).fill(false);
  const windows = [];

  for (let pass = 0; pass < limit; pass++) {
    let bi = -1;
    for (let i = 0; i < scored.length; i++) {
      if (used[i] || scored[i].score < minScore) continue;
      if (bi < 0 || scored[i].score > scored[bi].score) bi = i;
    }
    if (bi < 0) break;

    const peak = scored[bi].score;
    const floor = Math.max(minScore, peak - NEAR_PEAK);
    let lo = bi, hi = bi;
    while (lo - 1 >= 0 && !used[lo - 1] && scored[lo - 1].score >= floor) lo--;
    while (hi + 1 < scored.length && !used[hi + 1] && scored[hi + 1].score >= floor) hi++;
    for (let i = lo; i <= hi; i++) used[i] = true;

    let sum = 0;
    for (let i = lo; i <= hi; i++) sum += scored[i].score;
    windows.push({
      start: scored[lo].t,
      end: scored[hi].t + 3600e3,
      peakAt: scored[bi].t,
      peak,
      avg: Math.round(sum / (hi - lo + 1)),
      hours: hi - lo + 1,
      limiter: scored[bi].limiter,
      // The best hour's factors, for "why this score".
      parts: scored[bi].parts,
    });
  }

  return windows.sort((a, b) => b.peak - a.peak || a.start - b.start);
}

function sampleAir(store, t) {
  if (!store.air?.length) return null;
  let best = null, bd = Infinity;
  for (const a of store.air) {
    const d = Math.abs(a.t - t);
    if (d < bd) { bd = d; best = a; }
  }
  return bd < 3600e3 * 2 ? best : null;
}

function contextFor(store, t) {
  const f = store.frame(t);
  if (!f) return {};
  return {
    sunAltDeg: f.sun.altDeg,
    moonFraction: f.moon.fraction,
    moonUp: f.moon.altDeg > 0,
  };
}

/* ------------------------------------------------------------- nowcast */

/**
 * Minute-resolution answer to "is it about to rain, and how long have I got?"
 * Uses the 15-minute series where it exists, falling back to hourly.
 */
export function precipNowcast(store) {
  const now = Date.now();
  const horizon = now + 6 * 3600e3;
  const series = (store.min15?.length ? store.min15 : store.hours)
    .filter((d) => d.t >= now - 900e3 && d.t <= horizon);
  if (series.length < 2) return null;

  const WET = 0.002; // in/hr — below this is a trace, not rain
  const nowWet = (series[0].precip ?? 0) >= WET;

  let change = null;
  for (const d of series) {
    const wet = (d.precip ?? 0) >= WET;
    if (wet !== nowWet) { change = d; break; }
  }

  // Peak intensity in the window, for describing what's coming.
  const peak = series.reduce((a, c) => ((c.precip ?? 0) > (a.precip ?? 0) ? c : a), series[0]);

  return {
    raining: nowWet,
    changeAt: change?.t ?? null,
    minutes: change ? Math.round((change.t - now) / 60000) : null,
    peak: peak.precip ?? 0,
    peakAt: peak.t,
    resolution: store.min15?.length ? 15 : 60,
    series: series.map((d) => ({ t: d.t, p: d.precip ?? 0 })),
  };
}

/**
 * One-line human summary of the nowcast, or null when nothing is imminent.
 */
export function nowcastPhrase(nc, tf) {
  if (!nc) return null;
  if (nc.raining) {
    return nc.minutes != null
      ? `Rain now — easing in about ${nc.minutes} min`
      : 'Rain now — no let-up in the next 6 hours';
  }
  if (nc.minutes != null && nc.minutes <= 240) {
    const heavy = nc.peak > 0.08 ? 'Heavy rain' : nc.peak > 0.02 ? 'Rain' : 'Light rain';
    return `${heavy} starting in ${nc.minutes} min (${tf.hm(nc.changeAt)})`;
  }
  return null;
}
