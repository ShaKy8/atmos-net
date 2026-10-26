/**
 * STORMS — the hurricane atlas, a mode of RADAR.
 *
 * Every Atlantic and East/Central Pacific tropical cyclone in NHC's
 * best-track archive that came near the visitor, drawn on the radar's map:
 * faint by default, tap one to replay it, or sweep through the years and
 * watch each season's storms grow. The rules (distances, categories, season
 * progress) are in lib/storms.js; this file draws and listens.
 *
 * The archive is a snapshot built by scripts/fetch-storms.mjs and read from
 * our own origin (/storms/), never from NHC. It is loaded when this mode is
 * first opened, and this whole file with it: RADAR's own bundle does not carry
 * it. Without the snapshot (the standalone Weather server has none) the panel
 * says so and RADAR is otherwise unchanged.
 *
 * It owns its own clock. The footer's scrubber is tied to the forecast
 * window, which a storm from 1992 can never be inside, so a replay has its own
 * playhead and the radar's loop stands down while this mode is on.
 */

import { store } from '../state.js';
import { api } from '../api.js';
import { alpha, haloText, DIM, FAINT, INK, SERIES } from '../charts.js';
import { escapeHtml as esc } from '../lib/util.js';
import { decodeArchive, decodeRadii, STATUS_NAME, unwrapLon } from '../lib/stormpack.js';
import * as S from '../lib/storms.js';

const NEAR_MI = 500;
const RINGS_MI = [100, 150];
const YEARS_PER_SECOND = 5;
const REPLAY_SECONDS = 9;
const PICK_PX = 24;
const LIVE_TICK_MS = 60000;           // the live panel's ages are redrawn every minute
const LIVE_POLL_MS = 180000;          // and NHC is asked again every three minutes
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const BASIN_NAME = { AL: 'Atlantic', EP: 'East Pacific', CP: 'Central Pacific' };

/** "Sep 11, 1976, 03Z" — the archive's own UTC, with no locale to get wrong. */
function when(ms, withHour = false) {
  const d = new Date(ms);
  const day = `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
  return withHour ? `${day}, ${String(d.getUTCHours()).padStart(2, '0')}Z` : day;
}

const mi = (km) => km / S.KM_PER_MI;
const wrap180 = (d) => ((((d + 180) % 360) + 360) % 360) - 180;

async function getJSON(url) {
  const res = await fetch(url);
  if (res.status === 404) { const e = new Error('absent'); e.absent = true; throw e; }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function createStorms({ map, panel, hud, root }) {
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  let active = false;
  let visible = true;                 // the RADAR view is on screen
  let state = 'idle';                 // idle | loading | ready | absent | fail
  let storms = [];
  let index = null;
  let near = [];                      // nearbyStorms() for the current place
  let selected = null;                // a decoded storm
  let replay = { t: 0, playing: false };
  let sweep = { on: false, p: 0, first: 1851, last: 2025 };
  let loopId = 0, lastFrame = 0;
  let overlayAdded = false;
  // The live layer (/api/storms). 'idle' until asked; 'fail' means the CHECK failed,
  // which is never the same as "no storms": see renderLive().
  let live = { state: 'idle', data: null, at: 0, lastOk: 0 };
  let liveStorms = [];                // data.storms, each with unwrapped longitudes ready to draw
  let liveSel = null;                 // id of the live storm the YOU card is about
  let liveTimer = 0;
  const analogCache = new Map();      // `${storm}|${last fix}` -> { res, nexts }: the match is worked out once per fix
  let analogSel = null;               // the id of the similar past storm the visitor opened
  const modelsOff = new Set();        // model keys the visitor has switched off (session only)
  // Wind radii, by basin file ('AL' | 'EP'): 'idle' | 'loading' | Map | 'fail' | 'absent'.
  const radiiFiles = { AL: 'idle', EP: 'idle' };

  const $ = (sel) => panel.querySelector(sel);
  const place = () => store.loc;

  /* ------------------------------------------------------------- data */

  async function load() {
    if (state === 'loading' || state === 'ready') return;
    state = 'loading';
    render();
    try {
      const base = new URL('/storms/', location.origin);
      index = await getJSON(new URL('index.json', base));
      const [al, ep] = await Promise.all(['al', 'ep'].map((b) => getJSON(new URL(index.files[b], base))));
      storms = [...decodeArchive(al), ...decodeArchive(ep)];
      state = 'ready';
      locate();
      prepareLive();
    } catch (e) {
      state = e.absent ? 'absent' : 'fail';
      if (!e.absent) console.error('[storms]', e);
    }
    render();
    renderLive();                      // a live storm's similar-storms section waits on the archive
    map.invalidate();
  }

  /** Recompute what is near the current place. */
  function locate() {
    const p = place();
    near = state === 'ready' && p ? S.nearbyStorms(storms, p.lat, p.lon, NEAR_MI * S.KM_PER_MI) : [];
    if (near.length) {
      sweep.first = Math.min(...near.map((n) => n.storm.year));
      sweep.last = Math.max(...near.map((n) => n.storm.year));
    }
  }

  /* -------------------------------------------------------------- live */

  const advisoryHours = (st, now) => S.advisoryAge(st, now);

  /**
   * The past storms whose track looked most like this live storm's, with what
   * each did next. Needs the archive, so it is null until that has loaded.
   * Worked out once per best-track fix and kept: it is ~40 ms over the whole
   * archive, and the panel redraws every minute.
   */
  function analogsFor(st) {
    if (state !== 'ready' || !st._track.n) return null;
    const key = `${st.id}|${st._track.t[st._track.n - 1]}`;
    if (!analogCache.has(key)) {
      const res = S.analogs(st._track, storms, { k: 5 });
      const nexts = res.results.map((r) => S.nextAfter(r));
      res.results.forEach((r) => { let i = 0; while (i < r.storm.n - 1 && r.storm.t[i] < r.startT) i++; r.i0w = i; });
      analogCache.clear();
      analogCache.set(key, { res, nexts });
    }
    return analogCache.get(key);
  }

  /** Shift a ring's longitudes so it is contiguous and sits nearest `ref`. */
  function nearRing(ring, ref) {
    let prev = null;
    return ring.map(([lo, la]) => {
      prev = prev == null ? lo + 360 * Math.round((ref - lo) / 360) : unwrapLon(prev, lo);
      return [prev, la];
    });
  }

  /**
   * Ready a live storm for drawing: its best track as an archive-shaped
   * storm with unwrapped longitudes, its forecast continuing from the last
   * best fix, and its cone moved to the same side of the dateline.
   */
  function prepareLive() {
    const now = Date.now();
    liveStorms = (live.data ? live.data.storms : []).map((st) => {
      const track = { n: 0, t: new Float64Array(0), lat: new Float32Array(0), lon: new Float32Array(0), wind: new Int16Array(0), status: '', land: [] };
      const f = st.best || [];
      Object.assign(track, { n: f.length, t: Float64Array.from(f, (x) => x.t), lat: Float32Array.from(f, (x) => x.lat), wind: Int16Array.from(f, (x) => (x.wind == null ? -99 : x.wind)) });
      let prev = f.length ? f[0].lon : (st.lon ?? 0);
      track.lon = Float32Array.from(f, (x, i) => { prev = i ? unwrapLon(prev, x.lon) : x.lon; return prev; });
      const ref = f.length ? track.lon[f.length - 1] : (st.lon ?? 0);
      let q = ref;
      const fc = (st.forecast ? st.forecast.points : []).map((p) => { q = unwrapLon(q, p.lon); return { ...p, lon: q }; });
      const cone = [];
      for (const ft of (st.cone && st.cone.features) || []) {
        const g = ft.geometry;
        const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
        for (const rings of polys) cone.push(rings.map((r) => nearRing(r, ref)));
      }
      // Each model's run, unwrapped from the storm's side of the dateline, with its age against NHC's forecast.
      const runs = S.MODELS.filter((md) => st.models && st.models[md.key]).map((md) => {
        const run = st.models[md.key];
        let mq = ref;
        const pts = run.points.map((p) => { mq = unwrapLon(mq, p.lon); return { ...p, lon: mq }; });
        const lag = S.runLag(run.cycle, st.forecast && st.forecast.cycle);
        return { ...md, cycle: run.cycle, pts, lag, old: S.isOldRun(lag) };
      });
      const age = advisoryHours(st, now);
      return {
        ...st, _track: track, _fc: fc, _cone: cone, _ref: ref, _runs: runs, _an: analogsFor({ ...st, _track: track }),
        _lat: f.length ? track.lat[f.length - 1] : st.lat, _lon: ref, _age: age, _stale: S.staleness(age),
      };
    });
    const here = place();
    const cards = liveStorms.map((st) => ({ st, card: here ? S.youCard(st.forecast, here, st.cone, now) : null }));
    cards.sort((a, b) => (a.card ? a.card.km : Infinity) - (b.card ? b.card.km : Infinity));
    if (!liveStorms.some((x) => x.id === liveSel)) liveSel = cards.length ? cards[0].st.id : null;
  }

  async function pollLive() {
    if (live.state !== 'ok') live = { ...live, state: 'loading' };
    try {
      const d = await api.storms();
      if (!d || !Array.isArray(d.storms) || typeof d.activeCount !== 'number') throw new Error('unexpected /api/storms answer');
      const had = liveStorms.length;
      live = { state: 'ok', data: d, at: Date.now(), lastOk: Date.now() };
      prepareLive();
      if (!had && liveStorms.length) fitLive();
    } catch (e) {
      console.error('[storms] live', e);
      live = { ...live, state: 'fail', at: Date.now() };
      prepareLive();
    }
    renderLive();
    frame();
  }

  function startLive() {
    stopLive();
    if (!active || !visible) return;
    if (!live.at || Date.now() - live.at >= LIVE_POLL_MS) pollLive(); else renderLive();
    liveTimer = setInterval(() => {
      if (!active || !visible || document.hidden) return;
      if (Date.now() - live.at >= LIVE_POLL_MS) pollLive();
      else { prepareLive(); renderLive(); map.invalidate(); }
    }, LIVE_TICK_MS);
  }

  function stopLive() {
    if (liveTimer) clearInterval(liveTimer);
    liveTimer = 0;
  }

  /* --------------------------------------------------------- wind radii */

  const radiiKey = (s) => (s.basin === 'AL' ? 'AL' : 'EP');   // Central Pacific storms are in the East Pacific file

  /** The radii map for a storm's basin once loaded, else null. */
  function radiiMapFor(s) {
    const m = radiiFiles[radiiKey(s)];
    return m instanceof Map ? m.get(s.id) || new Map() : null;
  }

  /** The measured wind radii of the replayed storm at time t, or null. */
  function windOf(s, t) {
    return S.radiiAt(s, radiiMapFor(s), t);          // { known, r }
  }

  /** Fetch the basin's radii file when a storm that can have radii is chosen. */
  async function ensureRadii(s) {
    if (s.year < S.RADII_FROM_YEAR) return;
    const key = radiiKey(s);
    if (radiiFiles[key] !== 'idle') return;
    const name = index && index.files && index.files[key.toLowerCase() + 'r'];
    if (!name) { radiiFiles[key] = 'absent'; return; }
    radiiFiles[key] = 'loading';
    try {
      radiiFiles[key] = decodeRadii(await getJSON(new URL(name, new URL('/storms/', location.origin))));
    } catch (e) {
      radiiFiles[key] = e.absent ? 'absent' : 'fail';
      if (!e.absent) console.error('[storms] radii', e);
    }
    paintWind(); map.invalidate();
  }

  /** The wind line for the replayed storm: what is measured, or why nothing is drawn. */
  function windLines() {
    const s = selected;
    if (!s) return [];
    if (s.year < S.RADII_FROM_YEAR) return [`Wind radii were not measured before ${S.RADII_FROM_YEAR}, so no wind field is drawn for ${s.year}.`];
    const st = radiiFiles[radiiKey(s)];
    if (st === 'idle' || st === 'loading') return ['Loading wind radii…'];
    if (st === 'absent' || st === 'fail') return ['Wind radii are not available.'];
    const w = windOf(s, replay.t);
    if (!w.known) return ['NHC did not measure wind radii at this time, so no wind field is drawn.'];
    return w.r ? S.radiiText(w.r) : ['No winds of tropical-storm force at this time.'];
  }

  function paintWind() {
    const el = $('#st-wind');
    if (!el) return;
    el.hidden = !selected;
    if (!selected) return;
    const lines = windLines();
    const html = `<div class="st-legend" aria-hidden="true">${S.THRESHOLDS.map((k) => `<span><i style="background:${WIND[k]}"></i>${k} KT</span>`).join('')}</div>`
      + lines.map((l) => `<div class="st-note">${esc(l)}</div>`).join('');
    // The replay repaints this every frame; rewrite the DOM only when the words change.
    if (html !== el._html) { el._html = html; el.innerHTML = html; }
  }

  /* ----------------------------------------------------------- drawing */

  const colourOf = (w) => (S.category(w) || { color: DIM }).color;

  /**
   * A storm's track in category colours, at the three world copies. `cut`
   * stops it at a time (ms), for the sweep and the replay.
   */
  function drawTrack(ctx, m, s, { a = 1, scale = 1, cut = Infinity, dots = false, from = 0, to = Infinity, dash = null } = {}) {
    const n = s.n;
    const xs = new Float64Array(n), ys = new Float64Array(n);
    let last = n - 1;
    for (let i = 0; i < n; i++) {
      if (s.t[i] > cut) { last = i - 1; break; }
      [xs[i], ys[i]] = m.project(s.lat[i], s.lon[i]);
    }
    if (last < 0) return;
    const W = 256 * 2 ** m.zoom;
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i <= last; i++) { lo = Math.min(lo, xs[i]); hi = Math.max(hi, xs[i]); }
    ctx.save();
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    if (dash) ctx.setLineDash(dash);
    const upto = Math.min(last, to);
    for (const off of [-W, 0, W]) {
      if (hi + off < -40 || lo + off > m.w + 40) continue;
      for (let i = from; i < upto; i++) {
        const c = S.category(S.windAt(s, i));
        ctx.strokeStyle = alpha(c ? c.color : DIM, a);
        ctx.lineWidth = (c ? c.width : 1.2) * scale;
        ctx.beginPath(); ctx.moveTo(xs[i] + off, ys[i]); ctx.lineTo(xs[i + 1] + off, ys[i + 1]); ctx.stroke();
      }
      if (dots) {
        ctx.fillStyle = alpha(INK, a * 0.8);
        for (let i = 0; i <= last; i++) { ctx.beginPath(); ctx.arc(xs[i] + off, ys[i], 1.6, 0, Math.PI * 2); ctx.fill(); }
        // Landfall records: a ring, because that is where the track met land.
        ctx.strokeStyle = alpha(INK, a);
        for (const i of s.land) {
          if (i > last) continue;
          ctx.beginPath(); ctx.arc(xs[i] + off, ys[i], 4.5, 0, Math.PI * 2); ctx.stroke();
        }
      }
    }
    ctx.restore();
  }

  /** The storm's centre now: a ring and two spiral arms. */
  function drawEye(ctx, m, lat, lon, wind, spin) {
    const c = colourOf(wind);
    const W = 256 * 2 ** m.zoom;
    const [x0, y] = m.project(lat, lon);
    for (const off of [-W, 0, W]) {
      const x = x0 + off;
      if (x < -30 || x > m.w + 30 || y < -30 || y > m.h + 30) continue;
      ctx.save();
      ctx.translate(x, y); ctx.rotate(spin);
      ctx.strokeStyle = c; ctx.fillStyle = c; ctx.lineWidth = 2;
      ctx.shadowColor = c; ctx.shadowBlur = 8;
      for (let k = 0; k < 2; k++) {
        ctx.beginPath();
        ctx.arc(0, 0, 11, k * Math.PI + 0.2, k * Math.PI + 2.4);
        ctx.stroke();
      }
      ctx.beginPath(); ctx.arc(0, 0, 3, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
  }

  /** One colour per model, none of them a wind threshold's or the official line's white. */
  const MODEL_COLOUR = { AVNO: '#b39dfa', EMXI: '#7fb2f0', HFSA: '#8fdc6a', HFSB: '#f2b45a', CTCX: '#f07aa6' };

  /** The colours of the three wind thresholds, outermost first. */
  const WIND = { 34: '#3fd0d8', 50: '#f2b45a', 64: '#f47171' };

  /**
   * One storm's measured wind field around a centre: a quarter circle per
   * quadrant at each of 34, 50 and 64 knots, outermost drawn first so each
   * threshold sits inside the last. `outline` draws the 34 kt edge alone.
   */
  function drawWind(ctx, m, lat, lon, radii, { a = 1, outline = false } = {}) {
    const r = S.normRadii(radii);
    if (!r) return;
    const W = 256 * 2 ** m.zoom;
    ctx.save();
    ctx.lineJoin = 'round';
    for (const k of outline ? [34] : S.THRESHOLDS) {
      const ring = S.radiiRing(lat, lon, r[k]);
      if (!ring.length) continue;
      const pts = ring.map(([la, lo]) => m.project(la, lo));
      for (const off of [-W, 0, W]) {
        ctx.beginPath();
        pts.forEach(([x, y], i) => { if (i) ctx.lineTo(x + off, y); else ctx.moveTo(x + off, y); });
        ctx.closePath();
        if (outline) { ctx.setLineDash([4, 4]); ctx.strokeStyle = alpha(WIND[k], 0.55 * a); ctx.lineWidth = 1; ctx.stroke(); ctx.setLineDash([]); continue; }
        ctx.fillStyle = alpha(WIND[k], (k === 34 ? 0.12 : k === 50 ? 0.17 : 0.24) * a); ctx.fill();
        ctx.strokeStyle = alpha(WIND[k], 0.85 * a); ctx.lineWidth = 1.2; ctx.stroke();
      }
    }
    ctx.restore();
  }

  /**
   * Similar past storms, in their own real positions: the stretch that matched
   * (thin) and then what they did next (dotted, heavier, in their own
   * intensity colours), with a ring where the match ends and the name at the
   * far end. These are tracks that HAPPENED, to other storms.
   */
  function drawAnalogs(ctx, m, st, dim) {
    const { res, nexts } = st._an;
    res.results.forEach((r, i) => {
      const s = r.storm, nx = nexts[i];
      const a = dim * (analogSel == null ? 0.8 : analogSel === s.id ? 1 : 0.25);
      drawTrack(ctx, m, s, { a: a * 0.55, scale: 1, from: r.i0w, to: r.endIndex });
      drawTrack(ctx, m, s, { a, scale: 1.7, from: nx.i0, to: nx.i1, dash: [2, 4] });
      const W = 256 * 2 ** m.zoom;
      const [ex, ey] = m.project(s.lat[r.endIndex], s.lon[r.endIndex]);
      const [fx, fy] = m.project(s.lat[nx.i1], s.lon[nx.i1]);
      ctx.save();
      ctx.font = "600 11.5px 'Chakra Petch', sans-serif"; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      for (const off of [-W, 0, W]) {
        ctx.strokeStyle = alpha(INK, a); ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.arc(ex + off, ey, 4.5, 0, Math.PI * 2); ctx.stroke();
        if (nx.i1 > nx.i0 && (analogSel == null || analogSel === s.id)) { ctx.fillStyle = alpha(INK, a); haloText(ctx, S.titleOf(s), fx + off + 7, fy); }
      }
      ctx.restore();
    });
  }

  /** The forecast cone, the official forecast track, the best track and the storm's centre. */
  function drawLive(ctx, m, now) {
    const W = 256 * 2 ** m.zoom;
    for (const st of liveStorms) {
      const dim = st._stale === 'old' ? 0.35 : 1;      // an out-of-date forecast is drawn faint, not hidden
      ctx.save();
      for (const off of [-W, 0, W]) {
        for (const poly of st._cone) {
          ctx.beginPath();
          for (const ring of poly) {
            ring.forEach(([lo, la], i) => { const [x, y] = m.project(la, lo); if (i) ctx.lineTo(x + off, y); else ctx.moveTo(x + off, y); });
            ctx.closePath();
          }
          ctx.fillStyle = alpha(INK, 0.13 * dim); ctx.fill('evenodd');
          ctx.strokeStyle = alpha(INK, 0.55 * dim); ctx.lineWidth = 1.2; ctx.stroke();
        }
      }
      if (st._an) drawAnalogs(ctx, m, st, dim);
      // Model guidance, thin and underneath: each line is one model's own run. NHC's official line is drawn over them.
      for (const run of st._runs) {
        if (modelsOff.has(run.key)) continue;
        const a = dim * (run.old ? 0.3 : 0.75);
        ctx.lineWidth = 1.4; ctx.strokeStyle = alpha(MODEL_COLOUR[run.key], a); ctx.fillStyle = alpha(MODEL_COLOUR[run.key], a);
        for (const off of [-W, 0, W]) {
          ctx.beginPath();
          run.pts.forEach((p, i) => { const [x, y] = m.project(p.lat, p.lon); if (i) ctx.lineTo(x + off, y); else ctx.moveTo(x + off, y); });
          ctx.stroke();
          const end = run.pts[run.pts.length - 1];
          const [ex, ey] = m.project(end.lat, end.lon);
          ctx.beginPath(); ctx.arc(ex + off, ey, 2.6, 0, Math.PI * 2); ctx.fill();
        }
      }
      // The official forecast track, dashed, from where the storm is now.
      if (st._fc.length) {
        ctx.setLineDash([7, 5]); ctx.lineWidth = 2; ctx.strokeStyle = alpha(INK, 0.9 * dim);
        for (const off of [-W, 0, W]) {
          ctx.beginPath();
          const [x0, y0] = m.project(st._lat, st._lon); ctx.moveTo(x0 + off, y0);
          for (const p of st._fc) { const [x, y] = m.project(p.lat, p.lon); ctx.lineTo(x + off, y); }
          ctx.stroke();
        }
        ctx.setLineDash([]);
        ctx.font = "600 11.5px 'Chakra Petch', sans-serif"; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        for (const p of st._fc) {
          if (p.tau < 12 || p.tau % 12) continue;
          const c = S.category(p.wind);
          for (const off of [-W, 0, W]) {
            const [x, y] = m.project(p.lat, p.lon);
            ctx.fillStyle = alpha(c ? c.color : INK, dim);
            ctx.beginPath(); ctx.arc(x + off, y, 4.2, 0, Math.PI * 2); ctx.fill();
            if (p.tau % 24 === 0) { ctx.fillStyle = alpha(INK, dim); haloText(ctx, `+${p.tau}H`, x + off + 8, y); }
          }
        }
      }
      ctx.restore();
      // The measured wind field now, from the latest best-track fix; the 34 kt edge NHC forecasts for later.
      const lastFix = st.best && st.best.length ? st.best[st.best.length - 1] : null;
      if (lastFix) drawWind(ctx, m, st._lat, st._lon, lastFix.r, { a: dim });
      for (const p of st._fc) if (p.tau >= 24 && p.tau % 24 === 0) drawWind(ctx, m, p.lat, p.lon, p.r, { a: dim, outline: true });
      drawTrack(ctx, m, st._track, { a: dim, scale: 1.5 });
      drawEye(ctx, m, st._lat, st._lon, st._track.n ? (st._track.wind[st._track.n - 1] === -99 ? st.windKt : st._track.wind[st._track.n - 1]) : st.windKt, now / 300);
      ctx.save();
      ctx.font = "600 11.5px 'Chakra Petch', sans-serif"; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
      ctx.fillStyle = alpha(INK, dim);
      const [lx, ly] = m.project(st._lat, st._lon);
      haloText(ctx, `${(st.name || st.id).toUpperCase()}${st.windKt != null ? ` ${Math.round(st.windKt)} KT` : ''}`, lx + 16, ly - 8);
      ctx.restore();
    }
  }

  function drawRings(ctx, m) {
    const p = place();
    if (!p) return;
    const [ox, oy] = m.project(p.lat, p.lon);
    const mPerPx = (156543.03392 * Math.cos(p.lat * Math.PI / 180)) / 2 ** m.zoom;
    ctx.save();
    ctx.strokeStyle = alpha(SERIES[1], 0.45); ctx.lineWidth = 1; ctx.setLineDash([5, 5]);
    ctx.font = "500 11.5px 'JetBrains Mono', monospace";
    ctx.fillStyle = SERIES[1]; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    for (const r of RINGS_MI) {
      const px = (r * S.KM_PER_MI * 1000) / mPerPx;
      if (px < 18 || px > Math.max(m.w, m.h) * 1.5) continue;
      ctx.beginPath(); ctx.arc(ox, oy, px, 0, Math.PI * 2); ctx.stroke();
      haloText(ctx, `${r} MI`, ox, oy - px - 2);
    }
    ctx.restore();
  }

  function overlay(ctx, m) {
    if (!active) return;
    drawRings(ctx, m);
    const now = lastFrame;

    if (sweep.on) {
      const year = sweep.first + Math.floor(sweep.p);
      const cut = Date.UTC(year, 0, 1) + (sweep.p % 1) * 366 * 86400000;
      for (const { storm: s } of near) {
        if (s.year < year) drawTrack(ctx, m, s, { a: 0.16, scale: 0.8 });
        else if (s.year === year) {
          drawTrack(ctx, m, s, { a: 0.95, cut });
          if (s.t[0] <= cut && cut <= s.t[s.n - 1]) {
            const p = S.positionAt(s, cut);
            drawEye(ctx, m, p.lat, p.lon, p.wind, now / 300);
          }
        }
      }
    } else {
      for (const { storm: s } of near) if (s !== selected) drawTrack(ctx, m, s, { a: selected ? 0.18 : liveStorms.length ? 0.07 : 0.5 });
      // Name the closest three where they came nearest, so the map reads without the list.
      if (!selected) {
        ctx.save();
        ctx.font = "600 11.5px 'Chakra Petch', sans-serif";
        ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        near.slice(0, 3).forEach((n) => {
          const [x, y] = m.project(n.lat, n.lon);
          if (x < 0 || y < 0 || x > m.w || y > m.h) return;
          ctx.fillStyle = INK;
          haloText(ctx, S.titleOf(n.storm), x + 7, y);
        });
        ctx.restore();
      }
    }

    if (liveStorms.length) drawLive(ctx, m, now);

    if (selected) {
      drawTrack(ctx, m, selected, { a: 0.35, scale: 1.2, dots: true });
      drawTrack(ctx, m, selected, { a: 1, scale: 1.3, cut: replay.t });
      const p = S.positionAt(selected, replay.t);
      const wr = windOf(selected, replay.t);
      if (wr.r) drawWind(ctx, m, p.lat, p.lon, wr.r);
      drawEye(ctx, m, p.lat, p.lon, p.wind, now / 300);
    }
  }

  /* ------------------------------------------------------------- panel */

  function shell() {
    panel.innerHTML = `
      <div class="hd">STORMS<span class="rule"></span><span class="val" id="st-src">NHC BEST TRACKS</span></div>
      <div class="body">
        <div id="st-live"></div>
        <div id="st-status" class="st-status" role="status"></div>
        <div id="st-facts"></div>
        <div class="oh-chips" id="st-modes">
          <button class="oh-chip" id="st-sweep" aria-pressed="false" style="--chip:var(--vi)">▶ SWEEP THE YEARS</button>
        </div>
        <div id="st-replay" hidden>
          <div class="st-transport">
            <button class="tl-btn" id="st-play" aria-label="Play or pause the replay">❚❚</button>
            <input type="range" id="st-scrub" min="0" max="1000" value="0" aria-label="Replay position">
          </div>
          <div id="st-era" class="st-note"></div>
          <div id="st-wind" class="st-wind" hidden></div>
        </div>
        <div class="st-h">NEAREST TRACKS</div>
        <div id="st-list"></div>
        <div class="st-h">ON THIS DATE</div>
        <div id="st-date"></div>
        <div id="st-season"></div>
        <p class="st-note" id="st-about"></p>
      </div>`;
    $('#st-sweep').addEventListener('click', toggleSweep);
    $('#st-play').addEventListener('click', () => { replay.playing = !replay.playing; paintTransport(); kick(); });
    $('#st-scrub').addEventListener('input', (e) => {
      if (!selected) return;
      replay.playing = false;
      replay.t = selected.t[0] + (e.target.value / 1000) * (selected.t[selected.n - 1] - selected.t[0]);
      paintTransport(); frame();
    });
    if (reduceMotion) $('#st-sweep').hidden = true;
    panel.addEventListener('click', (e) => {
      const an = e.target.closest('[data-analog]');
      if (an) {
        analogSel = analogSel === an.dataset.analog ? null : an.dataset.analog;
        renderLive(); map.invalidate();
        return;
      }
      const md = e.target.closest('[data-model]');
      if (md) {
        const k = md.dataset.model;
        if (modelsOff.has(k)) modelsOff.delete(k); else modelsOff.add(k);
        renderLive(); map.invalidate();
        return;
      }
      const lv = e.target.closest('[data-live]');
      if (lv) {
        liveSel = lv.dataset.live;
        const st = liveStorms.find((x) => x.id === liveSel);
        if (st) fitLive(st);
        renderLive(); map.invalidate();
        return;
      }
      const b = e.target.closest('[data-storm]');
      if (b) select(storms.find((s) => s.id === b.dataset.storm));
    });
  }

  function row(s, right, sub) {
    const c = S.category(sub);
    return `<button class="st-row" data-storm="${esc(s.id)}" aria-pressed="${s === selected}">
      <span class="st-n">${esc(S.titleOf(s))}</span><span class="st-d">${esc(right)}</span>
      <span class="st-c" style="color:${c ? c.color : 'var(--faint)'}">${c ? esc(c.key) : '—'}</span></button>`;
  }

  function render() {
    if (!$('#st-status')) shell();
    const status = $('#st-status');
    const p = place();
    $('#st-modes').hidden = state !== 'ready' || !near.length || reduceMotion;
    if (state === 'loading' || state === 'idle') {
      status.textContent = 'Loading the archive…';
      $('#st-facts').innerHTML = ''; $('#st-list').innerHTML = ''; $('#st-date').innerHTML = ''; $('#st-season').innerHTML = '';
    } else if (state === 'absent') {
      status.textContent = 'The hurricane archive is not available here.';
    } else if (state === 'fail') {
      status.textContent = 'The hurricane archive could not be loaded. Try again in a moment.';
    } else {
      const through = Math.max(index.through.al, index.through.ep);
      status.textContent = `${storms.length.toLocaleString('en-US')} storms · Atlantic 1851–${index.through.al} · East & Central Pacific 1949–${index.through.ep}`;
      renderFacts(p, through);
      $('#st-list').innerHTML = near.length
        ? near.slice(0, 8).map((n) => row(n.storm, `${Math.round(mi(n.km))} mi`, n.wind)).join('')
        : '<div class="nodata">none within 500 mi</div>';
      const day = S.onThisDate(storms, Date.now(), 3).slice(0, 3);
      $('#st-date').innerHTML = day.length
        ? day.map((d) => row(d.storm, when(d.storm.t[d.i]).replace(/, \d{4}$/, ''), d.wind)).join('')
        : '<div class="nodata">nothing in the archive for these dates</div>';
      renderSeason();
    }
    $('#st-about').innerHTML = 'Source: NHC best-track archive (HURDAT2), a six-hourly record of each storm\'s centre. '
      + 'Distances are to the straight line between positions; wind is the storm\'s wind when nearest, not what a place felt. '
      + 'This is history, not a warning source: for current storms see <a href="https://www.nhc.noaa.gov/" target="_blank" rel="noopener">nhc.noaa.gov</a>.';
    paintHud();
    paintSweep();
  }

  /**
   * The live section: what NHC says is happening now. Three outcomes that
   * must never blur into one: storms (with the honesty strip and a YOU card),
   * "no active storms" (a successful check that found none), and "could not
   * check" (which says NOTHING about whether there are storms).
   */
  function renderLive() {
    const el = $('#st-live');
    if (!el) return;
    const now = Date.now();
    const link = '<a href="https://www.nhc.noaa.gov/" target="_blank" rel="noopener">nhc.noaa.gov</a>';
    const clock = (ms) => `${store.fmt.weekday(ms)} ${store.fmt.hm12(ms)}`;
    let html = '';
    if (live.state === 'fail') {
      html += `<div class="st-alarm" role="alert">COULD NOT CHECK NHC${live.lastOk ? ` (last answer ${clock(live.lastOk)})` : ''}. `
        + `That does not mean there are no storms. Go to ${link}.</div>`;
    }
    if (live.state === 'idle' || (live.state === 'loading' && !live.data)) {
      html += '<div class="st-quiet">CHECKING NHC FOR ACTIVE STORMS…</div>';
    } else if (live.data && !liveStorms.length) {
      const ago = Math.max(0, Math.round((now - Date.parse(live.data.checked)) / 60000));
      html += live.data.activeCount > 0
        ? `<div class="st-alarm" role="alert">NHC LISTS ${live.data.activeCount} STORM${live.data.activeCount === 1 ? '' : 'S'} THAT THIS PAGE COULD NOT READ. See ${link}.</div>`
        : `<div class="st-quiet">NO ACTIVE STORMS · CHECKED ${ago} MIN AGO · NHC · ${link}</div>`;
    }
    if (liveStorms.length) {
      html += `<div class="st-honest"><b>NOT AN OFFICIAL SOURCE.</b> Use ${link} and your local NWS office for warnings. `
        + 'This page can be wrong, late, or missing a storm.</div>';
      html += liveStorms.map((st) => {
        const c = S.category(st.windKt);
        const h = st._age;
        const age = h == null ? 'ADVISORY AGE UNKNOWN' : h < 1 ? 'ADVISORY WITHIN THE HOUR' : `ADVISORY ${Math.floor(h)} H OLD`;
        const bad = st._stale !== 'fresh';
        return `<button class="st-row st-live-row" data-live="${esc(st.id)}" aria-pressed="${st.id === liveSel}">
          <span class="st-n">${esc((st.name || st.id).toUpperCase())}</span>
          <span class="st-d">${st.windKt != null ? Math.round(st.windKt) + ' kt' : '—'}</span>
          <span class="st-c" style="color:${c ? c.color : 'var(--faint)'}">${c ? esc(c.key) : '—'}</span>
          <span class="st-age${bad ? ' bad' : ''}">${age}${st._stale === 'old' ? ' · FORECAST OUT OF DATE' : st._stale === 'stale' ? ' · NHC UPDATE OVERDUE' : ''}</span></button>`;
      }).join('');
      const st = liveStorms.find((x) => x.id === liveSel);
      if (st) html += youHtml(st, now);
    }
    el.innerHTML = html;
  }

  /**
   * Similar past tracks. Everything here is worded as similarity: the
   * heading, the note, the limits. What a matched storm did next is what
   * happened to it, and says nothing certain about this one.
   */
  function analogsHtml(st) {
    const head = '<div class="st-h">SIMILAR PAST TRACKS</div>';
    if (state === 'absent' || state === 'fail') return `${head}<div class="st-note">The hurricane archive is not available, so similar past storms cannot be found.</div>`;
    if (!st._an) return `${head}<div class="st-note">Loading the archive to find similar storms…</div>`;
    const { res, nexts } = st._an;
    if (res.tooShort) return `${head}<div class="st-note">Too early to match: this storm needs at least ${S.ANALOG_MIN * 6 - 6} hours of track.</div>`;
    if (!res.results.length) return `${head}<div class="st-note">No past storm in the archive has a track close to this one's.</div>`;
    const hours = (res.window - 1) * 6;
    const rows = res.results.map((r, i) => {
      const c = S.category(S.windAt(r.storm, r.endIndex));
      const on = analogSel === r.storm.id;
      const p = r.parts;
      return `<button class="st-row" data-analog="${esc(r.storm.id)}" aria-pressed="${on}">
        <span class="st-n">${esc(S.titleOf(r.storm))}</span><span class="st-d">${Math.round(p.posKm)} km apart</span>
        <span class="st-c" style="color:${c ? c.color : 'var(--faint)'}">${c ? esc(c.key) : '—'}</span></button>`
        + (on ? `<div class="st-analog">
          <div class="st-note">Matched on the last ${hours} hours of track: ${Math.round(p.posKm)} km apart on average, winds within ${Math.round(p.windKt)} kt, headings ${Math.round(p.headDeg)}° apart, ${Math.round(p.seasonDays)} days apart in the year. The match ends ${esc(when(r.endT, true))}.</div>
          ${nexts[i].lines.map((l) => `<div class="st-note">${esc(l)}</div>`).join('')}
          ${S.eraNote(r.storm.year) ? `<div class="st-note">${esc(S.eraNote(r.storm.year))}</div>` : ''}</div>` : '');
    }).join('');
    return `${head}<div class="st-honest st-sim"><b>Similarity, not a forecast.</b> These are past storms whose last ${hours} hours of track looked like this one's. `
      + `What they did next is what happened to them: it says nothing certain about this storm.</div>${rows}`
      + `<div class="st-note">It matches position (60%), strength (20%), heading (10%) and time of year (10%), and knows nothing of steering winds, wind shear or sea temperature. `
      + `The archive holds ${storms.length.toLocaleString('en-US')} storms in 175 years, a score is not a probability, and it has never been checked against what happened. `
      + `Dotted lines are what each did next, in its own intensity colours; the ring is where the match ends.</div>`;
  }

  /** Model guidance: one chip per model that has a run, which is also the legend. */
  function modelsHtml(st) {
    if (!st._runs.length) {
      return st.parts.models === 'none' ? '<div class="st-h">MODEL GUIDANCE</div><div class="st-note">No model guidance is published for this storm yet.</div>' : '';
    }
    const chips = st._runs.map((r) => `<button class="oh-chip" data-model="${esc(r.key)}" aria-pressed="${!modelsOff.has(r.key)}" style="--chip:${MODEL_COLOUR[r.key]}"
      title="${esc(r.name)}: ${esc(r.note)}, run at ${esc(S.runLabel(r.cycle))} UTC${r.old ? ' (an old run)' : ''}">${esc(r.name)} ${esc(S.runLabel(r.cycle))}${r.old ? ' · OLD' : ''}</button>`).join('');
    return `<div class="st-h">MODEL GUIDANCE</div><div class="oh-chips">${chips}</div>`
      + '<div class="st-note">Each thin line is one computer model\'s own forecast, run at the time shown (UTC). They disagree, and that spread is not a probability. '
      + 'NHC\'s official forecast, the dashed white line, weighs these and more: follow it, not any one model.</div>';
  }

  /** The measured wind radii at a live storm's centre, in words, as of its latest best-track fix. */
  function windHtml(st) {
    const last = st.best && st.best.length ? st.best[st.best.length - 1] : null;
    const lines = last ? S.radiiText(last.r) : [];
    return `<div class="st-h">WIND RADII NOW (NHC)</div>`
      + `<div class="st-legend" aria-hidden="true">${S.THRESHOLDS.map((k) => `<span><i style="background:${WIND[k]}"></i>${k} KT</span>`).join('')}</div>`
      + (lines.length ? lines.map((l) => `<div class="st-note">${esc(l)}</div>`).join('')
        : '<div class="st-note">No winds of tropical-storm force reported at the latest position.</div>')
      + '<div class="st-note">Quarter circles, as measured: how far each wind speed reaches in each quadrant. The dashed outlines are NHC\'s forecast 34 kt reach at +24 h and later.</div>';
  }

  function youHtml(st, now) {
    const here = place();
    const notes = [];
    if (st.parts.best === 'fail') notes.push('The best track could not be read.');
    if (st.parts.forecast === 'fail') notes.push('NHC\'s forecast could not be read.');
    else if (st.parts.forecast === 'none') notes.push('NHC has not published a forecast for this storm yet.');
    if (st.parts.cone === 'fail') notes.push('The forecast cone could not be read.');
    if (st.parts.models === 'fail') notes.push('Model guidance could not be read.');
    const card = here ? S.youCard(st.forecast, here, st.cone, now) : null;
    const text = S.youText(card, store.fmt);
    const old = st._stale === 'old' ? '<div class="st-alarm">THIS FORECAST IS OUT OF DATE. Do not rely on it: check NHC.</div>' : '';
    return `<div class="st-you">
      <div class="st-h">YOU · ${esc(here ? here.name.toUpperCase() : '')}</div>${old}
      ${text ? `<div class="st-youhead">${esc(text.headline)}</div>${text.lines.map((l) => `<div class="st-note">${esc(l)}</div>`).join('')}
        <div class="st-note">${esc(text.cone)}</div><div class="st-note">${esc(text.note)}</div>`
        : '<div class="st-note">No official forecast track to measure against.</div>'}
      ${modelsHtml(st)}
      ${analogsHtml(st)}
      ${windHtml(st)}
      ${notes.map((n) => `<div class="st-note">${esc(n)}</div>`).join('')}
    </div>`;
  }

  function renderFacts(p, through) {
    const el = $('#st-facts');
    if (!p) { el.innerHTML = ''; return; }
    if (!near.length) {
      el.innerHTML = `<div class="st-note">No storm in this archive passed within ${NEAR_MI} mi of ${esc(p.name)}. `
        + 'It covers the Atlantic and the East and Central Pacific only, so that says nothing about other ocean basins.</div>';
      return;
    }
    const f = S.facts(near);
    const c = f.closest;
    const kv = (k, v) => `<div class="kv"><dt>${k}</dt><dd>${v}</dd></div>`;
    el.innerHTML = `<dl style="margin:0">
      ${kv('Centre within 100 mi', String(f.within100))}
      ${kv('Centre within 150 mi', String(f.within150))}
      ${kv('Nearest', `${esc(S.titleOf(c.storm))}, ${Math.round(mi(c.km))} mi · ${when(c.t)}`)}
      ${kv('Wind when nearest', c.wind == null ? '—' : `${Math.round(c.wind)} kt`)}
      ${f.strongest ? kv('Strongest nearby', `${esc(S.titleOf(f.strongest.storm))}, ${Math.round(f.strongest.wind)} kt at ${Math.round(mi(f.strongest.km))} mi`) : ''}
    </dl>`;
  }

  function renderSeason() {
    const el = $('#st-season');
    // The basin the place belongs to is the one its nearest storm came from.
    const basin = near.length ? near[0].storm.basin : 'AL';
    const p = S.seasonProgress(storms, basin, Date.now());
    const peak = new Date(Date.UTC(2001, 0, p.peakDoy));
    const pct = Math.round(p.behind * 100);
    el.innerHTML = `<div class="st-season">
      <div class="st-ring" style="--p:${pct}" role="img" aria-label="${pct} percent of the season is behind us"><b>${pct}%</b></div>
      <div class="st-note">Of all the tropical-storm days in the ${esc(BASIN_NAME[basin] || basin)} archive, ${pct}% fall on or before today's date.
      The busiest day is ${MONTHS[peak.getUTCMonth()]} ${peak.getUTCDate()}.</div></div>`;
  }

  /* ------------------------------------------------- hud, transport, state */

  function paintHud() {
    const t = hud.querySelector('b'), sub = hud.querySelector('span');
    if (sweep.on) {
      const year = sweep.first + Math.floor(sweep.p);
      const so = near.filter((n) => n.storm.year <= year).length;
      t.textContent = String(year);
      sub.textContent = `${so} of ${near.length} storms so far`;
    } else if (selected) {
      const p = S.positionAt(selected, replay.t);
      const c = S.category(p.wind);
      const st = STATUS_NAME[selected.status[p.i]] || '';
      t.textContent = S.titleOf(selected).toUpperCase();
      sub.textContent = `${c ? c.label : st} · ${p.wind == null ? '—' : Math.round(p.wind) + ' kt'} · ${when(replay.t, true)}`;
    } else if (liveStorms.length) {
      const st = liveStorms.find((x) => x.id === liveSel) || liveStorms[0];
      const c = S.category(st.windKt);
      t.textContent = (st.name || st.id).toUpperCase();
      sub.textContent = `${c ? c.label : st.classification || 'Storm'} · ${st.windKt != null ? Math.round(st.windKt) + ' kt' : '—'}`
        + (st._stale === 'old' ? ' · FORECAST OUT OF DATE' : st._stale === 'stale' ? ' · NHC UPDATE OVERDUE' : '');
    } else {
      t.textContent = 'HURRICANE ATLAS';
      sub.textContent = state === 'ready' ? `${near.length} storms within ${NEAR_MI} mi since 1851` : '';
    }
  }

  function paintTransport() {
    const box = $('#st-replay');
    if (!box) return;
    box.hidden = !selected;
    if (!selected) return;
    $('#st-play').textContent = replay.playing ? '❚❚' : '▶';
    const span = selected.t[selected.n - 1] - selected.t[0];
    $('#st-scrub').value = String(Math.round(((replay.t - selected.t[0]) / span) * 1000));
    $('#st-era').textContent = S.eraNote(selected.year) || '';
    paintWind();
  }

  function paintSweep() {
    const b = $('#st-sweep');
    if (!b) return;
    b.setAttribute('aria-pressed', String(sweep.on));
    b.textContent = sweep.on ? '❚❚ STOP SWEEP' : '▶ SWEEP THE YEARS';
  }

  /* --------------------------------------------------------- the loop */

  function frame() {
    paintHud();
    map.invalidate();
  }

  function kick() {
    if (loopId || !active || !visible || document.hidden) return;
    lastFrame = performance.now();
    loopId = requestAnimationFrame(loop);
  }

  function loop(now) {
    loopId = 0;
    if (!active || !visible || document.hidden) return;
    const dt = Math.min(100, now - lastFrame);
    lastFrame = now;
    let moving = false;
    if (sweep.on) {
      sweep.p += (dt / 1000) * YEARS_PER_SECOND;
      if (sweep.first + sweep.p >= sweep.last + 1) { sweep.on = false; sweep.p = 0; paintSweep(); }
      moving = sweep.on;
    }
    if (replay.playing && selected) {
      const end = selected.t[selected.n - 1];
      replay.t += dt * ((end - selected.t[0]) / (REPLAY_SECONDS * 1000));
      if (replay.t >= end) { replay.t = end; replay.playing = false; }
      paintTransport();
      moving = moving || replay.playing;
    }
    frame();
    if (moving || replay.playing || sweep.on) loopId = requestAnimationFrame(loop);
  }

  /* ------------------------------------------------------ interaction */

  function toggleSweep() {
    if (!near.length) return;
    sweep.on = !sweep.on;
    if (sweep.on) { sweep.p = 0; selected = null; replay.playing = false; paintTransport(); }
    paintSweep(); render(); frame(); kick();
  }

  /** Frame a set of points (longitudes already unwrapped). */
  function fitPoints(lats, lons) {
    const la0 = Math.min(...lats), la1 = Math.max(...lats), lo0 = Math.min(...lons), lo1 = Math.max(...lons);
    const span = Math.max(lo1 - lo0, (la1 - la0) * 1.4, 4) * 1.35;
    const z = Math.max(map.minZoom, Math.min(7, Math.floor(Math.log2((360 * Math.min(map.w, map.h * 1.6)) / (256 * span)))));
    map.setView((la0 + la1) / 2, wrap180((lo0 + lo1) / 2), z);
  }

  function fit(s) { fitPoints(Array.from(s.lat), Array.from(s.lon)); }

  /** Frame a live storm (or all of them) together with the visitor's place. */
  function fitLive(only) {
    const lats = [], lons = [];
    for (const st of only ? [only] : liveStorms) {
      // The last two days of track, not all of it: a storm that formed 2,000 km away would otherwise
      // shrink the forecast, and the model lines beside it, to a smudge.
      for (let i = Math.max(0, st._track.n - 8); i < st._track.n; i++) { lats.push(st._track.lat[i]); lons.push(st._track.lon[i]); }
      for (const p of st._fc) { lats.push(p.lat); lons.push(p.lon); }
      for (const run of st._runs) for (const p of run.pts) { lats.push(p.lat); lons.push(p.lon); }
    }
    const here = place();
    if (here && lons.length) {
      // The visitor, on the same side of the dateline as the storm.
      lats.push(here.lat); lons.push(here.lon + 360 * Math.round((lons[0] - here.lon) / 360));
    }
    if (lats.length) fitPoints(lats, lons);
  }

  function select(s) {
    if (!s) return;
    selected = s;
    sweep.on = false; paintSweep();
    replay = { t: s.t[0], playing: !reduceMotion };
    ensureRadii(s);
    fit(s);
    render(); paintTransport(); frame(); kick();
  }

  function pick(pt) {
    if (!active || state !== 'ready') return;
    const W = 256 * 2 ** map.zoom;
    let best = null;
    const pool = [...near.map((n) => n.storm), ...(selected && !near.some((n) => n.storm === selected) ? [selected] : [])];
    for (const s of pool) {
      const pts = [];
      for (let i = 0; i < s.n; i++) pts.push(map.project(s.lat[i], s.lon[i]));
      for (const off of [-W, 0, W]) {
        for (let i = 0; i < s.n; i++) {
          const [x1, y1] = pts[i], [x2, y2] = pts[Math.min(i + 1, s.n - 1)];
          const ax = x1 + off, bx = x2 + off, dx = bx - ax, dy = y2 - y1, l2 = dx * dx + dy * dy;
          const u = l2 ? Math.max(0, Math.min(1, ((pt.x - ax) * dx + (pt.y - y1) * dy) / l2)) : 0;
          const d = Math.hypot(pt.x - (ax + u * dx), pt.y - (y1 + u * dy));
          if (d < PICK_PX && (!best || d < best.d)) best = { s, d };
        }
      }
    }
    if (best) select(best.s);
    else if (selected) { selected = null; replay.playing = false; render(); paintTransport(); frame(); }
  }

  store.on('loc', () => {
    if (!active) return;
    locate(); selected = null; sweep.on = false;
    prepareLive(); render(); renderLive(); paintTransport();
    if (place()) map.setView(place().lat, place().lon, 5);
  });

  /* ----------------------------------------------------------- lifecycle */

  return {
    enter() {
      active = true;
      if (!overlayAdded) { map.overlays.push(overlay); overlayAdded = true; }
      map.onTap = pick;
      hud.hidden = false;
      panel.hidden = false;
      if (place()) map.setView(place().lat, place().lon, 5);
      load();
      render();
      renderLive();
      startLive();
      map.invalidate();
    },
    exit() {
      active = false;
      sweep.on = false; replay.playing = false;
      if (loopId) cancelAnimationFrame(loopId);
      loopId = 0;
      stopLive();
      map.onTap = undefined;
      hud.hidden = true;
      panel.hidden = true;
      map.invalidate();
    },
    /** RADAR left the screen or came back. */
    setVisible(v) { visible = v; if (v) { kick(); startLive(); map.invalidate(); } else stopLive(); },
  };
}
