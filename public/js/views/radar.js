/**
 * RADAR — animated precipitation over a neon-graded map.
 *
 * RainViewer publishes ~13 past frames at 10-minute spacing plus, when a
 * system is active, a short nowcast. The base map is CARTO's dark raster
 * pushed through a canvas filter into the console's cyan, with labels drawn
 * as a separate dimmer layer so they never fight the radar.
 */

import { store } from '../state.js';
import { api } from '../api.js';
import {
  SlippyMap, drawGeometry, drawMarker, drawScaleBar,
  ESRI_CANVAS as ESRI, ESRI_BASE_FILTER as BASE_FILTER, ESRI_LABEL_FILTER as LABEL_FILTER,
} from '../map.js';
import { SERIES, STATUS, INK, DIM, FAINT, alpha, mount, capBar, tag } from '../charts.js';
import { alertColor, clamp, escapeHtml as esc } from '../lib/util.js';

export function createRadar(root) {
  root.className = 'view radar';
  root.innerHTML = `
    <div class="radar-wrap">
      <div class="panel bare radar-main">
        <canvas class="fill" id="r-map"></canvas>
        <div class="radar-hud">
          <div class="radar-stamp"><b id="r-time">—</b><span id="r-age">—</span></div>
          <div class="radar-legend" id="r-legend"></div>
        </div>
        <div class="radar-tools">
          <button class="tl-btn sm" id="r-center" title="Recentre on location">⌖</button>
          <button class="tl-btn sm" id="r-zin" title="Zoom in">+</button>
          <button class="tl-btn sm" id="r-zout" title="Zoom out">−</button>
          <button class="tl-btn sm on" id="r-labels" title="Place labels">A</button>
          <button class="tl-btn sm on" id="r-alerts" title="Alert polygons">⚠</button>
        </div>
        <div class="radar-frames">
          <button class="tl-btn" id="r-play">❚❚</button>
          <canvas id="r-strip"></canvas>
        </div>
      </div>

      <div class="radar-side">
        <div class="panel">
          <div class="hd">COVERAGE<span class="rule"></span><span class="val" id="r-src">RAINVIEWER</span></div>
          <div class="body" id="r-cover"></div>
        </div>
        <div class="panel grow" style="--ac:var(--rd)">
          <div class="hd">WATCHES &amp; WARNINGS<span class="rule"></span><span class="val" id="r-alertn">0</span></div>
          <div class="body" id="r-alertlist" style="overflow-y:auto"></div>
        </div>
        <div class="panel">
          <div class="hd" style="--ac:var(--am)">CONVECTIVE<span class="rule"></span><span class="val">STORM FUEL</span></div>
          <div class="body" id="r-conv"></div>
        </div>
      </div>
    </div>
  `;

  const $ = (id) => root.querySelector('#' + id);

  /*
   * ONE TRANSPORT. The radar used to run its own loop over its own frame
   * index with its own pause button, and never read store.cursor - so the
   * footer's rewind, play and forward moved the readout while the picture
   * kept looping, and the map's pause left the footer alone. Now the frame
   * shown is always the one nearest store.cursor, and the loop advances the
   * CURSOR at the radar's own cadence (a frame every 0.42s, about 24 minutes
   * of radar a second) while this view is on screen and store.playing is
   * true. The footer and the map are the same button in two places.
   */
  let frames = [];        // {time, path, kind}
  let idx = 0;
  let acc = 0;
  let lastSideKey = '';
  let lastT = performance.now();
  let host = '';

  const map = new SlippyMap($('r-map'), {
    center: [store.loc?.lat ?? 0, store.loc?.lon ?? 0],
    zoom: 7, minZoom: 3, maxZoom: 11,
    onMove: () => scheduleStrip(),
  });

  map.layers = [
    {
      name: 'base',
      url: (z, x, y) => `${ESRI}/World_Dark_Gray_Base/MapServer/tile/${z}/${y}/${x}`,
      filter: BASE_FILTER, opacity: 1,
    },
    {
      name: 'radar',
      url: (z, x, y) => {
        const f = frames[idx];
        if (!f || !host) return null;
        return `${host}${f.path}/256/${z}/${x}/${y}/4/1_1.png`;
      },
      opacity: 0.82, blend: 'screen',
      /*
       * Measured against the live tile cache: RainViewer's public radar
       * serves real tiles to z 7 and the same 1370-byte "Zoom Level Not
       * Supported" placeholder at every zoom above it, everywhere in the
       * world. The map upscales z 7 instead — which is honest, since the
       * data behind it is a 1km grid either way.
       */
      maxTileZoom: 7,
    },
    {
      name: 'labels',
      url: (z, x, y) => `${ESRI}/World_Dark_Gray_Reference/MapServer/tile/${z}/${y}/${x}`,
      filter: LABEL_FILTER, opacity: 1,
    },
  ];

  const layer = (n) => map.layers.find((l) => l.name === n);

  /* ------------------------------------------------------------ overlays */

  map.overlays.push((ctx, m) => {
    // Alert polygons beneath the marker.
    if (layer('alerts')?.enabled !== false && showAlerts) {
      for (const a of store.alerts) {
        if (!a.geometry) continue;
        const c = alertColor(a.event, a.severity);
        drawGeometry(ctx, m, a.geometry, { stroke: c, fill: alpha(c, 0.12), width: 1.5, glow: 10 });
      }
    }
    if (store.loc) {
      const [x, y] = m.project(store.loc.lat, store.loc.lon);
      drawMarker(ctx, x, y, SERIES[1], store.loc.name.toUpperCase());
    }
    drawScaleBar(ctx, m, 14, m.h - 14);

    // Crosshair graticule, purely for the control-room feel.
    ctx.save();
    ctx.strokeStyle = 'rgba(63,208,216,.06)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      ctx.beginPath();
      ctx.moveTo((m.w * i) / 4, 0); ctx.lineTo((m.w * i) / 4, m.h);
      ctx.moveTo(0, (m.h * i) / 4); ctx.lineTo(m.w, (m.h * i) / 4);
      ctx.stroke();
    }
    ctx.restore();
  });

  let showAlerts = true;

  /* -------------------------------------------------------- frame strip */

  const strip = mount($('r-strip'), (ctx, w, h) => {
    if (!frames.length) return;
    const n = frames.length;
    const bw = Math.max(2, w / n - 2);
    const nowIdx = frames.findIndex((f) => f.kind === 'nowcast');
    frames.forEach((f, i) => {
      const x = (i * w) / n;
      const isPast = f.kind === 'past';
      const c = i === idx ? SERIES[1] : isPast ? SERIES[0] : STATUS.warn;
      ctx.fillStyle = alpha(c, i === idx ? 1 : 0.30);
      ctx.fillRect(x, i === idx ? 2 : 6, bw, i === idx ? h - 4 : h - 12);
    });
    // Divider between observed and forecast frames.
    if (nowIdx > 0) {
      const x = (nowIdx * w) / n - 1;
      ctx.save();
      ctx.strokeStyle = alpha(STATUS.warn, .8);
      ctx.setLineDash([2, 2]);
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
      ctx.restore();
    }
  }, {
    onPick: ({ x, w }) => {
      if (!frames.length) return;
      // A deliberate pick, like a drag of the footer's strip: it pauses and
      // it is not undone by the clock.
      const f = frames[clamp(Math.floor((x / w) * frames.length), 0, frames.length - 1)];
      store.playing = false;
      store.emit('play', false);
      store.scrubTo(f.time * 1000);
    },
  });

  /** The frame nearest t (ms). Strict < so a midpoint picks the earlier one. */
  function frameFor(t) {
    let best = 0, bd = Infinity;
    for (let i = 0; i < frames.length; i++) {
      const d = Math.abs(frames[i].time * 1000 - t);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  /** Show the frame the cursor asks for, if it is not already up. */
  function followCursor() {
    if (!frames.length) return;
    const i = frameFor(store.cursor);
    if (i !== idx) { idx = i; applyFrame(); }
  }

  function paintPlay() {
    $('r-play').textContent = store.playing ? '❚❚' : '▶';
  }

  const scheduleStrip = () => strip.render();

  function applyFrame() {
    const f = frames[idx];
    if (!f) return;
    $('r-time').textContent = store.fmt.hm(f.time * 1000);
    const age = Math.round((Date.now() / 1000 - f.time) / 60);
    $('r-age').textContent = f.kind === 'nowcast'
      ? `FORECAST +${Math.abs(age)}m`
      : age <= 1 ? 'LATEST' : `${age} MIN AGO`;
    $('r-age').style.color = f.kind === 'nowcast' ? STATUS.warn : (age <= 12 ? STATUS.good : DIM);
    map.invalidate();
    strip.render();
  }

  /* ------------------------------------------------------------- data */

  async function loadFrames() {
    try {
      const r = store.radar || await api.radar();
      host = r.host;
      const past = (r.radar?.past || []).map((f) => ({ ...f, kind: 'past' }));
      const now = (r.radar?.nowcast || []).map((f) => ({ ...f, kind: 'nowcast' }));
      frames = [...past, ...now];
      idx = frameFor(store.cursor);
      $('r-src').textContent = now.length
        ? `${past.length} OBS + ${now.length} FCST`
        : `${past.length} OBSERVED`;
      applyFrame();
      renderLegend();
    } catch (e) {
      console.error('[radar] frames', e);
      $('r-src').textContent = 'UNAVAILABLE';
    }
  }

  function renderLegend() {
    // RainViewer colour scheme 4, labelled by intensity rather than dBZ so
    // it means something without a meteorology degree.
    const steps = [
      ['#62a4ef', 'light'], ['#6cc98f', 'moderate'], ['#ecd46a', 'heavy'],
      ['#f59a5b', 'very heavy'], ['#f47171', 'intense'], ['#c89af5', 'hail'],
    ];
    $('r-legend').innerHTML =
      '<span class="lg-title">intensity</span>' +
      steps.map(([c, l]) => `<b><i style="background:${c}"></i>${l}</b>`).join('');
  }

  function renderSide() {
    const tf = store.fmt;
    // Called on every cursor event, and the loop emits one every 0.42s while
    // it plays; three panels' innerHTML seven times a second for the same
    // hour is work for nothing. Rebuild only when what they show changed.
    const f0 = store.frame();
    const key = [f0?.t, f0?.precip, f0?.cape, f0?.cloud, store.alerts.length, store.hours.length].join('|');
    if (key === lastSideKey) return;
    lastSideKey = key;

    /* alerts */
    const a = store.alerts;
    $('r-alertn').textContent = String(a.length);
    $('r-alertlist').innerHTML = a.length ? a.map((x) => `
      <div class="alert-item" style="--ac:${alertColor(x.event, x.severity)}">
        <b>${esc(x.event)}</b>
        <span>${esc(x.areaDesc || '').slice(0, 90)}</span><br>
        <span>until ${tf.weekday(x.expires)} ${tf.hm(x.expires)}</span>
      </div>`).join('')
      : '<div class="nodata">no active alerts</div>';

    /* coverage summary from the forecast, since radar tiles carry no values */
    const f = store.frame();
    const next6 = store.hours.filter((h) => h.t >= Date.now() && h.t <= Date.now() + 6 * 3600e3);
    const total = next6.reduce((s, h) => s + (h.precip ?? 0), 0);
    const maxPop = Math.max(0, ...next6.map((h) => h.pop ?? 0));
    $('r-cover').innerHTML = `
      <dl style="margin:0">
        ${kv('Now', f?.wx.label ?? '--')}
        ${kv('Rate', f?.precip != null ? `${f.precip.toFixed(3)} in/hr` : '--')}
        ${kv('Next 6h total', `${total.toFixed(2)} in`)}
        ${kv('Peak chance 6h', `${Math.round(maxPop)}%`)}
        ${kv('Cloud cover', f?.cloud != null ? `${Math.round(f.cloud)}%` : '--')}
        ${kv('Freezing level', f?.freezing != null ? `${Math.round(f.freezing * 3.28084)} ft` : '--')}
      </dl>`;

    /* convective */
    const cape = f?.cape ?? 0, li = f?.li, cin = f?.cin;
    const risk = cape < 300 ? ['STABLE', STATUS.good] : cape < 1000 ? ['MARGINAL', SERIES[0]]
      : cape < 2500 ? ['MODERATE', STATUS.warn] : cape < 4000 ? ['STRONG', STATUS.serious] : ['EXTREME', STATUS.crit];
    const peakCape = Math.max(0, ...store.hours
      .filter((h) => h.t >= Date.now() && h.t <= Date.now() + 24 * 3600e3)
      .map((h) => h.cape ?? 0));
    $('r-conv').innerHTML = `
      <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:6px">
        <span class="num" style="font-size:1.5rem;font-weight:700;color:${risk[1]}">${Math.round(cape)}</span>
        <span class="lbl">J/kg CAPE</span>
        <span class="chip" style="--ac:${risk[1]};margin-left:auto">${risk[0]}</span>
      </div>
      <div class="meter seg" style="--ac:${risk[1]};margin-bottom:8px"><i style="width:${clamp(cape / 4000 * 100, 0, 100)}%"></i></div>
      <dl style="margin:0">
        ${kv('Lifted index', li != null ? li.toFixed(1) : '--')}
        ${kv('Inhibition', cin != null ? `${Math.round(cin)} J/kg` : '--')}
        ${kv('Peak CAPE 24h', `${Math.round(peakCape)} J/kg`)}
      </dl>
      <div style="font-size:max(.58rem,var(--fs-floor,0px));color:var(--faint);line-height:1.5;margin-top:7px">
        CAPE is the energy available to a rising parcel. Above ~1000 J/kg with a
        negative lifted index, thunderstorms become plausible.
      </div>`;
  }

  /* ------------------------------------------------------------ controls */

  $('r-play').addEventListener('click', () => {
    store.playing = !store.playing;
    store.emit('play', store.playing);
    paintPlay();
  });
  // Most pauses never emit 'play' (the arrow keys, the footer's strip, the
  // meteogram), so the glyph is refreshed on every cursor event as well.
  store.on('play', paintPlay);
  store.on('cursor', () => {
    if (store.view !== 'radar') return;
    followCursor();
    paintPlay();
  });
  $('r-center').addEventListener('click', () => {
    if (store.loc) map.setView(store.loc.lat, store.loc.lon, 7);
  });
  $('r-zin').addEventListener('click', () => map.setView(map.lat, map.lon, map.zoom + 1));
  $('r-zout').addEventListener('click', () => map.setView(map.lat, map.lon, map.zoom - 1));
  $('r-labels').addEventListener('click', (e) => {
    const l = layer('labels');
    l.enabled = l.enabled === false;
    e.currentTarget.classList.toggle('on', l.enabled !== false);
    map.invalidate();
  });
  $('r-alerts').addEventListener('click', (e) => {
    showAlerts = !showAlerts;
    e.currentTarget.classList.toggle('on', showAlerts);
    map.invalidate();
  });

  /* The radar loop runs only while this view is on screen. */
  function tick(now) {
    if (store.view !== 'radar') { lastT = now; return; }
    const dt = Math.min(0.2, (now - lastT) / 1000);
    lastT = now;
    if (store.playing && frames.length) {
      acc += dt;
      // Hold the final frame a beat longer so the loop reads clearly.
      const hold = idx === frames.length - 1 ? 1.1 : 0.42;
      if (acc >= hold) {
        acc = 0;
        const next = (idx + 1) % frames.length;
        // Drive the cursor, not a private index: the footer's readout and
        // playhead move with the radar, and the cursor listener above picks
        // the frame. setCursor, not scrubTo - the loop is ambient, so
        // `following` stays true and the deck comes back live afterwards.
        // Without hourly data setCursor is a no-op, so fall back to the
        // frame itself rather than freeze.
        if (store.hours.length) store.setCursor(frames[next].time * 1000);
        else { idx = next; applyFrame(); }
      }
    }
  }
  requestAnimationFrame(function raf(t) { requestAnimationFrame(raf); tick(t); });

  store.on('loc', () => { if (store.loc) map.setView(store.loc.lat, store.loc.lon, 7); });
  store.on('radar', loadFrames);

  const kv = (k, v) => `<div class="kv"><dt>${k}</dt><dd>${v}</dd></div>`;

  loadFrames();

  return {
    map,                     // the pan/pinch surface, reachable from ATMOS.views
    update() { renderSide(); map.invalidate(); },
    onShow() {
      map.resize();
      strip.render();
      followCursor();
      // The loop is ambient: it runs while the view is up, as it always did.
      store.playing = true;
      store.emit('play', true);
      paintPlay();
    },
    onHide() {
      store.playing = false;
      store.emit('play', false);
      // The loop parked the cursor in the last two hours. If the user never
      // scrubbed, the deck should come back live, not "PROJECTED · 14:20".
      if (store.following) store.setCursor(Date.now());
    },
  };
}
