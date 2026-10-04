/**
 * The live sky.
 *
 * A single full-screen fragment shader that draws the atmosphere as it
 * actually is at the scrubber's current moment: sun and moon at their true
 * altitude and azimuth, three independent cloud decks drifting at the real
 * wind speed and bearing, precipitation, fog, lightning, aurora, stars, and
 * a neon city horizon underneath it all.
 *
 * Everything is expressed in (azimuth, elevation) so celestial bodies land
 * where they genuinely are rather than where a 2D layout would put them.
 */

const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform vec2  uRes;
uniform float uTime;
uniform int   uQuality;      // 0..3, drives octave counts and effect gating

uniform float uSunAlt;       // radians
uniform float uSunAz;        // radians, 0 = north, increasing eastward
uniform float uMoonAlt;
uniform float uMoonAz;
uniform float uMoonPhase;    // 0 new .. 0.5 full .. 1 new
uniform float uMoonFrac;     // illuminated fraction

uniform float uViewAz;       // bearing the camera faces
uniform float uCloudLow;
uniform float uCloudMid;
uniform float uCloudHigh;
uniform float uPrecip;       // 0..1 intensity
uniform float uSnow;         // 0 = rain, 1 = snow
uniform float uStorm;        // 0..1 convective activity
uniform float uFlash;        // lightning, driven from JS
uniform float uFog;          // 0..1
uniform float uWind;         // mph
uniform float uWindDir;      // radians, direction wind blows TOWARD
uniform float uKp;           // 0..9 planetary K index
uniform float uLat;          // observer latitude, degrees
uniform float uHaze;         // aerosol / low visibility
uniform float uCityGlow;     // light-pollution intensity on the horizon

#define PI 3.14159265359
#define TAU 6.28318530718

/* ------------------------------------------------------------ noise */

float hash21(vec2 p) {
  p = fract(p * vec2(233.34, 851.73));
  p += dot(p, p + 23.45);
  return fract(p.x * p.y);
}

vec2 hash22(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return fract(sin(p) * 43758.5453);
}

float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm(vec2 p, int oct) {
  float v = 0.0, a = 0.5;
  mat2 rot = mat2(0.8, 0.6, -0.6, 0.8); // decorrelate octaves
  for (int i = 0; i < 7; i++) {
    if (i >= oct) break;
    v += a * vnoise(p);
    p = rot * p * 2.02;
    a *= 0.5;
  }
  return v;
}

/* Ridged noise reads more like real cloud structure than plain fbm. */
float ridged(vec2 p, int oct) {
  float v = 0.0, a = 0.5;
  mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
  for (int i = 0; i < 6; i++) {
    if (i >= oct) break;
    v += a * (1.0 - abs(vnoise(p) * 2.0 - 1.0));
    p = rot * p * 2.1;
    a *= 0.5;
  }
  return v;
}

/*
 * Skyline height in radians of elevation, for a given azimuth. Four octaves
 * of hashed blocks give a mix of towers and low-rise without any geometry.
 */
float skyline(float az) {
  float h = 0.0;
  for (int i = 0; i < 4; i++) {
    float scale = 16.0 + float(i) * 25.0;
    float cell = floor(az * scale);
    float r = hash21(vec2(cell, float(i) * 31.7));
    float bh = r * r * (0.085 - float(i) * 0.016);
    h = max(h, bh * step(0.28, r));
  }
  return h;
}

/* Great-circle angle between two (azimuth, elevation) pairs. */
float angDist(float az1, float el1, float az2, float el2) {
  float c = sin(el1) * sin(el2) + cos(el1) * cos(el2) * cos(az1 - az2);
  return acos(clamp(c, -1.0, 1.0));
}

/*
 * Project a viewing ray onto a horizontal slab at height h and return the
 * ground-plane coordinate. This is what makes cloud decks converge toward
 * the horizon instead of sliding like a flat texture.
 */
vec2 slab(float az, float el, float h) {
  float s = max(sin(el), 0.012);
  float t = h / s;
  return vec2(sin(az), cos(az)) * t;
}

/* ------------------------------------------------------------ main */

void main() {
  vec2 uv = vUv;
  float aspect = uRes.x / uRes.y;

  // Horizon sits low so the sky dominates the frame.
  float horizonY = -0.30;
  float elev = (uv.y - horizonY) * 0.95;              // ~ +/- radians
  float el   = elev * (PI * 0.42);
  float az   = uViewAz + uv.x * aspect * 0.95;

  int oct = uQuality >= 3 ? 6 : uQuality == 2 ? 5 : uQuality == 1 ? 4 : 3;

  // Needed by both the cloud masks and the ground block below.
  float cityH = skyline(az);

  /*
   * Optical depth of the cloud column. Thick cloud does not merely cover the
   * sky, it blocks the light coming through it, so this dims the palette AND
   * occludes the sun and moon. Without it a 95%-overcast thunderstorm renders
   * as a bright white sheet with a visible solar halo burnt through it.
   */
  float totalCloud = clamp(uCloudLow * 0.62 + uCloudMid * 0.30 + uCloudHigh * 0.08, 0.0, 1.0);
  float gloom = clamp(1.0 - totalCloud * 0.68 - uStorm * 0.34, 0.12, 1.0);
  float seeThrough = 1.0 - totalCloud * 0.92;   // how much of the disc survives

  float sunDeg = uSunAlt * 57.29578;
  float dayAmt   = smoothstep(-6.5, 7.0, sunDeg);
  float nightAmt = 1.0 - smoothstep(-15.0, -1.5, sunDeg);
  float goldAmt  = exp(-pow((sunDeg - 1.5) / 8.0, 2.0));

  /* ---------------------------------------------------- sky gradient */

  float zen = clamp(el / (PI * 0.5), 0.0, 1.0);

  // Palettes are graded toward cyan and magenta rather than natural blue.
  vec3 dayZen  = vec3(0.031, 0.243, 0.478);
  vec3 dayHor  = vec3(0.298, 0.667, 0.808);
  vec3 goldZen = vec3(0.075, 0.153, 0.400);
  vec3 goldHor = vec3(1.000, 0.412, 0.180);
  vec3 nightZen= vec3(0.004, 0.010, 0.035);
  vec3 nightHor= vec3(0.020, 0.055, 0.125);

  vec3 zenC = mix(nightZen, dayZen, dayAmt);
  vec3 horC = mix(nightHor, dayHor, dayAmt);
  zenC = mix(zenC, goldZen, goldAmt * 0.75);
  horC = mix(horC, goldHor, goldAmt * 0.85);

  float grad = pow(1.0 - zen, 2.1);
  vec3 col = mix(zenC, horC, grad);

  // A magenta bloom opposite the sun: the anti-twilight arch, and at night
  // the light dome of a city. Most metro areas have plenty of both.
  float horizonBand = pow(1.0 - clamp(abs(el) / 0.30, 0.0, 1.0), 2.5);
  float sunSideward = 0.5 + 0.5 * cos(az - uSunAz);
  col += vec3(1.0, 0.18, 0.55) * horizonBand * goldAmt * 0.35 * (1.0 - sunSideward);
  col += vec3(1.0, 0.45, 0.16) * horizonBand * goldAmt * 0.55 * sunSideward;
  col += vec3(1.0, 0.30, 0.62) * horizonBand * nightAmt * uCityGlow * 0.55;
  col += vec3(0.20, 0.85, 1.00) * horizonBand * nightAmt * uCityGlow * 0.22;

  /* ---------------------------------------------------------- stars */

  if (nightAmt > 0.01 && el > cityH) {
    // Cell-based star field in angular space, so stars stay put as the
    // horizon curves rather than stretching.
    vec2 sp = vec2(az * 30.0, el * 30.0);
    vec2 cell = floor(sp);
    vec2 f = fract(sp);
    float starTot = 0.0;
    for (int j = -1; j <= 1; j++) {
      for (int i = -1; i <= 1; i++) {
        vec2 o = vec2(float(i), float(j));
        vec2 h = hash22(cell + o);
        if (h.x > 0.55) {                 // star density
          vec2 pos = o + h;
          float d = length(f - pos);
          float mag = hash21(cell + o + 7.1);
          float bright = pow(mag, 3.4) * 2.2 + 0.035;   // few bright, many faint
          // Twinkle harder near the horizon, where the air path is longest.
          float tw = 0.75 + 0.25 * sin(uTime * (1.5 + mag * 5.0) + mag * 30.0)
                     * (1.0 - smoothstep(0.0, 0.6, el));
          starTot += bright * tw * smoothstep(0.075, 0.0, d);
        }
      }
    }
    // Milky Way: a broad band tilted by observer latitude.
    float mwBand = exp(-pow((el - 0.55 + sin(az * 0.8) * 0.28) / 0.30, 2.0));
    float mwTex = fbm(vec2(az * 3.0, el * 3.0) + 11.0, oct);
    vec3 mwCol = mix(vec3(0.35, 0.45, 0.75), vec3(0.75, 0.55, 0.85), mwTex);
    float horizonFade = smoothstep(cityH, cityH + 0.25, el);

    col += vec3(0.85, 0.93, 1.0) * starTot * nightAmt * horizonFade * seeThrough;
    col += mwCol * mwBand * mwTex * 0.16 * nightAmt * horizonFade * seeThrough;
  }

  /* --------------------------------------------------------- aurora */

  if (uKp >= 3.0 && nightAmt > 0.2) {
    // Aurora sits toward the pole: north above the equator, south below.
    float poleAz = uLat >= 0.0 ? 0.0 : PI;
    float toPole = abs(mod(az - poleAz + PI, TAU) - PI);
    float facing = smoothstep(1.5, 0.2, toPole);
    float band = smoothstep(0.02, 0.10, el) * (1.0 - smoothstep(0.22, 0.75, el));
    float curtain = ridged(vec2(az * 2.4 + uTime * 0.045, el * 5.0 - uTime * 0.10), oct);
    float rays = fbm(vec2(az * 22.0, el * 2.0 - uTime * 0.35), 3);
    float strength = smoothstep(3.0, 7.5, uKp) * facing * band;
    vec3 auroraCol = mix(vec3(0.15, 1.0, 0.55), vec3(0.70, 0.25, 1.0), smoothstep(0.3, 0.85, curtain));
    col += auroraCol * pow(curtain, 2.2) * rays * strength * 1.5;
  }

  /* ------------------------------------------------------- sun/moon */

  float sunD = angDist(az, el, uSunAz, uSunAlt);
  float moonD = angDist(az, el, uMoonAz, uMoonAlt);

  // Broad forward-scattering halo, present even when the disc is below us.
  float halo = exp(-sunD * 2.6) * 0.55 + exp(-sunD * 9.0) * 0.6;
  vec3 sunTint = mix(vec3(1.0, 0.42, 0.14), vec3(1.0, 0.95, 0.80), dayAmt);
  col += sunTint * halo * (0.35 + dayAmt * 0.9) * smoothstep(-0.22, 0.02, uSunAlt)
         * mix(0.10, 1.0, seeThrough);

  // The disc itself, ~0.53 deg across, with a touch of bloom.
  float sunDisc = smoothstep(0.0105, 0.0075, sunD);
  if (uSunAlt > -0.06) {
    col = mix(col, vec3(1.0, 0.97, 0.88), sunDisc * 0.97 * seeThrough);
    col += sunTint * exp(-sunD * 60.0) * 1.2 * seeThrough;
  }

  // Moon: a lit disc with a real terminator, plus earthshine on the dark limb.
  if (uMoonAlt > -0.05) {
    float md = smoothstep(0.0125, 0.0095, moonD);
    if (md > 0.001) {
      // Local disc coordinates, so we can carve the phase.
      float dAz = mod(az - uMoonAz + PI, TAU) - PI;
      float dx = dAz * cos(uMoonAlt);
      float dy = el - uMoonAlt;
      float r = 0.0115;
      vec2 p = vec2(dx, dy) / r;
      /*
       * Terminator. The shadow edge is an ellipse whose semi-minor axis is
       * k = 1 - 2f, running +1 at new moon through 0 at quarter to -1 at
       * full. A waxing moon is lit on the right, a waning moon on the left.
       */
      float k = 1.0 - 2.0 * uMoonFrac;
      float term = k * sqrt(max(0.0, 1.0 - p.y * p.y));
      float sd = (uMoonPhase < 0.5) ? (p.x - term) : (-p.x - term);
      float lit = smoothstep(-0.09, 0.09, sd);
      float mare = fbm(p * 1.6 + 3.0, 3);
      vec3 moonSurf = mix(vec3(0.86, 0.90, 0.96), vec3(0.55, 0.60, 0.70), mare * 0.55);
      vec3 moonLit = moonSurf * (0.15 + 0.95 * lit) + vec3(0.06, 0.10, 0.16) * (1.0 - lit);
      float moonVis = (1.0 - dayAmt * 0.55) * seeThrough;
      col = mix(col, moonLit, md * moonVis);
      col += vec3(0.65, 0.80, 1.0) * exp(-moonD * 90.0) * uMoonFrac * moonVis * 0.5;
    }
  }

  /* --------------------------------------------------------- clouds */

  float windRad = uWindDir;
  vec2 drift = vec2(sin(windRad), cos(windRad)) * uTime * (0.004 + uWind * 0.0016);
  float skyMask = smoothstep(cityH - 0.004, cityH + 0.03, el);

  vec3 cloudLitDay   = vec3(1.00, 0.99, 0.98);
  vec3 cloudLitGold  = vec3(1.00, 0.52, 0.30);
  vec3 cloudShadeDay = vec3(0.36, 0.44, 0.56);
  vec3 cloudNight    = vec3(0.045, 0.075, 0.135);

  vec3 cLit   = mix(cloudNight * 2.2, mix(cloudLitDay, cloudLitGold, goldAmt * 0.8), dayAmt) * gloom;
  vec3 cShade = mix(cloudNight, cloudShadeDay, dayAmt) * gloom;

  // Storm cloud is bruised blue-grey, not neutral.
  vec3 stormTint = vec3(0.34, 0.37, 0.50);
  cLit   = mix(cLit,   cLit   * stormTint, uStorm * 0.65);
  cShade = mix(cShade, cShade * stormTint, uStorm * 0.75);

  // The sky between the clouds dims too.
  col *= mix(1.0, gloom, 0.75);
  // Under a city dome, cloud bases pick up magenta from below.
  cShade += vec3(0.55, 0.12, 0.30) * nightAmt * uCityGlow * 0.35;

  // -- high deck: thin cirrus, fast, wispy
  if (uCloudHigh > 0.01) {
    vec2 p = slab(az, el, 7.0) * 0.11 + drift * 2.2;
    float n = ridged(p, oct);
    float cov = smoothstep(1.02 - uCloudHigh * 0.75, 1.25 - uCloudHigh * 0.75, n + uCloudHigh * 0.35);
    cov *= skyMask * smoothstep(0.0, 0.16, el);
    col = mix(col, mix(cShade, cLit, 0.85), cov * 0.55 * uCloudHigh);
  }

  // -- mid deck
  if (uCloudMid > 0.01) {
    vec2 p = slab(az, el, 3.2) * 0.22 + drift * 1.4;
    float n = fbm(p, oct);
    float cov = smoothstep(0.62 - uCloudMid * 0.34, 0.80 - uCloudMid * 0.30, n);
    cov *= skyMask * smoothstep(0.0, 0.10, el);
    float shade = fbm(p + vec2(0.35), oct - 1);
    col = mix(col, mix(cShade, cLit, smoothstep(0.30, 0.72, shade)), cov * 0.72 * uCloudMid);
  }

  // -- low deck: the one you actually feel, thickest and slowest
  if (uCloudLow > 0.01) {
    vec2 p = slab(az, el, 1.35) * 0.40 + drift;
    float n = fbm(p, oct);
    float det = fbm(p * 3.1 - drift * 0.4, oct - 1);
    n = n * 0.78 + det * 0.22;
    float cov = smoothstep(0.58 - uCloudLow * 0.36, 0.76 - uCloudLow * 0.30, n);
    cov *= skyMask * smoothstep(0.0, 0.055, el);
    // Fake self-shadowing: sample slightly toward the sun for the lit side.
    float toward = fbm(p + vec2(sin(uSunAz), cos(uSunAz)) * 0.16, oct - 1);
    float shade = smoothstep(0.34, 0.70, toward);
    vec3 body = mix(cShade, cLit, shade);
    col = mix(col, body, cov * 0.92 * uCloudLow);

    // Lightning lights the deck from inside.
    if (uFlash > 0.001) {
      col += vec3(0.80, 0.88, 1.0) * cov * uFlash * 0.85;
    }
  }

  /* ------------------------------------------------------------ fog */

  if (uFog > 0.01) {
    float fogAmt = uFog * (1.0 - smoothstep(-0.05, 0.35, el));
    vec3 fogCol = mix(vec3(0.06, 0.10, 0.16), vec3(0.62, 0.70, 0.78), dayAmt);
    fogCol += vec3(0.45, 0.10, 0.28) * nightAmt * uCityGlow * 0.5;
    float swirl = fbm(vec2(az * 3.0, el * 6.0) + uTime * 0.02, 4);
    col = mix(col, fogCol, clamp(fogAmt * (0.6 + swirl * 0.5), 0.0, 0.95));
  }

  // General aerosol haze washes out contrast near the horizon.
  col = mix(col, mix(vec3(0.10, 0.13, 0.18), vec3(0.68, 0.72, 0.76), dayAmt),
            uHaze * horizonBand * 0.45);

  /* ------------------------------------------------- ground / city */

  /*
   * The skyline occupies POSITIVE elevation — buildings stand up from the
   * horizon. Ground (grid floor) is everything below el = 0.
   */
  if (el < cityH) {
    vec3 ground;

    if (el >= 0.0) {
      // --- building face ---
      float up = el / max(cityH, 1e-4);              // 0 at street, 1 at roofline
      vec3 face = vec3(0.012, 0.017, 0.034) * (1.0 - up * 0.45);

      // Window grid. Columns follow azimuth, rows follow elevation.
      vec2 wcell = floor(vec2(az * 520.0, el * 900.0));
      float lit = hash21(wcell);
      float on = step(0.80 - nightAmt * 0.10, lit);
      vec3 winCol = mix(vec3(1.0, 0.76, 0.32), vec3(0.35, 0.95, 1.0), hash21(wcell + 5.7));
      face += winCol * on * (0.45 + nightAmt * 1.05);

      // Occasional neon sign band on a facade.
      float signHash = hash21(vec2(floor(az * 45.0), 3.0));
      if (signHash > 0.88) {
        float band = smoothstep(0.42, 0.46, up) * (1.0 - smoothstep(0.56, 0.60, up));
        vec3 signCol = mix(vec3(1.0, 0.10, 0.55), vec3(0.10, 1.0, 0.85), hash21(vec2(floor(az * 45.0), 9.0)));
        face += signCol * band * (0.6 + nightAmt * 1.4)
                * (0.7 + 0.3 * sin(uTime * 3.0 + signHash * 40.0));
      }

      // Roofline aviation lights.
      float roof = smoothstep(0.965, 1.0, up) * step(0.93, hash21(vec2(floor(az * 90.0), 17.0)));
      face += vec3(1.0, 0.12, 0.12) * roof * (0.5 + 0.5 * sin(uTime * 2.2));

      ground = face;
    } else {
      /*
       * Ground plane grid. Project the ray onto a floor one unit below the
       * eye: distance along the ground is 1/tan(dip), so the grid genuinely
       * converges at the horizon instead of fanning out from screen centre.
       */
      float dip = -el;
      float dist = 1.0 / max(tan(dip), 0.004);
      vec2 fp = vec2(sin(az), cos(az)) * dist;
      fp.y -= uTime * 0.55;                       // drift toward the viewer

      // Derivative-aware line width keeps distant lines from aliasing away.
      vec2 gw = fwidth(fp) * 1.4;
      vec2 gf = abs(fract(fp) - 0.5);
      vec2 gl = smoothstep(gw, vec2(0.0), gf);
      float grid = clamp(max(gl.x, gl.y), 0.0, 1.0);

      float fade = 1.0 / (1.0 + dist * dist * 0.0022);
      vec3 gridCol = mix(vec3(0.55, 0.10, 0.42), vec3(0.0, 0.92, 1.0), clamp(dist / 14.0, 0.0, 1.0));
      ground = vec3(0.004, 0.008, 0.020) + gridCol * grid * fade * 0.42;
      // Wet streets mirror the sky when it is raining.
      ground += horC * uPrecip * 0.16 * fade;   // wet streets mirror the sky
    }

    // Haze stacked on the skyline, and the city's own light dome.
    float distFade = exp(-max(0.0, cityH - el) * 22.0);
    // Skyline haze is lit by the sky above it, so it must dim with the sky.
    ground += mix(horC, vec3(1.0, 0.22, 0.52), nightAmt * 0.65)
              * distFade * (0.22 + uCityGlow * 0.45) * mix(gloom, 1.0, nightAmt * 0.7);

    col = mix(col, ground, smoothstep(cityH + 0.0015, cityH - 0.0015, el));
  }

  // Glow spilling upward off the skyline into the sky.
  {
    float above = el - cityH;
    if (above > 0.0) {
      col += mix(vec3(0.9, 0.45, 0.15), vec3(1.0, 0.25, 0.60), nightAmt)
             * exp(-above * 55.0) * uCityGlow * (0.10 + nightAmt * 0.30)
             * mix(gloom, 1.0, nightAmt * 0.7);
    }
  }

  /* --------------------------------------------------- precipitation */

  if (uPrecip > 0.01 && uQuality >= 1) {
    vec2 sp = vec2(uv.x * aspect, uv.y);
    float acc = 0.0;
    int layers = uQuality >= 3 ? 4 : uQuality == 2 ? 3 : 2;

    if (uSnow < 0.5) {
      // Rain: near-vertical streaks, sheared by wind, faster in the near layers.
      float shear = clamp(uWind / 45.0, 0.0, 0.6) * sign(sin(uWindDir - uViewAz));
      for (int i = 0; i < 4; i++) {
        if (i >= layers) break;
        float fi = float(i);
        float scale = 34.0 + fi * 26.0;
        float speed = 2.6 + fi * 1.9;
        vec2 q = vec2(sp.x * scale + fi * 17.0, sp.y * scale * 0.24 + uTime * speed);
        q.x += q.y * shear;
        vec2 cell = floor(q);
        float h = hash21(cell);
        if (h > 0.972 - uPrecip * 0.045) {
          vec2 f = fract(q) - vec2(hash21(cell + 1.7), 0.5);
          float streak = smoothstep(0.055, 0.0, abs(f.x)) * smoothstep(0.62, 0.0, abs(f.y));
          acc += streak * (0.5 + fi * 0.22);
        }
      }
      // Streaks veil the scene; they must never overwhelm it.
      acc = clamp(acc, 0.0, 1.0);
      col = mix(col, col * 0.82 + vec3(0.30, 0.44, 0.58), acc * uPrecip * 0.42);
    } else {
      // Snow: slow drifting flakes with a lateral sway.
      for (int i = 0; i < 4; i++) {
        if (i >= layers) break;
        float fi = float(i);
        float scale = 18.0 + fi * 15.0;
        float speed = 0.30 + fi * 0.26;
        vec2 q = vec2(sp.x * scale, sp.y * scale + uTime * speed);
        vec2 cell = floor(q);
        float h = hash21(cell);
        if (h > 0.962 - uPrecip * 0.045) {
          vec2 f = fract(q) - 0.5;
          f.x += sin(uTime * (0.7 + h) + h * 20.0) * 0.28;
          float flake = smoothstep(0.14 + fi * 0.02, 0.0, length(f));
          acc += flake * (0.55 + fi * 0.2);
        }
      }
      acc = clamp(acc, 0.0, 1.0);
      col = mix(col, col * 0.85 + vec3(0.62, 0.68, 0.78), acc * uPrecip * 0.55);
    }
  }

  // Precipitation greys out distance; this is most of what "heavy rain" looks like.
  if (uPrecip > 0.01) {
    vec3 veil = mix(vec3(0.06, 0.09, 0.14), vec3(0.42, 0.47, 0.54), dayAmt) * gloom;
    col = mix(col, veil, clamp(uPrecip * 0.45, 0.0, 0.55) * horizonBand);
  }

  // Full-frame lightning wash.
  col += vec3(0.75, 0.85, 1.0) * uFlash * 0.16;

  /* ------------------------------------------------------- grading */

  // Gentle filmic curve, then a cyan-shadow / magenta-highlight push.
  col = max(col, 0.0);
  col = (col * (2.51 * col + 0.03)) / (col * (2.43 * col + 0.59) + 0.14);
  col = mix(col, col * vec3(0.88, 1.02, 1.10), 0.35);            // cool the shadows
  col += vec3(0.030, 0.0, 0.022) * pow(max(col.r, 0.0), 2.0);    // magenta in the highs

  // Vignette (the CSS layer adds another, subtler one on top).
  float vig = 1.0 - 0.28 * pow(length(uv * vec2(aspect, 1.0)) * 0.62, 2.2);
  col *= vig;

  fragColor = vec4(col, 1.0);
}`;

/* ------------------------------------------------------------------ class */

const DEFAULTS = {
  sunAlt: 0.4, sunAz: 3.0, moonAlt: -0.4, moonAz: 1.0, moonPhase: 0.25, moonFrac: 0.5,
  viewAz: Math.PI, cloudLow: 0.2, cloudMid: 0.1, cloudHigh: 0.1,
  precip: 0, snow: 0, storm: 0, fog: 0, wind: 6, windDir: 4.0,
  kp: 2, lat: 40.7, haze: 0.15, cityGlow: 0.5,
};

// Parameters that must not be interpolated (they are flags, not quantities).
const SNAP = new Set(['snow', 'lat']);

export class Sky {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = null;
    this.params = { ...DEFAULTS };
    this.target = { ...DEFAULTS };
    this.quality = 2;
    this.running = false;
    this.flash = 0;
    this.nextBolt = Infinity;
    this.scale = 1;
    this.ok = false;
    this.t0 = performance.now();
  }

  init() {
    const gl = this.canvas.getContext('webgl2', {
      alpha: false, antialias: false, depth: false, stencil: false,
      powerPreference: 'high-performance', preserveDrawingBuffer: false,
    });
    if (!gl) { this.ok = false; return false; }
    this.gl = gl;

    const prog = linkProgram(gl, VERT, FRAG);
    if (!prog) { this.ok = false; return false; }
    this.prog = prog;
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    this.u = {};
    for (const n of ['uRes', 'uTime', 'uQuality', 'uSunAlt', 'uSunAz', 'uMoonAlt', 'uMoonAz',
      'uMoonPhase', 'uMoonFrac', 'uViewAz', 'uCloudLow', 'uCloudMid', 'uCloudHigh', 'uPrecip',
      'uSnow', 'uStorm', 'uFlash', 'uFog', 'uWind', 'uWindDir', 'uKp', 'uLat', 'uHaze', 'uCityGlow']) {
      this.u[n] = gl.getUniformLocation(prog, n);
    }

    this.resize();
    this.ok = true;
    return true;
  }

  /** Merge new target values; the render loop eases toward them. */
  set(params) { Object.assign(this.target, params); }

  /** Jump immediately, used on first paint and on big scrubber jumps. */
  snap(params) { Object.assign(this.target, params); Object.assign(this.params, params); }

  setQuality(q) {
    this.quality = q;
    // Render below native resolution on weak tiers; the sky is soft enough
    // that nobody notices, and it is by far the cheapest lever we have.
    this.scale = q >= 3 ? 1 : q === 2 ? 0.85 : q === 1 ? 0.65 : 0.5;
    this.resize();
  }

  resize() {
    const gl = this.gl;
    if (!gl) return;
    const dpr = Math.min(window.devicePixelRatio || 1, this.quality >= 3 ? 2 : 1.5);
    const w = Math.max(2, Math.floor(this.canvas.clientWidth * dpr * this.scale));
    const h = Math.max(2, Math.floor(this.canvas.clientHeight * dpr * this.scale));
    if (this.canvas.width === w && this.canvas.height === h) return;
    this.canvas.width = w; this.canvas.height = h;
    gl.viewport(0, 0, w, h);
  }

  /** Advance eased parameters and lightning, then draw one frame. */
  render(nowMs, dt) {
    if (!this.ok) return;
    const gl = this.gl;
    const p = this.params, t = this.target;

    // Ease toward targets. Angles are eased on the shortest arc so the sun
    // doesn't sweep the long way round when the scrubber crosses north.
    const k = 1 - Math.pow(0.0016, dt);
    for (const key in t) {
      if (SNAP.has(key)) { p[key] = t[key]; continue; }
      if (key.endsWith('Az') || key === 'windDir') {
        let d = t[key] - p[key];
        d = ((d + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
        p[key] += d * k;
      } else {
        p[key] += (t[key] - p[key]) * k;
      }
    }

    // Lightning: Poisson-ish strikes whose rate scales with storm intensity.
    if (p.storm > 0.12) {
      if (this.nextBolt === Infinity) this.nextBolt = nowMs + Math.random() * 3000;
      if (nowMs > this.nextBolt) {
        this.flash = 0.30 + Math.random() * 0.45;
        this.nextBolt = nowMs + 900 + Math.random() * 9000 * (1.15 - p.storm);
      }
    } else {
      this.nextBolt = Infinity;
    }
    this.flash *= Math.pow(0.00008, dt);         // sharp decay (~0.25s)
    if (this.flash < 0.002) this.flash = 0;

    const u = this.u;
    gl.uniform2f(u.uRes, this.canvas.width, this.canvas.height);
    gl.uniform1f(u.uTime, (nowMs - this.t0) / 1000);
    gl.uniform1i(u.uQuality, this.quality);
    gl.uniform1f(u.uSunAlt, p.sunAlt);
    gl.uniform1f(u.uSunAz, p.sunAz);
    gl.uniform1f(u.uMoonAlt, p.moonAlt);
    gl.uniform1f(u.uMoonAz, p.moonAz);
    gl.uniform1f(u.uMoonPhase, p.moonPhase);
    gl.uniform1f(u.uMoonFrac, p.moonFrac);
    gl.uniform1f(u.uViewAz, p.viewAz);
    gl.uniform1f(u.uCloudLow, p.cloudLow);
    gl.uniform1f(u.uCloudMid, p.cloudMid);
    gl.uniform1f(u.uCloudHigh, p.cloudHigh);
    gl.uniform1f(u.uPrecip, p.precip);
    gl.uniform1f(u.uSnow, p.snow);
    gl.uniform1f(u.uStorm, p.storm);
    gl.uniform1f(u.uFlash, this.flash);
    gl.uniform1f(u.uFog, p.fog);
    gl.uniform1f(u.uWind, p.wind);
    gl.uniform1f(u.uWindDir, p.windDir);
    gl.uniform1f(u.uKp, p.kp);
    gl.uniform1f(u.uLat, p.lat);
    gl.uniform1f(u.uHaze, p.haze);
    gl.uniform1f(u.uCityGlow, p.cityGlow);

    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}

function linkProgram(gl, vsSrc, fsSrc) {
  const vs = compile(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc);
  if (!vs || !fs) return null;
  const p = gl.createProgram();
  gl.attachShader(p, vs); gl.attachShader(p, fs);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    console.error('[sky] link failed:', gl.getProgramInfoLog(p));
    return null;
  }
  gl.deleteShader(vs); gl.deleteShader(fs);
  return p;
}

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    console.error(`[sky] ${type === gl.VERTEX_SHADER ? 'vertex' : 'fragment'} compile failed:\n${log}`);
    // Print the offending line to make shader iteration bearable.
    const m = /ERROR:\s*\d+:(\d+)/.exec(log || '');
    if (m) {
      const lines = src.split('\n');
      const n = +m[1];
      console.error(lines.slice(Math.max(0, n - 3), n + 2)
        .map((l, i) => `${Math.max(1, n - 2) + i}| ${l}`).join('\n'));
    }
    return null;
  }
  return s;
}
