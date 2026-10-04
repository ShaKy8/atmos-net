/**
 * Adaptive quality.
 *
 * The console runs on a laptop, so it earns its frame rate rather than
 * assuming it. Quality tier 0-3 is chosen from power state, visibility and
 * measured frame time, and every expensive subsystem reads it.
 *
 *   3  plugged in, comfortably above 55fps  -> everything on
 *   2  the normal case                      -> full effects, slight downscale
 *   1  on battery, or struggling            -> reduced octaves, no grain
 *   0  hidden tab, low battery, or crawling -> minimal, near-idle
 */

const listeners = new Set();

export const perf = {
  tier: 2,
  fps: 60,
  onBattery: false,
  batteryLevel: 1,
  hidden: false,
  reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
  manual: null,          // user override from the settings panel

  onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
};

let frames = 0, acc = 0, lastEval = 0;
let sustainedLow = 0, sustainedHigh = 0;

/** Called once per animation frame with the frame delta in seconds. */
export function sampleFrame(dt) {
  frames++;
  acc += dt;
  const now = performance.now();
  if (now - lastEval < 1000) return;
  lastEval = now;
  perf.fps = acc > 0 ? frames / acc : 60;
  frames = 0; acc = 0;

  if (perf.fps < 40) { sustainedLow++; sustainedHigh = 0; }
  else if (perf.fps > 55) { sustainedHigh++; sustainedLow = 0; }
  else { sustainedLow = 0; sustainedHigh = 0; }

  const want = decide();
  if (want !== perf.tier) apply(want);
}

/*
 * A phone is a battery device that cannot say so.
 *
 * The tier ladder below infers "plugged in" from navigator.getBattery, which
 * Safari does not implement — so perf.onBattery stays false forever and every
 * iPhone booted at tier 3: the six-octave shader at full device resolution,
 * under six to eight backdrop-filter layers and three animated overlays. It
 * only clawed back one tier per three seconds of sub-40fps, so the first ten
 * seconds on a phone were the most expensive configuration in the app.
 *
 * A coarse pointer on a small viewport is the reliable signal Safari does give
 * us. The adaptive ladder still applies on top, and Settings still overrides.
 */
function isHandheld() {
  if (typeof matchMedia !== 'function') return false;
  return matchMedia('(pointer: coarse)').matches && matchMedia('(max-width: 820px)').matches;
}

function decide() {
  if (perf.manual != null) return perf.manual;
  if (perf.hidden) return 0;
  if (perf.reducedMotion) return 1;
  if (isHandheld()) {
    // Start low and let sustainedHigh climb if the device turns out to cope.
    let h = 1;
    if (sustainedLow >= 3) h = Math.max(0, perf.tier - 1);
    if (sustainedHigh >= 6 && perf.tier < 2) h = perf.tier + 1;
    return Math.max(0, Math.min(2, h));
  }

  let t = perf.onBattery ? 2 : 3;
  if (perf.onBattery && perf.batteryLevel < 0.25) t = 1;
  // Only step down after the slowdown persists, so one janky second from a
  // map tile load doesn't permanently degrade the sky.
  if (sustainedLow >= 3) t = Math.max(0, perf.tier - 1);
  if (sustainedHigh >= 6 && t > perf.tier) t = perf.tier + 1;
  return Math.max(0, Math.min(3, t));
}

function apply(t) {
  perf.tier = t;
  document.documentElement.dataset.q = String(t);
  sustainedLow = 0; sustainedHigh = 0;
  for (const fn of listeners) fn(t);
}

export function initPerf() {
  document.addEventListener('visibilitychange', () => {
    perf.hidden = document.hidden;
    apply(decide());
  });

  matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', (e) => {
    perf.reducedMotion = e.matches;
    apply(decide());
  });

  if (navigator.getBattery) {
    navigator.getBattery().then((b) => {
      const read = () => {
        perf.onBattery = !b.charging;
        perf.batteryLevel = b.level;
        apply(decide());
      };
      b.addEventListener('chargingchange', read);
      b.addEventListener('levelchange', read);
      read();
    }).catch(() => {});
  }

  apply(decide());
}

/** Force a tier (or null to resume automatic control). */
export function setManualQuality(t) {
  perf.manual = t;
  apply(decide());
}
