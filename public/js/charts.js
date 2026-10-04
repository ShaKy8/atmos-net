/**
 * Canvas chart primitives for the console.
 *
 * Conventions that hold across every chart here:
 *  - One measure per plot area. Temperature and precipitation share an
 *    x-axis but never a y-axis; they are stacked panels, not a dual axis.
 *  - Categorical series use SERIES in fixed order and are never cycled.
 *  - Status colors (lime/amber/orange/red) are reserved for state and always
 *    ship beside a text label, never as the only signal.
 *  - Grid and axes are recessive; the data is the brightest thing drawn.
 *  - Every plot gets a hover crosshair and a readout.
 */

import { clamp, lerp } from './lib/util.js';

/* ---------------------------------------------------------------- palette */

// Fixed categorical order. Lime is deliberately absent: against amber it
// falls to dE 6.6 under deuteranopia, so it is reserved for status, where it
// always appears with a word next to it.
export const SERIES = ['#3fd0d8', '#f07aa6', '#f2b45a', '#b39dfa', '#7fb2f0'];
export const STATUS = { good: '#8fdc6a', warn: '#ecd46a', serious: '#f59a5b', crit: '#f47171' };
export const INK = '#dde2e8';
// Every colour here is kept equal to its core.css token (--cy, --mg, --am,
// --vi, --ice; --lm, --rd; --ink, --dim, --faint; --panel-solid), and a test
// holds them together. The canvas cannot read a custom property cheaply per
// draw, so the palette is written twice and checked once.
export const DIM = '#b3bfcc';
export const FAINT = '#8d9aab';
export const GHOST = 'rgba(255,255,255,.055)';
export const SURFACE = '#0f1826';
export const GROUND = '#16212f';

// Chart text was 9-10px. Density is decided from measured pixels (fitTicks,
// fitStride, tagRow are ceilings), so larger labels thin out where a chart is
// tight rather than collide; label-audit proves it.
export const MONO = "500 12px 'JetBrains Mono', ui-monospace, monospace";
export const MONO_SM = "500 11.5px 'JetBrains Mono', ui-monospace, monospace";
export const UI_LBL = "600 11.5px 'Chakra Petch', system-ui, sans-serif";

/** Temperature -> color. A single perceptual ramp, cold blue to hot magenta. */
export function tempColor(f) {
  if (f == null) return DIM;
  const stops = [
    [-20, '#9d8ef5'], [10, '#6aa9f0'], [32, '#3fd0d8'], [50, '#5cd6bc'],
    [65, '#a2d86a'], [78, '#ecd46a'], [88, '#f59a5b'], [100, '#f47171'], [115, '#f07aa6'],
  ];
  if (f <= stops[0][0]) return stops[0][1];
  if (f >= stops.at(-1)[0]) return stops.at(-1)[1];
  for (let i = 0; i < stops.length - 1; i++) {
    const [a, ca] = stops[i], [b, cb] = stops[i + 1];
    if (f >= a && f <= b) return mixHex(ca, cb, (f - a) / (b - a));
  }
  return DIM;
}

export function mixHex(a, b, t) {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  const p = pa.map((v, i) => Math.round(lerp(v, pb[i], clamp(t, 0, 1))));
  return `#${p.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

export function alpha(hex, a) {
  const p = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `rgba(${p[0]},${p[1]},${p[2]},${a})`;
}

/* ------------------------------------------------------------------ mount */

/* ------------------------------------------------------- tap to inspect */

/**
 * Charts currently holding a pinned readout.
 *
 * A mouse hovers and the readout follows it. A finger cannot hover: it
 * arrives, covers the thing it summoned, and leaves. So on a coarse pointer
 * the readout is STICKY — placed by a tap, dragged by a slide, and left on
 * screen when the finger lifts, until something else is tapped. Several of
 * these charts hold numbers that appear nowhere else in the console, and
 * before this they were unreadable on a phone.
 */
const pinned = new Set();

/** Drop every pinned readout. Called when the view changes. */
export function clearInspect() {
  for (const c of pinned) { c.hover = null; c.render(); }
  pinned.clear();
}

/** How far a finger may travel and still count as a tap rather than a drag. */
const TAP_SLOP = 10;

/**
 * Bind a draw function to a canvas: handles device-pixel ratio, resize, and
 * pointer tracking. `draw(ctx, w, h, hover)` is called whenever anything
 * that affects the picture changes.
 *
 * `hover.coarse` tells the draw function it is being read by a finger. That
 * is a placement problem rather than a data one: the readout has to go
 * somewhere the hand is not, which is what `tooltip`'s `pin` option does.
 *
 * Pass `inspect: false` for a canvas that runs its own drag gesture — the
 * time scrubber — which keeps `touch-action: none` and must not hold a
 * readout after the finger lifts.
 */
export function mount(canvas, draw, { onPick, inspect = true } = {}) {
  const ctx = canvas.getContext('2d');
  const chart = { canvas, ctx, hover: null, data: null, draw, dirty: true };

  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    const cw = Math.round(w * dpr), ch = Math.round(h * dpr);
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw; canvas.height = ch;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    chart.w = w; chart.h = h;
    chart.render();
  };

  chart.render = () => {
    if (!chart.w || !chart.h) return;
    ctx.clearRect(0, 0, chart.w, chart.h);
    try { draw(ctx, chart.w, chart.h, chart.hover, chart.data); }
    catch (e) { console.error('[chart]', e.stack || e); }
  };

  chart.update = (data) => { chart.data = data; chart.render(); };

  const ro = new ResizeObserver(resize);
  ro.observe(canvas);

  // `pan-y` hands vertical scrolling back to the browser — the views scroll
  // on a phone — while keeping horizontal movement, so a finger can slide
  // along the chart to read it. The browser announces that it has taken the
  // gesture with `pointercancel`, which is where the readout is dropped.
  if (inspect) canvas.style.touchAction = 'pan-y';

  const at = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const coarse = (e) => !!e.pointerType && e.pointerType !== 'mouse';
  const show = (p, c) => { chart.hover = { x: p.x, y: p.y, coarse: c }; chart.render(); };
  const hide = () => { pinned.delete(chart); chart.hover = null; chart.render(); };

  let down = null;

  const move = (e) => {
    if (!coarse(e)) { show(at(e), false); return; }
    if (!down) return;
    down.moved = Math.max(down.moved, Math.hypot(e.clientX - down.cx, e.clientY - down.cy));
    if (inspect) show(at(e), true);
  };

  const start = (e) => {
    const p = at(e);
    down = { x: p.x, y: p.y, cx: e.clientX, cy: e.clientY, moved: 0, coarse: coarse(e) };
    if (!down.coarse || !inspect) return;
    // Tapping the same spot again puts the readout away; tapping anywhere
    // else simply re-aims it. Tapping a different chart clears this one.
    const prev = chart.hover;
    down.dismiss = !!prev && !!prev.coarse
      && Math.abs(prev.x - p.x) < 14 && Math.abs(prev.y - p.y) < 14;
    for (const c of pinned) if (c !== chart) { c.hover = null; c.render(); }
    pinned.clear(); pinned.add(chart);
    show(p, true);
  };

  const end = (e) => {
    const d = down;
    down = null;
    if (!d) return;
    if (d.coarse && inspect && d.dismiss && d.moved < TAP_SLOP) hide();
    // Firing on release under a movement threshold is what stops a scroll,
    // or a slide along the chart to read it, from being taken as a pick.
    if (onPick && d.moved < TAP_SLOP) onPick({ x: d.x, y: d.y, w: chart.w, h: chart.h }, e);
  };

  // The browser claimed the gesture for scrolling: nothing here happened.
  const cancel = () => { if (down && down.coarse && inspect) hide(); down = null; };

  // A finger "leaves" on every lift, which is exactly what must not clear it.
  const leave = (e) => { if (!coarse(e)) { chart.hover = null; chart.render(); } };

  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerdown', start);
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', cancel);
  canvas.addEventListener('pointerleave', leave);
  if (onPick) canvas.style.cursor = 'crosshair';

  chart.destroy = () => {
    ro.disconnect();
    pinned.delete(chart);
    canvas.removeEventListener('pointermove', move);
    canvas.removeEventListener('pointerdown', start);
    canvas.removeEventListener('pointerup', end);
    canvas.removeEventListener('pointercancel', cancel);
    canvas.removeEventListener('pointerleave', leave);
  };
  resize();
  return chart;
}

/* ------------------------------------------------------------- primitives */

/** Neon stroke: a wide soft pass under a crisp 2px pass. */
export function neonLine(ctx, pts, color, { width = 2, glow = 12, closed = false } = {}) {
  if (pts.length < 2) return;
  const path = () => {
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    if (closed) ctx.closePath();
  };
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  if (glow) {
    ctx.save();
    ctx.shadowColor = color; ctx.shadowBlur = glow / 2;
    ctx.strokeStyle = alpha(color, 0.55); ctx.lineWidth = width;
    path(); ctx.stroke();
    ctx.restore();
  }
  ctx.strokeStyle = color; ctx.lineWidth = width;
  path(); ctx.stroke();
}

/** Smooth path through points using Catmull-Rom -> bezier. */
export function smoothPath(ctx, pts) {
  if (pts.length < 2) return;
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    ctx.bezierCurveTo(
      p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6,
      p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6,
      p2[0], p2[1]);
  }
}

/** Recessive horizontal gridlines with right-edge value labels. */
export function gridY(ctx, box, ticks, fmt = String, { color = GHOST, label = true } = {}) {
  ctx.save();
  ctx.strokeStyle = color; ctx.lineWidth = 1;
  ctx.font = MONO_SM; ctx.fillStyle = FAINT;
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  let lastY = -1e9;
  for (const { v, y } of ticks) {
    ctx.beginPath();
    ctx.moveTo(box.x, Math.round(y) + 0.5);
    ctx.lineTo(box.x + box.w, Math.round(y) + 0.5);
    ctx.stroke();
    if (!label) continue;
    // The top line's number sits above the box by default, which is the row
    // the panel's title and legend live in. Put that one inside instead.
    const ly = y - box.y < 9 ? y + 6 : y - 5;
    // MONO_SM is 11.5px, so anything closer than this is two numbers touching.
    if (Math.abs(ly - lastY) < 14) continue;
    haloText(ctx, fmt(v), box.x + box.w - 2, ly);
    lastY = ly;
  }
  ctx.restore();
}

/** A bar with a 4px rounded far end, anchored to the baseline. */
export function capBar(ctx, x, yTop, w, yBase, color, r = 3) {
  const h = Math.abs(yBase - yTop);
  if (h < 0.4) return;
  const rr = Math.min(r, w / 2, h);
  ctx.beginPath();
  ctx.moveTo(x, yBase);
  ctx.lineTo(x, yTop + rr);
  ctx.quadraticCurveTo(x, yTop, x + rr, yTop);
  ctx.lineTo(x + w - rr, yTop);
  ctx.quadraticCurveTo(x + w, yTop, x + w, yTop + rr);
  ctx.lineTo(x + w, yBase);
  ctx.closePath();
  // The body at 60%, the cap at full strength: a week of solid yellow AQI
  // bars was the brightest area on the screen, and the value reads off the
  // cap's edge anyway.
  ctx.fillStyle = color;
  ctx.save();
  ctx.globalAlpha *= 0.6;
  ctx.fill();
  ctx.clip();
  ctx.globalAlpha /= 0.6;
  ctx.fillRect(x, yTop, w, Math.min(2.5, h));
  ctx.restore();
}

/**
 * Text that has to read over a chart's own fills and lines: a thin dark
 * outline under the glyphs, then the fill. Labels drawn in a series colour on
 * top of an area of the same family (GOOD on the AQI band, 92° on the
 * temperature fill) measured 2-4:1 against the pixels actually behind them;
 * the outline gives each glyph its own ground whatever is underneath.
 */
export function haloText(ctx, text, x, y, width = 3) {
  ctx.save();
  ctx.lineWidth = width; ctx.lineJoin = 'round';
  ctx.strokeStyle = alpha(GROUND, .9);
  ctx.strokeText(text, x, y);
  ctx.restore();
  ctx.fillText(text, x, y);
}

/** Small caps label, used for axis titles and panel names inside plots. */
export function tag(ctx, x, y, text, color = FAINT, align = 'left') {
  ctx.save();
  ctx.font = UI_LBL; ctx.fillStyle = color;
  ctx.textAlign = align; ctx.textBaseline = 'top';
  ctx.letterSpacing = '1.4px';
  haloText(ctx, text.toUpperCase(), x, y);
  ctx.restore();
}

/**
 * Floating readout box. Flips side near the right edge so it never clips.
 *
 * `pin` is for a finger: instead of following the pointer it goes to the
 * corner diagonally opposite it, so the box is never under the hand that
 * asked for it. Following the pointer is right for a mouse, where the
 * cursor is a few pixels wide and the hand is somewhere else entirely.
 */
export function tooltip(ctx, x, y, lines, w, h, accent = '#3fd0d8', { pin = false } = {}) {
  const pad = 7, lh = 13;
  ctx.save();
  ctx.font = MONO;
  const tw = Math.max(...lines.map((l) => ctx.measureText(l.replace(/\|/g, '  ')).width)) + pad * 2;
  const th = lines.length * lh + pad * 2 - 2;
  let bx, by;
  if (pin) {
    bx = x > w / 2 ? 4 : Math.max(4, w - tw - 4);
    by = y < h / 2 ? Math.max(4, h - th - 4) : 4;
  } else {
    bx = x + 12;
    by = clamp(y - th - 10, 4, h - th - 4);
    if (bx + tw > w - 4) bx = x - tw - 12;
    bx = clamp(bx, 4, Math.max(4, w - tw - 4));
  }

  ctx.fillStyle = alpha(GROUND, .94);
  ctx.strokeStyle = alpha(accent, 0.5);
  ctx.lineWidth = 1;
  const c = 5;
  ctx.beginPath();
  ctx.moveTo(bx, by + c); ctx.lineTo(bx + c, by);
  ctx.lineTo(bx + tw, by); ctx.lineTo(bx + tw, by + th - c);
  ctx.lineTo(bx + tw - c, by + th); ctx.lineTo(bx, by + th);
  ctx.closePath();
  ctx.fill(); ctx.stroke();

  ctx.textBaseline = 'top';
  lines.forEach((l, i) => {
    const [a, b] = l.split('|');
    ctx.textAlign = 'left';
    ctx.fillStyle = i === 0 ? accent : DIM;
    ctx.fillText(a, bx + pad, by + pad + i * lh);
    if (b != null) {
      ctx.textAlign = 'right';
      ctx.fillStyle = i === 0 ? accent : INK;
      ctx.fillText(b, bx + tw - pad, by + pad + i * lh);
    }
  });
  ctx.restore();
}

/** Inline legend chip row. Present whenever two or more series are drawn. */
export function legend(ctx, x, y, items, { align = 'left' } = {}) {
  ctx.save();
  ctx.font = UI_LBL;
  ctx.textBaseline = 'middle';
  ctx.letterSpacing = '1.2px';
  let total = 0;
  const widths = items.map((it) => {
    const w = ctx.measureText(it.label.toUpperCase()).width + 16;
    total += w; return w;
  });
  let cx = align === 'right' ? x - total : x;
  items.forEach((it, i) => {
    ctx.fillStyle = it.color;
    if (it.dash) {
      ctx.strokeStyle = it.color; ctx.lineWidth = 2;
      ctx.setLineDash([3, 2]);
      ctx.beginPath(); ctx.moveTo(cx, y); ctx.lineTo(cx + 9, y); ctx.stroke();
      ctx.setLineDash([]);
    } else {
      ctx.fillRect(cx, y - 3, 9, 3);
    }
    ctx.fillStyle = DIM;
    ctx.textAlign = 'left';
    ctx.fillText(it.label.toUpperCase(), cx + 13, y);
    cx += widths[i];
  });
  ctx.restore();
}

/** Shade the hours between sunset and sunrise across a time axis. */
export function nightBands(ctx, box, days, xOf, tz) {
  ctx.save();
  ctx.fillStyle = 'rgba(8,13,22,.32)';
  for (const d of days) {
    if (!d.sunset || !d.sunrise) continue;
    // Night runs from this day's sunset to the next day's sunrise.
    const next = days[days.indexOf(d) + 1];
    const a = xOf(d.sunset);
    const b = next?.sunrise ? xOf(next.sunrise) : box.x + box.w;
    const x0 = clamp(a, box.x, box.x + box.w);
    const x1 = clamp(b, box.x, box.x + box.w);
    if (x1 > x0) ctx.fillRect(x0, box.y, x1 - x0, box.h);
  }
  ctx.restore();
}

/** Vertical marker with a label flag, used for "now" and the cursor. */
export function marker(ctx, x, box, color, label, { dash = null, flagTop = true } = {}) {
  ctx.save();
  ctx.strokeStyle = color; ctx.lineWidth = 1;
  if (dash) ctx.setLineDash(dash);
  ctx.shadowColor = color; ctx.shadowBlur = 4;
  ctx.beginPath();
  ctx.moveTo(Math.round(x) + 0.5, box.y);
  ctx.lineTo(Math.round(x) + 0.5, box.y + box.h);
  ctx.stroke();
  ctx.restore();
  if (label) {
    ctx.save();
    ctx.font = UI_LBL; ctx.letterSpacing = '1.2px';
    const w = ctx.measureText(label).width + 8;
    const bx = clamp(x - w / 2, box.x, box.x + box.w - w);
    const by = flagTop ? box.y : box.y + box.h - 11;
    ctx.fillStyle = color;
    ctx.fillRect(bx, by, w, 11);
    ctx.fillStyle = SURFACE;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(label, bx + w / 2, by + 6);
    ctx.restore();
  }
}

/* ------------------------------------------------------------- nice ticks */

/** Human-friendly axis steps (1/2/5 x 10^n) covering [lo, hi]. */
/* ----------------------------------------------------- fitting to the box */

/*
 * Density decided from measured pixels rather than from a constant.
 *
 * The console was built for one 27-inch screen, so every axis, legend and
 * label took its density from a number typed at the call site: three y-ticks
 * on a panel 40px tall, a legend drawn beside a title with neither knowing
 * how wide the other was, hour labels centred on x = 0. Measured at 390x844
 * that came to ten overlapping label pairs and five labels running off the
 * canvas — and three of those were wrong on the desktop too.
 *
 * Each of these is a CEILING and never a floor: given desktop room they
 * return exactly what the call site asked for, so the wide layout is
 * unchanged and this cannot make any chart denser than it already was.
 */

/** Gridlines a box this tall can carry. Never more than `want`. */
export function fitTicks(h, want = 4) {
  return clamp(Math.floor(h / 26), 1, want);
}

/**
 * Draw every nth of `count` items spread across `span` px, so two neighbours
 * keep `gap` px of clear air between them. Never finer than `least`.
 */
export function fitStride(count, span, widest, { gap = 8, least = 1 } = {}) {
  if (count < 2 || span <= 0) return least;
  const per = span / (count - 1);
  return Math.max(least, Math.ceil((widest + gap) / Math.max(per, 0.5)));
}

/**
 * A centre-aligned label kept inside [x0, x1]: nudged in when it would hang
 * over an edge, skipped when it cannot fit at all. Returns whether it drew.
 * The caller sets textAlign 'center' — this is the axis-label case, where a
 * label centred on the first or last point is half off the canvas.
 */
export function fitLabel(ctx, text, x, y, x0, x1) {
  const w = ctx.measureText(text).width;
  if (w > x1 - x0) return false;
  ctx.fillText(text, clamp(x, x0 + w / 2, x1 - w / 2), y);
  return true;
}

/**
 * A panel's title and its legend share one row: title left, legend right.
 * They are drawn together because neither can otherwise see how much room
 * the other left — at 390px "FORECAST VS CLIMATE RECORD °F" and its legend
 * overlapped by 53px. Too narrow for both and the title falls back to
 * `short`; still too narrow and the legend goes, because the title is the
 * part you cannot recover by looking at the picture.
 */
export function tagRow(ctx, box, y, text, items = [], { short = null } = {}) {
  const span = (spacing, str) => {
    ctx.save();
    ctx.font = UI_LBL; ctx.letterSpacing = spacing;
    const w = ctx.measureText(String(str).toUpperCase()).width;
    ctx.restore();
    return w;
  };
  const rowW = (t, list) =>
    span('1.4px', t) + list.reduce((n, it) => n + span('1.2px', it.label) + 16, 0) + 14;
  const brief = items.map((it) => (it.short ? { ...it, label: it.short } : it));
  /*
   * What to give up, in order: nothing, then the long legend words, then the
   * long title, then the legend itself. The title survives longest because
   * it is the one thing you cannot recover by looking at the picture — and
   * with the readouts now tappable, the legend is recoverable.
   */
  const [title, list] = [
    [text, items], [text, brief], [short ?? text, brief], [short ?? text, []],
  ].find(([t, l]) => rowW(t, l) <= box.w) ?? [short ?? text, []];
  tag(ctx, box.x + 2, y, title);
  if (list.length) legend(ctx, box.x + box.w, y + 5, list, { align: 'right' });
}

export function niceTicks(lo, hi, count = 4) {
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo === hi) return [lo || 0];
  const span = hi - lo;
  const raw = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(6));
  return out;
}

/* ============================================================ radial gauge */

/**
 * A 240-degree arc gauge. `bands` optionally paints qualitative zones behind
 * the value arc (UV, AQI); each band carries its own label so the color is
 * never the only cue.
 */
export function gauge(ctx, cx, cy, r, {
  value, min = 0, max = 100, color = SERIES[0], label = '', unit = '',
  bands = null, sub = '', decimals = 0, ticks = 5,
}) {
  const A0 = Math.PI * 0.75, A1 = Math.PI * 2.25;
  const frac = value == null ? 0 : clamp((value - min) / (max - min), 0, 1);
  const aVal = A0 + (A1 - A0) * frac;

  ctx.save();
  ctx.lineCap = 'butt';

  // Track
  ctx.beginPath();
  ctx.arc(cx, cy, r, A0, A1);
  ctx.strokeStyle = 'rgba(255,255,255,.07)';
  ctx.lineWidth = 6;
  ctx.stroke();

  // Qualitative bands
  if (bands) {
    for (const b of bands) {
      const f0 = clamp((b.from - min) / (max - min), 0, 1);
      const f1 = clamp((b.to - min) / (max - min), 0, 1);
      if (f1 <= f0) continue;
      ctx.beginPath();
      ctx.arc(cx, cy, r + 6, A0 + (A1 - A0) * f0, A0 + (A1 - A0) * f1);
      ctx.strokeStyle = alpha(b.color, 0.55);
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }
  }

  // Tick marks
  ctx.strokeStyle = 'rgba(255,255,255,.14)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= ticks; i++) {
    const a = A0 + (A1 - A0) * (i / ticks);
    const c = Math.cos(a), s = Math.sin(a);
    ctx.beginPath();
    ctx.moveTo(cx + c * (r - 5), cy + s * (r - 5));
    ctx.lineTo(cx + c * (r - 10), cy + s * (r - 10));
    ctx.stroke();
  }

  // Value arc
  if (value != null && frac > 0.001) {
    ctx.save();
    ctx.shadowColor = color; ctx.shadowBlur = 7;
    ctx.beginPath();
    ctx.arc(cx, cy, r, A0, aVal);
    ctx.strokeStyle = color; ctx.lineWidth = 6;
    ctx.stroke();
    ctx.restore();

    // Needle tip
    const c = Math.cos(aVal), s = Math.sin(aVal);
    ctx.beginPath();
    ctx.arc(cx + c * r, cy + s * r, 3.2, 0, Math.PI * 2);
    ctx.fillStyle = INK;
    ctx.shadowColor = color; ctx.shadowBlur = 5;
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  // Readout
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = INK;
  ctx.font = `700 ${Math.round(r * 0.62)}px 'JetBrains Mono', monospace`;
  const text = value == null ? '--' : value.toFixed(decimals);
  const vy = cy + r * 0.18;
  const vDrop = ctx.measureText(text).actualBoundingBoxDescent;
  ctx.fillText(text, cx, vy);
  if (unit) {
    ctx.font = MONO_SM; ctx.fillStyle = DIM;
    /*
     * Under the value's ink rather than at a fixed fraction of the radius.
     * Both are sized from r, but the unit is not: MONO_SM is 9px whatever r
     * is, so below about r = 26 -- the six gauges on a phone -- the two ran
     * into each other. Measured at 390px: all six overlapped.
     */
    const rise = ctx.measureText(unit).actualBoundingBoxAscent;
    ctx.fillText(unit, cx, Math.max(cy + r * 0.46, vy + vDrop + rise + 3));
  }
  if (label) {
    ctx.font = UI_LBL; ctx.fillStyle = FAINT;
    ctx.letterSpacing = '1.4px';
    ctx.fillText(label.toUpperCase(), cx, cy + r + 15);
  }
  if (sub) {
    ctx.font = UI_LBL; ctx.fillStyle = color;
    ctx.letterSpacing = '1.2px';
    haloText(ctx, sub.toUpperCase(), cx, cy - r * 0.42);
  }
  ctx.restore();
}

/* ============================================================== sparkline */

export function spark(ctx, box, values, {
  color = SERIES[0], fill = true, width = 1.8, min = null, max = null, glow = 8,
}) {
  const vals = values.filter((v) => v != null);
  if (vals.length < 2) return;
  const lo = min ?? Math.min(...vals), hi = max ?? Math.max(...vals);
  const span = hi - lo || 1;
  const pts = values.map((v, i) => [
    box.x + (i / (values.length - 1)) * box.w,
    box.y + box.h - ((v ?? lo) - lo) / span * box.h,
  ]);

  if (fill) {
    ctx.save();
    ctx.beginPath();
    smoothPath(ctx, pts);
    ctx.lineTo(pts.at(-1)[0], box.y + box.h);
    ctx.lineTo(pts[0][0], box.y + box.h);
    ctx.closePath();
    const g = ctx.createLinearGradient(0, box.y, 0, box.y + box.h);
    g.addColorStop(0, alpha(color, 0.34));
    g.addColorStop(1, alpha(color, 0));
    ctx.fillStyle = g;
    ctx.fill();
    ctx.restore();
  }

  ctx.save();
  if (glow) { ctx.shadowColor = color; ctx.shadowBlur = glow / 2; }
  ctx.beginPath();
  smoothPath(ctx, pts);
  ctx.strokeStyle = color; ctx.lineWidth = width;
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  ctx.stroke();
  ctx.restore();
  return pts;
}

/* ============================================================== bar series */

export function bars(ctx, box, values, {
  color = SERIES[0], max = null, gap = 2, colorFn = null, baseline = 'bottom',
}) {
  const hi = max ?? Math.max(...values.filter((v) => v != null), 1);
  const n = values.length;
  const bw = Math.max(1, box.w / n - gap);
  const base = box.y + box.h;
  values.forEach((v, i) => {
    if (v == null) return;
    const x = box.x + (i * box.w) / n;
    const h = clamp(v / hi, 0, 1) * box.h;
    capBar(ctx, x, base - h, bw, base, colorFn ? colorFn(v, i) : color);
  });
}

/* ========================================================== compass / rose */

/** Wind direction dial with a gust ring. */
export function windRose(ctx, cx, cy, r, { dir, speed, gust, color = SERIES[0] }) {
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,.09)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();

  ctx.font = UI_LBL; ctx.fillStyle = FAINT;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const [lab, a] of [['N', -90], ['E', 0], ['S', 90], ['W', 180]]) {
    const rad = a * Math.PI / 180;
    ctx.fillText(lab, cx + Math.cos(rad) * (r + 8), cy + Math.sin(rad) * (r + 8));
  }
  for (let i = 0; i < 16; i++) {
    const a = (i * 22.5 - 90) * Math.PI / 180;
    const long = i % 4 === 0;
    ctx.strokeStyle = long ? 'rgba(255,255,255,.20)' : 'rgba(255,255,255,.09)';
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    ctx.lineTo(cx + Math.cos(a) * (r - (long ? 7 : 4)), cy + Math.sin(a) * (r - (long ? 7 : 4)));
    ctx.stroke();
  }

  if (dir != null) {
    // Meteorological direction is where wind comes FROM; the arrow flies with it.
    const a = (dir - 90 + 180) * Math.PI / 180;
    const len = r - 10;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(a);
    ctx.shadowColor = color; ctx.shadowBlur = 6;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(len, 0);
    ctx.lineTo(len - 9, -5.5);
    ctx.lineTo(len - 6, 0);
    ctx.lineTo(len - 9, 5.5);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = color; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(-len * 0.55, 0); ctx.lineTo(len - 7, 0); ctx.stroke();
    ctx.restore();
  }

  ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = INK;
  ctx.font = `700 ${Math.round(r * 0.44)}px 'JetBrains Mono', monospace`;
  const spd = speed == null ? '--' : String(Math.round(speed));
  const sy = cy + r * 0.06;
  const sDrop = ctx.measureText(spd).actualBoundingBoxDescent;
  ctx.fillText(spd, cx, sy);
  ctx.font = MONO_SM; ctx.fillStyle = DIM;
  // As in gauge(): the unit is a fixed 9px while the number scales with r,
  // so a small rose ran the two together.
  ctx.fillText('mph', cx, Math.max(cy + r * 0.30,
    sy + sDrop + ctx.measureText('mph').actualBoundingBoxAscent + 3));
  if (gust != null && gust > (speed ?? 0) + 1) {
    ctx.font = MONO_SM; ctx.fillStyle = STATUS.serious;
    ctx.fillText(`G${Math.round(gust)}`, cx, cy - r * 0.26);
  }
  ctx.restore();
}

/* ================================================================ moon disc */

/** The moon at its real phase, with maria and earthshine. */
export function moonDisc(ctx, cx, cy, r, phase, fraction) {
  ctx.save();
  // Dark limb
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = '#16212f';
  ctx.fill();
  ctx.strokeStyle = 'rgba(127,178,240,.22)';
  ctx.lineWidth = 1;
  ctx.stroke();

  // Lit region, carved by the terminator ellipse.
  const k = 1 - 2 * clamp(fraction, 0, 1);
  const waxing = phase < 0.5;
  ctx.save();
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.clip();
  ctx.beginPath();
  const steps = 48;
  for (let i = 0; i <= steps; i++) {
    const y = -1 + (2 * i) / steps;
    const x = k * Math.sqrt(Math.max(0, 1 - y * y));
    const px = cx + (waxing ? x : -x) * r;
    if (i === 0) ctx.moveTo(px, cy + y * r); else ctx.lineTo(px, cy + y * r);
  }
  for (let i = steps; i >= 0; i--) {
    const y = -1 + (2 * i) / steps;
    ctx.lineTo(cx + (waxing ? 1 : -1) * Math.sqrt(Math.max(0, 1 - y * y)) * r, cy + y * r);
  }
  ctx.closePath();
  const g = ctx.createRadialGradient(cx - r * 0.25, cy - r * 0.25, r * 0.1, cx, cy, r);
  g.addColorStop(0, '#f2f6ff');
  g.addColorStop(1, '#b9c6da');
  ctx.fillStyle = g;
  ctx.shadowColor = 'rgba(200,225,255,.7)'; ctx.shadowBlur = r * 0.5;
  ctx.fill();
  ctx.shadowBlur = 0;

  // Maria: a few fixed blotches so the disc reads as the Moon, not a circle.
  ctx.globalCompositeOperation = 'multiply';
  ctx.fillStyle = 'rgba(150,165,190,.55)';
  for (const [ox, oy, or] of [[-.28, -.20, .26], [.10, -.34, .18], [.22, .10, .22], [-.15, .30, .16], [-.42, .12, .13]]) {
    ctx.beginPath();
    ctx.arc(cx + ox * r, cy + oy * r, or * r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
  ctx.restore();
}

/* ============================================================== sky dome */

/**
 * Polar plot of the visible hemisphere: horizon at the rim, zenith at the
 * centre, north up. Used to show where the sun and moon actually are.
 */
export function skyDome(ctx, cx, cy, r, {
  sunTrack = [], moonTrack = [], sun = null, moon = null, iss = null, night = 0,
}) {
  const proj = (azDeg, altDeg) => {
    const rr = (1 - clamp(altDeg, 0, 90) / 90) * r;
    const a = (azDeg - 90) * Math.PI / 180;
    return [cx + Math.cos(a) * rr, cy + Math.sin(a) * rr];
  };

  ctx.save();
  // Dome fill
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  g.addColorStop(0, night > 0.5 ? 'rgba(6,12,30,.85)' : 'rgba(10,40,72,.55)');
  g.addColorStop(1, night > 0.5 ? 'rgba(2,4,12,.6)' : 'rgba(6,20,40,.4)');
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = g; ctx.fill();

  // Altitude rings at 30 and 60 degrees, plus the horizon.
  ctx.strokeStyle = 'rgba(255,255,255,.10)'; ctx.lineWidth = 1;
  for (const alt of [30, 60]) {
    ctx.beginPath(); ctx.arc(cx, cy, (1 - alt / 90) * r, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(63,208,216,.28)';
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();

  // Cardinal spokes
  ctx.font = UI_LBL; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const [lab, az] of [['N', 0], ['E', 90], ['S', 180], ['W', 270]]) {
    const [x1, y1] = proj(az, 0);
    ctx.strokeStyle = 'rgba(255,255,255,.07)';
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(x1, y1); ctx.stroke();
    const [lx, ly] = proj(az, -9);
    ctx.fillStyle = FAINT;
    ctx.fillText(lab, lx, ly);
  }

  // Tracks (above-horizon segments only)
  const drawTrack = (track, color, dash) => {
    let run = [];
    const flush = () => {
      if (run.length > 1) {
        ctx.save();
        if (dash) ctx.setLineDash(dash);
        neonLine(ctx, run, color, { width: 1.5, glow: 6 });
        ctx.restore();
      }
      run = [];
    };
    for (const p of track) {
      if (p.alt < 0) { flush(); continue; }
      run.push(proj(p.az, p.alt));
    }
    flush();
  };
  drawTrack(sunTrack, '#f2b45a', null);
  drawTrack(moonTrack, '#7fb2f0', [3, 3]);

  // Bodies
  const body = (b, color, rad) => {
    if (!b || b.alt < -2) return;
    const [x, y] = proj(b.az, Math.max(0, b.alt));
    ctx.save();
    ctx.shadowColor = color; ctx.shadowBlur = 8;
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(x, y, rad, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    if (b.alt < 0) {
      ctx.strokeStyle = alpha(color, .5);
      ctx.setLineDash([2, 2]);
      ctx.beginPath(); ctx.arc(x, y, rad + 3, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
    }
  };
  body(moon, '#c9d8f5', 5);
  body(sun, '#efc865', 6.5);
  if (iss) {
    const [x, y] = proj(iss.az, Math.max(0, iss.alt));
    ctx.save();
    ctx.strokeStyle = '#8fdc6a'; ctx.lineWidth = 1.5;
    ctx.shadowColor = '#8fdc6a'; ctx.shadowBlur = 5;
    ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x - 7, y); ctx.lineTo(x + 7, y); ctx.stroke();
    ctx.restore();
  }
  ctx.restore();
}
