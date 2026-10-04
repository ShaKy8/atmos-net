/**
 * The single source of truth.
 *
 * Raw API payloads are normalized once into flat, evenly-spaced series, and
 * everything the console draws is then a pure function of (series, cursor).
 * That is what makes the time scrubber work: move the cursor and the sky,
 * every gauge and every number re-derive from the same interpolation.
 */

import { api } from './api.js';
import { clamp, lerp, wx, makeTimeFmt } from './lib/util.js';
import { sunPosition, moonPosition, moonIllumination, sunTimes, moonTimes, toCompass } from './lib/astro.js';

const HOUR = 3600_000;
const LS = 'atmos.v1';

/* --------------------------------------------------------------- helpers */

/**
 * Open-Meteo returns local wall-clock strings when timezone=auto. Combine
 * them with the reported UTC offset to get a real instant.
 *
 * The hourly and 15-minute blocks carry a time ("2026-09-06T00:00"), but the
 * DAILY block is date-only ("2026-09-06"). Appending "Z" to that builds
 * "2026-09-06Z", and the ECMAScript date-time grammar permits a timezone offset
 * ONLY when a time is present — so that string is not a date-time string at
 * all. V8 parses it anyway through its legacy fallback, which is why it worked
 * on every desktop and Android browser it was tested in. JavaScriptCore does
 * not, so on iOS every daily timestamp became an Invalid Date and the first
 * Intl.DateTimeFormat.format() call threw "date value is not finite", taking
 * the whole console down at boot with FATAL.
 */
const utcIso = (s) => (typeof s === 'string' && s
  ? `${s.includes('T') ? s : `${s}T00:00:00`}Z`
  : '');
const epochFrom = (offsetSec) => (s) => Date.parse(utcIso(s)) - offsetSec * 1000;

/** Zip Open-Meteo's parallel arrays into records, renaming to short keys. */
function zip(block, offsetSec, map) {
  if (!block?.time?.length) return [];
  const toEpoch = epochFrom(offsetSec);
  const n = block.time.length;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const rec = { t: toEpoch(block.time[i]), i };
    for (const [key, src] of Object.entries(map)) rec[key] = block[src]?.[i] ?? null;
    out[i] = rec;
  }
  return out;
}

const HOURLY_MAP = {
  temp: 'temperature_2m', rh: 'relative_humidity_2m', dew: 'dew_point_2m',
  feels: 'apparent_temperature', pop: 'precipitation_probability', precip: 'precipitation',
  rain: 'rain', showers: 'showers', snow: 'snowfall', snowDepth: 'snow_depth',
  code: 'weather_code', pressure: 'pressure_msl', surfPressure: 'surface_pressure',
  cloud: 'cloud_cover', cloudLow: 'cloud_cover_low', cloudMid: 'cloud_cover_mid',
  cloudHigh: 'cloud_cover_high', vis: 'visibility', vpd: 'vapour_pressure_deficit',
  wind: 'wind_speed_10m', windDir: 'wind_direction_10m', gust: 'wind_gusts_10m',
  uv: 'uv_index', uvClear: 'uv_index_clear_sky', isDay: 'is_day',
  sunshine: 'sunshine_duration', cape: 'cape', li: 'lifted_index',
  cin: 'convective_inhibition', freezing: 'freezing_level_height',
  blh: 'boundary_layer_height', wetbulb: 'wet_bulb_temperature_2m',
  soilT: 'soil_temperature_0cm', soilM: 'soil_moisture_0_to_1cm', et0: 'et0_fao_evapotranspiration',
};

const DAILY_MAP = {
  code: 'weather_code', tmax: 'temperature_2m_max', tmin: 'temperature_2m_min',
  feelsMax: 'apparent_temperature_max', feelsMin: 'apparent_temperature_min',
  sunriseS: 'sunrise', sunsetS: 'sunset', daylight: 'daylight_duration',
  sunshine: 'sunshine_duration', uvMax: 'uv_index_max', precip: 'precipitation_sum',
  rain: 'rain_sum', showers: 'showers_sum', snow: 'snowfall_sum',
  precipHours: 'precipitation_hours', pop: 'precipitation_probability_max',
  windMax: 'wind_speed_10m_max', gustMax: 'wind_gusts_10m_max',
  windDir: 'wind_direction_10m_dominant', radiation: 'shortwave_radiation_sum',
  et0: 'et0_fao_evapotranspiration',
};

const MIN15_MAP = {
  precip: 'precipitation', code: 'weather_code', cape: 'cape',
  vis: 'visibility', gust: 'wind_gusts_10m', isDay: 'is_day',
};

const AQ_MAP = {
  aqi: 'us_aqi', pm10: 'pm10', pm25: 'pm2_5', co: 'carbon_monoxide',
  no2: 'nitrogen_dioxide', so2: 'sulphur_dioxide', o3: 'ozone',
  aod: 'aerosol_optical_depth', dust: 'dust', uv: 'uv_index',
  alder: 'alder_pollen', birch: 'birch_pollen', grass: 'grass_pollen',
  mugwort: 'mugwort_pollen', olive: 'olive_pollen', ragweed: 'ragweed_pollen',
};

const FT_TO_M = 0.3048;

/**
 * Convert any field the API reported in feet back to metres, using the
 * declared units rather than a hardcoded list, so a future field that gains
 * the same behaviour is handled automatically.
 */
function normalizeLengths(rows, units, map) {
  if (!units || !rows?.length) return;
  const feetKeys = Object.entries(map)
    .filter(([, src]) => units[src] === 'ft')
    .map(([key]) => key);
  if (!feetKeys.length) return;
  for (const r of rows) {
    for (const k of feetKeys) if (r[k] != null) r[k] *= FT_TO_M;
  }
}

/** Fields that should snap to the nearest sample instead of blending. */
const DISCRETE = new Set(['code', 'isDay', 'i']);

/** Linear interpolation between two records of an evenly-spaced series. */
function blend(a, b, f) {
  if (!a) return b ? { ...b } : null;
  if (!b) return { ...a };
  const out = {};
  for (const k in a) {
    const av = a[k], bv = b[k];
    if (DISCRETE.has(k)) { out[k] = f < 0.5 ? av : bv; continue; }
    if (typeof av === 'number' && typeof bv === 'number') out[k] = lerp(av, bv, f);
    else out[k] = av ?? bv;
  }
  return out;
}

/** Sample an evenly-spaced series at an arbitrary instant. */
function sampleSeries(series, t) {
  if (!series?.length) return null;
  if (t <= series[0].t) return { ...series[0] };
  if (t >= series.at(-1).t) return { ...series.at(-1) };
  const step = series[1].t - series[0].t;
  const raw = (t - series[0].t) / step;
  const i = clamp(Math.floor(raw), 0, series.length - 2);
  return blend(series[i], series[i + 1], raw - i);
}

/* ----------------------------------------------------------------- store */

class Store {
  constructor() {
    this.listeners = new Map();

    this.loc = null;
    this.tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    this.fmt = makeTimeFmt(this.tz);

    this.raw = null;
    this.hours = [];
    this.days = [];
    this.min15 = [];
    this.air = [];
    this.airNow = null;
    this.alerts = [];
    this.space = null;
    this.climate = null;
    this.models = null;
    this.pollen = null;
    this.radar = null;
    this.observed = null;

    this.cursor = Date.now();
    this.now = Date.now();
    /*
     * When following, the cursor tracks wall-clock time. The portal's whole
     * purpose is to sit open fullscreen for hours, and without this the hero
     * number silently freezes at whatever moment the page happened to load
     * while the toolbar clock keeps ticking. Cleared the moment the user
     * scrubs deliberately; restored by toNow().
     */
    this.following = true;
    this.playing = false;
    this.playRate = 1;          // hours of forecast per real second
    this.view = 'deck';
    this.status = 'boot';
    this.lastFetch = 0;
    this.favorites = [];
    this.settings = { sound: false, skinType: 3, voice: true };

    this.restore();
  }

  /* -- events -- */
  on(evt, fn) {
    if (!this.listeners.has(evt)) this.listeners.set(evt, new Set());
    this.listeners.get(evt).add(fn);
    return () => this.listeners.get(evt).delete(fn);
  }
  emit(evt, detail) {
    for (const fn of this.listeners.get(evt) || []) {
      try { fn(detail); } catch (e) { console.error(`[store:${evt}]`, e); }
    }
  }

  /* -- persistence -- */
  restore() {
    try {
      const s = JSON.parse(localStorage.getItem(LS) || '{}');
      if (s.loc) this.loc = s.loc;
      if (Array.isArray(s.favorites)) this.favorites = s.favorites;
      if (s.settings) Object.assign(this.settings, s.settings);
    } catch { /* first run */ }
  }
  save() {
    try {
      localStorage.setItem(LS, JSON.stringify({
        loc: this.loc, favorites: this.favorites, settings: this.settings,
      }));
    } catch { /* private mode */ }
  }

  setStatus(s) { this.status = s; this.emit('status', s); }

  /* -- location -- */
  async setLocation(loc, { remember = true } = {}) {
    this.loc = {
      name: loc.name, admin1: loc.admin1 || '', country: loc.country_code || loc.country || '',
      lat: +(loc.latitude ?? loc.lat), lon: +(loc.longitude ?? loc.lon),
      tz: loc.timezone || this.tz, elevation: loc.elevation ?? null,
    };
    this.tz = this.loc.tz;
    this.fmt = makeTimeFmt(this.tz);
    if (remember) this.save();
    this.emit('loc', this.loc);
    await this.refresh({ full: true });
  }

  addFavorite(loc) {
    const key = (l) => `${(+l.lat ?? +l.latitude).toFixed(3)},${(+l.lon ?? +l.longitude).toFixed(3)}`;
    const entry = {
      name: loc.name, admin1: loc.admin1 || '', country_code: loc.country_code || loc.country || '',
      latitude: +(loc.latitude ?? loc.lat), longitude: +(loc.longitude ?? loc.lon),
      timezone: loc.timezone || loc.tz,
    };
    this.favorites = this.favorites.filter((f) => key(f) !== key(entry));
    this.favorites.unshift(entry);
    this.favorites = this.favorites.slice(0, 12);
    this.save();
    this.emit('favorites', this.favorites);
  }

  removeFavorite(i) {
    this.favorites.splice(i, 1);
    this.save();
    this.emit('favorites', this.favorites);
  }

  /* -- data -- */
  async refresh({ full = false } = {}) {
    if (!this.loc) return;
    const { lat, lon } = this.loc;
    this.setStatus('load');

    try {
      const bundle = await api.bundle(lat, lon);
      this.ingest(bundle);
      this.setStatus(bundle.forecast?.ok ? 'ok' : 'err');
      this.lastFetch = Date.now();
      this.emit('data', this);
    } catch (err) {
      console.error('[store] bundle failed', err);
      this.setStatus('err');
      this.emit('error', err);
      return;
    }

    // Secondary feeds refresh in the background; a failure here degrades one
    // panel rather than blocking the console.
    const side = [
      api.radar().then((r) => { this.radar = r; this.emit('radar', r); }),
      api.pollen(lat, lon).then((p) => { this.pollen = p; this.emit('pollen', p); }),
      api.observations(lat, lon).then((o) => { this.observed = o; this.emit('observed', o); }),
    ];
    if (full || !this.climate) {
      side.push(api.climate(lat, lon).then((c) => { this.climate = c; this.emit('climate', c); }));
      side.push(api.models(lat, lon).then((m) => { this.models = this.reduceModels(m); this.emit('models', this.models); }));
    }
    await Promise.allSettled(side);
    this.emit('data', this);
  }

  ingest(bundle) {
    this.raw = bundle;
    const f = bundle.forecast?.ok ? bundle.forecast.data : null;
    if (f) {
      const off = f.utc_offset_seconds ?? 0;
      this.utcOffset = off;
      this.elevation = f.elevation;
      if (f.timezone && f.timezone !== this.tz) {
        this.tz = f.timezone;
        this.fmt = makeTimeFmt(this.tz);
        if (this.loc) this.loc.tz = f.timezone;
      }
      this.hours = zip(f.hourly, off, HOURLY_MAP);
      this.min15 = zip(f.minutely_15, off, MIN15_MAP);

      /*
       * Open-Meteo switches every LENGTH field to feet whenever
       * precipitation_unit is inches — visibility, freezing level, boundary
       * layer height and snow depth — and declares it in *_units. Everything
       * downstream assumes metres, so normalise once here rather than
       * sprinkling conversions through the views.
       */
      normalizeLengths(this.hours, f.hourly_units, HOURLY_MAP);
      normalizeLengths(this.min15, f.minutely_15_units, MIN15_MAP);

      this.days = zip(f.daily, off, DAILY_MAP).map((d) => ({
        ...d,
        sunrise: d.sunriseS ? Date.parse(utcIso(d.sunriseS)) - off * 1000 : null,
        sunset: d.sunsetS ? Date.parse(utcIso(d.sunsetS)) - off * 1000 : null,
      }));
      /*
       * Open-Meteo's `current` block is deliberately NOT used. It is the
       * current step of the 15-minute model series, which is noisy — 73.9,
       * 71.8, 72.1, 73.7 across four consecutive steps — so the hero would
       * jitter by ~2 degrees and disagree with the smooth hourly curve drawn
       * directly beneath it. The hero interpolates the hourly series; real
       * measurements come from /api/observations instead.
       */
    }

    const a = bundle.air?.ok ? bundle.air.data : null;
    if (a) {
      this.air = zip(a.hourly, a.utc_offset_seconds ?? 0, AQ_MAP);
      this.airNow = a.current ? Object.fromEntries(
        Object.entries(AQ_MAP).map(([k, src]) => [k, a.current[src] ?? null])) : null;
    }

    this.alerts = bundle.alerts?.ok
      ? (bundle.alerts.data.features || []).map((ft) => ({ ...ft.properties, geometry: ft.geometry }))
      : [];

    this.space = bundle.space?.ok ? bundle.space.data : null;

    // Keep the cursor live if we are following; otherwise just clamp it into
    // the window we actually have data for.
    if (this.hours.length) {
      const t = this.following ? Date.now() : this.cursor;
      this.cursor = clamp(t, this.hours[0].t, this.hours.at(-1).t);
    }
  }

  /** Collapse the multi-model payload into per-hour spread statistics. */
  reduceModels(m) {
    const h = m?.hourly;
    if (!h?.time?.length) return null;
    const off = m.utc_offset_seconds ?? 0;
    const toEpoch = epochFrom(off);
    const names = Object.keys(h).filter((k) => k.startsWith('temperature_2m_'))
      .map((k) => k.replace('temperature_2m_', ''));
    const rows = [];
    for (let i = 0; i < h.time.length; i++) {
      const temps = names.map((n) => h[`temperature_2m_${n}`]?.[i]).filter((v) => v != null);
      const precs = names.map((n) => h[`precipitation_${n}`]?.[i]).filter((v) => v != null);
      if (!temps.length) continue;
      const mean = temps.reduce((s, v) => s + v, 0) / temps.length;
      rows.push({
        t: toEpoch(h.time[i]),
        mean, min: Math.min(...temps), max: Math.max(...temps),
        spread: Math.max(...temps) - Math.min(...temps),
        temps,
        precipAgree: precs.length ? precs.filter((v) => v > 0.004).length / precs.length : null,
      });
    }
    return { names, rows };
  }

  /* -- time cursor -- */

  setCursor(t, { silent = false } = {}) {
    if (!this.hours.length) return;
    const lo = this.hours[0].t, hi = this.hours.at(-1).t;
    this.cursor = clamp(t, lo, hi);
    if (!silent) this.emit('cursor', this.cursor);
  }

  /**
   * Move the cursor because the user asked for it. Stops following now, so a
   * deliberate scrub is not yanked back a few seconds later.
   */
  scrubTo(t, opts) {
    this.following = false;
    this.setCursor(t, opts);
  }

  /** Advance the cursor to real time. No-op unless we are following. */
  syncToNow() {
    if (!this.following || this.playing) return;
    // On the radar a pause leaves `following` true (the loop is ambient),
    // and this sync would undo the pause within 20s by snapping the cursor
    // - and so the frame - back to now.
    if (this.view === 'radar') return;
    const t = Date.now();
    // Only emit when the change is meaningful, so idle ticks stay cheap.
    if (Math.abs(t - this.cursor) < 1000) return;
    this.setCursor(t);
  }

  toNow() {
    this.playing = false;
    this.following = true;
    this.setCursor(Date.now());
    this.emit('play', false);
  }

  get atNow() { return Math.abs(this.cursor - Date.now()) < 90_000; }
  get span() {
    return this.hours.length ? { lo: this.hours[0].t, hi: this.hours.at(-1).t } : { lo: 0, hi: 0 };
  }

  /**
   * Conditions at the cursor. Hourly data is the backbone; where 15-minute
   * data exists it overrides precipitation so the nowcast has real detail.
   */
  frame(t = this.cursor) {
    const h = sampleSeries(this.hours, t);
    if (!h) return null;
    const f = { ...h, t };

    const m = sampleSeries(this.min15, t);
    if (m && Math.abs(m.t - t) < 30 * 60_000 && m.precip != null) {
      f.precip = m.precip;
      f.code = m.code ?? f.code;
      if (m.cape != null) f.cape = m.cape;
      if (m.vis != null) f.vis = m.vis;
      if (m.gust != null) f.gust = m.gust;
    }

    const a = sampleSeries(this.air, t);
    if (a) f.air = a;

    f.wx = wx(Math.round(f.code ?? 0));
    f.day = this.dayFor(t);

    const { lat, lon } = this.loc || { lat: 0, lon: 0 };
    const d = new Date(t);
    const sp = sunPosition(d, lat, lon);
    const mp = moonPosition(d, lat, lon);
    const mi = moonIllumination(d);
    f.sun = { alt: sp.altitude, az: sp.azimuth, altDeg: sp.altitude * 57.29578, compass: toCompass(sp.azimuth) };
    f.moon = {
      alt: mp.altitude, az: mp.azimuth, altDeg: mp.altitude * 57.29578,
      compass: toCompass(mp.azimuth), phase: mi.phase, fraction: mi.fraction,
      distance: mp.distance,
    };
    return f;
  }

  /** The daily record covering instant `t` in the location's timezone. */
  dayFor(t) {
    const key = this.fmt.isoDate(t);
    return this.days.find((d) => this.fmt.isoDate(d.t) === key) || null;
  }

  sunTimesFor(t = this.cursor) {
    const { lat, lon } = this.loc || { lat: 0, lon: 0 };
    return sunTimes(new Date(t), lat, lon, this.elevation || 0);
  }
  moonTimesFor(t = this.cursor) {
    const { lat, lon } = this.loc || { lat: 0, lon: 0 };
    return moonTimes(new Date(t), lat, lon);
  }

  /** Sky-shader parameters derived from the frame at `t`. */
  skyParams(t = this.cursor) {
    const f = this.frame(t);
    if (!f) return null;
    const kind = f.wx.kind;
    const precipRate = f.precip ?? 0;

    // Blend the code's nominal intensity with the actual rate, so a "rain"
    // code with 0.001 in/hr doesn't produce a downpour.
    const rateAmt = clamp(precipRate / 0.12, 0, 1);
    const precip = (kind === 'rain' || kind === 'snow' || kind === 'storm')
      ? clamp(Math.max(f.wx.intensity * 0.55, rateAmt), 0, 1) : rateAmt * 0.6;

    const kp = this.currentKp() ?? 2;

    return {
      sunAlt: f.sun.alt, sunAz: f.sun.az + Math.PI,       // shader azimuth is from north
      moonAlt: f.moon.alt, moonAz: f.moon.az + Math.PI,
      moonPhase: f.moon.phase, moonFrac: f.moon.fraction,
      /*
       * Face whatever is worth looking at. With a 180-degree field of view a
       * fixed southward camera loses the sun for much of the day (it sets at
       * ~272 degrees here), so the view follows the sun while it is up, the
       * moon when it isn't, and falls back to the equator.
       */
      viewAz: this.viewBearing(f),
      cloudLow: clamp((f.cloudLow ?? 0) / 100, 0, 1),
      cloudMid: clamp((f.cloudMid ?? 0) / 100, 0, 1),
      cloudHigh: clamp((f.cloudHigh ?? 0) / 100, 0, 1),
      precip,
      snow: kind === 'snow' ? 1 : 0,
      storm: kind === 'storm' ? 0.85 : clamp((f.cape ?? 0) / 2500, 0, 0.6),
      fog: kind === 'fog' ? 0.85 : clamp(1 - (f.vis ?? 20000) / 6000, 0, 0.6),
      wind: f.wind ?? 5,
      windDir: ((f.windDir ?? 0) + 180) * Math.PI / 180,   // blows toward
      kp,
      lat: this.loc?.lat ?? 0,
      haze: clamp(1 - (f.vis ?? 24000) / 24000, 0, 0.8),
      cityGlow: 0.55,
    };
  }

  /** Camera bearing for the sky, in shader azimuth (radians from north). */
  viewBearing(f) {
    const equator = (this.loc?.lat ?? 0) >= 0 ? Math.PI : 0;
    if (f.sun.altDeg > -8) return f.sun.az + Math.PI;
    if (f.moon.altDeg > 2) return f.moon.az + Math.PI;
    return equator;
  }

  currentKp() {
    const k = this.space?.kpNow;
    if (k?.ok && Array.isArray(k.data) && k.data.length) {
      const last = k.data.at(-1);
      const v = Number(last.estimated_kp ?? last.kp_index);
      if (Number.isFinite(v)) return v;
    }
    return null;
  }

  /** Kp forecast rows as {t, kp}. */
  /**
   * Kp forecast rows as {t, kp, observed}.
   *
   * SWPC serves this product as an array of objects, but several sibling
   * products use a header row plus positional arrays, so accept both shapes.
   */
  kpForecast() {
    const k = this.space?.kpFc;
    if (!k?.ok || !Array.isArray(k.data) || !k.data.length) return [];
    const raw = k.data;
    const rows = Array.isArray(raw[0])
      ? raw.slice(1).map((r) => ({ time_tag: r[0], kp: r[1], observed: r[2] }))
      : raw;
    return rows.map((r) => ({
      t: Date.parse(String(r.time_tag).replace(' ', 'T').replace(/Z?$/, 'Z')),
      kp: Number(r.kp ?? r.kp_index ?? r.estimated_kp),
      observed: r.observed,
    })).filter((r) => Number.isFinite(r.kp) && Number.isFinite(r.t));
  }
}

export const store = new Store();
export { sampleSeries, blend };
