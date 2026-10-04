/**
 * Generative ambient soundscape.
 *
 * Nothing here is a sample. Rain is filtered noise whose bandwidth tracks
 * drop size, wind is a slower noise band swept by an LFO, thunder is a
 * synthesised rumble fired in step with the sky shader's lightning, and a
 * quiet drone sits underneath tuned to the temperature. Everything is
 * gain-ramped so parameters can move continuously without clicking.
 *
 * Browsers require a user gesture before audio starts, so the context is
 * created lazily on the first toggle.
 */

let ctx = null;
let master = null;
let enabled = false;
let nodes = null;
let lastStorm = 0;
let nextThunder = Infinity;

/** A few seconds of looping white noise, reused by every noise voice. */
function noiseBuffer(ac, seconds = 4) {
  const buf = ac.createBuffer(1, ac.sampleRate * seconds, ac.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

function noiseVoice(ac, dest, { type, freq, q, gain }) {
  const src = ac.createBufferSource();
  src.buffer = noiseBuffer(ac);
  src.loop = true;
  const filt = ac.createBiquadFilter();
  filt.type = type;
  filt.frequency.value = freq;
  filt.Q.value = q;
  const g = ac.createGain();
  g.gain.value = gain;
  src.connect(filt).connect(g).connect(dest);
  src.start();
  return { src, filt, gain: g };
}

export function initAudio() {
  if (ctx) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  ctx = new AC();

  master = ctx.createGain();
  master.gain.value = 0;

  // A gentle limiter keeps thunder from clipping the mix.
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -18;
  comp.ratio.value = 6;
  comp.attack.value = 0.004;
  comp.release.value = 0.25;
  master.connect(comp).connect(ctx.destination);

  const rain = noiseVoice(ctx, master, { type: 'bandpass', freq: 1400, q: 0.7, gain: 0 });
  // A second, brighter band gives rain its "on glass" character.
  const patter = noiseVoice(ctx, master, { type: 'highpass', freq: 4200, q: 0.5, gain: 0 });
  const wind = noiseVoice(ctx, master, { type: 'bandpass', freq: 420, q: 1.6, gain: 0 });

  // LFO sweeps the wind band so gusts breathe rather than hiss.
  const lfo = ctx.createOscillator();
  const lfoGain = ctx.createGain();
  lfo.frequency.value = 0.07;
  lfoGain.gain.value = 180;
  lfo.connect(lfoGain).connect(wind.filt.frequency);
  lfo.start();

  // Warm drone: two detuned oscillators through a soft lowpass.
  const droneGain = ctx.createGain();
  droneGain.gain.value = 0;
  const droneFilt = ctx.createBiquadFilter();
  droneFilt.type = 'lowpass';
  droneFilt.frequency.value = 480;
  droneFilt.Q.value = 0.6;
  droneFilt.connect(droneGain).connect(master);
  const oscs = [0, 3.5].map((detune) => {
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = 55;
    o.detune.value = detune;
    const g = ctx.createGain();
    g.gain.value = 0.22;
    o.connect(g).connect(droneFilt);
    o.start();
    return o;
  });

  nodes = { rain, patter, wind, drone: { oscs, gain: droneGain, filt: droneFilt }, lfo, lfoGain };
}

export function isAudioOn() { return enabled; }

export function setAudioEnabled(on) {
  enabled = on;
  if (!ctx) return;
  if (on && ctx.state === 'suspended') ctx.resume();
  ramp(master.gain, on ? 0.5 : 0, on ? 1.2 : 0.6);
}

const ramp = (param, v, t = 0.6) => {
  const now = ctx.currentTime;
  param.cancelScheduledValues(now);
  param.setValueAtTime(param.value, now);
  param.linearRampToValueAtTime(v, now + t);
};

/** Thunder: a filtered noise burst with a long, decaying low tail. */
function thunder(distance = 0.5) {
  if (!ctx || !enabled) return;
  const now = ctx.currentTime;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx, 3);

  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  // Distant strikes lose their high end to the air.
  lp.frequency.setValueAtTime(700 - distance * 480, now);
  lp.Q.value = 0.5;

  const g = ctx.createGain();
  const peak = 0.55 * (1 - distance * 0.65);
  g.gain.setValueAtTime(0.0001, now);
  g.gain.exponentialRampToValueAtTime(Math.max(0.02, peak), now + 0.04 + distance * 0.3);
  g.gain.exponentialRampToValueAtTime(0.0001, now + 1.6 + distance * 2.4);

  src.connect(lp).connect(g).connect(master);
  src.start(now);
  src.stop(now + 4.2);
}

/**
 * Drive the mix from the current frame. Called every animation frame; all
 * writes are ramps, so calling it often is cheap and smooth.
 */
export function updateAudio(store) {
  if (!ctx || !enabled || !nodes) return;
  const f = store.frame();
  if (!f) return;

  const kind = f.wx.kind;
  const precip = Math.min(1, Math.max((f.precip ?? 0) / 0.10, kind === 'rain' || kind === 'storm' ? f.wx.intensity * 0.5 : 0));
  const windAmt = Math.min(1, (f.wind ?? 0) / 32);
  const gustAmt = Math.min(1, ((f.gust ?? f.wind ?? 0) - (f.wind ?? 0)) / 18);

  // Rain body and patter.
  ramp(nodes.rain.gain.gain, precip * 0.30, 0.9);
  ramp(nodes.rain.filt.frequency, 900 + precip * 1500, 0.9);
  ramp(nodes.patter.gain.gain, precip * precip * 0.10, 0.9);

  // Wind.
  ramp(nodes.wind.gain.gain, windAmt * 0.24, 1.1);
  ramp(nodes.wind.filt.Q, 1.2 + gustAmt * 2.5, 1.1);
  nodes.lfo.frequency.value = 0.05 + gustAmt * 0.22;
  nodes.lfoGain.gain.value = 120 + gustAmt * 420;

  // Drone: pitch drifts with temperature, brightness with sun altitude.
  const t = f.temp ?? 60;
  const hz = 44 + Math.max(0, Math.min(1, (t - 20) / 80)) * 26;
  for (const o of nodes.drone.oscs) o.frequency.setTargetAtTime(hz, ctx.currentTime, 1.5);
  ramp(nodes.drone.gain.gain, 0.055 + (f.sun.altDeg > 0 ? 0.02 : 0.05), 2);
  ramp(nodes.drone.filt.frequency, 300 + Math.max(0, f.sun.altDeg) * 9, 2);

  // Thunder, timed off the same storm intensity the shader uses.
  const storm = kind === 'storm' ? 0.9 : Math.min(0.6, (f.cape ?? 0) / 2500);
  const now = performance.now();
  if (storm > 0.15) {
    if (nextThunder === Infinity) nextThunder = now + Math.random() * 6000;
    if (now > nextThunder) {
      thunder(Math.random() * (1 - storm * 0.6));
      nextThunder = now + 3000 + Math.random() * 22000 * (1.1 - storm);
    }
  } else {
    nextThunder = Infinity;
  }
  lastStorm = storm;
}
