/**
 * Solar and lunar position math (Meeus, via the well-trodden SunCalc
 * formulation). Everything here is pure: give it a Date and a coordinate and
 * it hands back where the sun and moon actually are.
 *
 * The sky shader, the golden-hour panel, the moon dial and the stargazing
 * score all read from this, which is why it's worth doing properly rather
 * than approximating sunrise as "6am".
 */

const rad = Math.PI / 180;
const dayMs = 86400000;
const J1970 = 2440588;
const J2000 = 2451545;
const e = rad * 23.4397; // obliquity of the ecliptic

const toJulian = (date) => date.valueOf() / dayMs - 0.5 + J1970;
const fromJulian = (j) => new Date((j + 0.5 - J1970) * dayMs);
const toDays = (date) => toJulian(date) - J2000;

const rightAscension = (l, b) => Math.atan2(Math.sin(l) * Math.cos(e) - Math.tan(b) * Math.sin(e), Math.cos(l));
const declination = (l, b) => Math.asin(Math.sin(b) * Math.cos(e) + Math.cos(b) * Math.sin(e) * Math.sin(l));
const azimuth = (H, phi, dec) => Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi));
const altitude = (H, phi, dec) => Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
const siderealTime = (d, lw) => rad * (280.16 + 360.9856235 * d) - lw;

/** Apparent lift of a body near the horizon caused by the atmosphere. */
function astroRefraction(h) {
  if (h < 0) h = 0;
  return 0.0002967 / Math.tan(h + 0.00312536 / (h + 0.08901179));
}

const solarMeanAnomaly = (d) => rad * (357.5291 + 0.98560028 * d);

function eclipticLongitude(M) {
  const C = rad * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  const P = rad * 102.9372; // perihelion of the Earth
  return M + C + P + Math.PI;
}

function sunCoords(d) {
  const M = solarMeanAnomaly(d);
  const L = eclipticLongitude(M);
  return { dec: declination(L, 0), ra: rightAscension(L, 0) };
}

/** Sun altitude/azimuth in radians. Azimuth is measured from due south. */
export function sunPosition(date, lat, lon) {
  const lw = rad * -lon, phi = rad * lat, d = toDays(date);
  const c = sunCoords(d);
  const H = siderealTime(d, lw) - c.ra;
  return {
    azimuth: azimuth(H, phi, c.dec),
    altitude: altitude(H, phi, c.dec),
    declination: c.dec,
  };
}

/** Compass bearing in degrees (0 = north, 90 = east). */
export const toCompass = (azRad) => (azRad * 180 / Math.PI + 180 + 360) % 360;
export const toDeg = (r) => r * 180 / Math.PI;

const J0 = 0.0009;
const julianCycle = (d, lw) => Math.round(d - J0 - lw / (2 * Math.PI));
const approxTransit = (Ht, lw, n) => J0 + (Ht + lw) / (2 * Math.PI) + n;
const solarTransitJ = (ds, M, L) => J2000 + ds + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);

function hourAngle(h, phi, d) {
  return Math.acos((Math.sin(h) - Math.sin(phi) * Math.sin(d)) / (Math.cos(phi) * Math.cos(d)));
}
const observerAngle = (height) => -2.076 * Math.sqrt(height) / 60;

function getSetJ(h, lw, phi, dec, n, M, L) {
  const w = hourAngle(h, phi, dec);
  const a = approxTransit(w, lw, n);
  return solarTransitJ(a, M, L);
}

// Sun-altitude thresholds, in degrees, that define each named moment.
const SUN_TIMES = [
  [-0.833, 'sunrise', 'sunset'],
  [-0.3, 'sunriseEnd', 'sunsetStart'],
  [-4, 'blueHourEnd', 'blueHour'],
  [-6, 'dawn', 'dusk'],
  [-12, 'nauticalDawn', 'nauticalDusk'],
  [-18, 'nightEnd', 'night'],
  [6, 'goldenHourEnd', 'goldenHour'],
];

/**
 * Named solar events for the local day containing `date`. Any event that
 * doesn't occur (polar day/night, or no true darkness in summer at latitude)
 * comes back as an Invalid Date, which callers check with isNaN.
 */
export function sunTimes(date, lat, lon, height = 0) {
  const lw = rad * -lon, phi = rad * lat;
  const dh = observerAngle(height);
  const d = toDays(date);
  const n = julianCycle(d, lw);
  const ds = approxTransit(0, lw, n);
  const M = solarMeanAnomaly(ds);
  const L = eclipticLongitude(M);
  const dec = declination(L, 0);
  const Jnoon = solarTransitJ(ds, M, L);

  const result = { solarNoon: fromJulian(Jnoon), nadir: fromJulian(Jnoon - 0.5) };
  for (const [angle, riseName, setName] of SUN_TIMES) {
    const h0 = (angle + dh) * rad;
    const Jset = getSetJ(h0, lw, phi, dec, n, M, L);
    const Jrise = Jnoon - (Jset - Jnoon);
    result[riseName] = fromJulian(Jrise);
    result[setName] = fromJulian(Jset);
  }
  return result;
}

function moonCoords(d) {
  const L = rad * (218.316 + 13.176396 * d); // ecliptic longitude
  const M = rad * (134.963 + 13.064993 * d); // mean anomaly
  const F = rad * (93.272 + 13.229350 * d);  // mean distance
  const l = L + rad * 6.289 * Math.sin(M);
  const b = rad * 5.128 * Math.sin(F);
  const dt = 385001 - 20905 * Math.cos(M);   // km
  return { ra: rightAscension(l, b), dec: declination(l, b), dist: dt };
}

/**
 * Where a satellite sits in an observer's sky: altitude above the local
 * horizon and compass azimuth, from the sub-satellite point and its height.
 *
 * A satellite is close enough that the observer's displacement from the
 * Earth's centre matters -- at 420km the ISS is below the horizon for anyone
 * more than about 2,300km away, which a naive great-circle bearing would
 * happily ignore. Hence the `R / (R + altKm)` term.
 */
export function topocentric(obsLat, obsLon, satLat, satLon, altKm) {
  const R = 6371;
  const toR = Math.PI / 180;
  const cl = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const phi1 = obsLat * toR, phi2 = satLat * toR;
  const dl = (satLon - obsLon) * toR;
  const cosC = Math.sin(phi1) * Math.sin(phi2) + Math.cos(phi1) * Math.cos(phi2) * Math.cos(dl);
  const c = Math.acos(cl(cosC, -1, 1));                      // central angle
  const el = Math.atan2(Math.cos(c) - R / (R + altKm), Math.sin(c));
  const az = Math.atan2(
    Math.sin(dl) * Math.cos(phi2),
    Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dl));
  return { alt: toDeg(el), az: (toDeg(az) + 360) % 360, range: Math.round(c * R) };
}

export function moonPosition(date, lat, lon) {
  const lw = rad * -lon, phi = rad * lat, d = toDays(date);
  const c = moonCoords(d);
  const H = siderealTime(d, lw) - c.ra;
  let h = altitude(H, phi, c.dec);
  const pa = Math.atan2(Math.sin(H), Math.tan(phi) * Math.cos(c.dec) - Math.sin(c.dec) * Math.cos(H));
  h += astroRefraction(h);
  return { azimuth: azimuth(H, phi, c.dec), altitude: h, distance: c.dist, parallacticAngle: pa };
}

/**
 * `fraction` is the lit portion of the disc (0..1); `phase` runs 0 = new,
 * 0.25 = first quarter, 0.5 = full, 0.75 = last quarter.
 */
export function moonIllumination(date) {
  const d = toDays(date);
  const s = sunCoords(d), m = moonCoords(d);
  const sdist = 149598000; // km, mean Earth-Sun distance
  const phi = Math.acos(Math.sin(s.dec) * Math.sin(m.dec) + Math.cos(s.dec) * Math.cos(m.dec) * Math.cos(s.ra - m.ra));
  const inc = Math.atan2(sdist * Math.sin(phi), m.dist - sdist * Math.cos(phi));
  const angle = Math.atan2(
    Math.cos(s.dec) * Math.sin(s.ra - m.ra),
    Math.sin(s.dec) * Math.cos(m.dec) - Math.cos(s.dec) * Math.sin(m.dec) * Math.cos(s.ra - m.ra),
  );
  return {
    fraction: (1 + Math.cos(inc)) / 2,
    phase: 0.5 + 0.5 * inc * (angle < 0 ? -1 : 1) / Math.PI,
    angle,
  };
}

export const MOON_PHASES = [
  'New Moon', 'Waxing Crescent', 'First Quarter', 'Waxing Gibbous',
  'Full Moon', 'Waning Gibbous', 'Last Quarter', 'Waning Crescent',
];

export function moonPhaseName(phase) {
  // Snap to the exact phases within a narrow window, otherwise use the octant.
  const p = ((phase % 1) + 1) % 1;
  const near = (t, w = 0.02) => Math.abs(p - t) < w || Math.abs(p - t - 1) < w;
  if (near(0)) return 'New Moon';
  if (near(0.25)) return 'First Quarter';
  if (near(0.5)) return 'Full Moon';
  if (near(0.75)) return 'Last Quarter';
  if (p < 0.25) return 'Waxing Crescent';
  if (p < 0.5) return 'Waxing Gibbous';
  if (p < 0.75) return 'Waning Gibbous';
  return 'Waning Crescent';
}

/** Moonrise/moonset for the local day, by scanning altitude sign changes. */
export function moonTimes(date, lat, lon) {
  const t = new Date(date);
  t.setHours(0, 0, 0, 0);
  const hc = 0.133 * rad;
  let h0 = moonPosition(t, lat, lon).altitude - hc;
  let rise = null, set = null;

  // Two-hour steps with quadratic interpolation between them.
  for (let i = 1; i <= 24; i += 2) {
    const h1 = moonPosition(hoursLater(t, i), lat, lon).altitude - hc;
    const h2 = moonPosition(hoursLater(t, i + 1), lat, lon).altitude - hc;
    const a = (h0 + h2) / 2 - h1;
    const b = (h2 - h0) / 2;
    const xe = -b / (2 * a);
    const ye = (a * xe + b) * xe + h1;
    const d = b * b - 4 * a * h1;
    let roots = 0, x1 = 0, x2 = 0;

    if (d >= 0) {
      const dx = Math.sqrt(d) / (Math.abs(a) * 2);
      x1 = xe - dx; x2 = xe + dx;
      if (Math.abs(x1) <= 1) roots++;
      if (Math.abs(x2) <= 1) roots++;
      if (x1 < -1) x1 = x2;
    }
    if (roots === 1) { if (h0 < 0) rise = i + x1; else set = i + x1; }
    else if (roots === 2) {
      rise = i + (ye < 0 ? x2 : x1);
      set = i + (ye < 0 ? x1 : x2);
    }
    if (rise != null && set != null) break;
    h0 = h2;
  }
  return {
    rise: rise != null ? hoursLater(t, rise) : null,
    set: set != null ? hoursLater(t, set) : null,
    alwaysUp: rise == null && set == null && h0 > 0,
    alwaysDown: rise == null && set == null && h0 <= 0,
  };
}

const hoursLater = (date, h) => new Date(date.valueOf() + h * dayMs / 24);
