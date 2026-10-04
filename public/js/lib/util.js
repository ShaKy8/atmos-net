/** Formatting, WMO weather-code decoding, and small numeric helpers. */

/**
 * Escape text for interpolation into HTML.
 *
 * Covers the single-quote case too, so the result is safe inside either
 * quoting style of attribute value as well as in element content.
 */
const HTML_ESCAPES = { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (s) => String(s ?? '').replace(/[<>&"']/g, (c) => HTML_ESCAPES[c]);

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));
export const smoothstep = (t) => t * t * (3 - 2 * t);
export const round = (v, p = 0) => (v == null || Number.isNaN(v) ? null : +v.toFixed(p));

/** Linear interpolation across an array of samples at a fractional index. */
export function sampleAt(arr, idx) {
  if (!arr?.length) return null;
  const i = clamp(idx, 0, arr.length - 1);
  const lo = Math.floor(i), hi = Math.min(arr.length - 1, lo + 1);
  const a = arr[lo], b = arr[hi];
  if (a == null) return b ?? null;
  if (b == null) return a;
  return lerp(a, b, i - lo);
}

export const fmt = {
  temp: (v) => (v == null ? '--' : `${Math.round(v)}°`),
  tempP: (v) => (v == null ? '--' : `${v.toFixed(1)}°`),
  pct: (v) => (v == null ? '--' : `${Math.round(v)}%`),
  wind: (v) => (v == null ? '--' : `${Math.round(v)}`),
  pressure: (v) => (v == null ? '--' : (v * 0.029529983071445).toFixed(2)), // hPa -> inHg
  inches: (v) => (v == null ? '--' : v < 0.01 && v > 0 ? '<0.01' : v.toFixed(2)),
  miles: (v) => (v == null ? '--' : v >= 1609 * 9 ? '10+' : (v / 1609.344).toFixed(1)), // m -> mi
  int: (v) => (v == null ? '--' : String(Math.round(v))),
  signed: (v, p = 1) => (v == null ? '--' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(p)}`),
};

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export const compass = (deg) => (deg == null ? '--' : COMPASS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16]);

/** Duration in seconds -> "6h 42m". */
export function dur(sec) {
  if (sec == null) return '--';
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

/** "in 94 min" / "3h 20m ago", relative to now. */
export function relTime(ms) {
  const d = ms - Date.now();
  const a = Math.abs(d), mins = Math.round(a / 60000);
  if (mins < 1) return 'now';
  const s = mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;
  return d > 0 ? `in ${s}` : `${s} ago`;
}

/**
 * WMO 4677 present-weather codes. `kind` and `intensity` drive the sky
 * shader; `label` is what the console prints.
 */
const WMO = {
  0:  ['CLEAR',                'Clear sky',                       'clear',   0],
  1:  ['MAINLY CLEAR',         'Mainly clear',                    'clear',   0],
  2:  ['PARTLY CLOUDED',       'Partly cloudy',                   'cloud',   0.4],
  3:  ['OVERCAST',             'Overcast',                        'cloud',   1],
  45: ['FOG',                  'Fog',                             'fog',     0.7],
  48: ['RIME FOG',             'Depositing rime fog',             'fog',     1],
  51: ['LIGHT DRIZZLE',        'Light drizzle',                   'rain',    0.2],
  53: ['DRIZZLE',              'Moderate drizzle',                'rain',    0.35],
  55: ['DENSE DRIZZLE',        'Dense drizzle',                   'rain',    0.5],
  56: ['FREEZING DRIZZLE',     'Light freezing drizzle',          'rain',    0.3],
  57: ['FREEZING DRIZZLE+',    'Dense freezing drizzle',          'rain',    0.5],
  61: ['LIGHT RAIN',           'Slight rain',                     'rain',    0.35],
  63: ['RAIN',                 'Moderate rain',                   'rain',    0.6],
  65: ['HEAVY RAIN',           'Heavy rain',                      'rain',    1],
  66: ['FREEZING RAIN',        'Light freezing rain',             'rain',    0.5],
  67: ['FREEZING RAIN+',       'Heavy freezing rain',             'rain',    0.9],
  71: ['LIGHT SNOW',           'Slight snow fall',                'snow',    0.3],
  73: ['SNOW',                 'Moderate snow fall',              'snow',    0.6],
  75: ['HEAVY SNOW',           'Heavy snow fall',                 'snow',    1],
  77: ['SNOW GRAINS',          'Snow grains',                     'snow',    0.3],
  80: ['RAIN SHOWERS',         'Slight rain showers',             'rain',    0.45],
  81: ['RAIN SHOWERS',         'Moderate rain showers',           'rain',    0.7],
  82: ['VIOLENT SHOWERS',      'Violent rain showers',            'rain',    1],
  85: ['SNOW SHOWERS',         'Slight snow showers',             'snow',    0.5],
  86: ['HEAVY SNOW SHOWERS',   'Heavy snow showers',              'snow',    1],
  95: ['THUNDERSTORM',         'Thunderstorm',                    'storm',   0.7],
  96: ['T-STORM + HAIL',       'Thunderstorm with slight hail',   'storm',   0.85],
  99: ['SEVERE T-STORM',       'Thunderstorm with heavy hail',    'storm',   1],
};

export function wx(code) {
  const w = WMO[code] || WMO[0];
  return { code, label: w[0], long: w[1], kind: w[2], intensity: w[3] };
}

/** Glyph used in compact rows and the 10-day strip. */
export function wxGlyph(code, isDay = true) {
  const k = wx(code).kind;
  if (k === 'clear') return code === 0 ? (isDay ? '☀' : '☾') : (isDay ? '⛅' : '☁');
  if (k === 'cloud') return code === 3 ? '☁' : (isDay ? '⛅' : '☁');
  if (k === 'fog') return '░';
  if (k === 'rain') return '☔';
  if (k === 'snow') return '❄';
  if (k === 'storm') return '⚡';
  return '○';
}

/** US AQI category with the official EPA colors, re-tinted for the console. */
export function aqiCategory(aqi) {
  if (aqi == null) return { name: 'NO DATA', color: '#8d9aab', level: 0 };
  if (aqi <= 50) return { name: 'GOOD', color: '#8fdc6a', level: 1 };
  if (aqi <= 100) return { name: 'MODERATE', color: '#ecd46a', level: 2 };
  if (aqi <= 150) return { name: 'SENSITIVE GROUPS', color: '#f59a5b', level: 3 };
  if (aqi <= 200) return { name: 'UNHEALTHY', color: '#f47171', level: 4 };
  if (aqi <= 300) return { name: 'VERY UNHEALTHY', color: '#c89af5', level: 5 };
  return { name: 'HAZARDOUS', color: '#ef5a6a', level: 6 };
}

export function uvCategory(uv) {
  if (uv == null) return { name: 'NO DATA', color: '#8d9aab' };
  if (uv < 3) return { name: 'LOW', color: '#8fdc6a' };
  if (uv < 6) return { name: 'MODERATE', color: '#ecd46a' };
  if (uv < 8) return { name: 'HIGH', color: '#f59a5b' };
  if (uv < 11) return { name: 'VERY HIGH', color: '#f47171' };
  return { name: 'EXTREME', color: '#c89af5' };
}

/**
 * Minutes of unprotected exposure before erythema (sunburn), by Fitzpatrick
 * skin type I-VI.
 *
 * One UV index unit is 25 mW/m2 of erythemally-weighted irradiance, so the
 * dose rate is UVI * 0.025 W/m2 and the time to reach one MED (J/m2) is
 * MED / (UVI * 0.025) seconds, i.e. MED / (UVI * 1.5) minutes.
 */
const MED = [null, 200, 250, 300, 450, 600, 1000]; // J/m2, Fitzpatrick I-VI

export function burnTime(uv, skinType = 3) {
  if (!uv || uv <= 0.1) return null;
  const med = MED[skinType] ?? MED[3];
  return Math.round(med / (uv * 1.5));
}

/** Pollen.com publishes a 0-12 index; these are its own bands. */
export function pollenCategory(idx) {
  if (idx == null) return { name: 'NO DATA', color: '#8d9aab' };
  if (idx < 2.5) return { name: 'LOW', color: '#8fdc6a' };
  if (idx < 4.9) return { name: 'LOW-MED', color: '#c6dc6e' };
  if (idx < 7.3) return { name: 'MEDIUM', color: '#ecd46a' };
  if (idx < 9.7) return { name: 'MED-HIGH', color: '#f59a5b' };
  return { name: 'HIGH', color: '#f47171' };
}

/** Kp 0-9 -> aurora visibility band. */
export function kpCategory(kp) {
  if (kp == null) return { name: 'NO DATA', color: '#8d9aab', lat: null };
  if (kp < 3) return { name: 'QUIET', color: '#6bb3bd', lat: 66 };
  if (kp < 4) return { name: 'UNSETTLED', color: '#3fd0d8', lat: 63 };
  if (kp < 5) return { name: 'ACTIVE', color: '#8fdc6a', lat: 60 };
  if (kp < 6) return { name: 'G1 STORM', color: '#ecd46a', lat: 56 };
  if (kp < 7) return { name: 'G2 STORM', color: '#f59a5b', lat: 53 };
  if (kp < 8) return { name: 'G3 STORM', color: '#f47171', lat: 50 };
  if (kp < 9) return { name: 'G4 STORM', color: '#c89af5', lat: 47 };
  return { name: 'G5 EXTREME', color: '#ef5a6a', lat: 42 };
}

/**
 * Beaufort-ish descriptor for wind in mph, plus the effect you'd actually
 * notice. More useful on a dashboard than a bare number.
 */
export function windDescription(mph) {
  if (mph == null) return { name: '--', effect: '' };
  if (mph < 1) return { name: 'CALM', effect: 'smoke rises vertically' };
  if (mph < 4) return { name: 'LIGHT AIR', effect: 'smoke drifts' };
  if (mph < 8) return { name: 'LIGHT BREEZE', effect: 'leaves rustle' };
  if (mph < 13) return { name: 'GENTLE BREEZE', effect: 'flags extend' };
  if (mph < 19) return { name: 'MODERATE', effect: 'dust and paper lift' };
  if (mph < 25) return { name: 'FRESH BREEZE', effect: 'small trees sway' };
  if (mph < 32) return { name: 'STRONG BREEZE', effect: 'umbrellas fail' };
  if (mph < 39) return { name: 'NEAR GALE', effect: 'walking is work' };
  if (mph < 47) return { name: 'GALE', effect: 'twigs break off' };
  if (mph < 55) return { name: 'STRONG GALE', effect: 'shingles lift' };
  if (mph < 64) return { name: 'STORM', effect: 'trees uprooted' };
  if (mph < 73) return { name: 'VIOLENT STORM', effect: 'widespread damage' };
  return { name: 'HURRICANE', effect: 'devastation' };
}

/**
 * How the air actually feels. Dew point is a far better comfort predictor
 * than relative humidity, which is why it gets top billing on the deck.
 */
export function dewpointComfort(dpF) {
  if (dpF == null) return { name: '--', color: '#8d9aab', note: '' };
  if (dpF < 30) return { name: 'VERY DRY', color: '#7fb2f0', note: 'static, chapped lips' };
  if (dpF < 45) return { name: 'DRY', color: '#3fd0d8', note: 'crisp and comfortable' };
  if (dpF < 55) return { name: 'COMFORTABLE', color: '#8fdc6a', note: 'ideal' };
  if (dpF < 60) return { name: 'STICKY', color: '#c6dc6e', note: 'noticeable humidity' };
  if (dpF < 65) return { name: 'HUMID', color: '#ecd46a', note: 'uncomfortable' };
  if (dpF < 70) return { name: 'OPPRESSIVE', color: '#f59a5b', note: 'sweat does not evaporate' };
  if (dpF < 75) return { name: 'MISERABLE', color: '#f47171', note: 'dangerous for exertion' };
  return { name: 'LETHAL', color: '#ef5a6a', note: 'limit outdoor exposure' };
}

/** CAPE + lifted index -> thunderstorm potential. */
export function convectiveRisk(cape, li) {
  if (cape == null) return { name: 'NO DATA', color: '#8d9aab', score: 0 };
  let s = clamp(cape / 3000, 0, 1) * 0.7;
  if (li != null) s += clamp(-li / 8, 0, 1) * 0.3;
  const score = clamp(s, 0, 1);
  if (cape < 300) return { name: 'STABLE', color: '#6bb3bd', score };
  if (cape < 1000) return { name: 'MARGINAL', color: '#3fd0d8', score };
  if (cape < 2500) return { name: 'MODERATE', color: '#ecd46a', score };
  if (cape < 4000) return { name: 'STRONG', color: '#f59a5b', score };
  return { name: 'EXTREME', color: '#ef5a6a', score };
}

/** NWS alert severity -> console color. */
export function alertColor(event = '', severity = '') {
  const e = event.toLowerCase();
  if (/tornado|hurricane|extreme|tsunami/.test(e)) return '#ef5a6a';
  if (/warning/.test(e)) return '#f47171';
  if (/watch/.test(e)) return '#f59a5b';
  if (/advisory|statement/.test(e)) return '#ecd46a';
  if (severity === 'Extreme' || severity === 'Severe') return '#f47171';
  return '#3fd0d8';
}

/** Local-time helpers that respect the location's timezone, not the browser's. */
export function makeTimeFmt(tz) {
  const o = (opts) => new Intl.DateTimeFormat('en-US', { timeZone: tz, ...opts });
  const hm = o({ hour: '2-digit', minute: '2-digit', hour12: false });
  const hm12 = o({ hour: 'numeric', minute: '2-digit', hour12: true });
  const hr = o({ hour: 'numeric', hour12: true });
  const wd = o({ weekday: 'short' });
  const md = o({ month: 'short', day: 'numeric' });
  const full = o({ weekday: 'long', month: 'long', day: 'numeric' });
  const hms = o({ hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  /*
   * Intl.DateTimeFormat.format() THROWS on an Invalid Date rather than
   * returning a placeholder, so every one of these has to be guarded. The
   * hm/hour/weekday family always was; isoDate and hourOfDay were not, and a
   * single unparseable upstream timestamp reaching either of them threw during
   * boot and killed the entire console with FATAL rather than blanking one
   * readout. A bad value should cost you a cell, never the page.
   */
  const at = (d) => {
    if (d == null) return null;
    const x = new Date(d);
    return Number.isNaN(+x) ? null : x;
  };
  const safe = (f) => (d) => { const x = at(d); return x ? f.format(x) : '--'; };
  const isoCA = new Intl.DateTimeFormat('en-CA', { timeZone: tz });
  const hodFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: 'numeric', minute: 'numeric', hour12: false,
  });
  return {
    hm: safe(hm), hm12: safe(hm12), hour: safe(hr), weekday: safe(wd),
    monthDay: safe(md), full: safe(full), hms: safe(hms),
    /**
     * Local calendar date string (YYYY-MM-DD) in the target timezone, or '--'.
     * Callers compare the result for equality, so a placeholder simply fails to
     * match and the record is skipped - which is the right thing to do with a
     * timestamp nobody can read.
     */
    isoDate: (d) => { const x = at(d); return x ? isoCA.format(x) : '--'; },
    /** Fractional hour-of-day, 0..24, in the target timezone; NaN if unreadable. */
    hourOfDay: (d) => {
      const x = at(d);
      if (!x) return NaN;
      const p = hodFmt.formatToParts(x);
      const g = (t) => +p.find((y) => y.type === t)?.value;
      return (g('hour') % 24) + g('minute') / 60;
    },
  };
}

/** Day-of-year using the same calendar-aligned buckets the server uses. */
export function dayOfYearOf(date, tz) {
  const at = new Date(date);
  if (Number.isNaN(+at)) return NaN;      // format() would throw, not return
  const s = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(at);
  const [, m, d] = s.split('-').map(Number);
  const cum = [0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335];
  return cum[m - 1] + d - 1;
}
