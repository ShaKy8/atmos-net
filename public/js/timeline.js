/**
 * The time scrubber.
 *
 * A single strip spanning the whole data window (two days back, sixteen
 * days forward). Dragging it moves store.cursor, and because every view
 * derives from the cursor, the entire console — sky included — moves with it.
 */

import { store } from './state.js';
import {
  SERIES, STATUS, INK, DIM, FAINT, SURFACE, MONO_SM, UI_LBL,
  tempColor, alpha, mount, smoothPath, neonLine,
} from './charts.js';
import { clamp } from './lib/util.js';

const PAD_L = 8, PAD_R = 8, PAD_T = 16, PAD_B = 15;

export function createTimeline(root) {
  root.innerHTML = `
    <div class="tl-controls">
      <button class="tl-btn" data-act="back" title="Back 1 hour  [←]">◀◀</button>
      <button class="tl-btn tl-play" data-act="play" title="Play forecast  [Space]">▶</button>
      <button class="tl-btn" data-act="fwd" title="Forward 1 hour  [→]">▶▶</button>
      <button class="tl-btn tl-now" data-act="now" title="Return to now  [N]">NOW</button>
      <div class="tl-rate">
        <span class="lbl">rate</span>
        <button class="tl-btn sm" data-rate="1">1×</button>
        <button class="tl-btn sm" data-rate="3">3×</button>
        <button class="tl-btn sm" data-rate="12">12×</button>
      </div>
    </div>
    <div class="tl-readout">
      <div class="tl-when"><b>--</b><span>--</span></div>
      <div class="tl-delta">NOW</div>
    </div>
    <canvas class="tl-canvas"></canvas>
  `;

  const canvas = root.querySelector('.tl-canvas');
  const whenB = root.querySelector('.tl-when b');
  const whenS = root.querySelector('.tl-when span');
  const delta = root.querySelector('.tl-delta');
  const playBtn = root.querySelector('.tl-play');

  let dragging = false;

  // The scrubber runs its own drag, keeps `touch-action: none`, and must not
  // leave a crosshair behind when the finger lifts.
  const chart = mount(canvas, draw, { inspect: false });

  function geom(w) {
    const { lo, hi } = store.span;
    const plotW = w - PAD_L - PAD_R;
    return {
      lo, hi, plotW,
      xOf: (t) => PAD_L + ((t - lo) / (hi - lo || 1)) * plotW,
      tOf: (x) => lo + ((x - PAD_L) / plotW) * (hi - lo || 1),
    };
  }

  function draw(ctx, w, h, hover) {
    const hours = store.hours;
    if (!hours?.length) return;
    const g = geom(w);
    const tf = store.fmt;
    const box = { x: PAD_L, y: PAD_T, w: g.plotW, h: h - PAD_T - PAD_B };

    /* --- night shading --- */
    ctx.save();
    ctx.fillStyle = 'rgba(8,13,22,.4)';
    for (let i = 0; i < store.days.length; i++) {
      const d = store.days[i], next = store.days[i + 1];
      if (!d.sunset) continue;
      const x0 = clamp(g.xOf(d.sunset), box.x, box.x + box.w);
      const x1 = clamp(next?.sunrise ? g.xOf(next.sunrise) : box.x + box.w, box.x, box.x + box.w);
      if (x1 > x0) ctx.fillRect(x0, box.y, x1 - x0, box.h);
    }
    ctx.restore();

    /* --- temperature ribbon --- */
    const temps = hours.map((d) => d.temp).filter((v) => v != null);
    const lo = Math.min(...temps), hi = Math.max(...temps);
    const yOf = (v) => box.y + box.h * 0.92 - ((v - lo) / (hi - lo || 1)) * box.h * 0.72;
    const pts = hours.filter((d) => d.temp != null).map((d) => [g.xOf(d.t), yOf(d.temp)]);

    ctx.save();
    ctx.beginPath();
    smoothPath(ctx, pts);
    ctx.lineTo(pts.at(-1)[0], box.y + box.h);
    ctx.lineTo(pts[0][0], box.y + box.h);
    ctx.closePath();
    const fg = ctx.createLinearGradient(0, box.y, 0, box.y + box.h);
    fg.addColorStop(0, alpha(tempColor(hi), .34));
    fg.addColorStop(1, alpha(tempColor(lo), .03));
    ctx.fillStyle = fg;
    ctx.fill();
    ctx.restore();

    const lg = ctx.createLinearGradient(PAD_L, 0, PAD_L + g.plotW, 0);
    for (let i = 0; i <= 12; i++) {
      const d = hours[Math.round((i / 12) * (hours.length - 1))];
      lg.addColorStop(i / 12, tempColor(d?.temp));
    }
    ctx.save();
    ctx.shadowColor = alpha(SERIES[0], .8); ctx.shadowBlur = 4;
    ctx.beginPath(); smoothPath(ctx, pts);
    ctx.strokeStyle = lg; ctx.lineWidth = 1.8; ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.restore();

    /* --- precipitation, as ticks along the floor --- */
    const maxP = Math.max(...hours.map((d) => d.precip ?? 0), 0.02);
    ctx.save();
    for (const d of hours) {
      const p = d.precip ?? 0;
      if (p < 0.001) continue;
      const x = g.xOf(d.t);
      const hh = clamp(p / maxP, 0.08, 1) * box.h * 0.30;
      ctx.fillStyle = alpha(SERIES[4], .75);
      ctx.fillRect(x - 0.7, box.y + box.h - hh, 1.6, hh);
    }
    ctx.restore();

    /* --- day rules and labels ---
     *
     * The rules are drawn for every day; the LABELS are strided to fit. A
     * weekday at this size needs about 30px, and the strip carries up to 18
     * days - on a phone that is 18 labels in 360px, which rendered as an
     * unbroken run of "SUNMONTUEWED". The stride is derived from the measured
     * spacing between days rather than from their count. */
    ctx.save();
    ctx.font = UI_LBL; ctx.letterSpacing = '1.2px';
    ctx.textBaseline = 'top';
    const dayGap = store.days.length > 1
      ? Math.abs(g.xOf(store.days[1].t) - g.xOf(store.days[0].t))
      : box.w;
    const LABEL_PX = 34;
    const stride = Math.max(1, Math.ceil(LABEL_PX / Math.max(1, dayGap)));
    let i = 0;
    for (const d of store.days) {
      const x = g.xOf(d.t);
      const show = i++ % stride === 0;
      if (x < box.x || x > box.x + box.w) continue;
      ctx.strokeStyle = show ? 'rgba(255,255,255,.10)' : 'rgba(255,255,255,.05)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + .5, box.y);
      ctx.lineTo(Math.round(x) + .5, box.y + box.h);
      ctx.stroke();
      // Skip a label that would run off the right edge rather than clip it.
      if (!show || x + LABEL_PX > box.x + box.w) continue;
      ctx.fillStyle = FAINT;
      ctx.textAlign = 'left';
      ctx.fillText(tf.weekday(d.t).toUpperCase(), x + 3, h - PAD_B + 3);
    }
    ctx.restore();

    /* --- alert spans --- */
    for (const a of store.alerts) {
      const s = Date.parse(a.effective || a.onset || 0);
      const e = Date.parse(a.expires || a.ends || 0);
      if (!s || !e) continue;
      const x0 = clamp(g.xOf(s), box.x, box.x + box.w);
      const x1 = clamp(g.xOf(e), box.x, box.x + box.w);
      if (x1 <= x0) continue;
      ctx.fillStyle = alpha(STATUS.crit, .55);
      ctx.fillRect(x0, box.y - 4, x1 - x0, 3);
    }

    /* --- now --- */
    const now = Date.now();
    const nx = g.xOf(now);
    if (nx >= box.x && nx <= box.x + box.w) {
      ctx.save();
      ctx.strokeStyle = alpha(STATUS.good, .85);
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 3]);
      ctx.shadowColor = STATUS.good; ctx.shadowBlur = 4;
      ctx.beginPath();
      ctx.moveTo(Math.round(nx) + .5, box.y - 4);
      ctx.lineTo(Math.round(nx) + .5, box.y + box.h);
      ctx.stroke();
      ctx.restore();
    }

    /* --- hover preview --- */
    if (hover && !dragging && hover.x > box.x && hover.x < box.x + box.w) {
      const t = g.tOf(hover.x);
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,.22)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(hover.x) + .5, box.y);
      ctx.lineTo(Math.round(hover.x) + .5, box.y + box.h);
      ctx.stroke();
      ctx.font = MONO_SM; ctx.fillStyle = DIM;
      ctx.textAlign = hover.x > w - 70 ? 'right' : 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(`${tf.weekday(t)} ${tf.hm(t)}`, hover.x + (hover.x > w - 70 ? -5 : 5), 2);
      ctx.restore();
    }

    /* --- playhead --- */
    const cx = g.xOf(store.cursor);
    ctx.save();
    ctx.strokeStyle = SERIES[1];
    ctx.lineWidth = 1.5;
    ctx.shadowColor = SERIES[1]; ctx.shadowBlur = 7;
    ctx.beginPath();
    ctx.moveTo(Math.round(cx) + .5, box.y - 6);
    ctx.lineTo(Math.round(cx) + .5, box.y + box.h + 3);
    ctx.stroke();
    // Handle
    ctx.fillStyle = SERIES[1];
    ctx.beginPath();
    ctx.moveTo(cx, box.y - 10);
    ctx.lineTo(cx + 5, box.y - 16);
    ctx.lineTo(cx - 5, box.y - 16);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  /* ------------------------------------------------------- interaction */

  const pick = (clientX) => {
    const r = canvas.getBoundingClientRect();
    const g = geom(r.width);
    store.playing = false;
    updatePlayBtn();
    store.scrubTo(g.tOf(clamp(clientX - r.left, PAD_L, r.width - PAD_R)));
  };

  canvas.addEventListener('pointerdown', (e) => {
    dragging = true;
    canvas.setPointerCapture(e.pointerId);
    pick(e.clientX);
  });
  canvas.addEventListener('pointermove', (e) => { if (dragging) pick(e.clientX); });
  const stop = (e) => {
    if (!dragging) return;
    dragging = false;
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* already released */ }
  };
  canvas.addEventListener('pointerup', stop);
  canvas.addEventListener('pointercancel', stop);
  canvas.style.cursor = 'ew-resize';

  root.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.dataset.rate) {
      store.playRate = +btn.dataset.rate;
      root.querySelectorAll('[data-rate]').forEach((b) =>
        b.classList.toggle('on', +b.dataset.rate === store.playRate));
      return;
    }
    const act = btn.dataset.act;
    if (act === 'now') store.toNow();
    else if (act === 'back') { store.playing = false; store.scrubTo(store.cursor - 3600e3); }
    else if (act === 'fwd') { store.playing = false; store.scrubTo(store.cursor + 3600e3); }
    else if (act === 'play') {
      store.playing = !store.playing;
      // Playing is a deliberate departure from live - except on the radar,
      // where the loop is ambient and drives the cursor itself.
      if (store.playing && store.view !== 'radar') store.following = false;
      // Restart from now if the cursor already ran off the end.
      if (store.playing && store.cursor >= store.span.hi - 60e3) store.setCursor(Date.now());
      store.emit('play', store.playing);
    }
    updatePlayBtn();
  });

  function updatePlayBtn() {
    playBtn.textContent = store.playing ? '❚❚' : '▶';
    playBtn.classList.toggle('on', store.playing);
    root.querySelector('.tl-now').classList.toggle('on', store.atNow);
  }

  function updateReadout() {
    const tf = store.fmt;
    const t = store.cursor;
    whenB.textContent = tf.hm12(t);
    whenS.textContent = `${tf.weekday(t)} ${tf.monthDay(t)}`;
    const d = t - Date.now();
    const mins = Math.round(Math.abs(d) / 60000);
    if (mins < 3) {
      delta.textContent = 'NOW';
      delta.className = 'tl-delta now';
    } else {
      const h = Math.floor(mins / 60), m = mins % 60;
      const s = h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : h ? `${h}h ${m}m` : `${m}m`;
      delta.textContent = d > 0 ? `+${s}` : `−${s}`;
      delta.className = 'tl-delta ' + (d > 0 ? 'fwd' : 'back');
    }
    updatePlayBtn();
  }

  store.on('cursor', () => { updateReadout(); chart.render(); });
  store.on('data', () => { updateReadout(); chart.render(); });
  store.on('play', updatePlayBtn);
  root.querySelector('[data-rate="1"]').classList.add('on');
  updateReadout();

  return {
    render: () => chart.render(),
    /** Advance the cursor while playing; called from the main loop. */
    tick(dt) {
      // The radar owns the cadence while it is the view: its loop advances
      // the cursor a frame at a time. Advancing it here too would fight.
      if (!store.playing || store.view === 'radar') return;
      const next = store.cursor + dt * 1000 * 3600 * store.playRate;
      if (next >= store.span.hi) {
        store.setCursor(store.span.hi);
        store.playing = false;
        store.emit('play', false);
        updatePlayBtn();
      } else {
        store.setCursor(next);
      }
    },
  };
}
