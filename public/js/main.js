/**
 * Boot, main loop, routing and global input.
 *
 * One requestAnimationFrame loop drives everything that moves: the sky
 * shader, the playing time-scrubber, and the clock. Views re-render on
 * store events rather than per frame, so idling costs one shader pass.
 */

import { store } from './state.js';
import { api } from './api.js';
import { escapeHtml } from './lib/util.js';
import { perf, initPerf, sampleFrame, setManualQuality } from './perf.js';
import { Sky } from './gl/sky.js';
import { createTimeline } from './timeline.js';
import { clearInspect } from './charts.js';
import { createDeck } from './views/deck.js';
import { createRadar } from './views/radar.js';
import { createSkyView } from './views/sky.js';
import { createAir } from './views/air.js';
import { createData } from './views/data.js';
import { createOverhead } from './views/overhead.js';
import { initAudio, setAudioEnabled, updateAudio, isAudioOn } from './audio.js';
import { showBriefing } from './brief.js';

const VIEWS = ['deck', 'radar', 'sky', 'air', 'data', 'overhead'];
const REFRESH_MS = 5 * 60_000;

const el = {
  sky: document.getElementById('sky'),
  boot: document.getElementById('boot'),
  bootLog: document.getElementById('bootLog'),
  led: document.getElementById('led'),
  locBtn: document.getElementById('locBtn'),
  locName: document.getElementById('locName'),
  locSub: document.getElementById('locSub'),
  nav: document.getElementById('nav'),
  clockTime: document.getElementById('clockTime'),
  clockZone: document.getElementById('clockZone'),
  alertBtn: document.getElementById('alertBtn'),
  soundBtn: document.getElementById('soundBtn'),
  briefBtn: document.getElementById('briefBtn'),
  cfgBtn: document.getElementById('cfgBtn'),
  scrub: document.getElementById('scrub'),
  modal: document.getElementById('modal'),
  modalCard: document.getElementById('modalCard'),
};

const sky = new Sky(el.sky);
let timeline = null;
const views = {};

/* ------------------------------------------------------------------ boot */

const bootLines = [];
function boot(text, cls = '') {
  bootLines.push(cls ? `<span class="${cls}">${text}</span>` : text);
  el.bootLog.innerHTML = bootLines.join('\n');
}

async function start() {
  boot('ATMOS//NET v1.0.0');
  boot('<span class="mut">initialising atmospheric console…</span>');

  initPerf();
  // ?q=0..3 pins the render tier — useful for debugging and for slow remote
  // displays where the adaptive heuristic has nothing good to measure.
  const qParam = new URLSearchParams(location.search).get('q');
  if (qParam !== null && /^[0-3]$/.test(qParam)) setManualQuality(+qParam);
  boot(`render tier ${perf.tier} · ${perf.onBattery ? 'battery' : 'AC power'}`, 'ok');

  const glOk = sky.init();
  sky.setQuality(perf.tier);
  boot(glOk ? 'webgl2 sky renderer online' : 'webgl2 unavailable — sky disabled', glOk ? 'ok' : 'err');
  perf.onChange((t) => sky.setQuality(t));

  // Location: whatever we used last, else whatever the backend suggests.
  let loc = store.loc;
  let cfg = null;
  if (!loc) {
    cfg = await api.config();
    loc = cfg.home;
    boot(`no saved location — using ${escapeHtml(loc.name)}`);
  } else {
    boot(`location: ${escapeHtml(loc.name)}`);
  }

  boot('<span class="mut">contacting feeds…</span>');
  /*
   * On a public deployment the starting location is a neutral placeholder, not
   * something the visitor picked, so it must not be persisted — otherwise a
   * later visit would treat it as a choice and never offer to use their own.
   */
  await store.setLocation(loc, { remember: !cfg?.public });

  const b = store.raw;
  boot(`open-meteo forecast  ${b?.forecast?.ok ? 'OK' : 'FAIL'}`, b?.forecast?.ok ? 'ok' : 'err');
  boot(`open-meteo air       ${b?.air?.ok ? 'OK' : 'FAIL'}`, b?.air?.ok ? 'ok' : 'err');
  boot(`nws alerts           ${b?.alerts?.ok ? 'OK' : 'FAIL'}`, b?.alerts?.ok ? 'ok' : 'err');
  boot(`noaa swpc space wx   ${b?.space?.ok ? 'OK' : 'FAIL'}`, b?.space?.ok ? 'ok' : 'err');
  boot(`${store.hours.length} hourly steps · ${store.days.length} days · ${store.min15.length} 15-min steps`, 'ok');

  mountUI();
  boot('console ready', 'ok');

  setTimeout(() => {
    el.boot.classList.add('done');
    // Snap the sky to the current moment so it doesn't ease in from nothing.
    const p = store.skyParams();
    if (p) sky.snap(p);
  }, 480);

  loop();
  setInterval(() => { if (!document.hidden) store.refresh(); }, REFRESH_MS);

  maybeGeolocate(cfg);
}

/* -------------------------------------------------------------- mount UI */

function mountUI() {
  timeline = createTimeline(el.scrub);

  views.deck = createDeck(document.getElementById('view-deck'));
  views.radar = createRadar(document.getElementById('view-radar'));
  views.sky = createSkyView(document.getElementById('view-sky'));
  views.air = createAir(document.getElementById('view-air'));
  views.data = createData(document.getElementById('view-data'));
  views.overhead = createOverhead(document.getElementById('view-overhead'));

  const rerender = () => {
    const v = views[store.view];
    if (v?.update) v.update();
  };

  store.on('data', () => { rerender(); refreshChrome(); });
  store.on('cursor', () => { rerender(); pushSky(); });
  store.on('climate', rerender);
  store.on('models', rerender);
  store.on('pollen', rerender);
  store.on('observed', rerender);
  store.on('radar', rerender);
  store.on('loc', refreshChrome);
  store.on('status', (s) => { el.led.dataset.state = s === 'ok' ? '' : s; });

  el.nav.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-view]');
    if (b) setView(b.dataset.view);
  });

  el.locBtn.addEventListener('click', openSearch);
  el.alertBtn.addEventListener('click', openAlerts);
  el.briefBtn.addEventListener('click', () => showBriefing(store, openModal));
  el.cfgBtn.addEventListener('click', openSettings);
  el.soundBtn.addEventListener('click', toggleSound);

  el.modal.addEventListener('click', (e) => { if (e.target === el.modal) closeModal(); });

  // A laptop lid re-opened after hours should show now, not then.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { nowAccum = 0; store.syncToNow(); }
  });

  window.addEventListener('resize', () => { sky.resize(); });
  document.addEventListener('keydown', onKey);

  window.addEventListener('hashchange', () => setView(location.hash.slice(1), { push: false }));
  const initial = location.hash.slice(1);
  if (VIEWS.includes(initial) && initial !== 'deck') setView(initial);
  else document.documentElement.style.setProperty('--stage-dim', '0.25');

  refreshChrome();
  rerender();
}

function refreshChrome() {
  const l = store.loc;
  if (l) {
    el.locName.textContent = l.name;
    el.locSub.textContent = [l.admin1, l.country].filter(Boolean).join(' · ') || `${l.lat.toFixed(2)}, ${l.lon.toFixed(2)}`;
  }
  el.clockZone.textContent = store.tz.split('/').pop().replace(/_/g, ' ');
  el.alertBtn.dataset.n = String(store.alerts.length);
  el.soundBtn.classList.toggle('on', isAudioOn());
}

/* ---------------------------------------------------------------- routing */

function setView(v, { push = true } = {}) {
  if (!VIEWS.includes(v) || store.view === v) return;
  // Tell the view being left, so anything it polls can stand down.
  views[store.view]?.onHide?.();
  store.view = v;
  // A readout tapped onto a chart belongs to the view you were looking at.
  clearInspect();
  // Deep-linkable: reload or bookmark lands on the same view.
  if (push && location.hash.slice(1) !== v) history.replaceState(null, '', '#' + v);
  for (const b of el.nav.querySelectorAll('button')) {
    b.setAttribute('aria-selected', String(b.dataset.view === v));
  }
  for (const s of document.querySelectorAll('.view')) {
    s.classList.toggle('active', s.dataset.view === v);
  }
  // The deck lets the sky through; data-dense views dim it for legibility.
  document.documentElement.style.setProperty('--stage-dim', v === 'deck' ? '0.25' : '0.72');
  const view = views[v];
  if (view?.update) view.update();
  if (view?.onShow) view.onShow();
}

/* ------------------------------------------------------------------ loop */

let last = performance.now();
let skyAccum = 0;
let nowAccum = 0;

// How often the cursor re-syncs to wall-clock time while following. Well
// inside the model's rate of change, and the hero rounds to whole degrees, so
// nothing visibly stutters.
const FOLLOW_INTERVAL = 20;

function loop(now = performance.now()) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  sampleFrame(dt);

  if (!document.hidden) {
    sky.render(now, dt);
    timeline?.tick(dt);

    // Keep the cursor on real time. Driven from the rAF loop rather than a
    // timer so it naturally stops while the tab is hidden; visibilitychange
    // snaps it forward again on return.
    nowAccum += dt;
    if (nowAccum > FOLLOW_INTERVAL) { nowAccum = 0; store.syncToNow(); }

    // The sky follows the cursor continuously while playing, and otherwise
    // re-syncs a few times a second so real time keeps it honest.
    skyAccum += dt;
    if (store.playing || skyAccum > 0.25) { skyAccum = 0; pushSky(); }

    tickClock(now);
    updateAudio(store);
  }
}

function pushSky() {
  const p = store.skyParams();
  if (p) sky.set(p);
}

let lastClock = 0;
function tickClock(now) {
  if (now - lastClock < 500) return;
  lastClock = now;
  el.clockTime.textContent = store.fmt.hms(Date.now());
}

/* ----------------------------------------------------------------- modal */

export function openModal(html, onMount) {
  el.modalCard.innerHTML = html;
  el.modal.hidden = false;
  if (onMount) onMount(el.modalCard);
}
export function closeModal() {
  el.modal.hidden = true;
  el.modalCard.innerHTML = '';
}

/* -------------------------------------------------------------- search UI */

function openSearch() {
  openModal(`
    <div class="hd">LOCATION<span class="rule"></span><span class="val">ENTER TO SELECT · ESC TO CLOSE</span></div>
    <input class="search-input" id="q" placeholder="search any city, or paste  lat, lon" autocomplete="off" spellcheck="false">
    <button class="tl-btn" id="useloc" style="margin-top:8px">◎ USE MY LOCATION</button>
    <div class="res-list" id="res"></div>
  `, (card) => {
    const q = card.querySelector('#q');
    const res = card.querySelector('#res');
    let items = [], sel = 0, timer = null;

    const renderFavs = () => {
      items = store.favorites.map((f) => ({ ...f, fav: true }));
      paint('SAVED');
    };

    const paint = (title) => {
      if (!items.length) {
        res.innerHTML = `<h3>${title}</h3><div class="nodata">no results</div>`;
        return;
      }
      res.innerHTML = `<h3>${title}</h3>` + items.map((r, i) => `
        <div class="res-item ${i === sel ? 'sel' : ''}" data-i="${i}">
          <div>
            <b>${escape2(r.name)}</b><br>
            <span>${escape2([r.admin1, r.country || r.country_code].filter(Boolean).join(' · '))}</span>
          </div>
          <span class="coord">${(+r.latitude).toFixed(2)}, ${(+r.longitude).toFixed(2)}</span>
          ${r.fav ? `<button class="rm" data-rm="${i}" title="Remove">×</button>` : ''}
        </div>`).join('');
    };

    const choose = async (i) => {
      const r = items[i];
      if (!r) return;
      store.addFavorite(r);
      closeModal();
      await store.setLocation(r);
      pushSky();
    };

    res.addEventListener('click', (e) => {
      const rm = e.target.closest('[data-rm]');
      if (rm) {
        e.stopPropagation();
        store.removeFavorite(+rm.dataset.rm);
        renderFavs();
        return;
      }
      const it = e.target.closest('[data-i]');
      if (it) choose(+it.dataset.i);
    });

    q.addEventListener('input', () => {
      clearTimeout(timer);
      const v = q.value.trim();
      if (!v) { renderFavs(); return; }

      // Accept a raw coordinate pair as well as a place name.
      const m = v.match(/^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/);
      if (m) {
        const lat = +m[1], lon = +m[2];
        if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
          items = [{ name: `${lat.toFixed(4)}, ${lon.toFixed(4)}`, admin1: 'coordinate', latitude: lat, longitude: lon }];
          sel = 0; paint('COORDINATE');
          return;
        }
      }

      timer = setTimeout(async () => {
        try {
          const r = await api.geocode(v);
          items = r.results || [];
          sel = 0;
          paint('RESULTS');
        } catch { items = []; paint('RESULTS'); }
      }, 220);
    });

    q.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { sel = Math.min(items.length - 1, sel + 1); paint(res.querySelector('h3')?.textContent || ''); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); paint(res.querySelector('h3')?.textContent || ''); e.preventDefault(); }
      else if (e.key === 'Enter') { choose(sel); e.preventDefault(); }
    });

    /*
     * An explicit gesture, which browsers treat far more favourably than an
     * unsolicited prompt on load — and the only way back if the visitor
     * denied that first prompt.
     */
    const useloc = card.querySelector('#useloc');
    if (!navigator.geolocation || !window.isSecureContext) {
      useloc.remove();
    } else {
      useloc.addEventListener('click', () => {
        useloc.textContent = '◎ LOCATING…';
        navigator.geolocation.getCurrentPosition(
          async (pos) => {
            const lat = pos.coords.latitude, lon = pos.coords.longitude;
            let name = `${lat.toFixed(2)}, ${lon.toFixed(2)}`, admin1 = '', country = '';
            try {
              const r = await api.reverse(lat, lon);
              name = r.city || r.locality || r.principalSubdivision || name;
              admin1 = r.principalSubdivision || '';
              country = r.countryCode || '';
            } catch { /* a coordinate is a fine name */ }
            store.settings.geo = 'set';
            closeModal();
            await store.setLocation({
              name, admin1, country_code: country, latitude: lat, longitude: lon,
            });
            pushSky();
          },
          (err) => {
            useloc.textContent = err.code === err.PERMISSION_DENIED
              ? '◎ LOCATION BLOCKED IN BROWSER'
              : '◎ LOCATION UNAVAILABLE';
          },
          { timeout: 8000, maximumAge: 30 * 60_000 },
        );
      });
    }

    renderFavs();
    q.focus();
  });
}

function openAlerts() {
  const a = store.alerts;
  if (!a.length) {
    openModal(`<div class="hd">ALERTS<span class="rule"></span></div>
      <div class="nodata">no active watches, warnings or advisories for this location</div>`);
    return;
  }
  openModal(`
    <div class="hd" style="--ac:var(--rd)">ACTIVE ALERTS<span class="rule"></span><span class="val">${a.length}</span></div>
    <div class="res-list">
      ${a.map((x) => `
        <div style="padding:10px 0;border-bottom:1px solid rgba(255,255,255,.06)">
          <b style="color:#f47171;font-size:.82rem;letter-spacing:.08em">${escape2(x.event)}</b>
          <div style="font-family:var(--mono);font-size:max(.6rem,var(--fs-floor,0px));color:var(--faint);margin:3px 0 6px">
            ${escape2(x.senderName || '')} · until ${store.fmt.weekday(x.expires)} ${store.fmt.hm(x.expires)}
          </div>
          <div style="font-size:max(.72rem,var(--fs-floor,0px));color:var(--dim);line-height:1.5;white-space:pre-wrap">${escape2((x.description || '').slice(0, 900))}</div>
          ${x.instruction ? `<div style="margin-top:7px;font-size:max(.7rem,var(--fs-floor,0px));color:var(--am);line-height:1.5">${escape2(x.instruction.slice(0, 400))}</div>` : ''}
        </div>`).join('')}
    </div>
  `);
}

function openSettings() {
  const q = perf.manual;
  openModal(`
    <div class="hd">SETTINGS<span class="rule"></span><span class="val">ATMOS//NET v1.0.0</span></div>
    <div class="setrow">
      <label>Render quality<span class="hint">Auto adapts to power state and measured frame rate</span></label>
      <div class="seg" id="qseg">
        ${['auto', '0', '1', '2', '3'].map((v) => `<button data-q="${v}" class="${String(q) === v || (q == null && v === 'auto') ? 'on' : ''}">${v}</button>`).join('')}
      </div>
    </div>
    <div class="setrow">
      <label>Ambient audio<span class="hint">Generative soundscape matched to live conditions</span></label>
      <div class="seg"><button id="sndT" class="${isAudioOn() ? 'on' : ''}">${isAudioOn() ? 'on' : 'off'}</button></div>
    </div>
    <div class="setrow">
      <label>Spoken briefing<span class="hint">Reads the briefing aloud when opened</span></label>
      <div class="seg"><button id="voiceT" class="${store.settings.voice ? 'on' : ''}">${store.settings.voice ? 'on' : 'off'}</button></div>
    </div>
    <h3>Keyboard</h3>
    <div class="keyhelp">
      ${[['1–5', 'switch view'], ['Space', 'play / pause forecast'], ['← →', 'step 1 hour'],
         ['Shift ← →', 'step 6 hours'], ['N', 'return to now'], ['/', 'search location'],
         ['A', 'alerts'], ['B', 'briefing'], ['S', 'ambient audio'], ['F', 'fullscreen'],
         [',', 'settings'], ['Esc', 'close']]
        .map(([k, d]) => `<div><span>${d}</span><kbd>${k}</kbd></div>`).join('')}
    </div>
    <h3>Data sources</h3>
    <div style="font-size:max(.66rem,var(--fs-floor,0px));color:var(--dim);line-height:1.7">
      Open-Meteo (forecast · air quality · 1994– archive · multi-model ensemble) ·
      NWS api.weather.gov (US alerts) · RainViewer (radar) ·
      NOAA SWPC (space weather) · pollen.com (US pollen) · Esri (map tiles)
    </div>
  `, (card) => {
    card.querySelector('#qseg').addEventListener('click', (e) => {
      const b = e.target.closest('[data-q]');
      if (!b) return;
      setManualQuality(b.dataset.q === 'auto' ? null : +b.dataset.q);
      card.querySelectorAll('[data-q]').forEach((x) => x.classList.toggle('on', x === b));
    });
    card.querySelector('#sndT').addEventListener('click', (e) => {
      toggleSound();
      e.target.textContent = isAudioOn() ? 'on' : 'off';
      e.target.classList.toggle('on', isAudioOn());
    });
    card.querySelector('#voiceT').addEventListener('click', (e) => {
      store.settings.voice = !store.settings.voice;
      store.save();
      e.target.textContent = store.settings.voice ? 'on' : 'off';
      e.target.classList.toggle('on', store.settings.voice);
    });
  });
}

function toggleSound() {
  const on = !isAudioOn();
  initAudio();
  setAudioEnabled(on);
  store.settings.sound = on;
  store.save();
  el.soundBtn.classList.toggle('on', on);
}

/**
 * Offer to use the visitor's own location.
 *
 * Public deployments only — locally and over the tailnet the backend's
 * configured home is already correct, and geolocation needs a secure context
 * which `http://<tailnet-ip>:7777` is not.
 *
 * Never awaited: an unanswered permission prompt can sit indefinitely without
 * firing either callback, which would hang the boot screen. The console is
 * already live on the fallback by the time this runs, and simply snaps to the
 * real location a moment later.
 */
function maybeGeolocate(cfg) {
  if (!cfg?.public) return;
  if (store.settings.geo) return;              // already asked, once, ever
  if (!navigator.geolocation || !window.isSecureContext) return;

  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const lat = pos.coords.latitude, lon = pos.coords.longitude;
      let name = `${lat.toFixed(2)}, ${lon.toFixed(2)}`, admin1 = '', country = '';
      try {
        const r = await api.reverse(lat, lon);
        name = r.city || r.locality || r.principalSubdivision || name;
        admin1 = r.principalSubdivision || '';
        country = r.countryCode || '';
      } catch { /* a coordinate is a fine name */ }
      store.settings.geo = 'set';
      await store.setLocation({
        name, admin1, country_code: country, latitude: lat, longitude: lon,
      });
      pushSky();
    },
    (err) => {
      /*
       * Only a denial is permanent. A timeout or an unavailable fix may well
       * succeed next visit, so leave the marker unset in those cases.
       *
       * On denial, save explicitly: setLocation() assigns store.loc even when
       * remember is false, so any later save() — toggling audio, adding a
       * favourite — would otherwise persist the fallback as if it were chosen.
       * Doing it here makes the outcome deterministic instead of incidental.
       */
      if (err.code === err.PERMISSION_DENIED) {
        store.settings.geo = 'denied';
        store.save();
      }
    },
    { timeout: 8000, maximumAge: 30 * 60_000, enableHighAccuracy: false },
  );
}

/* -------------------------------------------------------------- keyboard */

function onKey(e) {
  // Never hijack typing.
  if (e.target.matches('input, textarea, [contenteditable]')) {
    if (e.key === 'Escape') { closeModal(); e.target.blur(); }
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  const k = e.key;
  if (k === 'Escape') { closeModal(); return; }
  if (k >= '1' && k <= '6') { setView(VIEWS[+k - 1]); return; }

  switch (k.toLowerCase()) {
    case ' ':
      store.playing = !store.playing;
      // As the footer's button: a departure from live, except on the radar.
      if (store.playing && store.view !== 'radar') store.following = false;
      if (store.playing && store.cursor >= store.span.hi - 60e3) store.setCursor(Date.now());
      store.emit('play', store.playing);
      e.preventDefault();
      break;
    case 'arrowleft':
      store.playing = false;
      store.scrubTo(store.cursor - (e.shiftKey ? 6 : 1) * 3600e3);
      e.preventDefault();
      break;
    case 'arrowright':
      store.playing = false;
      store.scrubTo(store.cursor + (e.shiftKey ? 6 : 1) * 3600e3);
      e.preventDefault();
      break;
    case 'n': store.toNow(); break;
    case '/': openSearch(); e.preventDefault(); break;
    case 'a': openAlerts(); break;
    case 'b': showBriefing(store, openModal); break;
    case 's': toggleSound(); break;
    case ',': openSettings(); break;
    case 'r': store.refresh(); break;
    case 'f':
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen?.();
      break;
    default: break;
  }
}

// Local alias for the shared escaper, kept short for readability in templates.
const escape2 = escapeHtml;

/* ------------------------------------------------------------------ go */

start().catch((err) => {
  console.error(err);
  boot(`FATAL: ${err.message}`, 'err');
});

// Expose for console debugging; harmless and very useful while iterating.
// `views` is also how scripts/pinch-audit.mjs reaches the radar map: there is
// no DOM readout of where the map is, and a gesture test has to be able to
// ask.
window.ATMOS = { store, sky, perf, setView, views };
