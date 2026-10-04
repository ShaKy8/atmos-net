/**
 * DATA — the long view.
 *
 * Everything here answers "is this unusual?" rather than "what is it?".
 * The forecast is placed against 30+ years of local observations, the models
 * are placed against each other, and the climate record is placed against
 * itself.
 */

import { store } from '../state.js';
import { meteogram, spreadFan, climateEnvelope } from '../plots.js';
import {
  SERIES, STATUS, INK, DIM, FAINT, mount, spark, neonLine, smoothPath,
  alpha, tag, niceTicks, gridY, mixHex, capBar, fitTicks, fitStride, fitLabel,
  UI_LBL,
} from '../charts.js';
import { fmt as F, clamp, dayOfYearOf, dur } from '../lib/util.js';

export function createData(root) {
  root.className = 'view dataview';
  root.innerHTML = `
    <div class="panel bare data-climate"><canvas class="fill" id="d2-clim"></canvas></div>
    <div class="panel bare data-spread"><canvas class="fill" id="d2-spread"></canvas></div>

    <div class="panel data-stats">
      <div class="hd">TODAY IN THE RECORD<span class="rule"></span><span class="val" id="d2-yrs">—</span></div>
      <div class="body" id="d2-rec"></div>
    </div>

    <div class="panel bare data-trend"><canvas class="fill" id="d2-trend"></canvas></div>

    <div class="panel data-derived">
      <div class="hd" style="--ac:var(--vi)">DERIVED<span class="rule"></span><span class="val">SEASON TO DATE</span></div>
      <div class="body" id="d2-derived"></div>
    </div>

    <div class="panel bare data-meteo"><canvas class="fill" id="d2-meteo"></canvas></div>
  `;

  const $ = (id) => root.querySelector('#' + id);
  const doyOf = (t) => dayOfYearOf(t, store.tz);

  // Function declarations, not consts: mount() renders synchronously, so the
  // draw callbacks run before any const below them would be initialised.
  function todayStart() {
    const key = store.fmt.isoDate(Date.now());
    const d = store.days.find((x) => store.fmt.isoDate(x.t) === key);
    return d ? d.t : Date.now() - 12 * 3600e3;
  }

  function pending(ctx, w, h, msg) {
    ctx.save();
    ctx.font = "600 11.5px 'Chakra Petch', sans-serif";
    ctx.fillStyle = FAINT; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.letterSpacing = '1.6px';
    ctx.fillText(msg.toUpperCase() + ' …', w / 2, h / 2);
    ctx.restore();
  }

  const climChart = mount($('d2-clim'), (ctx, w, h, hover) => {
    if (!store.climate) { pending(ctx, w, h, 'loading 30-year archive'); return; }
    climateEnvelope(ctx, w, h, hover, {
      days: store.days.filter((d) => d.t >= todayStart()),
      climate: store.climate, tf: store.fmt, doyOf,
    });
  });

  const spreadChart = mount($('d2-spread'), (ctx, w, h, hover) => {
    if (!store.models) { pending(ctx, w, h, 'loading model ensemble'); return; }
    spreadFan(ctx, w, h, hover, { rows: store.models.rows, tf: store.fmt, now: Date.now() });
  });

  const meteoChart = mount($('d2-meteo'), (ctx, w, h, hover) => {
    meteogram(ctx, w, h, hover, {
      hours: store.hours, days: store.days, tf: store.fmt,
      span: { lo: store.cursor - 24 * 3600e3, hi: store.cursor + 96 * 3600e3 },
      cursor: store.cursor, now: Date.now(),
      panels: ['pressure', 'cloud', 'uv', 'cape'],
    });
  }, {
    onPick: ({ x, w }) => {
      const lo = store.cursor - 24 * 3600e3, hi = store.cursor + 96 * 3600e3;
      store.playing = false;
      store.scrubTo(lo + ((x - 4) / (w - 34)) * (hi - lo));
    },
  });

  /** Annual mean temperature, with a least-squares trend line. */
  const trendChart = mount($('d2-trend'), (ctx, w, h, hover) => {
    const a = store.climate?.annual;
    if (!a?.length) { pending(ctx, w, h, 'loading climate record'); return; }
    const pad = { l: 4, r: 34, t: 16, b: 18 };
    const box = { x: pad.l, y: pad.t, w: w - pad.l - pad.r, h: h - pad.t - pad.b };
    if (box.w < 40 || box.h < 30) return;

    const vals = a.map((d) => d.mean);
    const lo = Math.min(...vals) - 0.4, hi = Math.max(...vals) + 0.4;
    const xOf = (i) => box.x + (i / (a.length - 1)) * box.w;
    const yOf = (v) => box.y + box.h - ((v - lo) / (hi - lo)) * box.h;

    gridY(ctx, box, niceTicks(lo, hi, fitTicks(box.h, 3)).map((v) => ({ v, y: yOf(v) })), (v) => `${v.toFixed(1)}°`);

    // Bars coloured by departure from the period mean: diverging, warm/cool.
    const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
    const bw = Math.max(2, box.w / a.length - 2);
    a.forEach((d, i) => {
      const dev = d.mean - mean;
      const c = dev >= 0
        ? mixHex('#8d9aab', '#f2b45a', clamp(Math.abs(dev) / 1.6, 0, 1))
        : mixHex('#8d9aab', '#7fb2f0', clamp(Math.abs(dev) / 1.6, 0, 1));
      const y0 = yOf(mean), y1 = yOf(d.mean);
      ctx.fillStyle = alpha(c, .9);
      ctx.fillRect(xOf(i) - bw / 2, Math.min(y0, y1), bw, Math.max(1.5, Math.abs(y1 - y0)));
    });

    // Trend line by ordinary least squares.
    const n = a.length;
    const sx = a.reduce((s, d) => s + d.year, 0) / n;
    const sy = mean;
    let num = 0, den = 0;
    for (const d of a) { num += (d.year - sx) * (d.mean - sy); den += (d.year - sx) ** 2; }
    const slope = den ? num / den : 0;
    const line = a.map((d, i) => [xOf(i), yOf(sy + slope * (d.year - sx))]);
    ctx.save();
    ctx.setLineDash([5, 3]);
    neonLine(ctx, line, slope >= 0 ? '#f2b45a' : '#7fb2f0', { width: 2, glow: 10 });
    ctx.restore();

    ctx.save();
    ctx.font = "500 11.5px 'JetBrains Mono', monospace";
    ctx.fillStyle = FAINT; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    // Every fifth year, or fewer where five years is not five labels wide.
    const yearStep = 5 * fitStride(Math.ceil(a.length / 5), box.w,
      ctx.measureText('2020').width);
    a.forEach((d, i) => {
      if (d.year % yearStep) return;
      fitLabel(ctx, String(d.year), xOf(i), h - pad.b + 4, 0, w);
    });
    ctx.restore();

    ctx.save();
    ctx.font = "600 11.5px 'Chakra Petch', sans-serif";
    ctx.letterSpacing = '1.2px';
    const trend = `TREND ${slope >= 0 ? '+' : '−'}${Math.abs(slope * 10).toFixed(2)}°F / DECADE`;
    const trendW = ctx.measureText(trend).width;
    ctx.fillStyle = slope >= 0 ? '#f2b45a' : '#7fb2f0';
    ctx.textAlign = 'right'; ctx.textBaseline = 'top';
    ctx.fillText(trend, box.x + box.w, 3);
    ctx.restore();
    // The trend is the headline of this chart, so the axis title is what
    // gives way when the two will not fit on one row.
    ctx.save();
    ctx.font = UI_LBL; ctx.letterSpacing = '1.4px';
    const full = 'annual mean temperature °F', brief = 'annual mean °F';
    const width = (t) => ctx.measureText(t.toUpperCase()).width;
    const title = width(full) + trendW + 14 <= box.w ? full
      : width(brief) + trendW + 14 <= box.w ? brief : null;
    ctx.restore();
    if (title) tag(ctx, box.x + 2, 3, title);

    if (hover && hover.x > box.x && hover.x < box.x + box.w) {
      const i = clamp(Math.round(((hover.x - box.x) / box.w) * (a.length - 1)), 0, a.length - 1);
      const d = a[i];
      ctx.save();
      ctx.fillStyle = 'rgba(22,33,47,.94)';
      ctx.strokeStyle = alpha(SERIES[0], .5);
      const txt = `${d.year}  ${d.mean.toFixed(2)}°F  ${d.mean - mean >= 0 ? '+' : '−'}${Math.abs(d.mean - mean).toFixed(2)} vs period mean`;
      ctx.font = "500 11.5px 'JetBrains Mono', monospace";
      const tw = ctx.measureText(txt).width + 14;
      const bx = clamp(xOf(i) - tw / 2, 4, Math.max(4, w - tw - 4));
      // A finger in the top half would sit on a box pinned to the top.
      const by = hover.coarse && hover.y < h / 2 ? box.y + box.h - 20 : box.y + 2;
      ctx.beginPath(); ctx.rect(bx, by, tw, 18); ctx.fill(); ctx.stroke();
      ctx.fillStyle = INK; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(txt, bx + 7, by + 9);
      ctx.restore();
    }
  });



  /* ------------------------------------------------------------- render */

  function update() {
    const tf = store.fmt;
    const c = store.climate;
    const day = store.dayFor(store.cursor);
    const cd = c?.doy?.[doyOf(store.cursor)];

    $('d2-yrs').textContent = c ? `${c.years} YEARS · ${c.start.slice(0, 4)}–${c.end.slice(0, 4)}` : '—';

    if (cd && day) {
      const dHigh = day.tmax - cd.normalHigh;
      const dLow = day.tmin - (cd.normalLow ?? day.tmin);
      const pctToRecord = clamp(
        ((day.tmax - cd.normalHigh) / Math.max(0.1, cd.recordHigh - cd.normalHigh)) * 100, 0, 100);
      $('d2-rec').innerHTML = `
        <div style="font-size:max(.62rem,var(--fs-floor,0px));color:var(--dim);margin-bottom:7px">
          ${tf.weekday(store.cursor)} ${tf.monthDay(store.cursor)} · forecast against every
          ${tf.monthDay(store.cursor)} since ${c.start.slice(0, 4)}
        </div>
        <dl style="margin:0">
          ${kvc('Forecast high', F.temp(day.tmax), dHigh >= 0 ? '#f2b45a' : '#7fb2f0')}
          ${kv('Normal high', `${F.temp(cd.normalHigh)}  (${F.signed(dHigh)}°)`)}
          ${kvc('Record high', `${F.temp(cd.recordHigh)} in ${cd.recordHighYear}`, day.tmax >= cd.recordHigh ? STATUS.crit : DIM)}
          ${kv('Forecast low', F.temp(day.tmin))}
          ${kv('Normal low', `${F.temp(cd.normalLow)}  (${F.signed(dLow)}°)`)}
          ${kvc('Record low', `${F.temp(cd.recordLow)} in ${cd.recordLowYear}`, day.tmin <= cd.recordLow ? SERIES[4] : DIM)}
        </dl>
        <div class="lbl" style="margin:9px 0 3px">high, normal → record</div>
        <div class="meter" style="--ac:${pctToRecord > 85 ? STATUS.crit : STATUS.serious}">
          <i style="width:${pctToRecord}%"></i></div>
        <div style="display:flex;justify-content:space-between;font-size:max(.52rem,var(--fs-floor,0px));color:var(--faint);margin-top:2px">
          <span>${F.temp(cd.normalHigh)} normal</span><span>${F.temp(cd.recordHigh)} record</span>
        </div>
        <dl style="margin:9px 0 0">
          ${kv('Historically wet', `${Math.round(cd.wetFrac * 100)}% of years`)}
          ${kv('Mean precip', `${cd.meanPrecip.toFixed(3)} in`)}
          ${kv('Forecast precip', `${(day.precip ?? 0).toFixed(2)} in`)}
        </dl>`;
    } else {
      $('d2-rec').innerHTML = '<div class="nodata">climate archive loading…</div>';
    }

    /* derived seasonal aggregates */
    const now = Date.now();
    const past = store.hours.filter((h) => h.t <= now && h.t >= now - 30 * 24 * 3600e3);
    let hdd = 0, cdd = 0, gdd = 0;
    for (const d of store.days) {
      if (d.tmax == null || d.tmin == null) continue;
      const mean = (d.tmax + d.tmin) / 2;
      if (d.t > now) continue;
      hdd += Math.max(0, 65 - mean);
      cdd += Math.max(0, mean - 65);
      gdd += Math.max(0, Math.min(mean, 86) - 50);
    }
    const spreadNow = store.models?.rows?.find((r) => r.t >= now);
    const confidence = spreadNow
      ? (spreadNow.spread < 2 ? ['HIGH', STATUS.good] : spreadNow.spread < 5 ? ['MODERATE', STATUS.warn]
        : spreadNow.spread < 9 ? ['LOW', STATUS.serious] : ['VERY LOW', STATUS.crit])
      : null;
    const day7 = store.models?.rows?.find((r) => r.t >= now + 7 * 24 * 3600e3);
    const totalPrecip = store.days.filter((d) => d.t > now).reduce((s, d) => s + (d.precip ?? 0), 0);
    const wetDays = store.days.filter((d) => d.t > now && (d.precip ?? 0) >= 0.01).length;

    $('d2-derived').innerHTML = `
      <dl style="margin:0">
        ${kv('Pressure now', `${F.pressure(store.frame()?.pressure)} inHg`)}
        ${kv('3h tendency', tendency())}
        ${confidence ? kvc('Forecast confidence', `${confidence[0]} · ±${(spreadNow.spread / 2).toFixed(1)}°`, confidence[1]) : ''}
        ${day7 ? kv('Day-7 model spread', `${day7.spread.toFixed(1)}°`) : ''}
        ${kv('16-day precip total', `${totalPrecip.toFixed(2)} in`)}
        ${kv('Wet days ahead', `${wetDays} of ${store.days.filter((d) => d.t > now).length}`)}
      </dl>
      <div class="lbl" style="margin:9px 0 3px">degree days, window shown</div>
      <dl style="margin:0">
        ${kv('Heating (base 65°F)', Math.round(hdd))}
        ${kv('Cooling (base 65°F)', Math.round(cdd))}
        ${kv('Growing (50/86°F)', Math.round(gdd))}
      </dl>
      <div style="font-size:max(.55rem,var(--fs-floor,0px));color:var(--faint);line-height:1.5;margin-top:7px">
        Degree days accumulate how far each day's mean sits from a base
        temperature — the standard proxy for heating load, cooling load and
        crop development.
      </div>`;

    climChart.render(); spreadChart.render(); trendChart.render(); meteoChart.render();
  }

  function tendency() {
    const t = store.cursor;
    const a = store.hours.find((h) => h.t >= t - 3 * 3600e3);
    const b = store.hours.find((h) => h.t >= t);
    if (!a?.pressure || !b?.pressure) return '—';
    const d = (b.pressure - a.pressure) * 0.029529983;
    const word = Math.abs(d) < 0.02 ? 'steady' : Math.abs(d) < 0.06 ? 'slow' : Math.abs(d) < 0.12 ? 'moderate' : 'rapid';
    return `${F.signed(d, 3)} inHg · ${d > 0 ? 'rising' : d < 0 ? 'falling' : ''} ${word}`.trim();
  }

  const kv = (k, v) => `<div class="kv"><dt>${k}</dt><dd>${v}</dd></div>`;
  const kvc = (k, v, c) => `<div class="kv"><dt>${k}</dt><dd style="color:${c}">${v}</dd></div>`;

  return {
    update,
    onShow() { climChart.render(); spreadChart.render(); trendChart.render(); meteoChart.render(); },
  };
}
