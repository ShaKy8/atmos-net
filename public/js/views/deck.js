/**
 * DECK — the home view.
 *
 * Everything here reads from store.frame(store.cursor), so dragging the time
 * scrubber rewrites the whole panel: the hero number, every gauge, the
 * activity windows and the ten-day strip all move together.
 */

import { store } from '../state.js';
import { meteogram } from '../plots.js';
import {
  SERIES, STATUS, INK, DIM, FAINT, mount, gauge, windRose, spark, bars,
  alpha, tempColor, capBar, tag, mixHex, moonDisc, fitLabel,
} from '../charts.js';
import {
  fmt as F, wx, wxGlyph, compass, dur, clamp, aqiCategory, uvCategory,
  dewpointComfort, windDescription, pollenCategory, alertColor, relTime, burnTime,
  escapeHtml as esc,
} from '../lib/util.js';
import { ACTIVITY_KEYS, activityMeta, bestWindows, greatHours, precipNowcast, nowcastPhrase } from '../activity.js';
import { createElsewhere } from '../elsewhere.js';

export function createDeck(root) {
  root.className = 'view deck active';
  root.innerHTML = `
    <div class="panel hero">
      <div class="hd">CURRENT<span class="rule"></span><span class="val" id="d-obs">—</span></div>
      <div class="body">
        <div class="hero-top">
          <div>
            <div class="hero-temp chroma num" id="d-temp">--<sup>°F</sup></div>
            <div class="hero-cond neon" id="d-cond">—</div>
            <div class="hero-feels">feels like <b id="d-feels">--</b> · dew point <b id="d-dew">--</b></div>
            <div class="hero-obs" id="d-obsline"></div>
          </div>
          <div class="hero-glyph" id="d-glyph">◌</div>
        </div>
        <div class="hero-range">
          <div class="stat"><div class="c">today high</div><div class="v" id="d-hi">--</div></div>
          <div class="stat"><div class="c">today low</div><div class="v" id="d-lo">--</div></div>
          <div class="stat"><div class="c">vs normal</div><div class="v" id="d-anom">--</div></div>
        </div>
        <div class="hero-spark"><canvas class="chart" id="d-spark"></canvas></div>
        <div class="hero-sun">
          <div class="stat"><div class="c">sunrise</div><div class="v" id="d-sunrise" style="font-size:.95rem">--</div></div>
          <div class="stat"><div class="c">sunset</div><div class="v" id="d-sunset" style="font-size:.95rem">--</div></div>
          <div class="stat"><div class="c">daylight</div><div class="v" id="d-daylight" style="font-size:.95rem">--</div></div>
        </div>
      </div>
    </div>

    <div class="panel meteo bare">
      <canvas class="chart fill" id="d-meteo"></canvas>
    </div>

    <div class="side">
      <div class="panel" id="d-alertPanel" style="--ac:var(--rd); display:none">
        <div class="hd">ACTIVE ALERTS<span class="rule"></span><span class="val" id="d-alertN">0</span></div>
        <div class="body" id="d-alerts"></div>
      </div>

      <div class="panel">
        <div class="hd" style="--ac:var(--ice)">NOWCAST<span class="rule"></span><span class="val" id="d-ncres">—</span></div>
        <div class="body nowcast">
          <div class="nowcast-line" id="d-ncline">—</div>
          <div class="nowcast-bars"><canvas class="chart" id="d-nc"></canvas></div>
          <div class="nowcast-scale"><span>NOW</span><span>+2h</span><span>+4h</span><span>+6h</span></div>
        </div>
      </div>

      <!--
        Above SUN & MOON deliberately. The column scrolls, and at 900px only
        three panels are above the fold — sun and moon are also the whole top
        half of the SKY view, while this is the only place ELSEWHERE appears.
      -->
      <div id="d-elsewhere"></div>

      <div class="panel grow">
        <div class="hd" style="--ac:var(--vi)">SUN &amp; MOON<span class="rule"></span><span class="val" id="d-moonname">—</span></div>
        <div class="body sunmoon-body"><canvas id="d-moondisc"></canvas><div id="d-sunmoon" style="flex:1;min-width:0"></div></div>
      </div>
    </div>

    <div class="panel gauge">
      <div class="hd">INSTRUMENTS<span class="rule"></span><span class="val" id="d-instnote">—</span></div>
      <div class="body">
        <div class="gauge-cell"><canvas class="chart" id="g-wind"></canvas><div class="gauge-note" id="n-wind"></div></div>
        <div class="gauge-cell"><canvas class="chart" id="g-hum"></canvas><div class="gauge-note" id="n-hum"></div></div>
        <div class="gauge-cell"><canvas class="chart" id="g-pres"></canvas><div class="gauge-note" id="n-pres"></div></div>
        <div class="gauge-cell"><canvas class="chart" id="g-uv"></canvas><div class="gauge-note" id="n-uv"></div></div>
        <div class="gauge-cell"><canvas class="chart" id="g-aqi"></canvas><div class="gauge-note" id="n-aqi"></div></div>
        <div class="gauge-cell"><canvas class="chart" id="g-vis"></canvas><div class="gauge-note" id="n-vis"></div></div>
      </div>
    </div>

    <div class="panel act">
      <div class="hd" style="--ac:var(--lm)">ACTIVITY WINDOWS<span class="rule"></span><span class="val">NEXT 36H</span></div>
      <div class="body" id="d-act"></div>
    </div>

    <div class="panel tenday">
      <div class="hd" style="--ac:var(--am)">16-DAY OUTLOOK<span class="rule"></span><span class="val" id="d-tdnote">—</span></div>
      <div class="body"><div class="tenday-grid" id="d-tenday"></div></div>
    </div>
  `;

  const $ = (id) => root.querySelector('#' + id);

  /*
   * ELSEWHERE owns its own markup, network and refresh throttle, so the deck
   * mounts it and forgets about it. It is the only panel here that does not
   * read from store.frame(), because it is asking about other places rather
   * than about another hour.
   */
  const elsewhere = createElsewhere($('d-elsewhere'));

  /* ------------------------------------------------------------ charts */

  const meteoChart = mount($('d-meteo'), (ctx, w, h, hover) => {
    const now = Date.now();
    meteogram(ctx, w, h, hover, {
      hours: store.hours, days: store.days, tf: store.fmt,
      span: { lo: store.cursor - 12 * 3600e3, hi: store.cursor + 36 * 3600e3 },
      cursor: store.cursor, now,
      panels: ['temp', 'pop', 'wind'],
    });
  }, {
    // Clicking the meteogram moves the cursor there.
    onPick: ({ x, w }) => {
      const lo = store.cursor - 12 * 3600e3, hi = store.cursor + 36 * 3600e3;
      const plotW = w - 34;
      store.playing = false;
      store.scrubTo(lo + ((x - 4) / plotW) * (hi - lo));
    },
  });

  const sparkChart = mount($('d-spark'), (ctx, w, h) => {
    const rows = store.hours.filter((d) => d.t >= store.cursor - 3600e3 && d.t <= store.cursor + 24 * 3600e3);
    if (rows.length < 2) return;
    const pts = spark(ctx, { x: 0, y: 4, w, h: h - 14 }, rows.map((d) => d.temp), { color: SERIES[0], glow: 9 });
    // Hour ticks so the sparkline has a readable time base.
    ctx.save();
    ctx.font = "500 11.5px 'JetBrains Mono', monospace";
    ctx.fillStyle = FAINT; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    for (let i = 0; i < rows.length; i += 6) {
      // The first and last are centred on x = 0 and x = w, so half of each
      // was off the canvas: "11AM" rendered as "PM" at both ends.
      fitLabel(ctx, store.fmt.hour(rows[i].t).replace(/\s/g, ''),
        (i / (rows.length - 1)) * w, h, 0, w);
    }
    ctx.restore();
    if (pts?.length) {
      ctx.save();
      ctx.fillStyle = INK; ctx.shadowColor = SERIES[0]; ctx.shadowBlur = 5;
      ctx.beginPath(); ctx.arc(pts[1]?.[0] ?? pts[0][0], pts[1]?.[1] ?? pts[0][1], 3, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
  });

  const moonDiscChart = mount($('d-moondisc'), (ctx, w, h) => {
    const f = store.frame();
    if (!f) return;
    moonDisc(ctx, w / 2, h / 2, Math.max(10, Math.min(w, h) / 2 - 3), f.moon.phase, f.moon.fraction);
  });

  const ncChart = mount($('d-nc'), (ctx, w, h) => {
    const nc = precipNowcast(store);
    if (!nc?.series?.length) return;
    const maxP = Math.max(...nc.series.map((s) => s.p), 0.02);
    const n = nc.series.length;
    const bw = Math.max(1, w / n - 0.6);
    nc.series.forEach((s, i) => {
      const x = (i * w) / n;
      const hh = s.p > 0 ? Math.max(1.5, (s.p / maxP) * h) : 0;
      if (!hh) return;
      capBar(ctx, x, h - hh, bw, h, alpha(s.p > 0.08 ? STATUS.crit : s.p > 0.02 ? SERIES[0] : SERIES[4], .9), 2);
    });
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,.10)';
    ctx.beginPath(); ctx.moveTo(0, h - .5); ctx.lineTo(w, h - .5); ctx.stroke();
    ctx.restore();
  });

  const gaugeCharts = [
    ['g-wind', (ctx, w, h) => {
      const f = store.frame();
      const r = Math.min(w, h) / 2 - 16;
      windRose(ctx, w / 2, h / 2 - 4, Math.max(14, r), {
        dir: f?.windDir, speed: f?.wind, gust: f?.gust, color: SERIES[3],
      });
    }],
    ['g-hum', (ctx, w, h) => {
      const f = store.frame();
      const r = Math.min(w, h) / 2 - 18;
      gauge(ctx, w / 2, h / 2 - 6, Math.max(14, r), {
        value: f?.rh, min: 0, max: 100, color: SERIES[4],
        label: 'humidity', unit: '%',
        sub: f ? dewpointComfort(f.dew).name : '',
      });
    }],
    ['g-pres', (ctx, w, h) => {
      const f = store.frame();
      const r = Math.min(w, h) / 2 - 18;
      const inHg = f?.pressure ? f.pressure * 0.029529983 : null;
      gauge(ctx, w / 2, h / 2 - 6, Math.max(14, r), {
        value: inHg, min: 28.5, max: 31.0, color: SERIES[3],
        label: 'pressure', unit: 'inHg', decimals: 2,
        sub: pressureTrend(),
      });
    }],
    ['g-uv', (ctx, w, h) => {
      const f = store.frame();
      const r = Math.min(w, h) / 2 - 18;
      gauge(ctx, w / 2, h / 2 - 6, Math.max(14, r), {
        value: f?.uv, min: 0, max: 12, color: uvCategory(f?.uv).color,
        label: 'uv index', unit: 'index', decimals: 1,
        sub: uvCategory(f?.uv).name,
        bands: [
          { from: 0, to: 3, color: STATUS.good }, { from: 3, to: 6, color: STATUS.warn },
          { from: 6, to: 8, color: STATUS.serious }, { from: 8, to: 11, color: STATUS.crit },
          { from: 11, to: 12, color: SERIES[3] },
        ],
      });
    }],
    ['g-aqi', (ctx, w, h) => {
      const f = store.frame();
      const aqi = f?.air?.aqi ?? store.airNow?.aqi;
      const cat = aqiCategory(aqi);
      const r = Math.min(w, h) / 2 - 18;
      gauge(ctx, w / 2, h / 2 - 6, Math.max(14, r), {
        value: aqi, min: 0, max: 200, color: cat.color,
        label: 'air quality', unit: 'US AQI',
        sub: cat.name.length > 12 ? 'SENSITIVE' : cat.name,
        bands: [
          { from: 0, to: 50, color: STATUS.good }, { from: 50, to: 100, color: STATUS.warn },
          { from: 100, to: 150, color: STATUS.serious }, { from: 150, to: 200, color: STATUS.crit },
        ],
      });
    }],
    ['g-vis', (ctx, w, h) => {
      const f = store.frame();
      const mi = f?.vis != null ? f.vis / 1609.344 : null;
      const r = Math.min(w, h) / 2 - 18;
      gauge(ctx, w / 2, h / 2 - 6, Math.max(14, r), {
        value: mi == null ? null : Math.min(mi, 10), min: 0, max: 10, color: SERIES[0],
        label: 'visibility', unit: 'miles', decimals: 1,
        sub: mi == null ? '' : mi >= 9 ? 'CLEAR' : mi >= 3 ? 'HAZY' : mi >= 1 ? 'POOR' : 'FOG',
      });
    }],
  ].map(([id, fn]) => mount($(id), fn));

  function pressureTrend() {
    const t = store.cursor;
    const a = store.hours.find((h) => h.t >= t - 3 * 3600e3);
    const b = store.hours.find((h) => h.t >= t);
    if (!a?.pressure || !b?.pressure) return '';
    const d = (b.pressure - a.pressure) * 0.029529983;
    if (Math.abs(d) < 0.02) return 'STEADY';
    return d > 0 ? `RISING ${d.toFixed(2)}` : `FALLING ${Math.abs(d).toFixed(2)}`;
  }

  /* ------------------------------------------------------------ render */

  function update() {
    const f = store.frame();
    if (!f) return;
    const tf = store.fmt;

    /* hero */
    $('d-temp').innerHTML = `${f.temp == null ? '--' : Math.round(f.temp)}<sup>°F</sup>`;
    $('d-cond').textContent = f.wx.label;
    $('d-glyph').textContent = wxGlyph(Math.round(f.code ?? 0), f.isDay > 0.5);
    $('d-feels').textContent = F.temp(f.feels);
    $('d-dew').textContent = F.temp(f.dew);
    $('d-obs').textContent = store.atNow
      ? `LIVE · ${relTime(store.lastFetch)}`
      : `PROJECTED · ${tf.hm(store.cursor)}`;

    /*
     * The hero is model output. Show the nearest real thermometer next to it
     * when we are looking at now — the two routinely differ by several
     * degrees, and only one of them is a measurement.
     */
    const ob = store.observed;
    const obEl = $('d-obsline');
    if (store.atNow && ob?.tempF != null) {
      const delta = f.temp != null ? f.temp - ob.tempF : null;
      obEl.innerHTML = `observed <b>${Math.round(ob.tempF)}°</b>`
        + `<span> · ${esc(ob.name || ob.station)} ${ob.distanceMi} mi · ${relTime(Date.parse(ob.time))}</span>`
        + (delta != null && Math.abs(delta) >= 1.5
            ? `<em> · model runs ${F.signed(delta, 0)}°</em>` : '');
      obEl.style.display = '';
    } else {
      obEl.style.display = 'none';
    }

    const day = f.day;
    $('d-hi').textContent = F.temp(day?.tmax);
    $('d-lo').textContent = F.temp(day?.tmin);

    // vs-normal needs the climate archive, which arrives after the first paint.
    const anomEl = $('d-anom');
    const c = store.climate?.doy?.[doy(store.cursor)];
    if (c && day?.tmax != null) {
      const d = day.tmax - c.normalHigh;
      anomEl.textContent = `${F.signed(d, 1)}°`;
      anomEl.style.color = Math.abs(d) < 2 ? DIM : d > 0 ? '#f2b45a' : '#7fb2f0';
    } else {
      anomEl.textContent = '--';
      anomEl.style.color = '';
    }

    const st = store.sunTimesFor();
    $('d-sunrise').textContent = tf.hm(st.sunrise);
    $('d-sunset').textContent = tf.hm(st.sunset);
    $('d-daylight').textContent = day?.daylight ? dur(day.daylight) : '--';

    /* alerts */
    const alerts = store.alerts;
    const ap = $('d-alertPanel');
    ap.style.display = alerts.length ? '' : 'none';
    $('d-alertN').textContent = String(alerts.length);
    $('d-alerts').innerHTML = alerts.slice(0, 4).map((a) => `
      <div class="alert-item" style="--ac:${alertColor(a.event, a.severity)}">
        <b>${esc(a.event || 'Alert')}</b>
        <span>until ${tf.weekday(a.expires || a.ends)} ${tf.hm(a.expires || a.ends)}</span>
      </div>`).join('');

    /* nowcast */
    const nc = precipNowcast(store);
    const phrase = nowcastPhrase(nc, tf);
    const ncl = $('d-ncline');
    if (phrase) {
      ncl.textContent = phrase;
      ncl.className = 'nowcast-line wet';
    } else {
      const nextWet = store.hours.find((h) => h.t > Date.now() && (h.pop ?? 0) >= 40);
      ncl.textContent = nextWet
        ? `Dry for 6+ hours. Next real chance ${tf.weekday(nextWet.t)} ${tf.hm(nextWet.t)} (${Math.round(nextWet.pop)}%).`
        : 'Dry. No meaningful precipitation in the forecast window.';
      ncl.className = 'nowcast-line';
    }
    $('d-ncres').textContent = nc ? `${nc.resolution}-MIN` : '—';

    /* sun & moon */
    const mi = f.moon, mt = store.moonTimesFor();
    $('d-moonname').textContent = `${Math.round(mi.fraction * 100)}% LIT`;
    $('d-sunmoon').innerHTML = `
      <dl style="margin:0">
        ${kv('Sun altitude', `${f.sun.altDeg.toFixed(1)}° ${compass(f.sun.compass)}`)}
        ${kv('Golden hour', `${tf.hm(st.goldenHour)} – ${tf.hm(st.sunset)}`)}
        ${kv('Blue hour', `${tf.hm(st.sunset)} – ${tf.hm(st.dusk)}`)}
        ${kv('Astro dark', isNaN(+st.night) ? 'none tonight' : tf.hm(st.night))}
        ${kv('Moon', `${moonName(mi.phase)}`)}
        ${kv('Moon alt', `${mi.altDeg.toFixed(1)}° ${compass(mi.compass)}`)}
        ${kv('Moonrise', mt.rise ? tf.hm(mt.rise) : '—')}
        ${kv('Moonset', mt.set ? tf.hm(mt.set) : '—')}
      </dl>`;

    /* gauge notes */
    const wd = windDescription(f.wind);
    $('n-wind').textContent = `${wd.name} · from ${compass(f.windDir)}`;
    $('n-hum').textContent = dewpointComfort(f.dew).note;
    $('n-pres').textContent = f.pressure ? `${Math.round(f.pressure)} hPa` : '';
    const burn = burnTime(f.uv, store.settings.skinType);
    $('n-uv').textContent = burn == null ? 'no burn risk'
      : burn > 180 ? 'burn risk negligible'
      : `burn in ~${burn} min`;
    const aqiV = f.air?.aqi ?? store.airNow?.aqi;
    $('n-aqi').textContent = f.air?.pm25 != null ? `PM2.5 ${f.air.pm25.toFixed(1)} µg/m³` : (aqiV != null ? '' : 'no data');
    $('n-vis').textContent = f.vis != null ? `${(f.vis / 1609.344).toFixed(1)} mi` : '';
    $('d-instnote').textContent = store.atNow ? 'LIVE' : tf.hm(store.cursor);

    /* activity */
    renderActivity();

    /* ten day */
    renderTenDay();

    moonDiscChart.render();
    for (const c of gaugeCharts) c.render();
    meteoChart.render();
    sparkChart.render();
    ncChart.render();
  }

  /*
   * ACTIVITY WINDOWS. The old rows were unreadable ("RUN Tue 07:00 ·
   * window 20:00-09:00 · 100"): nothing was labelled, the window crossed
   * midnight on a 24-hour clock without saying so, and on a good day every
   * number read 99 or 100. Now each row says when the best hour is and when
   * the good stretch runs, day on both ends; the number is GREAT HOURS - how
   * many of the next 36 score 90+ within the activity's sensible hours - and
   * a tap opens the best hour's factors. The open row survives re-renders,
   * which happen on every cursor tick.
   */
  let openAct = null;

  function renderActivity() {
    const tf = store.fmt;
    // Hours are whole, so "5 PM", not "5:00 PM"; the day is said once, and
    // again only when the window crosses midnight.
    const at = (t) => `${tf.weekday(t)} ${tf.hour(t)}`;
    const span = (a, b) => (tf.isoDate(a) === tf.isoDate(b)
      ? `${tf.weekday(a)} ${tf.hour(a)}–${tf.hour(b)}`
      : `${at(a)} – ${at(b)}`);
    const rows = ACTIVITY_KEYS.map((k) => {
      const meta = activityMeta(k);
      const w = bestWindows(k, store, { hours: 36, limit: 1, minScore: 50 })[0];
      const g = greatHours(k, store, { hours: 36, at: 90 });
      return { k, meta, w, g };
    }).sort((a, b) => (b.g.great - a.g.great) || ((b.w?.peak ?? 0) - (a.w?.peak ?? 0)));

    $('d-act').innerHTML = rows.map(({ k, meta, w, g }) => {
      const great = g.great;
      const share = g.eligible ? great / g.eligible : 0;
      const col = great > 0 ? STATUS.good : (w?.peak ?? 0) >= 60 ? STATUS.warn : STATUS.serious;
      const when = w
        // Two lines: the best hour, then the good stretch. A middle dot and
        // the faint grey put the stretch at 2.3:1 on the panel, unreadable.
        ? `<b class="act-best">Best ${at(w.peakAt)}</b>`
          + `<span class="act-good">Good ${span(w.start, w.end)}</span>`
          + (great === 0 ? `<span class="act-note">Best hour scores ${w.peak}/100</span>` : '')
          + (w.limiter ? `<span class="act-note">Held back by ${w.limiter}</span>` : '')
        : '<span class="act-note">No good time in the next 36 hours</span>';
      const open = openAct === k && w;
      const why = w ? w.parts.map((p) => {
        const lost = Math.round((1 - p.value) * p.weight * 100);
        return `<span class="act-factor"><span class="act-fname">${p.name}</span>`
          + `<span class="meter act-fbar" style="--ac:${lost === 0 ? STATUS.good : p.value >= 0.6 ? STATUS.warn : STATUS.serious}"><i style="width:${Math.round(p.value * 100)}%"></i></span>`
          + `<span class="act-fpts">${lost ? '−' + lost : 'full marks'}</span></span>`;
      }).join('') : '';
      return `
        <button type="button" class="act-row" data-act="${k}" aria-expanded="${open ? 'true' : 'false'}"
                aria-controls="act-why-${k}"${w ? '' : ' disabled'}>
          <span class="act-icon" style="color:${meta.color}">${meta.icon}</span>
          <span class="act-text">
            <span class="act-name">${meta.label}</span>
            <span class="act-when">${when}</span>
            <span class="meter act-bar" style="--ac:${col}"><i style="width:${Math.round(share * 100)}%"></i></span>
          </span>
          <span class="act-score" style="color:${col}">${great}<small class="act-unit">great hours</small></span>
        </button>
        <div class="act-why" id="act-why-${k}"${open ? '' : ' hidden'}>
          <span class="act-whyhd">Why the best hour (${w ? at(w.peakAt) : ''}) scores ${w?.peak ?? 0}</span>${why}
        </div>`;
    }).join('');
  }

  // One row open at a time; a second tap or Escape closes it.
  $('d-act').addEventListener('click', (e) => {
    const row = e.target.closest('.act-row');
    if (!row || row.disabled) return;
    openAct = openAct === row.dataset.act ? null : row.dataset.act;
    renderActivity();
    $('d-act').querySelector(`.act-row[data-act="${row.dataset.act}"]`)?.focus();
  });
  $('d-act').addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !openAct) return;
    const k = openAct;
    openAct = null;
    renderActivity();
    $('d-act').querySelector(`.act-row[data-act="${k}"]`)?.focus();
  });

  function renderTenDay() {
    const tf = store.fmt;
    // Drop the two past days the forecast payload carries for context.
    const todayIso = tf.isoDate(Date.now());
    const days = store.days.filter((d) => d.tmax != null && tf.isoDate(d.t) >= todayIso);
    if (!days.length) return;
    const lo = Math.min(...days.map((d) => d.tmin));
    const hi = Math.max(...days.map((d) => d.tmax));
    const todayKey = tf.isoDate(Date.now());
    const cursorKey = tf.isoDate(store.cursor);

    $('d-tenday').innerHTML = days.map((d) => {
      const key = tf.isoDate(d.t);
      const top = ((hi - d.tmax) / (hi - lo || 1)) * 100;
      const bot = ((d.tmin - lo) / (hi - lo || 1)) * 100;
      const grad = `linear-gradient(to top, ${tempColor(d.tmin)}, ${tempColor(d.tmax)})`;
      return `
        <div class="tenday-col ${key === todayKey ? 'today' : ''} ${key === cursorKey ? 'cursor' : ''}" data-t="${d.t}">
          <div class="td-day">${key === todayKey ? 'TODAY' : tf.weekday(d.t)}</div>
          <div class="td-date">${tf.monthDay(d.t)}</div>
          <div class="td-glyph" title="${wx(Math.round(d.code)).long}">${wxGlyph(Math.round(d.code), true)}</div>
          <div class="td-hi">${Math.round(d.tmax)}°</div>
          <div class="td-bar"><i style="top:${top}%;bottom:${bot}%;background:${grad};box-shadow:0 0 8px ${tempColor(d.tmax)}66"></i></div>
          <div class="td-lo">${Math.round(d.tmin)}°</div>
          <div class="td-pop">${(d.pop ?? 0) >= 10 ? `${Math.round(d.pop)}%` : ''}</div>
        </div>`;
    }).join('');

    $('d-tdnote').textContent = `${days.length} DAYS AHEAD`;
    $('d-tenday').querySelectorAll('.tenday-col').forEach((el) => {
      el.addEventListener('click', () => {
        // Jump to local midday of the clicked day: the most useful moment.
        store.playing = false;
        store.scrubTo(+el.dataset.t + 13 * 3600e3);
      });
    });
  }

  const kv = (k, v) => `<div class="kv"><dt>${k}</dt><dd>${v}</dd></div>`;
  const moonName = (p) => {
    const n = ['New Moon', 'Waxing Crescent', 'First Quarter', 'Waxing Gibbous',
      'Full Moon', 'Waning Gibbous', 'Last Quarter', 'Waning Crescent'];
    return n[Math.round((((p % 1) + 1) % 1) * 8) % 8];
  };
  const doy = (t) => {
    const s = store.fmt.isoDate(t);
    const [, m, d] = s.split('-').map(Number);
    return [0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335][m - 1] + d - 1;
  };

  return {
    update() { update(); elsewhere.update(); },
    onHide() { elsewhere.onHide(); },
  };
}
