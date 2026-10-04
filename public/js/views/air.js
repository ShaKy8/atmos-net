/**
 * AIR — what you are actually breathing, and what the sun is doing to you.
 *
 * Pollen is regional: Open-Meteo's model is CAMS Europe and returns nulls
 * across the Americas, so the server falls back to pollen.com for US points.
 * The panel says which source it got, because "no data" and "zero pollen"
 * are very different claims.
 */

import { store } from '../state.js';
import { haloText,
  SERIES, STATUS, INK, DIM, FAINT, mount, gauge, spark, capBar, alpha, tag, mixHex,
  tooltip, fitLabel,
} from '../charts.js';
import {
  fmt as F, clamp, aqiCategory, uvCategory, pollenCategory, dewpointComfort, burnTime,
  escapeHtml as esc,
} from '../lib/util.js';

/* EPA / WHO reference concentrations, used to scale each pollutant bar. */
const POLLUTANTS = [
  { key: 'pm25', label: 'PM2.5', unit: 'µg/m³', ref: 35, who: 15, note: 'fine particulate — lungs and bloodstream' },
  { key: 'pm10', label: 'PM10', unit: 'µg/m³', ref: 150, who: 45, note: 'coarse dust and pollen fragments' },
  { key: 'o3', label: 'Ozone', unit: 'µg/m³', ref: 140, who: 100, note: 'photochemical smog, peaks mid-afternoon' },
  { key: 'no2', label: 'NO₂', unit: 'µg/m³', ref: 200, who: 25, note: 'traffic and combustion' },
  { key: 'so2', label: 'SO₂', unit: 'µg/m³', ref: 350, who: 40, note: 'industry and shipping' },
  { key: 'co', label: 'CO', unit: 'µg/m³', ref: 10000, who: 4000, note: 'incomplete combustion' },
];

const SKIN_TYPES = ['I very fair', 'II fair', 'III medium', 'IV olive', 'V brown', 'VI dark'];

export function createAir(root) {
  root.className = 'view airview';
  root.innerHTML = `
    <div class="panel aqi-panel">
      <div class="hd">AIR QUALITY<span class="rule"></span><span class="val" id="a-src">US EPA AQI</span></div>
      <div class="body aqi-body">
        <canvas id="a-gauge"></canvas>
        <div class="aqi-meta">
          <div class="aqi-cat" id="a-cat">—</div>
          <div class="aqi-note" id="a-note">—</div>
          <dl id="a-dl" style="margin:8px 0 0"></dl>
        </div>
      </div>
    </div>

    <div class="panel">
      <div class="hd" style="--ac:var(--mg)">POLLUTANTS<span class="rule"></span><span class="val">vs EPA / WHO limits</span></div>
      <div class="body" id="a-poll"></div>
    </div>

    <div class="panel">
      <div class="hd" style="--ac:var(--lm)">POLLEN<span class="rule"></span><span class="val" id="a-polsrc">—</span></div>
      <div class="body" id="a-pollen"></div>
    </div>

    <div class="panel">
      <div class="hd" style="--ac:var(--am)">ULTRAVIOLET<span class="rule"></span><span class="val" id="a-uvnow">—</span></div>
      <div class="body">
        <canvas id="a-uv" style="flex:1;min-height:64px;width:100%"></canvas>
        <div id="a-burn" style="margin-top:6px"></div>
      </div>
    </div>

    <div class="panel">
      <div class="hd" style="--ac:var(--ice)">COMFORT<span class="rule"></span><span class="val" id="a-cmf">—</span></div>
      <div class="body" id="a-comfort"></div>
    </div>

    <div class="panel bare">
      <canvas class="fill" id="a-fc"></canvas>
    </div>
  `;

  const $ = (id) => root.querySelector('#' + id);

  const aqiGauge = mount($('a-gauge'), (ctx, w, h) => {
    const f = store.frame();
    const aqi = f?.air?.aqi ?? store.airNow?.aqi;
    const cat = aqiCategory(aqi);
    const r = Math.min(w, h) / 2 - 22;
    gauge(ctx, w / 2, h / 2 - 4, Math.max(18, r), {
      value: aqi, min: 0, max: 300, color: cat.color, label: '', unit: 'US AQI',
      bands: [
        { from: 0, to: 50, color: STATUS.good }, { from: 50, to: 100, color: STATUS.warn },
        { from: 100, to: 150, color: STATUS.serious }, { from: 150, to: 200, color: STATUS.crit },
        { from: 200, to: 300, color: '#c89af5' },
      ],
      ticks: 6,
    });
  });

  const uvChart = mount($('a-uv'), (ctx, w, h, hover) => {
    const dayKey = store.fmt.isoDate(store.cursor);
    const rows = store.hours.filter((d) => store.fmt.isoDate(d.t) === dayKey);
    if (rows.length < 2) return;
    const pad = { l: 2, r: 24, t: 12, b: 14 };
    const box = { x: pad.l, y: pad.t, w: w - pad.l - pad.r, h: h - pad.t - pad.b };
    const yOf = (v) => box.y + box.h - (clamp(v, 0, 12) / 12) * box.h;

    // Reference bands, labelled so colour isn't the only cue.
    for (const [v, c, l] of [[3, STATUS.good, 'LOW'], [6, STATUS.warn, 'MOD'], [8, STATUS.serious, 'HIGH'], [11, STATUS.crit, 'V.HIGH']]) {
      ctx.save();
      ctx.strokeStyle = alpha(c, .3); ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(box.x, yOf(v)); ctx.lineTo(box.x + box.w, yOf(v)); ctx.stroke();
      ctx.setLineDash([]);
      ctx.font = "500 11.5px 'JetBrains Mono', monospace";
      ctx.fillStyle = alpha(c, .8); ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
      haloText(ctx, l, box.x + box.w - 2, yOf(v) - 1);
      ctx.restore();
    }

    const n = rows.length;
    const bw = Math.max(2, box.w / n - 1.5);
    rows.forEach((d, i) => {
      const v = d.uv ?? 0;
      if (v <= 0.03) return;
      const c = uvCategory(v).color;
      capBar(ctx, box.x + (i * box.w) / n, yOf(v), bw, box.y + box.h, alpha(c, .85));
    });

    // Clear-sky reference, showing how much cloud is buying you.
    const clear = rows.map((d) => [box.x + (rows.indexOf(d) * box.w) / n + bw / 2, yOf(d.uvClear ?? 0)]);
    ctx.save();
    ctx.setLineDash([3, 2]); ctx.strokeStyle = alpha(INK, .35); ctx.lineWidth = 1;
    ctx.beginPath();
    clear.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.stroke(); ctx.restore();

    ctx.save();
    ctx.font = "500 11.5px 'JetBrains Mono', monospace";
    ctx.fillStyle = FAINT; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    rows.forEach((d, i) => {
      const hod = store.fmt.hourOfDay(d.t);
      if (Math.round(hod) % 4 || Math.abs(hod - Math.round(hod)) > 0.02) return;
      fitLabel(ctx, store.fmt.hm(d.t),
        box.x + (i * box.w) / n + bw / 2, h - pad.b + 3, 0, w);
    });
    ctx.restore();
    tag(ctx, box.x + 2, 1, 'uv index today · dashed = clear sky');
  });

  const fcChart = mount($('a-fc'), (ctx, w, h, hover) => {
    const rows = store.air.filter((d) => d.t >= Date.now() - 6 * 3600e3 && d.t <= Date.now() + 96 * 3600e3);
    if (rows.length < 3) { noData(ctx, w, h, 'no air quality forecast'); return; }
    const pad = { l: 4, r: 30, t: 16, b: 18 };
    const box = { x: pad.l, y: pad.t, w: w - pad.l - pad.r, h: h - pad.t - pad.b };
    const maxA = Math.max(110, Math.max(...rows.map((d) => d.aqi ?? 0)) * 1.15);
    const xOf = (t) => box.x + ((t - rows[0].t) / (rows.at(-1).t - rows[0].t)) * box.w;
    const yOf = (v) => box.y + box.h - (clamp(v, 0, maxA) / maxA) * box.h;

    for (const [v, c, l] of [[50, STATUS.good, 'GOOD'], [100, STATUS.warn, 'MODERATE'], [150, STATUS.serious, 'SENSITIVE']]) {
      if (v > maxA) continue;
      ctx.save();
      ctx.strokeStyle = alpha(c, .28); ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.moveTo(box.x, yOf(v)); ctx.lineTo(box.x + box.w, yOf(v)); ctx.stroke();
      ctx.setLineDash([]);
      ctx.font = "500 11.5px 'JetBrains Mono', monospace";
      ctx.fillStyle = alpha(c, .85); ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
      haloText(ctx, l, box.x + box.w - 2, yOf(v) - 2);
      ctx.restore();
    }

    const n = rows.length;
    const bw = Math.max(1, box.w / n - 0.5);
    rows.forEach((d, i) => {
      if (d.aqi == null) return;
      capBar(ctx, box.x + (i * box.w) / n, yOf(d.aqi), bw, box.y + box.h,
        alpha(aqiCategory(d.aqi).color, .8), 2);
    });

    ctx.save();
    ctx.font = "500 11.5px 'JetBrains Mono', monospace";
    ctx.fillStyle = FAINT; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.strokeStyle = 'rgba(255,255,255,.07)';
    let last = '';
    rows.forEach((d, i) => {
      const k = store.fmt.isoDate(d.t);
      if (k === last) return; last = k;
      const x = box.x + (i * box.w) / n;
      ctx.beginPath(); ctx.moveTo(x, box.y); ctx.lineTo(x, box.y + box.h); ctx.stroke();
      if (x < box.x + box.w - 20) ctx.fillText(store.fmt.weekday(d.t).toUpperCase(), x + 16, h - pad.b + 4);
    });
    ctx.restore();

    const nowX = xOf(Date.now());
    if (nowX > box.x && nowX < box.x + box.w) {
      ctx.save();
      ctx.strokeStyle = alpha(STATUS.good, .85); ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(nowX, box.y); ctx.lineTo(nowX, box.y + box.h); ctx.stroke();
      ctx.restore();
    }
    tag(ctx, box.x + 2, 3, 'us aqi — next 4 days');

    if (hover && hover.x > box.x && hover.x < box.x + box.w) {
      const i = clamp(Math.round(((hover.x - box.x) / box.w) * (n - 1)), 0, n - 1);
      const d = rows[i];
      const c = aqiCategory(d.aqi);
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,.3)';
      ctx.beginPath(); ctx.moveTo(xOf(d.t), box.y); ctx.lineTo(xOf(d.t), box.y + box.h); ctx.stroke();
      ctx.restore();
      tooltip(ctx, xOf(d.t), hover.y, [
        `${store.fmt.weekday(d.t)} ${store.fmt.hm(d.t)}|`,
        `AQI|${Math.round(d.aqi ?? 0)}`,
        `CATEGORY|${c.name}`,
        `PM2.5|${d.pm25?.toFixed(1) ?? '--'}`,
        `OZONE|${d.o3?.toFixed(0) ?? '--'}`,
      ], w, h, c.color, { pin: hover.coarse });
    }
  });

  function noData(ctx, w, h, msg) {
    ctx.save();
    ctx.font = "600 11.5px 'Chakra Petch', sans-serif";
    ctx.fillStyle = FAINT; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.letterSpacing = '1.6px'; ctx.fillText(msg.toUpperCase(), w / 2, h / 2);
    ctx.restore();
  }

  /* ------------------------------------------------------------- render */

  function update() {
    const f = store.frame();
    if (!f) return;
    const a = f.air || store.airNow;
    const aqi = a?.aqi;
    const cat = aqiCategory(aqi);

    $('a-cat').textContent = cat.name;
    $('a-cat').style.color = cat.color;
    $('a-note').textContent = aqiAdvice(aqi);

    // Identify which pollutant is actually driving the index.
    let driver = null;
    if (a) {
      for (const p of POLLUTANTS) {
        const v = a[p.key];
        if (v == null) continue;
        const frac = v / p.ref;
        if (!driver || frac > driver.frac) driver = { ...p, value: v, frac };
      }
    }
    $('a-dl').innerHTML = `
      ${kv('Dominant', driver ? `${driver.label} ${driver.value.toFixed(1)} ${driver.unit}` : '—')}
      ${kv('PM2.5', a?.pm25 != null ? `${a.pm25.toFixed(1)} µg/m³` : '—')}
      ${kv('Ozone', a?.o3 != null ? `${a.o3.toFixed(0)} µg/m³` : '—')}
      ${kv('Aerosol depth', a?.aod != null ? a.aod.toFixed(3) : '—')}
      ${kv('Dust', a?.dust != null ? `${a.dust.toFixed(1)} µg/m³` : '—')}
    `;

    /* pollutant bars */
    $('a-poll').innerHTML = POLLUTANTS.map((p) => {
      const v = a?.[p.key];
      if (v == null) return '';
      const pct = clamp((v / p.ref) * 100, 0, 100);
      const overWho = v > p.who;
      const col = pct > 100 ? STATUS.crit : pct > 66 ? STATUS.serious : pct > 33 ? STATUS.warn : STATUS.good;
      return `
        <div style="margin-bottom:7px">
          <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px">
            <span class="lbl" style="color:var(--dim)">${p.label}</span>
            <span class="num" style="font-size:max(.72rem,var(--fs-floor,0px));color:${col}">${v.toFixed(v < 10 ? 1 : 0)}<span style="color:var(--faint);font-size:max(.85em,var(--fs-floor,0px))"> ${p.unit}</span></span>
          </div>
          <div class="meter" style="--ac:${col};margin:3px 0 2px;position:relative">
            <i style="width:${pct}%"></i>
            <span style="position:absolute;left:${clamp((p.who / p.ref) * 100, 0, 100)}%;top:-2px;bottom:-2px;width:1px;background:rgba(255,255,255,.5)"></span>
          </div>
          <div style="font-size:max(.52rem,var(--fs-floor,0px));color:var(--faint)">${p.note}${overWho ? ' · <b style="color:' + STATUS.serious + '">above WHO guideline</b>' : ''}</div>
        </div>`;
    }).join('') || '<div class="nodata">no pollutant data</div>';

    /* pollen */
    renderPollen();

    /* UV */
    const uv = f.uv;
    $('a-uvnow').textContent = uv != null ? `${uv.toFixed(1)} · ${uvCategory(uv).name}` : '—';
    const peak = f.day?.uvMax;
    $('a-burn').innerHTML = uv > 0 || peak > 0 ? `
      <div class="lbl" style="margin-bottom:4px">time to burn at today's peak (UV ${(peak ?? uv).toFixed(1)})</div>
      <div class="burngrid">
        ${SKIN_TYPES.map((n, i) => {
          const m = burnTime(peak ?? uv, i + 1);
          const c = m == null ? DIM : m < 15 ? STATUS.crit : m < 30 ? STATUS.serious : m < 60 ? STATUS.warn : STATUS.good;
          return `<div><span class="lbl">${n}</span><b style="color:${c}">${m == null ? '—' : m + 'm'}</b></div>`;
        }).join('')}
      </div>` : '<div class="nodata">no uv exposure right now</div>';

    /* comfort */
    const cmf = dewpointComfort(f.dew);
    $('a-cmf').textContent = cmf.name;
    const hi = f.feels, spreadV = hi != null && f.temp != null ? hi - f.temp : null;
    $('a-comfort').innerHTML = `
      <div style="display:flex;align-items:baseline;gap:9px;margin-bottom:6px">
        <span class="num" style="font-size:1.7rem;font-weight:700;color:${cmf.color}">${F.temp(f.dew)}</span>
        <span class="lbl">dew point</span>
      </div>
      <div class="dewstrip">
        ${(() => {
          const bands = [[-99, 30, 'VERY DRY'], [30, 45, 'DRY'], [45, 55, 'COMFORTABLE'],
            [55, 60, 'STICKY'], [60, 65, 'HUMID'], [65, 70, 'OPPRESSIVE'], [70, 99, 'MISERABLE']];
          return bands.map(([lo2, hi2, l]) => {
            const on = f.dew != null && f.dew >= lo2 && f.dew < hi2;
            return `<i class="${on ? 'on' : ''}" style="--c:${dewpointComfort((lo2 + hi2) / 2).color}" title="${l}"></i>`;
          }).join('');
        })()}
      </div>
      <div style="display:flex;justify-content:space-between;font-size:max(.46rem,var(--fs-floor,0px));color:var(--faint);letter-spacing:.08em;margin-top:2px">
        <span>DRY</span><span>COMFORTABLE</span><span>OPPRESSIVE</span>
      </div>
      <div style="font-size:max(.62rem,var(--fs-floor,0px));color:var(--dim);margin:6px 0 8px">${cmf.note}</div>
      <dl style="margin:0">
        ${kv('Air temperature', F.temp(f.temp))}
        ${kv('Feels like', `${F.temp(f.feels)}${spreadV != null && Math.abs(spreadV) >= 1 ? ` (${F.signed(spreadV, 0)}°)` : ''}`)}
        ${kv('Relative humidity', F.pct(f.rh))}
        ${kv('Wet bulb', F.temp(f.wetbulb))}
        ${kv('Vapour deficit', f.vpd != null ? `${f.vpd.toFixed(2)} kPa` : '—')}
      </dl>
      <div style="font-size:max(.56rem,var(--fs-floor,0px));color:var(--faint);line-height:1.5;margin-top:7px">
        Dew point predicts how the air feels far better than relative humidity,
        which only tells you how close the air is to saturation at its own temperature.
      </div>`;

    aqiGauge.render(); uvChart.render(); fcChart.render();
  }

  function renderPollen() {
    const p = store.pollen;
    const tf = store.fmt;
    if (!p || p.source === 'none') {
      // Fall back to Open-Meteo's European pollen model if it has values.
      const a = store.frame()?.air;
      const eu = a && ['grass', 'birch', 'alder', 'ragweed', 'olive', 'mugwort']
        .map((k) => [k, a[k]]).filter(([, v]) => v != null);
      if (eu?.length) {
        $('a-polsrc').textContent = 'CAMS EUROPE';
        $('a-pollen').innerHTML = eu.map(([k, v]) => `
          <div class="kv"><dt>${k}</dt><dd>${v.toFixed(1)} grains/m³</dd></div>`).join('');
        return;
      }
      $('a-polsrc').textContent = 'NO COVERAGE';
      $('a-pollen').innerHTML = `<div class="nodata">
        pollen data unavailable here<br><span style="color:var(--faint);text-transform:none;letter-spacing:0">
        ${esc(p?.reason || 'no source covers this location')}</span></div>`;
      return;
    }

    const cat = pollenCategory(p.index);
    const trend = p.yesterday != null && p.index != null ? p.index - p.yesterday : null;
    $('a-polsrc').textContent = p.source.toUpperCase();
    $('a-pollen').innerHTML = `
      <div style="display:flex;align-items:baseline;gap:9px">
        <span class="num" style="font-size:1.9rem;font-weight:700;color:${cat.color}">${p.index?.toFixed(1) ?? '--'}</span>
        <div>
          <div class="chip" style="--ac:${cat.color}">${cat.name}</div>
          <div style="font-size:max(.54rem,var(--fs-floor,0px));color:var(--faint);margin-top:2px">of 12${trend != null ? ` · ${F.signed(trend, 1)} vs yesterday` : ''}</div>
        </div>
      </div>
      <div class="meter" style="--ac:${cat.color};margin:7px 0 9px"><i style="width:${clamp((p.index / 12) * 100, 0, 100)}%"></i></div>
      ${p.triggers?.length ? `
        <div class="lbl" style="margin-bottom:4px">today's triggers</div>
        <div style="display:flex;gap:5px;flex-wrap:wrap;margin-bottom:9px">
          ${p.triggers.map((t) => `<span class="chip" style="--ac:var(--lm)">${esc(t.name)}</span>`).join('')}
        </div>` : ''}
      ${p.forecast?.length ? `
        <div class="lbl" style="margin-bottom:4px">5-day outlook</div>
        <div class="pollen-fc">
          ${p.forecast.map((d) => {
            const c = pollenCategory(d.index);
            return `<div>
              <span class="bar" style="height:${clamp((d.index / 12) * 100, 4, 100)}%;--c:${c.color}"></span>
              <b>${d.index.toFixed(1)}</b>
              <span>${tf.weekday(Date.parse(d.date))}</span>
            </div>`;
          }).join('')}
        </div>` : ''}`;
  }

  function aqiAdvice(aqi) {
    if (aqi == null) return 'no measurement available';
    if (aqi <= 50) return 'Air quality is satisfactory. No restrictions.';
    if (aqi <= 100) return 'Acceptable. Unusually sensitive people may want to limit long outdoor exertion.';
    if (aqi <= 150) return 'Sensitive groups — asthma, heart or lung conditions, children, older adults — should reduce prolonged exertion.';
    if (aqi <= 200) return 'Everyone may begin to feel effects. Limit prolonged outdoor exertion.';
    if (aqi <= 300) return 'Health alert. Avoid outdoor exertion; keep windows closed.';
    return 'Emergency conditions. Remain indoors with filtration if possible.';
  }

  const kv = (k, v) => `<div class="kv"><dt>${k}</dt><dd>${v}</dd></div>`;

  return { update, onShow() { aqiGauge.render(); uvChart.render(); fcChart.render(); } };
}
