/**
 * Composite charts built from the primitives in charts.js.
 *
 * The meteogram is the workhorse. It stacks independent panels that share one
 * x-axis rather than overlaying two y-scales, because a dual-axis chart makes
 * the crossing point of two lines look meaningful when it isn't.
 */

import { haloText,
  SERIES, STATUS, INK, DIM, FAINT, GHOST, SURFACE, MONO, MONO_SM, UI_LBL,
  tempColor, alpha, mixHex, neonLine, smoothPath, gridY, capBar, tag, tooltip,
  legend, nightBands, marker, niceTicks, fitTicks, fitStride, fitLabel, tagRow,
} from './charts.js';
import { clamp, fmt as F, compass, wx } from './lib/util.js';

/* ------------------------------------------------------------- meteogram */

/**
 * @param opts.hours   normalized hourly series
 * @param opts.days    daily series (for night bands + date rules)
 * @param opts.span    {lo, hi} visible time window
 * @param opts.panels  which stacked panels to draw, in order
 */
export function meteogram(ctx, w, h, hover, opts) {
  const { hours, days, span, cursor, now, tf, panels = ['temp', 'pop'], showAxis = true } = opts;
  if (!hours?.length) return;

  const padL = 4, padR = 30, padT = 14, padB = showAxis ? 30 : 4;
  const plotW = w - padL - padR;
  if (plotW < 30) return;

  const visible = hours.filter((d) => d.t >= span.lo - 3600e3 && d.t <= span.hi + 3600e3);
  if (visible.length < 2) return;

  const xOf = (t) => padL + ((t - span.lo) / (span.hi - span.lo)) * plotW;
  const tOf = (x) => span.lo + ((x - padL) / plotW) * (span.hi - span.lo);

  // Distribute vertical space: temperature always gets the lion's share.
  const weights = { temp: 1, pop: 0.42, wind: 0.42, cloud: 0.30, pressure: 0.42, uv: 0.36, cape: 0.36 };
  const totalW = panels.reduce((s, p) => s + (weights[p] || 0.4), 0);
  // Each panel carries a caption above it, so stacks need real breathing room.
  const gapY = panels.length > 2 ? 16 : 9;
  const availH = h - padT - padB - (panels.length - 1) * gapY;

  let y = padT;
  const boxes = {};
  for (const p of panels) {
    const ph = (availH * (weights[p] || 0.4)) / totalW;
    boxes[p] = { x: padL, y, w: plotW, h: ph };
    y += ph + gapY;
  }

  /* --- shared backdrop --- */
  const full = { x: padL, y: padT, w: plotW, h: h - padT - padB };
  nightBands(ctx, full, days || [], xOf);

  // Midnight rules + day labels
  if (days?.length) {
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,.07)';
    ctx.lineWidth = 1;
    ctx.font = UI_LBL; ctx.letterSpacing = '1.2px';
    ctx.textBaseline = 'top';
    for (const d of days) {
      const x = xOf(d.t);
      if (x < padL - 1 || x > padL + plotW) continue;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, padT);
      ctx.lineTo(Math.round(x) + 0.5, padT + full.h);
      ctx.stroke();
      if (showAxis) {
        ctx.fillStyle = FAINT;
        ctx.textAlign = 'left';
        ctx.fillText(tf.weekday(d.t).toUpperCase(), x + 3, h - padB + 17);
      }
    }
    ctx.restore();
  }

  const drawn = [];

  /* --- temperature --- */
  if (boxes.temp) {
    const b = boxes.temp;
    const temps = visible.map((d) => d.temp).filter((v) => v != null);
    const feels = visible.map((d) => d.feels).filter((v) => v != null);
    const all = temps.concat(feels);
    const lo = Math.min(...all) - 2, hi = Math.max(...all) + 2;
    const yOf = (v) => b.y + b.h - ((v - lo) / (hi - lo)) * b.h;

    gridY(ctx, b, niceTicks(lo, hi, fitTicks(b.h, 3)).map((v) => ({ v, y: yOf(v) })), (v) => `${Math.round(v)}°`);

    // Feels-like sits behind, dashed, so the two never read as one series.
    if (feels.length > 1) {
      ctx.save();
      ctx.setLineDash([4, 3]);
      const fp = visible.filter((d) => d.feels != null).map((d) => [xOf(d.t), yOf(d.feels)]);
      neonLine(ctx, fp, alpha(SERIES[1], 0.75), { width: 1.5, glow: 6 });
      ctx.restore();
    }

    const pts = visible.filter((d) => d.temp != null).map((d) => [xOf(d.t), yOf(d.temp)]);

    // Area under the temperature curve, tinted by temperature itself.
    ctx.save();
    ctx.beginPath();
    smoothPath(ctx, pts);
    ctx.lineTo(pts.at(-1)[0], b.y + b.h);
    ctx.lineTo(pts[0][0], b.y + b.h);
    ctx.closePath();
    const ag = ctx.createLinearGradient(0, b.y, 0, b.y + b.h);
    ag.addColorStop(0, alpha(tempColor(hi), 0.30));
    ag.addColorStop(1, alpha(tempColor(lo), 0.02));
    ctx.fillStyle = ag;
    ctx.fill();
    ctx.restore();

    // The line itself is a gradient across the temperature ramp.
    const lg = ctx.createLinearGradient(padL, 0, padL + plotW, 0);
    for (let i = 0; i <= 8; i++) {
      const d = visible[Math.round((i / 8) * (visible.length - 1))];
      lg.addColorStop(i / 8, tempColor(d?.temp));
    }
    ctx.save();
    ctx.shadowColor = alpha(SERIES[0], 0.9); ctx.shadowBlur = 6;
    ctx.beginPath(); smoothPath(ctx, pts);
    ctx.strokeStyle = lg; ctx.lineWidth = 2.2;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.stroke();
    ctx.restore();

    // Direct labels on the day's extremes rather than a number on every point.
    ctx.save();
    ctx.font = MONO_SM; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    // gridY writes its numbers in a column at the right edge. A direct label
    // reaching into it prints one temperature on top of another, which is
    // exactly as confusing as it sounds.
    const axisW = ctx.measureText('100°').width + 6;
    for (const d of days || []) {
      const seg = visible.filter((x) => tf.isoDate(x.t) === tf.isoDate(d.t) && x.temp != null);
      if (seg.length < 3) continue;
      const mx = seg.reduce((a, c) => (c.temp > a.temp ? c : a));
      const mn = seg.reduce((a, c) => (c.temp < a.temp ? c : a));
      for (const [p, dy, al] of [[mx, -6, 'bottom'], [mn, 13, 'top']]) {
        const x = xOf(p.t);
        const lw = ctx.measureText(`${Math.round(p.temp)}°`).width;
        if (x - lw / 2 < padL + 4 || x + lw / 2 > padL + plotW - axisW) continue;
        // An extreme at the very top or bottom of the panel would put its
        // label outside it, on the neighbouring panel's title. Flip instead.
        const ly = yOf(p.temp) + dy;
        const flip = al === 'top' ? ly + 9 > b.y + b.h : ly - 9 < b.y;
        ctx.textBaseline = flip ? (al === 'top' ? 'bottom' : 'top') : al;
        ctx.fillStyle = tempColor(p.temp);
        haloText(ctx, `${Math.round(p.temp)}°`, x, flip ? yOf(p.temp) - dy : ly);
      }
    }
    ctx.restore();

    tagRow(ctx, b, b.y - 11, 'temperature °F', [
      { label: 'actual', color: SERIES[0] },
      { label: 'feels like', short: 'feels', color: SERIES[1], dash: true },
    ], { short: 'temp °F' });
    drawn.push({ key: 'temp', box: b, yOf });
  }

  /* --- precipitation probability --- */
  if (boxes.pop) {
    const b = boxes.pop;
    const yOf = (v) => b.y + b.h - (clamp(v, 0, 100) / 100) * b.h;
    gridY(ctx, b, [50, 100].map((v) => ({ v, y: yOf(v) })), (v) => `${v}%`);

    const pts = visible.map((d) => [xOf(d.t), yOf(d.pop ?? 0)]);
    ctx.save();
    ctx.beginPath();
    smoothPath(ctx, pts);
    ctx.lineTo(pts.at(-1)[0], b.y + b.h);
    ctx.lineTo(pts[0][0], b.y + b.h);
    ctx.closePath();
    const g = ctx.createLinearGradient(0, b.y, 0, b.y + b.h);
    g.addColorStop(0, alpha(SERIES[4], 0.55));
    g.addColorStop(1, alpha(SERIES[4], 0.04));
    ctx.fillStyle = g; ctx.fill();
    ctx.restore();
    neonLine(ctx, pts, SERIES[4], { width: 1.6, glow: 7 });

    /*
     * Accumulation is a second measure, so it is direct-labelled at the wet
     * peaks instead of being given its own y-axis on this panel.
     */
    ctx.save();
    ctx.font = MONO_SM; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    ctx.fillStyle = SERIES[0];
    let lastX = -999;
    const popAxisW = ctx.measureText('100%').width + 6;
    for (let i = 1; i < visible.length - 1; i++) {
      const d = visible[i];
      if ((d.precip ?? 0) < 0.02) continue;
      if ((d.precip ?? 0) <= (visible[i - 1].precip ?? 0) || (d.precip ?? 0) < (visible[i + 1].precip ?? 0)) continue;
      const x = xOf(d.t);
      const lw = ctx.measureText(`${d.precip.toFixed(2)}"`).width;
      if (x - lastX < 46 || x - lw / 2 < padL + 4 || x + lw / 2 > padL + plotW - popAxisW) continue;
      ctx.fillText(`${d.precip.toFixed(2)}"`, x, yOf(d.pop ?? 0) - 4);
      lastX = x;
    }
    ctx.restore();

    tag(ctx, b.x + 2, b.y - 11, 'precip probability');
    drawn.push({ key: 'pop', box: b, yOf });
  }

  /* --- wind --- */
  if (boxes.wind) {
    const b = boxes.wind;
    const maxW = Math.max(...visible.map((d) => d.gust ?? d.wind ?? 0), 10) * 1.12;
    const yOf = (v) => b.y + b.h - (clamp(v, 0, maxW) / maxW) * b.h;
    gridY(ctx, b, niceTicks(0, maxW, fitTicks(b.h, 2)).map((v) => ({ v, y: yOf(v) })), (v) => String(Math.round(v)));

    // Gusts as a filled envelope beneath the sustained-wind line.
    const gp = visible.map((d) => [xOf(d.t), yOf(d.gust ?? d.wind ?? 0)]);
    ctx.save();
    ctx.beginPath(); smoothPath(ctx, gp);
    ctx.lineTo(gp.at(-1)[0], b.y + b.h); ctx.lineTo(gp[0][0], b.y + b.h);
    ctx.closePath();
    ctx.fillStyle = alpha(STATUS.serious, 0.16);
    ctx.fill();
    ctx.restore();
    neonLine(ctx, gp, alpha(STATUS.serious, .85), { width: 1.2, glow: 5 });
    neonLine(ctx, visible.map((d) => [xOf(d.t), yOf(d.wind ?? 0)]), SERIES[3], { width: 1.8, glow: 8 });

    // Direction barbs along the bottom of the panel.
    ctx.save();
    ctx.strokeStyle = alpha(SERIES[3], .55); ctx.lineWidth = 1;
    const stepH = Math.max(1, Math.round(visible.length / (plotW / 26)));
    for (let i = 0; i < visible.length; i += stepH) {
      const d = visible[i];
      if (d.windDir == null) continue;
      const x = xOf(d.t), yy = b.y + b.h - 5;
      const a = (d.windDir - 90 + 180) * Math.PI / 180;
      ctx.save(); ctx.translate(x, yy); ctx.rotate(a);
      ctx.beginPath(); ctx.moveTo(-4, 0); ctx.lineTo(4, 0);
      ctx.moveTo(4, 0); ctx.lineTo(1.5, -2); ctx.moveTo(4, 0); ctx.lineTo(1.5, 2);
      ctx.stroke(); ctx.restore();
    }
    ctx.restore();

    tagRow(ctx, b, b.y - 11, 'wind mph', [
      { label: 'sustained', short: 'wind', color: SERIES[3] },
      { label: 'gusts', color: STATUS.serious },
    ], { short: 'wind' });
    drawn.push({ key: 'wind', box: b, yOf });
  }

  /* --- cloud cover, as stacked decks --- */
  if (boxes.cloud) {
    const b = boxes.cloud;
    const n = visible.length;
    const bw = Math.max(1, plotW / n);
    const decks = [
      ['cloudHigh', alpha(SERIES[4], .55)],
      ['cloudMid', alpha(SERIES[0], .5)],
      ['cloudLow', alpha(INK, .45)],
    ];
    visible.forEach((d, i) => {
      const x = padL + (i * plotW) / n;
      let yy = b.y;
      const dh = b.h / 3;
      decks.forEach(([k, c], j) => {
        const v = clamp((d[k] ?? 0) / 100, 0, 1);
        ctx.fillStyle = c;
        // 2px gap between deck rows keeps the segments legible.
        ctx.fillRect(x, yy + (dh - 2) * (1 - v), Math.max(1, bw - 0.5), (dh - 2) * v);
        yy += dh;
      });
    });
    ctx.save();
    ctx.font = UI_LBL; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    ['HIGH', 'MID', 'LOW'].forEach((l, j) => {
      const y = b.y + (b.h / 3) * (j + 0.5);
      ctx.fillStyle = 'rgba(22,33,47,.75)';
      ctx.fillRect(b.x + b.w - 30, y - 5, 30, 10);
      ctx.fillStyle = FAINT;
      haloText(ctx, l, b.x + b.w - 2, y);
    });
    ctx.restore();
    tag(ctx, b.x + 2, b.y - 11, 'cloud decks %');
    drawn.push({ key: 'cloud', box: b });
  }

  /* --- pressure --- */
  if (boxes.pressure) {
    const b = boxes.pressure;
    const vals = visible.map((d) => d.pressure).filter((v) => v != null);
    const lo = Math.min(...vals) - 1, hi = Math.max(...vals) + 1;
    const yOf = (v) => b.y + b.h - ((v - lo) / (hi - lo)) * b.h;
    gridY(ctx, b, niceTicks(lo, hi, fitTicks(b.h, 2)).map((v) => ({ v, y: yOf(v) })), (v) => (v * 0.02953).toFixed(2));
    neonLine(ctx, visible.filter((d) => d.pressure != null).map((d) => [xOf(d.t), yOf(d.pressure)]),
      SERIES[3], { width: 1.8, glow: 8 });
    tag(ctx, b.x + 2, b.y - 11, 'pressure inHg');
    drawn.push({ key: 'pressure', box: b, yOf });
  }

  /* --- UV --- */
  if (boxes.uv) {
    const b = boxes.uv;
    const yOf = (v) => b.y + b.h - (clamp(v, 0, 12) / 12) * b.h;
    gridY(ctx, b, [3, 6, 8, 11].map((v) => ({ v, y: yOf(v) })), String);
    const n = visible.length;
    const bw = Math.max(1, plotW / n - 1);
    visible.forEach((d, i) => {
      const v = d.uv ?? 0;
      if (v <= 0.05) return;
      const x = padL + (i * plotW) / n;
      const c = v < 3 ? STATUS.good : v < 6 ? STATUS.warn : v < 8 ? STATUS.serious : v < 11 ? STATUS.crit : SERIES[3];
      capBar(ctx, x, yOf(v), bw, b.y + b.h, alpha(c, .8));
    });
    tag(ctx, b.x + 2, b.y - 11, 'uv index');
    drawn.push({ key: 'uv', box: b, yOf });
  }

  /* --- convective energy --- */
  if (boxes.cape) {
    const b = boxes.cape;
    const maxC = Math.max(...visible.map((d) => d.cape ?? 0), 500) * 1.1;
    const yOf = (v) => b.y + b.h - (clamp(v, 0, maxC) / maxC) * b.h;
    gridY(ctx, b, niceTicks(0, maxC, fitTicks(b.h, 2)).map((v) => ({ v, y: yOf(v) })), (v) => String(Math.round(v)));
    const pts = visible.map((d) => [xOf(d.t), yOf(d.cape ?? 0)]);
    ctx.save();
    ctx.beginPath(); smoothPath(ctx, pts);
    ctx.lineTo(pts.at(-1)[0], b.y + b.h); ctx.lineTo(pts[0][0], b.y + b.h); ctx.closePath();
    ctx.fillStyle = alpha(STATUS.crit, .18); ctx.fill();
    ctx.restore();
    neonLine(ctx, pts, STATUS.crit, { width: 1.6, glow: 7 });
    tag(ctx, b.x + 2, b.y - 11, 'CAPE J/kg');
    drawn.push({ key: 'cape', box: b, yOf });
  }

  /* --- time axis --- */
  if (showAxis) {
    ctx.save();
    ctx.font = MONO_SM; ctx.fillStyle = FAINT;
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    const hoursSpan = (span.hi - span.lo) / 3600e3;
    /*
     * The span alone cannot decide this: the same 48 hours are a thousand
     * pixels on a desktop and 340 on a phone. Start from what the span asks
     * for and coarsen until neighbours have clear air — never the reverse,
     * so the wide layout keeps exactly the axis it had.
     */
    const bySpan = hoursSpan > 200 ? 24 : hoursSpan > 96 ? 12 : hoursSpan > 40 ? 6 : hoursSpan > 16 ? 3 : 1;
    const need = ctx.measureText('00:00').width + 8;
    const perHour = plotW / Math.max(hoursSpan, 1);
    const stepH = [1, 3, 6, 12, 24, 48]
      .filter((v) => v >= bySpan).find((v) => v * perHour >= need) ?? 48;
    for (const d of visible) {
      const hod = tf.hourOfDay(d.t);
      if (Math.abs(hod - Math.round(hod)) > 0.01) continue;
      if (Math.round(hod) % stepH !== 0) continue;
      const x = xOf(d.t);
      if (x < padL + 10 || x > padL + plotW - 10) continue;
      ctx.fillText(tf.hm(d.t), x, h - padB + 4);
    }
    ctx.restore();
  }

  /* --- markers --- */
  if (now != null && now >= span.lo && now <= span.hi) {
    marker(ctx, xOf(now), full, alpha(STATUS.good, .9), 'NOW', { dash: [3, 3] });
  }
  if (cursor != null && Math.abs(cursor - (now ?? cursor)) > 90e3 && cursor >= span.lo && cursor <= span.hi) {
    marker(ctx, xOf(cursor), full, SERIES[1], null);
  }

  /* --- hover --- */
  if (hover && hover.x > padL && hover.x < padL + plotW) {
    const t = tOf(hover.x);
    const d = nearest(visible, t);
    if (d) {
      const x = xOf(d.t);
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,.35)';
      ctx.setLineDash([2, 3]); ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + .5, padT); ctx.lineTo(Math.round(x) + .5, padT + full.h);
      ctx.stroke();
      ctx.restore();

      for (const p of drawn) {
        if (!p.yOf) continue;
        const v = p.key === 'temp' ? d.temp : p.key === 'pop' ? (d.pop ?? 0)
          : p.key === 'wind' ? d.wind : p.key === 'pressure' ? d.pressure
          : p.key === 'uv' ? d.uv : p.key === 'cape' ? d.cape : null;
        if (v == null) continue;
        ctx.save();
        ctx.fillStyle = INK;
        ctx.shadowColor = SERIES[0]; ctx.shadowBlur = 5;
        ctx.beginPath(); ctx.arc(x, p.yOf(v), 3.5, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      }

      const lines = [`${tf.weekday(d.t)} ${tf.hm(d.t)}|`];
      if (boxes.temp) {
        lines.push(`TEMP|${F.temp(d.temp)}`);
        lines.push(`FEELS|${F.temp(d.feels)}`);
      }
      if (boxes.pop) {
        lines.push(`RAIN CHANCE|${F.pct(d.pop)}`);
        if ((d.precip ?? 0) > 0.001) lines.push(`AMOUNT|${F.inches(d.precip)}"`);
      }
      if (boxes.wind) lines.push(`WIND|${F.wind(d.wind)} ${compass(d.windDir)}`);
      if (boxes.pressure) lines.push(`PRESSURE|${F.pressure(d.pressure)}`);
      if (boxes.uv) lines.push(`UV|${d.uv?.toFixed(1) ?? '--'}`);
      if (boxes.cape) lines.push(`CAPE|${Math.round(d.cape ?? 0)}`);
      lines.push(`SKY|${wx(Math.round(d.code ?? 0)).label}`);
      tooltip(ctx, x, hover.y, lines, w, h, '#3fd0d8', { pin: hover.coarse });
    }
  }

  return { xOf, tOf, boxes };
}

function nearest(arr, t) {
  let best = null, bd = Infinity;
  for (const d of arr) {
    const dd = Math.abs(d.t - t);
    if (dd < bd) { bd = dd; best = d; }
  }
  return best;
}

/* ============================================================ spread fan */

/**
 * Multi-model agreement. One hue at graded opacity (a sequential encoding of
 * uncertainty), not five categorical colors — the question is "how wide is
 * the envelope", not "which model said what".
 */
export function spreadFan(ctx, w, h, hover, { rows, tf, now }) {
  if (!rows?.length) return;
  const padL = 4, padR = 34, padT = 16, padB = 20;
  const box = { x: padL, y: padT, w: w - padL - padR, h: h - padT - padB };
  if (box.w < 30 || box.h < 20) return;

  const lo0 = Math.min(...rows.map((r) => r.min)), hi0 = Math.max(...rows.map((r) => r.max));
  const lo = lo0 - 2, hi = hi0 + 2;
  const xOf = (t) => box.x + ((t - rows[0].t) / (rows.at(-1).t - rows[0].t)) * box.w;
  const yOf = (v) => box.y + box.h - ((v - lo) / (hi - lo)) * box.h;

  gridY(ctx, box, niceTicks(lo, hi, fitTicks(box.h, 4)).map((v) => ({ v, y: yOf(v) })), (v) => `${Math.round(v)}°`);

  // Envelope
  ctx.save();
  ctx.beginPath();
  rows.forEach((r, i) => (i ? ctx.lineTo(xOf(r.t), yOf(r.max)) : ctx.moveTo(xOf(r.t), yOf(r.max))));
  for (let i = rows.length - 1; i >= 0; i--) ctx.lineTo(xOf(rows[i].t), yOf(rows[i].min));
  ctx.closePath();
  const g = ctx.createLinearGradient(box.x, 0, box.x + box.w, 0);
  g.addColorStop(0, alpha(SERIES[0], .30));
  g.addColorStop(1, alpha(SERIES[0], .10));   // confidence decays with range
  ctx.fillStyle = g;
  ctx.fill();
  ctx.strokeStyle = alpha(SERIES[0], .35); ctx.lineWidth = 1; ctx.stroke();
  ctx.restore();

  neonLine(ctx, rows.map((r) => [xOf(r.t), yOf(r.mean)]), SERIES[0], { width: 2, glow: 10 });

  // Day rules
  ctx.save();
  ctx.strokeStyle = GHOST; ctx.font = MONO_SM; ctx.fillStyle = FAINT;
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  let lastDay = '';
  // A rule on every day boundary, but a weekday label only where the last
  // one left room for it: sixteen days across a phone is 21px per day.
  const gapD = ctx.measureText('WED').width + 8;
  let lastLx = -1e9;
  for (const r of rows) {
    const day = tf.isoDate(r.t);
    if (day === lastDay) continue;
    lastDay = day;
    const x = xOf(r.t);
    ctx.beginPath(); ctx.moveTo(x + .5, box.y); ctx.lineTo(x + .5, box.y + box.h); ctx.stroke();
    if (x < box.x + 12 || x > box.x + box.w - 12 || x - lastLx < gapD) continue;
    ctx.fillText(tf.weekday(r.t).toUpperCase(), x, h - padB + 5);
    lastLx = x;
  }
  ctx.restore();

  if (now >= rows[0].t && now <= rows.at(-1).t) {
    marker(ctx, xOf(now), box, alpha(STATUS.good, .9), 'NOW', { dash: [3, 3] });
  }

  tagRow(ctx, box, 3, 'model agreement °F', [
    { label: 'ensemble mean', short: 'mean', color: SERIES[0] },
    { label: 'model range', short: 'range', color: alpha(SERIES[0], .35) },
  ], { short: 'model spread °F' });

  if (hover && hover.x > box.x && hover.x < box.x + box.w) {
    const t = rows[0].t + ((hover.x - box.x) / box.w) * (rows.at(-1).t - rows[0].t);
    const r = nearest(rows, t);
    if (r) {
      const x = xOf(r.t);
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,.3)'; ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(x + .5, box.y); ctx.lineTo(x + .5, box.y + box.h); ctx.stroke();
      ctx.restore();
      const conf = r.spread < 2 ? 'HIGH' : r.spread < 5 ? 'MODERATE' : r.spread < 9 ? 'LOW' : 'VERY LOW';
      tooltip(ctx, x, hover.y, [
        `${tf.weekday(r.t)} ${tf.hm(r.t)}|`,
        `MEAN|${F.tempP(r.mean)}`,
        `RANGE|${F.temp(r.min)}–${F.temp(r.max)}`,
        `SPREAD|${r.spread.toFixed(1)}°`,
        `CONFIDENCE|${conf}`,
        r.precipAgree != null ? `MODELS WET|${Math.round(r.precipAgree * 100)}%` : null,
      ].filter(Boolean), w, h, '#3fd0d8', { pin: hover.coarse });
    }
  }
}

/* ====================================================== climate envelope */

/**
 * Today's forecast against 30+ years of local record. Anomaly is a diverging
 * measure — warm and cool poles around a neutral normal — so it gets amber
 * and ice with a grey midpoint, never a rainbow.
 */
export function climateEnvelope(ctx, w, h, hover, { days, climate, tf, doyOf }) {
  if (!days?.length || !climate?.doy?.length) return;
  const padL = 4, padR = 34, padT = 16, padB = 20;
  const box = { x: padL, y: padT, w: w - padL - padR, h: h - padT - padB };
  if (box.w < 40 || box.h < 30) return;

  const rows = days.map((d) => {
    const c = climate.doy[doyOf(d.t)];
    return c ? { ...d, c } : null;
  }).filter(Boolean);
  if (!rows.length) return;

  const all = rows.flatMap((r) => [r.c.recordHigh, r.c.recordLow, r.tmax, r.tmin]).filter((v) => v != null);
  const lo = Math.min(...all) - 3, hi = Math.max(...all) + 3;
  const n = rows.length;
  const colW = box.w / n;
  const xOf = (i) => box.x + colW * (i + 0.5);
  const yOf = (v) => box.y + box.h - ((v - lo) / (hi - lo)) * box.h;

  gridY(ctx, box, niceTicks(lo, hi, fitTicks(box.h, 4)).map((v) => ({ v, y: yOf(v) })), (v) => `${Math.round(v)}°`);

  // Record envelope: the widest band, faintest ink.
  ctx.save();
  ctx.beginPath();
  rows.forEach((r, i) => (i ? ctx.lineTo(xOf(i), yOf(r.c.recordHigh)) : ctx.moveTo(xOf(i), yOf(r.c.recordHigh))));
  for (let i = n - 1; i >= 0; i--) ctx.lineTo(xOf(i), yOf(rows[i].c.recordLow));
  ctx.closePath();
  ctx.fillStyle = 'rgba(255,255,255,.045)';
  ctx.fill();
  ctx.restore();

  // Normal band.
  ctx.save();
  ctx.beginPath();
  rows.forEach((r, i) => (i ? ctx.lineTo(xOf(i), yOf(r.c.normalHigh)) : ctx.moveTo(xOf(i), yOf(r.c.normalHigh))));
  for (let i = n - 1; i >= 0; i--) ctx.lineTo(xOf(i), yOf(rows[i].c.normalLow));
  ctx.closePath();
  ctx.fillStyle = 'rgba(141,154,171,.20)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(141,154,171,.45)';
  ctx.setLineDash([3, 3]); ctx.lineWidth = 1; ctx.stroke();
  ctx.restore();

  // Forecast range bars, colored by anomaly against the normal.
  const bw = Math.min(15, colW * 0.42);
  rows.forEach((r, i) => {
    if (r.tmax == null || r.tmin == null) return;
    const anomaly = ((r.tmax - r.c.normalHigh) + (r.tmin - (r.c.normalLow ?? r.c.normalHigh))) / 2;
    const mag = clamp(Math.abs(anomaly) / 15, 0, 1);
    const col = anomaly >= 0
      ? mixHex('#8d9aab', '#f2b45a', mag)
      : mixHex('#8d9aab', '#7fb2f0', mag);
    const x = xOf(i) - bw / 2;
    const yT = yOf(r.tmax), yB = yOf(r.tmin);
    ctx.save();
    ctx.shadowColor = col; ctx.shadowBlur = 5;
    ctx.fillStyle = col;
    const rr = Math.min(4, bw / 2);
    ctx.beginPath();
    ctx.moveTo(x, yB - rr);
    ctx.lineTo(x, yT + rr);
    ctx.quadraticCurveTo(x, yT, x + rr, yT);
    ctx.lineTo(x + bw - rr, yT);
    ctx.quadraticCurveTo(x + bw, yT, x + bw, yT + rr);
    ctx.lineTo(x + bw, yB - rr);
    ctx.quadraticCurveTo(x + bw, yB, x + bw - rr, yB);
    ctx.lineTo(x + rr, yB);
    ctx.quadraticCurveTo(x, yB, x, yB - rr);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // Flag any day that threatens a record — the thing worth noticing.
    if (r.tmax >= r.c.recordHigh) {
      ctx.save();
      ctx.fillStyle = STATUS.crit; ctx.font = MONO_SM;
      ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      haloText(ctx, 'REC', xOf(i), yOf(r.tmax) - 4);
      ctx.restore();
    }
  });

  // Day labels
  ctx.save();
  ctx.font = MONO_SM; ctx.fillStyle = FAINT;
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  const stepD = fitStride(n, box.w, ctx.measureText('WED').width,
    { least: n > 12 ? 2 : 1 });
  rows.forEach((r, i) => {
    if (i % stepD) return;
    fitLabel(ctx, tf.weekday(r.t).toUpperCase(), xOf(i), h - padB + 5, 0, w);
  });
  ctx.restore();

  tagRow(ctx, box, 3, 'forecast vs climate record °F', [
    { label: 'forecast', color: '#f2b45a' },
    { label: 'normal', color: 'rgba(141,154,171,.7)', dash: true },
    { label: 'record range', short: 'record', color: 'rgba(255,255,255,.2)' },
  ], { short: 'climate record °F' });

  if (hover && hover.x > box.x && hover.x < box.x + box.w) {
    const i = clamp(Math.floor((hover.x - box.x) / colW), 0, n - 1);
    const r = rows[i];
    const anomalyH = r.tmax - r.c.normalHigh;
    tooltip(ctx, xOf(i), hover.y, [
      `${tf.weekday(r.t)} ${tf.monthDay(r.t)}|`,
      `FORECAST|${F.temp(r.tmin)} – ${F.temp(r.tmax)}`,
      `NORMAL|${F.temp(r.c.normalLow)} – ${F.temp(r.c.normalHigh)}`,
      `HIGH vs NORMAL|${F.signed(anomalyH)}°`,
      `RECORD HIGH|${F.temp(r.c.recordHigh)} (${r.c.recordHighYear})`,
      `RECORD LOW|${F.temp(r.c.recordLow)} (${r.c.recordLowYear})`,
    ], w, h, anomalyH >= 0 ? '#f2b45a' : '#7fb2f0', { pin: hover.coarse });
  }
}

/* ============================================================== kp chart */

export function kpChart(ctx, w, h, hover, { rows, tf, now }) {
  if (!rows?.length) return;
  const padL = 4, padR = 22, padT = 14, padB = 18;
  const box = { x: padL, y: padT, w: w - padL - padR, h: h - padT - padB };
  if (box.w < 30) return;
  const n = rows.length;
  const bw = Math.max(2, box.w / n - 2);
  // Scale to the data but always keep the Kp 5 storm line on screen.
  const top = Math.max(5.6, Math.ceil(Math.max(...rows.map((r) => r.kp)) + 0.8));
  const yOf = (v) => box.y + box.h - (clamp(v, 0, top) / top) * box.h;

  gridY(ctx, box, [3, 5, 7].filter((v) => v <= top).map((v) => ({ v, y: yOf(v) })), String);

  // Kp 5 is the storm threshold; mark it explicitly.
  ctx.save();
  ctx.strokeStyle = alpha(STATUS.serious, .5);
  ctx.setLineDash([4, 3]); ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(box.x, yOf(5)); ctx.lineTo(box.x + box.w, yOf(5)); ctx.stroke();
  ctx.setLineDash([]);
  ctx.font = UI_LBL; ctx.fillStyle = alpha(STATUS.serious, .8);
  ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
  haloText(ctx, 'STORM', box.x + 3, yOf(5) - 2);
  ctx.restore();

  rows.forEach((r, i) => {
    const c = r.kp < 3 ? SERIES[0] : r.kp < 5 ? STATUS.good : r.kp < 6 ? STATUS.warn
      : r.kp < 7 ? STATUS.serious : STATUS.crit;
    const x = box.x + (i * box.w) / n;
    capBar(ctx, x, yOf(Math.min(r.kp, top)), bw, box.y + box.h, alpha(c, r.observed === 'observed' ? .9 : .55));
  });

  ctx.save();
  ctx.font = MONO_SM; ctx.fillStyle = FAINT;
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  let last = '';
  const gapK = ctx.measureText('WED').width + 8;
  let lastKx = -1e9;
  rows.forEach((r, i) => {
    const d = tf.isoDate(r.t);
    if (d === last) return;
    last = d;
    const x = box.x + (i * box.w) / n + bw / 2;
    if (x < box.x + 10 || x > box.x + box.w - 10 || x - lastKx < gapK) return;
    ctx.fillText(tf.weekday(r.t).toUpperCase(), x, h - padB + 4);
    lastKx = x;
  });
  ctx.restore();

  tag(ctx, box.x + 2, 2, 'planetary K index');

  if (hover && hover.x > box.x && hover.x < box.x + box.w) {
    const i = clamp(Math.floor(((hover.x - box.x) / box.w) * n), 0, n - 1);
    const r = rows[i];
    tooltip(ctx, box.x + (i * box.w) / n + bw / 2, hover.y, [
      `${tf.weekday(r.t)} ${tf.hm(r.t)}|`,
      `Kp|${r.kp.toFixed(2)}`,
      `STATUS|${(r.observed || 'predicted').toUpperCase()}`,
    ], w, h, SERIES[3], { pin: hover.coarse });
  }
}
