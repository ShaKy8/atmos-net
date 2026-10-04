/**
 * SKY — where the sun, the moon and the space weather are.
 *
 * The dome is a real polar projection of the visible hemisphere: horizon at
 * the rim, zenith at the centre, north up. The tracks are computed by
 * sampling the ephemeris every ten minutes across the cursor's local day, so
 * scrubbing time walks the sun along its actual arc.
 */

import { store } from '../state.js';
import { api } from '../api.js';
import {
  SERIES, STATUS, INK, DIM, FAINT, mount, skyDome, moonDisc, spark,
  alpha, capBar, tag, gauge, fitLabel,
} from '../charts.js';
import { kpChart } from '../plots.js';
import { neonLine } from '../charts.js';
import {
  fmt as F, compass, dur, clamp, kpCategory, relTime, escapeHtml as esc } from '../lib/util.js';
import {
  sunPosition, moonPosition, moonIllumination, moonPhaseName, toCompass, toDeg, topocentric,
  sunTimes,
} from '../lib/astro.js';
import { assessNights, verdict, bestOther, NIGHTS } from '../lib/tonight.js';
import { scoreHour } from '../activity.js';

export function createSkyView(root) {
  root.className = 'view skyview';
  root.innerHTML = `
    <div class="panel bare dome-panel">
      <canvas class="fill" id="s-dome"></canvas>
      <div class="dome-cap"><span class="lbl">CELESTIAL DOME</span><span class="lbl" id="s-domewhen">—</span></div>
    </div>

    <div class="panel moon-panel" style="--ac:var(--ice)">
      <div class="hd">MOON<span class="rule"></span><span class="val" id="s-mphase">—</span></div>
      <div class="body moon-body">
        <canvas id="s-moon"></canvas>
        <dl id="s-moondl" style="margin:0;flex:1"></dl>
      </div>
      <canvas id="s-moonalt" style="flex:1;min-height:58px;width:100%;margin-top:6px"></canvas>
    </div>

    <div class="panel sun-panel" style="--ac:var(--am)">
      <div class="hd">SOLAR DAY<span class="rule"></span><span class="val" id="s-daylen">—</span></div>
      <div class="body">
        <canvas id="s-daybar" style="height:52px;flex:0 0 52px;width:100%"></canvas>
        <dl id="s-sundl" style="margin:6px 0 0"></dl>
      </div>
    </div>

    <div class="panel" style="--ac:var(--vi)">
      <div class="hd">GEOMAGNETIC<span class="rule"></span><span class="val" id="s-kpnow">—</span></div>
      <div class="body">
        <canvas id="s-kp" style="flex:1;min-height:70px;width:100%"></canvas>
        <dl id="s-spacedl" style="margin:6px 0 0"></dl>
      </div>
    </div>

    <div class="panel" style="--ac:var(--lm)">
      <div class="hd">OBSERVING CONDITIONS<span class="rule"></span><span class="val" id="s-seenow">—</span></div>
      <div class="body" id="s-seeing"></div>
      <div class="tn" id="s-tonight"></div>
    </div>
  `;

  const $ = (id) => root.querySelector('#' + id);
  let iss = null;

  /* ------------------------------------------------------------- tracks */

  /** Sample the sun and moon every 10 minutes across the cursor's local day. */
  function tracks() {
    const { lat, lon } = store.loc || { lat: 0, lon: 0 };
    const dayKey = store.fmt.isoDate(store.cursor);
    // Find local midnight by walking back from the cursor.
    let t0 = store.cursor;
    while (store.fmt.isoDate(t0 - 60e3) === dayKey) t0 -= 60e3;
    const sun = [], moon = [];
    for (let m = 0; m <= 24 * 60; m += 10) {
      const d = new Date(t0 + m * 60e3);
      const sp = sunPosition(d, lat, lon);
      const mp = moonPosition(d, lat, lon);
      sun.push({ az: toCompass(sp.azimuth), alt: toDeg(sp.altitude), t: +d });
      moon.push({ az: toCompass(mp.azimuth), alt: toDeg(mp.altitude), t: +d });
    }
    return { sun, moon, t0 };
  }

  const domeChart = mount($('s-dome'), (ctx, w, h, hover) => {
    const f = store.frame();
    if (!f) return;
    const { sun, moon } = tracks();
    const r = Math.min(w, h) / 2 - 26;
    const cx = w / 2, cy = h / 2;
    skyDome(ctx, cx, cy, r, {
      sunTrack: sun, moonTrack: moon,
      sun: { az: f.sun.compass, alt: f.sun.altDeg },
      moon: { az: f.moon.compass, alt: f.moon.altDeg },
      iss: iss && iss.alt > 0 ? iss : null,
      night: f.sun.altDeg < -6 ? 1 : 0,
    });

    // Readouts around the rim.
    ctx.save();
    ctx.font = "500 12px 'JetBrains Mono', monospace";
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    const rows = [
      ['SUN', `${f.sun.altDeg.toFixed(1)}°  ${compass(f.sun.compass)}`, '#f2b45a'],
      ['MOON', `${f.moon.altDeg.toFixed(1)}°  ${compass(f.moon.compass)}`, '#7fb2f0'],
    ];
    if (iss) rows.push(['ISS', `${iss.alt > 0 ? `${iss.alt.toFixed(0)}° ${compass(iss.az)}` : 'below horizon'}`, '#8fdc6a']);
    rows.forEach(([k, v, c], i) => {
      ctx.fillStyle = c; ctx.fillText(k, 10, 10 + i * 15);
      ctx.fillStyle = INK; ctx.fillText(v, 52, 10 + i * 15);
    });
    ctx.restore();
  });

  const moonChart = mount($('s-moon'), (ctx, w, h) => {
    const f = store.frame();
    if (!f) return;
    const r = Math.min(w, h) / 2 - 4;
    moonDisc(ctx, w / 2, h / 2, Math.max(10, r), f.moon.phase, f.moon.fraction);
  });

  /** Moon and sun altitude across the cursor's day, sharing one axis. */
  const moonAlt = mount($('s-moonalt'), (ctx, w, h) => {
    const { sun, moon } = tracks();
    const pad = { l: 2, r: 22, t: 12, b: 12 };
    const box = { x: pad.l, y: pad.t, w: w - pad.l - pad.r, h: h - pad.t - pad.b };
    if (box.w < 30 || box.h < 20) return;
    const yOf = (a) => box.y + box.h - ((clamp(a, -60, 90) + 60) / 150) * box.h;
    const xOf = (i) => box.x + (i / (moon.length - 1)) * box.w;

    // Horizon line: the only value that matters on this chart.
    ctx.save();
    ctx.strokeStyle = 'rgba(63,208,216,.30)'; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(box.x, yOf(0)); ctx.lineTo(box.x + box.w, yOf(0)); ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = "500 11.5px 'JetBrains Mono', monospace";
    ctx.fillStyle = FAINT; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    ctx.fillText('0°', box.x + box.w + 18, yOf(0));
    ctx.restore();

    neonLine(ctx, sun.map((p, i) => [xOf(i), yOf(p.alt)]), '#f2b45a', { width: 1.4, glow: 6 });
    ctx.save();
    ctx.setLineDash([3, 3]);
    neonLine(ctx, moon.map((p, i) => [xOf(i), yOf(p.alt)]), '#7fb2f0', { width: 1.6, glow: 7 });
    ctx.restore();

    // Cursor
    const ci = clamp(Math.round(((store.cursor - moon[0].t) / (moon.at(-1).t - moon[0].t)) * (moon.length - 1)), 0, moon.length - 1);
    ctx.save();
    ctx.strokeStyle = SERIES[1]; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(xOf(ci), box.y); ctx.lineTo(xOf(ci), box.y + box.h); ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.font = "500 11.5px 'JetBrains Mono', monospace";
    ctx.fillStyle = FAINT; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (let hh = 0; hh <= 24; hh += 6) {
      if (hh === 24) continue;
      fitLabel(ctx, String(hh).padStart(2, '0'),
        xOf((hh / 24) * (moon.length - 1)), h - pad.b + 1, 0, w);
    }
    ctx.restore();
    tag(ctx, box.x + 2, 1, 'altitude — sun solid, moon dashed');
  });

  /** Horizontal bar of the solar day: night, twilight bands, daylight. */
  const dayBar = mount($('s-daybar'), (ctx, w, h) => {
    const st = store.sunTimesFor();
    const dayKey = store.fmt.isoDate(store.cursor);
    let t0 = store.cursor;
    while (store.fmt.isoDate(t0 - 60e3) === dayKey) t0 -= 60e3;
    const t1 = t0 + 24 * 3600e3;
    const xOf = (t) => ((t - t0) / (t1 - t0)) * w;
    const barY = 8, barH = 16;

    const seg = (a, b, color) => {
      if (a == null || b == null || isNaN(+a) || isNaN(+b)) return;
      const x0 = clamp(xOf(+a), 0, w), x1 = clamp(xOf(+b), 0, w);
      if (x1 <= x0) return;
      ctx.fillStyle = color;
      ctx.fillRect(x0, barY, x1 - x0, barH);
    };

    ctx.fillStyle = '#0f1826';
    ctx.fillRect(0, barY, w, barH);
    seg(st.nightEnd, st.nauticalDawn, 'rgba(30,20,70,.9)');
    seg(st.nauticalDawn, st.dawn, 'rgba(40,40,120,.9)');
    seg(st.dawn, st.sunrise, 'rgba(90,60,150,.9)');
    seg(st.sunrise, st.goldenHourEnd, 'rgba(245,154,91,.85)');
    seg(st.goldenHourEnd, st.goldenHour, 'rgba(90,180,235,.75)');
    seg(st.goldenHour, st.sunset, 'rgba(245,154,91,.85)');
    seg(st.sunset, st.dusk, 'rgba(150,70,140,.9)');
    seg(st.dusk, st.nauticalDusk, 'rgba(60,45,130,.9)');
    seg(st.nauticalDusk, st.night, 'rgba(30,20,70,.9)');

    // Hour ticks
    ctx.save();
    ctx.font = "500 11.5px 'JetBrains Mono', monospace";
    ctx.fillStyle = FAINT; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.strokeStyle = 'rgba(255,255,255,.10)';
    for (let hh = 0; hh <= 24; hh += 3) {
      const x = (hh / 24) * w;
      ctx.beginPath(); ctx.moveTo(x, barY + barH); ctx.lineTo(x, barY + barH + 3); ctx.stroke();
      if (hh % 6 === 0 && hh < 24) fitLabel(ctx, String(hh).padStart(2, '0'), x, barY + barH + 5, 0, w);
    }
    ctx.restore();

    // Named moments
    const label = (t, txt, color) => {
      if (t == null || isNaN(+t)) return;
      const x = clamp(xOf(+t), 6, w - 6);
      ctx.save();
      ctx.strokeStyle = color; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, barY - 4); ctx.lineTo(x, barY + barH); ctx.stroke();
      ctx.font = "600 11.5px 'Chakra Petch', sans-serif";
      ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.fillText(txt, x, barY - 5);
      ctx.restore();
    };
    label(st.sunrise, '↑', '#f2b45a');
    label(st.sunset, '↓', '#f2b45a');

    // Cursor
    const cx = clamp(xOf(store.cursor), 0, w);
    ctx.save();
    ctx.strokeStyle = SERIES[1]; ctx.lineWidth = 1.5;
    ctx.shadowColor = SERIES[1]; ctx.shadowBlur = 4;
    ctx.beginPath(); ctx.moveTo(cx, barY - 6); ctx.lineTo(cx, barY + barH + 2); ctx.stroke();
    ctx.restore();
  });

  const kpC = mount($('s-kp'), (ctx, w, h, hover) => {
    const rows = store.kpForecast();
    if (!rows.length) { noData(ctx, w, h, 'no space weather data'); return; }
    kpChart(ctx, w, h, hover, { rows, tf: store.fmt, now: Date.now() });
  });

  function noData(ctx, w, h, msg) {
    ctx.save();
    ctx.font = "600 11.5px 'Chakra Petch', sans-serif";
    ctx.fillStyle = FAINT; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.letterSpacing = '1.6px';
    ctx.fillText(msg.toUpperCase(), w / 2, h / 2);
    ctx.restore();
  }

  /* --------------------------------------------------------- lunar dates */

  /** Next instant the moon reaches the given phase, searching forward. */
  function nextPhase(target, from = Date.now()) {
    let t = from;
    const step = 6 * 3600e3;
    let prev = moonIllumination(new Date(t)).phase;
    for (let i = 0; i < 240; i++) {
      t += step;
      const p = moonIllumination(new Date(t)).phase;
      // Detect crossing, allowing for the wrap at 1 -> 0.
      const crossed = prev <= target && p >= target
        || (prev > p && (prev <= target || p >= target));
      if (crossed) {
        // Refine by bisection.
        let lo = t - step, hi = t;
        for (let j = 0; j < 28; j++) {
          const mid = (lo + hi) / 2;
          const pm = moonIllumination(new Date(mid)).phase;
          const before = pm < target || (pm > 0.9 && target < 0.1);
          if (before) lo = mid; else hi = mid;
        }
        return (lo + hi) / 2;
      }
      prev = p;
    }
    return null;
  }

  /* ------------------------------------------------------------- render */

  function update() {
    const f = store.frame();
    if (!f) return;
    const tf = store.fmt;

    $('s-domewhen').textContent = store.atNow ? 'LIVE' : `${tf.weekday(store.cursor)} ${tf.hm(store.cursor)}`;

    /* moon */
    const mt = store.moonTimesFor();
    $('s-mphase').textContent = moonPhaseName(f.moon.phase).toUpperCase();
    const full = nextPhase(0.5), nw = nextPhase(0.0);
    $('s-moondl').innerHTML = `
      ${kv('Illumination', `${(f.moon.fraction * 100).toFixed(1)}%`)}
      ${kv('Altitude', `${f.moon.altDeg.toFixed(1)}° ${compass(f.moon.compass)}`)}
      ${kv('Distance', `${Math.round(f.moon.distance).toLocaleString()} km`)}
      ${kv('Moonrise', mt.rise ? tf.hm(mt.rise) : mt.alwaysUp ? 'always up' : '—')}
      ${kv('Moonset', mt.set ? tf.hm(mt.set) : mt.alwaysDown ? 'never up' : '—')}
      ${kv('Next full', full ? `${tf.monthDay(full)} ${tf.hm(full)}` : '—')}
      ${kv('Next new', nw ? `${tf.monthDay(nw)} ${tf.hm(nw)}` : '—')}
    `;

    /* sun */
    const st = store.sunTimesFor();
    const day = f.day;
    $('s-daylen').textContent = day?.daylight ? dur(day.daylight) : '—';

    // Day-length change: compare with the previous day in the daily series.
    let deltaTxt = '—';
    const di = store.days.findIndex((d) => tf.isoDate(d.t) === tf.isoDate(store.cursor));
    if (di > 0 && store.days[di].daylight && store.days[di - 1].daylight) {
      const d = store.days[di].daylight - store.days[di - 1].daylight;
      const m = Math.abs(d) / 60;
      deltaTxt = `${d >= 0 ? '+' : '−'}${Math.floor(m)}m ${Math.round((m % 1) * 60)}s vs yesterday`;
    }

    $('s-sundl').innerHTML = `
      ${kv('First light', tf.hm(st.dawn))}
      ${kv('Sunrise', tf.hm(st.sunrise))}
      ${kv('Golden hour ends', tf.hm(st.goldenHourEnd))}
      ${kv('Solar noon', `${tf.hm(st.solarNoon)} · ${maxAlt().toFixed(1)}°`)}
      ${kv('Golden hour', tf.hm(st.goldenHour))}
      ${kv('Sunset', tf.hm(st.sunset))}
      ${kv('Civil dusk', tf.hm(st.dusk))}
      ${kv('Astronomical dark', isNaN(+st.night) ? 'none tonight' : tf.hm(st.night))}
      ${kv('Day length', deltaTxt)}
    `;

    /* space weather */
    const kp = store.currentKp();
    const cat = kpCategory(kp);
    $('s-kpnow').textContent = kp != null ? `Kp ${kp.toFixed(2)} · ${cat.name}` : 'NO DATA';
    const sw = store.space;
    const speed = sw?.wind?.ok ? sw.wind.data?.[0]?.proton_speed : null;
    const bt = sw?.mag?.ok ? sw.mag.data?.[0]?.bt : null;
    const bz = sw?.mag?.ok ? sw.mag.data?.[0]?.bz_gsm : null;
    const scales = sw?.scales?.ok ? sw.scales.data?.['0'] : null;
    $('s-spacedl').innerHTML = `
      ${kv('Solar wind', speed != null ? `${speed} km/s` : '—')}
      ${kv('IMF Bt / Bz', bt != null ? `${bt} / ${bz} nT` : '—')}
      ${kv('Aurora visible to', cat.lat != null ? `${cat.lat}° latitude` : '—')}
      ${kv('Your latitude', `${Math.abs(store.loc.lat).toFixed(1)}° ${store.loc.lat >= 0 ? 'N' : 'S'}`)}
      ${kv('Radio / Solar / Geo', scales ? `R${scales.R?.Scale ?? 0} S${scales.S?.Scale ?? 0} G${scales.G?.Scale ?? 0}` : '—')}
    `;

    /* observing conditions */
    const air = f.air;
    const s = scoreHour('stargaze', { ...f, air }, {
      sunAltDeg: f.sun.altDeg, moonFraction: f.moon.fraction, moonUp: f.moon.altDeg > 0,
    });
    const score = s?.score ?? 0;
    const col = score >= 75 ? STATUS.good : score >= 50 ? STATUS.warn : score >= 30 ? STATUS.serious : STATUS.crit;
    $('s-seenow').textContent = `${score}/100`;

    // Find tonight's best hour for observing.
    const tonight = store.hours.filter((h) => h.t > Date.now() && h.t < Date.now() + 30 * 3600e3);
    let best = null;
    for (const h of tonight) {
      const fr = store.frame(h.t);
      if (!fr || fr.sun.altDeg > -12) continue;
      const sc = scoreHour('stargaze', fr, {
        sunAltDeg: fr.sun.altDeg, moonFraction: fr.moon.fraction, moonUp: fr.moon.altDeg > 0,
      });
      if (!best || sc.score > best.score) best = { t: h.t, score: sc.score, limiter: sc.limiter };
    }

    $('s-seeing').innerHTML = `
      <div style="display:flex;align-items:baseline;gap:9px;margin-bottom:5px">
        <span class="num" style="font-size:1.9rem;font-weight:700;color:${col}">${score}</span>
        <span class="lbl">stargazing now</span>
      </div>
      <div class="meter" style="--ac:${col};margin-bottom:9px"><i style="width:${score}%"></i></div>
      ${(s?.parts || []).map((p) => `
        <div class="kv">
          <dt>${p.name}</dt>
          <dd style="display:flex;align-items:center;gap:6px">
            <span class="meter" style="width:52px;--ac:${p.value > .7 ? STATUS.good : p.value > .4 ? STATUS.warn : STATUS.crit}">
              <i style="width:${p.value * 100}%"></i></span>
            ${Math.round(p.value * 100)}
          </dd>
        </div>`).join('')}
      <div style="margin-top:8px;font-size:max(.66rem,var(--fs-floor,0px));color:var(--dim);line-height:1.5">
        ${best
          ? `Best hour right now: <b style="color:${INK}">${tf.weekday(best.t)} ${tf.hm(best.t)}</b> at ${best.score}/100${best.limiter ? `, held back by ${best.limiter}` : ''}.`
          : 'No astronomical darkness in the next 30 hours.'}
      </div>`;

    renderTonight();
    domeChart.render(); moonChart.render(); moonAlt.render(); dayBar.render(); kpC.render();
  }

  /*
   * TONIGHT: the planning layer under the "right now" score above it.
   *
   * The panel already answers how good the sky is this second and which
   * single hour in the next thirty is best. This answers the different
   * question you actually act on — which of the next seven nights is worth
   * going outside for, and for how long.
   *
   * The viewer is standing at store.loc, so the day is anchored in their own
   * timezone and no offset is passed. ELSEWHERE will need one.
   */
  function renderTonight() {
    const el = $('s-tonight');
    if (!store.loc || !store.hours?.length) { el.innerHTML = ''; return; }
    const tf = store.fmt;
    const nights = assessNights(store.hours, store.loc.lat, store.loc.lon, Date.now(), {
      sunTimes, moonPosition, moonIllumination, toDeg,
    });
    const pick = bestOther(nights);
    /*
     * Height is the number printed above it -- hours of clear moonless dark --
     * not the score. Scoring the bars made every good night full height, so a
     * week of clear weather drew seven identical blocks and the strip said
     * nothing. Colour carries the score instead.
     */
    const topH = Math.max(4, ...nights.map((n) => n.goodHours));

    const bar = (n) => {
      const on = pick && n.index === pick.index && n.score > nights[0].score;
      const c = n.score >= 75 ? STATUS.good : n.score >= 45 ? STATUS.warn : STATUS.crit;
      return `
        <div class="tn-n${on ? ' pick' : ''}${n.index === 0 ? ' now' : ''}"
             title="${n.goodHours} clear moonless hours of ${n.dark ? n.dark.hours.toFixed(1) : 0} dark">
          <span class="tn-h">${n.dark ? `${n.goodHours}h` : '—'}</span>
          <span class="tn-bar"><i style="height:${Math.round((n.goodHours / topH) * 100)}%;background:${c}"></i></span>
          <span class="tn-d">${tf.weekday(n.day).slice(0, 3).toUpperCase()}</span>
        </div>`;
    };

    el.innerHTML = `
      <p class="tn-verdict">${esc(verdict(nights, tf))}</p>
      <div class="tn-week">${nights.map(bar).join('')}</div>
      <p class="tn-key">clear, moonless hours per night · next ${NIGHTS}</p>`;
  }

  function maxAlt() {
    const { lat, lon } = store.loc || { lat: 0, lon: 0 };
    const st = store.sunTimesFor();
    if (!st.solarNoon || isNaN(+st.solarNoon)) return 0;
    return toDeg(sunPosition(st.solarNoon, lat, lon).altitude);
  }

  const kv = (k, v) => `<div class="kv"><dt>${k}</dt><dd>${v}</dd></div>`;

  /* ISS: refreshed only while this view is visible. */
  async function pollISS() {
    if (store.view !== 'sky') return;
    try {
      const r = await api.iss();
      if (r.pos?.ok) {
        const p = r.pos.data;
        const o = store.loc || { lat: 0, lon: 0 };
        iss = {
          ...topocentric(o.lat, o.lon, p.latitude, p.longitude, p.altitude),
          lat: p.latitude, lon: p.longitude, visibility: p.visibility,
        };
        domeChart.render();
      }
    } catch { /* leave the previous fix in place */ }
  }

  setInterval(pollISS, 8000);

  return {
    update,
    onShow() { pollISS(); domeChart.render(); moonChart.render(); moonAlt.render(); dayBar.render(); kpC.render(); },
  };
}
