/**
 * A small canvas slippy map.
 *
 * Written rather than imported so the base tiles can be colour-graded into
 * the console's palette and the radar composited exactly how we want. It
 * handles Web Mercator projection, fractional zoom, tile caching, inertia-free
 * panning and wheel zoom — which is all a weather map actually needs.
 */

/*
 * Esri's Dark Gray Canvas: keyless, CORS-enabled and genuinely dark, unlike
 * CARTO's basemaps which now stamp "API KEY REQUIRED" across keyless tiles.
 * Esri serves tiles as {z}/{row}/{col}, which is y before x. Shared, because
 * both map views want the same graded basemap and a divergence would show.
 */
export const ESRI_CANVAS = 'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas';
export const ESRI_BASE_FILTER = 'grayscale(1) brightness(1.18) contrast(1.05) sepia(.6) hue-rotate(170deg) saturate(1.3)';
export const ESRI_LABEL_FILTER = 'grayscale(1) brightness(1.9) contrast(1.1) sepia(.4) hue-rotate(170deg) saturate(.8)';

const TILE = 256;
const MAX_CACHE = 600;

export const proj = {
  lonToWorld: (lon, z) => ((lon + 180) / 360) * Math.pow(2, z) * TILE,
  latToWorld: (lat, z) => {
    const s = Math.sin((Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180);
    return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * Math.pow(2, z) * TILE;
  },
  worldToLon: (x, z) => (x / (Math.pow(2, z) * TILE)) * 360 - 180,
  worldToLat: (y, z) => {
    const n = Math.PI - (2 * Math.PI * y) / (Math.pow(2, z) * TILE);
    return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  },
};

/* Shared image cache across every map instance and layer. */
const cache = new Map();
let pending = 0;

function loadTile(url, onReady) {
  const hit = cache.get(url);
  if (hit) {
    if (hit.state === 'ok') return hit.img;
    return null;
  }
  // Cap concurrency so a fast pan doesn't queue hundreds of requests.
  if (pending > 24) return null;

  const img = new Image();
  const entry = { img, state: 'loading' };
  cache.set(url, entry);
  pending++;
  img.crossOrigin = 'anonymous';
  img.onload = () => { entry.state = 'ok'; pending--; onReady?.(); };
  img.onerror = () => { entry.state = 'err'; pending--; };
  img.src = url;

  if (cache.size > MAX_CACHE) {
    // Evict the oldest quarter; insertion order is good enough here.
    let n = Math.floor(MAX_CACHE / 4);
    for (const k of cache.keys()) { if (n-- <= 0) break; cache.delete(k); }
  }
  return null;
}

/** How far a pointer may travel and still count as a tap rather than a drag. */
const TAP_SLOP = 10;

export class SlippyMap {
  /**
   * @param layers array of
   *   {url(z,x,y)->string|null, opacity, filter, blend, enabled, maxTileZoom}
   */
  constructor(canvas, { center = [0, 0], zoom = 7, minZoom = 2, maxZoom = 12, onMove, onTap } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.lat = center[0];
    this.lon = center[1];
    this.zoom = zoom;
    this.minZoom = minZoom;
    this.maxZoom = maxZoom;
    this.onMove = onMove;
    this.onTap = onTap;   // (canvasPoint, event) for a press that never became a drag
    this.layers = [];
    this.overlays = [];      // (ctx, map) => void
    this.dirty = true;
    this.w = 0; this.h = 0;
    this._raf = null;

    this._bind();
    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(canvas);
    this.resize();
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!w || !h) return;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = w; this.h = h;
    this.invalidate();
  }

  invalidate() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = null; this.render(); });
  }

  setView(lat, lon, zoom) {
    this.lat = lat; this.lon = lon;
    if (zoom != null) this.zoom = Math.max(this.minZoom, Math.min(this.maxZoom, zoom));
    this.invalidate();
    this.onMove?.(this);
  }

  /* --- projection between screen and geography --- */
  project(lat, lon) {
    const z = this.zoom;
    return [
      proj.lonToWorld(lon, z) - proj.lonToWorld(this.lon, z) + this.w / 2,
      proj.latToWorld(lat, z) - proj.latToWorld(this.lat, z) + this.h / 2,
    ];
  }
  unproject(x, y) {
    const z = this.zoom;
    return [
      proj.worldToLat(proj.latToWorld(this.lat, z) + y - this.h / 2, z),
      proj.worldToLon(proj.lonToWorld(this.lon, z) + x - this.w / 2, z),
    ];
  }

  /**
   * Move the centre so that (lat, lon) lands on the canvas point (sx, sy).
   *
   * This is the whole of panning and pinching: hold one geographic point
   * under one screen point, whatever the zoom did in between.
   */
  _placeAt(lat, lon, sx, sy) {
    const z = this.zoom;
    this.lon = proj.worldToLon(proj.lonToWorld(lon, z) + this.w / 2 - sx, z);
    this.lat = Math.max(-85, Math.min(85,
      proj.worldToLat(proj.latToWorld(lat, z) + this.h / 2 - sy, z)));
  }

  /** Change zoom while keeping the geography under (sx, sy) where it is. */
  _zoomAbout(sx, sy, zoom) {
    const [lat, lon] = this.unproject(sx, sy);
    this.zoom = Math.max(this.minZoom, Math.min(this.maxZoom, zoom));
    this._placeAt(lat, lon, sx, sy);
  }

  _bind() {
    const c = this.canvas;

    /*
     * Pointers are tracked BY ID. The first version kept a single `drag` and
     * ignored pointerId, so on a phone a second finger simply overwrote the
     * first and a pinch read as a wild pan — the map was pannable but not
     * zoomable by touch at all.
     *
     * One pointer pans, two pinch, and both are the same operation: hold the
     * anchor under the midpoint of whatever is down.
     */
    const live = new Map();
    let gesture = null;
    let rect = null;

    const local = (e) => ({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    const mid = () => {
      const ps = [...live.values()];
      return {
        n: ps.length,
        x: ps.reduce((t, p) => t + p.x, 0) / ps.length,
        y: ps.reduce((t, p) => t + p.y, 0) / ps.length,
        span: ps.length < 2 ? 0 : Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y),
      };
    };

    /*
     * Re-anchor whenever the number of pointers changes, so lifting one
     * finger out of a pinch carries on panning from where it is instead of
     * jumping to wherever the remaining finger happens to be.
     */
    const anchor = () => {
      if (!live.size) { gesture = null; return; }
      const m = mid();
      const [lat, lon] = this.unproject(m.x, m.y);
      gesture = { lat, lon, span: m.span, zoom: this.zoom };
    };

    c.addEventListener('pointerdown', (e) => {
      if (live.size >= 2) return;              // two is all a pinch needs
      rect = c.getBoundingClientRect();
      const p = local(e);
      // x0/y0 is where this pointer landed, so a release can tell a tap from
      // the end of a pan without a second bookkeeping structure.
      live.set(e.pointerId, { ...p, x0: p.x, y0: p.y });
      try { c.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
      anchor();
      c.style.cursor = 'grabbing';
    });

    c.addEventListener('pointermove', (e) => {
      if (!gesture || !live.has(e.pointerId)) return;
      const was = live.get(e.pointerId);
      live.set(e.pointerId, { ...local(e), x0: was.x0, y0: was.y0 });
      const m = mid();
      // Below 20px apart the ratio of two finger positions is mostly noise.
      if (m.n > 1 && gesture.span > 20 && m.span > 8) {
        this.zoom = Math.max(this.minZoom, Math.min(this.maxZoom,
          gesture.zoom + Math.log2(m.span / gesture.span)));
      }
      this._placeAt(gesture.lat, gesture.lon, m.x, m.y);
      this.invalidate();
      this.onMove?.(this);
    });

    const end = (e) => {
      const was = live.get(e.pointerId);
      if (!live.delete(e.pointerId)) return;
      try { c.releasePointerCapture(e.pointerId); } catch { /* already gone */ }
      /*
       * A press that never travelled is a tap. Same discriminator the charts
       * use, for the same reason: panning the map must not also select what
       * happens to be under where your finger came to rest.
       */
      if (this.onTap && !live.size && Math.hypot(was.x - was.x0, was.y - was.y0) < TAP_SLOP) {
        this.onTap({ x: was.x, y: was.y }, e);
      }
      anchor();
      if (!live.size) c.style.cursor = 'grab';
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);

    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = c.getBoundingClientRect();
      const dz = -e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0022);
      this._zoomAbout(e.clientX - r.left, e.clientY - r.top, this.zoom + dz);
      this.invalidate();
      this.onMove?.(this);
    }, { passive: false });

    /*
     * Safari's own pinch gesture. `touch-action: none` stops the page from
     * scrolling but NOT these, and the page's viewport meta allows scaling,
     * so without this a pinch on the map zooms the whole document instead.
     * They do not exist in any other engine, hence no feature test.
     */
    for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
      c.addEventListener(type, (e) => e.preventDefault());
    }

    c.style.cursor = 'grab';
    c.style.touchAction = 'none';
  }

  render() {
    const { ctx, w, h } = this;
    if (!w || !h) return;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#0f1826';
    ctx.fillRect(0, 0, w, h);

    const zi = Math.max(0, Math.min(this.maxZoom, Math.round(this.zoom)));

    // World pixel of the viewport's top-left corner, at the fractional zoom.
    const originX = proj.lonToWorld(this.lon, this.zoom) - w / 2;
    const originY = proj.latToWorld(this.lat, this.zoom) - h / 2;

    const again = () => this.invalidate();

    for (const layer of this.layers) {
      if (layer.enabled === false || layer.opacity === 0) continue;

      /*
       * A layer whose source runs out of zoom levels is drawn from its
       * deepest tiles, scaled up, rather than not at all. RainViewer's
       * public radar stops at z 7 and hands back a "Zoom Level Not
       * Supported" placeholder above it — which used to tile itself across
       * the map in letters a hundred pixels tall.
       */
      const lz = Math.min(zi, layer.maxTileZoom ?? zi);
      const size = TILE * Math.pow(2, this.zoom - lz);
      const n = Math.pow(2, lz);
      const x0 = Math.floor(originX / size), x1 = Math.floor((originX + w) / size);
      const y0 = Math.floor(originY / size), y1 = Math.floor((originY + h) / size);

      ctx.save();
      ctx.globalAlpha = layer.opacity ?? 1;
      if (layer.filter) ctx.filter = layer.filter;
      if (layer.blend) ctx.globalCompositeOperation = layer.blend;
      // Slight overdraw avoids hairline seams between tiles.
      const pad = 0.5;
      for (let ty = y0; ty <= y1; ty++) {
        if (ty < 0 || ty >= n) continue;
        for (let tx = x0; tx <= x1; tx++) {
          const wx = ((tx % n) + n) % n;   // wrap east-west
          const url = layer.url(lz, wx, ty);
          if (!url) continue;
          const img = loadTile(url, again);
          if (!img) continue;
          ctx.drawImage(
            img,
            Math.round(tx * size - originX) - pad,
            Math.round(ty * size - originY) - pad,
            Math.ceil(size) + pad * 2,
            Math.ceil(size) + pad * 2,
          );
        }
      }
      ctx.restore();
    }

    for (const fn of this.overlays) {
      ctx.save();
      try { fn(ctx, this); } catch (e) { console.error('[map overlay]', e); }
      ctx.restore();
    }
  }

  destroy() { this._ro.disconnect(); }
}

/* --------------------------------------------------------------- helpers */

/** Draw a GeoJSON Polygon / MultiPolygon in map coordinates. */
export function drawGeometry(ctx, map, geom, { stroke, fill, width = 1.5, glow = 8 }) {
  if (!geom) return;
  const rings = geom.type === 'Polygon' ? [geom.coordinates]
    : geom.type === 'MultiPolygon' ? geom.coordinates : null;
  if (!rings) return;

  ctx.beginPath();
  for (const poly of rings) {
    for (const ring of poly) {
      ring.forEach(([lon, lat], i) => {
        const [x, y] = map.project(lat, lon);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.closePath();
    }
  }
  if (fill) { ctx.fillStyle = fill; ctx.fill('evenodd'); }
  if (stroke) {
    ctx.save();
    if (glow) { ctx.shadowColor = stroke; ctx.shadowBlur = glow / 2; }
    ctx.strokeStyle = stroke; ctx.lineWidth = width;
    ctx.stroke();
    ctx.restore();
  }
}

/** The "you are here" reticle. */
export function drawMarker(ctx, x, y, color = '#f07aa6', label = null, pulse = 0) {
  ctx.save();
  ctx.shadowColor = color; ctx.shadowBlur = 7;
  ctx.strokeStyle = color; ctx.lineWidth = 1.5;

  const r = 7;
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath();
  for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
    ctx.moveTo(x + dx * (r + 2), y + dy * (r + 2));
    ctx.lineTo(x + dx * (r + 7), y + dy * (r + 7));
  }
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.arc(x, y, 2.2, 0, Math.PI * 2); ctx.fill();

  if (pulse > 0) {
    ctx.globalAlpha = 1 - pulse;
    ctx.beginPath(); ctx.arc(x, y, r + pulse * 26, 0, Math.PI * 2); ctx.stroke();
    ctx.globalAlpha = 1;
  }
  if (label) {
    ctx.shadowBlur = 0;
    ctx.font = "600 11.5px 'Chakra Petch', sans-serif";
    ctx.letterSpacing = '1.4px';
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    const w = ctx.measureText(label).width + 10;
    ctx.fillStyle = 'rgba(22,33,47,.85)';
    ctx.fillRect(x + r + 8, y - 7, w, 14);
    ctx.fillStyle = color;
    ctx.fillText(label, x + r + 13, y);
  }
  ctx.restore();
}

/** Scale bar, so distances on the radar mean something. */
export function drawScaleBar(ctx, map, x, y) {
  const metersPerPx = (156543.03392 * Math.cos((map.lat * Math.PI) / 180)) / Math.pow(2, map.zoom);
  const targetPx = 110;
  const targetMi = (metersPerPx * targetPx) / 1609.344;
  const steps = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
  const mi = steps.reduce((a, b) => (Math.abs(b - targetMi) < Math.abs(a - targetMi) ? b : a));
  const px = (mi * 1609.344) / metersPerPx;

  ctx.save();
  ctx.strokeStyle = 'rgba(221,226,232,.75)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, y - 4); ctx.lineTo(x, y); ctx.lineTo(x + px, y); ctx.lineTo(x + px, y - 4);
  ctx.stroke();
  ctx.font = "500 11.5px 'JetBrains Mono', monospace";
  ctx.fillStyle = 'rgba(221,226,232,.75)';
  ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
  ctx.fillText(`${mi} mi`, x + px / 2, y - 5);
  ctx.restore();
}
