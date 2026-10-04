/**
 * OVERHEAD — what is above you, right now.
 *
 * Aircraft from a volunteer ADS-B network, the ISS, and the sun and moon,
 * placed on the same slippy map the radar uses. The question it answers is
 * the one you ask standing in the garden: what is that, and where is it
 * going?
 *
 * Positions come through our own backend rather than straight from the feed —
 * that keeps the tile hosts out of the CSP, gives every viewer the same
 * ten-second edge cache, and means a hobbyist's receiver sees one request per
 * ten seconds however many people are watching.
 *
 * Route and airframe details are fetched only for the aircraft you tap.
 * Enriching a hundred of them on every refresh would be a hundred requests
 * every ten seconds against a free service.
 */

import { store } from '../state.js';
import { api } from '../api.js';
import { SlippyMap, drawMarker, drawScaleBar, ESRI_CANVAS, ESRI_BASE_FILTER, ESRI_LABEL_FILTER } from '../map.js';
import { FAINT, SERIES, alpha, mixHex, haloText } from '../charts.js';
import { sunPosition, moonPosition, toCompass, toDeg, topocentric } from '../lib/astro.js';
import { compass, clamp, escapeHtml as esc } from '../lib/util.js';

const NM = 1852;              // metres in a nautical mile
const REFRESH = 10_000;
const PICK_PX = 24;           // how close a tap has to land, in CSS pixels

/** Low is warm, high is cold — the convention every traffic display uses. */
const altColour = (ft, ground) =>
  (ground ? FAINT : mixHex('#f07aa6', '#3fd0d8', clamp((ft ?? 0) / 38000, 0, 1)));

export function createOverhead(root) {
  root.className = 'view overheadview';
  root.innerHTML = `
    <div class="oh-wrap">
      <div class="panel bare oh-main">
        <canvas class="fill" id="o-map"></canvas>
        <!-- radar-stamp and radar-tools are generic HUD furniture; the names
             are historical, not a coupling to the radar view. -->
        <div class="radar-hud">
          <div class="radar-stamp"><b id="o-count">—</b><span id="o-age">—</span></div>
        </div>
        <div class="radar-tools">
          <button class="tl-btn sm" id="o-center" title="Recentre on you">⌖</button>
          <button class="tl-btn sm" id="o-zin" title="Zoom in">+</button>
          <button class="tl-btn sm" id="o-zout" title="Zoom out">−</button>
        </div>
      </div>

      <div class="oh-side">
        <div class="panel grow">
          <div class="hd">SELECTED<span class="rule"></span><span class="val" id="o-cs">NOTHING</span></div>
          <div class="body" id="o-sel" style="overflow-y:auto"></div>
        </div>
        <div class="panel" style="--ac:var(--am)">
          <div class="hd">ALSO UP<span class="rule"></span><span class="val" id="o-lookwhen">NOW</span></div>
          <div class="body" id="o-sky"></div>
        </div>
        <div class="panel grow">
          <div class="hd">NEAREST<span class="rule"></span><span class="val" id="o-src">—</span></div>
          <div class="body" id="o-near" style="overflow-y:auto"></div>
        </div>
      </div>
    </div>
  `;

  const $ = (id) => root.querySelector('#' + id);

  let planes = [];          // trimmed aircraft records, nearest first
  let at = 0;               // when the feed sample was taken
  let source = null;
  let sel = null;           // hex of the selected aircraft
  let selInfo = null;       // enrichment for `sel`, or null while it loads
  let iss = null;
  let timer = null;

  const here = () => store.loc || { lat: 0, lon: 0 };

  const map = new SlippyMap($('o-map'), {
    center: [here().lat, here().lon],
    zoom: 9, minZoom: 5, maxZoom: 12,
    onTap: (p) => pick(p),
  });

  map.layers = [
    {
      name: 'base',
      url: (z, x, y) => `${ESRI_CANVAS}/World_Dark_Gray_Base/MapServer/tile/${z}/${y}/${x}`,
      filter: ESRI_BASE_FILTER, opacity: 1,
    },
    {
      name: 'labels',
      url: (z, x, y) => `${ESRI_CANVAS}/World_Dark_Gray_Reference/MapServer/tile/${z}/${y}/${x}`,
      filter: ESRI_LABEL_FILTER, opacity: 0.85,
    },
  ];

  /* ------------------------------------------------------------- overlay */

  map.overlays.push((ctx, m) => {
    const o = here();
    const [ox, oy] = m.project(o.lat, o.lon);
    const mPerPx = (156543.03392 * Math.cos((m.lat * Math.PI) / 180)) / Math.pow(2, m.zoom);

    // Range rings, so "how far away is that" has an answer without tapping.
    ctx.save();
    ctx.strokeStyle = 'rgba(63,208,216,.13)';
    ctx.setLineDash([2, 4]);
    ctx.lineWidth = 1;
    ctx.font = "500 11.5px 'JetBrains Mono', monospace";
    // Outlined, in the full accent: at .4 alpha they read only on a black map.
    ctx.fillStyle = SERIES[0];
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    for (const nm of [10, 20, 40]) {
      const r = (nm * NM) / mPerPx;
      if (r < 24 || r > Math.max(m.w, m.h)) continue;
      ctx.beginPath(); ctx.arc(ox, oy, r, 0, Math.PI * 2); ctx.stroke();
      haloText(ctx, `${nm} NM`, ox, oy - r - 2);
    }
    ctx.restore();

    for (const a of planes) {
      const [x, y] = m.project(a.lat, a.lon);
      if (x < -20 || y < -20 || x > m.w + 20 || y > m.h + 20) continue;
      const on = a.hex === sel;
      const c = altColour(a.alt, a.gnd);

      if (on) {
        // Where it will be in a minute, at its present speed and heading.
        const nmPerMin = (a.gs ?? 0) / 60;
        if (nmPerMin > 0.1 && a.trk != null) {
          const len = (nmPerMin * NM) / mPerPx;
          const rad = ((a.trk - 90) * Math.PI) / 180;
          ctx.save();
          ctx.strokeStyle = alpha(c, 0.6); ctx.setLineDash([3, 3]); ctx.lineWidth = 1.2;
          ctx.beginPath(); ctx.moveTo(x, y);
          ctx.lineTo(x + Math.cos(rad) * len, y + Math.sin(rad) * len);
          ctx.stroke(); ctx.restore();
        }
        ctx.save();
        ctx.strokeStyle = c; ctx.lineWidth = 1.5;
        ctx.shadowColor = c; ctx.shadowBlur = 5;
        ctx.beginPath(); ctx.arc(x, y, 13, 0, Math.PI * 2); ctx.stroke();
        ctx.restore();
      }

      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(((a.trk ?? 0) * Math.PI) / 180);   // the glyph is drawn nose-up
      ctx.fillStyle = c;
      if (on) { ctx.shadowColor = c; ctx.shadowBlur = 4; }
      ctx.beginPath();
      ctx.moveTo(0, -6.5);
      ctx.lineTo(4.5, 5);
      ctx.lineTo(0, 2.4);
      ctx.lineTo(-4.5, 5);
      ctx.closePath();
      ctx.fill();
      ctx.restore();

      // Only label what you asked about — a hundred callsigns is a smear.
      if (on && a.cs) {
        ctx.save();
        ctx.font = "600 11.5px 'Chakra Petch', sans-serif";
        ctx.letterSpacing = '1.2px';
        ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        const w = ctx.measureText(a.cs).width + 10;
        ctx.fillStyle = 'rgba(22,33,47,.88)';
        ctx.fillRect(x + 16, y - 7, w, 14);
        ctx.fillStyle = c;
        ctx.fillText(a.cs, x + 21, y);
        ctx.restore();
      }
    }

    if (store.loc) drawMarker(ctx, ox, oy, '#f07aa6', null);
    drawScaleBar(ctx, m, 12, m.h - 12);
  });

  /* -------------------------------------------------------------- picking */

  function pick(p) {
    let best = null, bestD = PICK_PX;
    for (const a of planes) {
      const [x, y] = map.project(a.lat, a.lon);
      const d = Math.hypot(x - p.x, y - p.y);
      if (d < bestD) { bestD = d; best = a; }
    }
    select(best ? best.hex : null);
  }

  function select(hex) {
    if (sel === hex) return;
    sel = hex;
    selInfo = null;
    renderSel();
    map.invalidate();
    if (!hex) return;
    const a = planes.find((x) => x.hex === hex);
    if (!a) return;
    api.flight(a.cs || '', a.hex || '')
      .then((info) => { if (sel === hex) { selInfo = info; renderSel(); } })
      .catch(() => { /* the readout is useful without the route */ });
  }

  /* ------------------------------------------------------------- readouts */

  const kv = (k, v) => `<div class="kv"><dt>${k}</dt><dd>${v}</dd></div>`;
  const ft = (v) => (v == null ? '—' : `${Math.round(v).toLocaleString()} ft`);

  /** Bearing from you to a point, in degrees true. */
  function bearingTo(lat, lon) {
    const o = here();
    const toR = Math.PI / 180;
    const dl = (lon - o.lon) * toR;
    const y = Math.sin(dl) * Math.cos(lat * toR);
    const x = Math.cos(o.lat * toR) * Math.sin(lat * toR)
      - Math.sin(o.lat * toR) * Math.cos(lat * toR) * Math.cos(dl);
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
  }

  function renderSel() {
    const a = planes.find((x) => x.hex === sel);
    if (!a) {
      $('o-cs').textContent = 'NOTHING';
      $('o-sel').innerHTML = '<p class="hint">Tap an aircraft on the map, '
        + 'or a row in NEAREST.</p>';
      return;
    }
    $('o-cs').textContent = a.cs || a.reg || a.hex.toUpperCase();

    const climb = a.vs == null || Math.abs(a.vs) < 100 ? 'level'
      : a.vs > 0 ? `climbing ${Math.round(a.vs).toLocaleString()} ft/min`
        : `descending ${Math.abs(Math.round(a.vs)).toLocaleString()} ft/min`;
    const brg = bearingTo(a.lat, a.lon);

    const rows = [];
    const i = selInfo;
    if (i?.airline) rows.push(kv('Operator', esc(i.airline)));
    else if (i?.aircraft?.owner) rows.push(kv('Operator', esc(i.aircraft.owner)));
    const model = i?.aircraft?.manufacturer && i?.aircraft?.type
      ? `${i.aircraft.manufacturer} ${i.aircraft.type}` : a.type;
    if (model) rows.push(kv('Aircraft', esc(model)));
    if (a.reg) rows.push(kv('Registration', esc(a.reg)));

    if (i?.origin || i?.destination) {
      const side = (x) => (x ? `${esc(x.iata || '??')} <span class="dim">${esc(x.city || '')}</span>` : '—');
      rows.push(kv('From', side(i.origin)));
      rows.push(kv('To', side(i.destination)));
    }

    rows.push(kv('Altitude', a.gnd ? 'on the ground' : ft(a.alt)));
    rows.push(kv('Motion', `${a.gs == null ? '—' : `${Math.round(a.gs)} kt`} · ${climb}`));
    rows.push(kv('Heading', a.trk == null ? '—' : `${Math.round(a.trk)}° ${compass(a.trk)}`));
    rows.push(kv('From you', `${(a.dst ?? 0).toFixed(1)} nm ${compass(brg)}`));

    // Short, because this panel shares its height with NEAREST.
    const note = i && !i.origin && a.cs
      ? '<p class="hint">No published route — usually private or general aviation.</p>'
      : i?.origin
        ? '<p class="hint">Route is by callsign, which airlines reuse day to day.</p>'
        : '';
    $('o-sel').innerHTML = rows.join('') + note;
  }

  function renderNear() {
    const list = planes.filter((a) => !a.gnd).slice(0, 8);
    $('o-src').textContent = source ? source.toUpperCase() : 'NO FEED';
    if (!list.length) {
      $('o-near').innerHTML = '<p class="hint">Nothing in the air within range.</p>';
      return;
    }
    $('o-near').innerHTML = '<div class="oh-head"><span>callsign</span><span>type</span>'
      + '<span>range</span><span>alt</span></div>' + list.map((a) => `
      <button class="oh-row" data-hex="${esc(a.hex)}" aria-pressed="${a.hex === sel}">
        <span class="oh-cs" style="color:color-mix(in srgb, ${altColour(a.alt, a.gnd)} 80%, var(--ink))">${esc(a.cs || a.reg || a.hex)}</span>
        <span class="oh-t">${esc(a.type || '')}</span>
        <span class="oh-d">${(a.dst ?? 0).toFixed(1)} nm</span>
        <span class="oh-a">${a.alt == null ? '—' : `${(a.alt / 1000).toFixed(1)}k`}</span>
      </button>`).join('');
    for (const b of $('o-near').querySelectorAll('.oh-row')) {
      b.addEventListener('click', () => { select(b.dataset.hex); renderNear(); });
    }
  }

  /** Sun, moon and the ISS: where to point your face. */
  function renderSky() {
    const o = here();
    const now = new Date(store.cursor);
    const s = sunPosition(now, o.lat, o.lon);
    const mo = moonPosition(now, o.lat, o.lon);
    const line = (name, alt, az, colour) => {
      const up = alt > 0;
      return `<div class="kv"><dt style="color:${colour}">${name}</dt><dd>${
        up ? `${alt.toFixed(0)}° up, ${compass(az)}` : '<span class="dim">below the horizon</span>'
      }</dd></div>`;
    };
    const out = [
      line('Sun', toDeg(s.altitude), toCompass(s.azimuth), '#f2b45a'),
      line('Moon', toDeg(mo.altitude), toCompass(mo.azimuth), '#7fb2f0'),
    ];
    out.push(iss && iss.alt > 0
      ? line('ISS', iss.alt, iss.az, '#8fdc6a')
      : '<div class="kv"><dt style="color:#8fdc6a">ISS</dt><dd><span class="dim">'
        + `${iss ? `below the horizon, ${iss.range.toLocaleString()} km away` : 'no fix'}`
        + '</span></dd></div>');
    // The sun and moon follow the scrubber, so the header must not claim "now".
    const drift = Math.abs(store.cursor - Date.now());
    $('o-lookwhen').textContent = drift < 6 * 60e3
      ? 'NOW' : `${store.fmt.weekday(store.cursor)} ${store.fmt.hm(store.cursor)}`;
    $('o-sky').innerHTML = out.join('')
      + '<p class="hint">Aircraft positions from adsb.lol under ODbL; routes and '
      + 'airframes from adsbdb. Both are run by volunteers.</p>';
  }

  function renderStamp() {
    const airborne = planes.filter((a) => !a.gnd).length;
    $('o-count').textContent = `${airborne} AIRCRAFT`;
    const age = at ? Math.round((Date.now() - at) / 1000) : null;
    $('o-age').textContent = age == null ? '—'
      : age < 20 ? 'LIVE' : `${age}s AGO`;
  }

  /* --------------------------------------------------------------- polling */

  async function poll() {
    if (store.view !== 'overhead' || !store.loc) return;
    try {
      const r = await api.aircraft(store.loc.lat, store.loc.lon, 60);
      planes = r.aircraft || [];
      at = r.at || Date.now();
      source = r.source;
      // The selection survives a refresh; the aircraft may not.
      if (sel && !planes.some((a) => a.hex === sel)) select(null);
      renderStamp(); renderNear(); renderSel();
      map.invalidate();
    } catch { /* keep the last sample rather than blanking the map */ }
  }

  async function pollISS() {
    if (store.view !== 'overhead' || !store.loc) return;
    try {
      const r = await api.iss();
      if (r.pos?.ok) {
        const p = r.pos.data;
        iss = topocentric(store.loc.lat, store.loc.lon, p.latitude, p.longitude, p.altitude);
        renderSky();
      }
    } catch { /* leave the previous fix in place */ }
  }

  /* ---------------------------------------------------------------- wiring */

  $('o-center').addEventListener('click', () => {
    if (store.loc) map.setView(store.loc.lat, store.loc.lon, 9);
  });
  $('o-zin').addEventListener('click', () => map.setView(map.lat, map.lon, map.zoom + 1));
  $('o-zout').addEventListener('click', () => map.setView(map.lat, map.lon, map.zoom - 1));

  store.on('loc', () => {
    if (!store.loc) return;
    map.setView(store.loc.lat, store.loc.lon, 9);
    poll(); pollISS();
  });

  renderSel();
  renderSky();

  store.on('cursor', () => { if (store.view === 'overhead') renderSky(); });

  return {
    map,                    // reachable through ATMOS.views, as the radar's is
    update() { renderSky(); map.invalidate(); },
    onShow() {
      map.resize();
      poll(); pollISS();
      clearInterval(timer);
      // Polling runs only while the view is on screen: this is somebody's
      // hobby server, and a tab left open overnight is 8,640 requests.
      timer = setInterval(() => { poll(); renderStamp(); }, REFRESH);
    },
    onHide() { clearInterval(timer); timer = null; },
  };
}
