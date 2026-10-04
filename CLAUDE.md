# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

ATMOS//NET: a weather console. A zero-dependency Node server (`server.mjs`) that serves a vanilla-JS ES-module frontend (`public/`) and acts as a caching proxy for free upstream APIs (Open-Meteo, NWS, RainViewer, NOAA SWPC, pollen.com, Esri tiles). Default location is New York City, overridable with `ATMOS_HOME_*` (`HOME` in `server.mjs`). `README.md` covers features, keyboard shortcuts, and desktop integration in detail.

## Commands

```
npm start                 # node server.mjs → http://localhost:7777
npm run dev               # node --watch server.mjs
./scripts/atmos-wallpaper [--force]   # re-render desktop background now
./scripts/install-desktop.sh | uninstall-desktop.sh
systemctl --user status atmos-net     # the installed service
```

There is no build step, bundler, linter, or test suite, and no npm dependencies (Node >= 20). Verify changes by running the server and loading the page; `?q=0`–`3` pins render quality, `#radar` etc. deep-links a view.

Env vars: `ATMOS_PORT`/`PORT` (7777), `ATMOS_HOST` (default `::`, dual-stack on purpose for Tailscale/iOS AAAA; use `127.0.0.1` for local-only), `ANTHROPIC_API_KEY` (optional; enables the model-written sentence in `/api/elsewhere`, otherwise it returns `{text:null}` and the page keeps its deterministic sentence).

## Architecture

**Server (`server.mjs`)** — one file. A `routes` object maps `/api/*` paths to async handlers returning JSON; anything else is static from `public/` (with a containment check against `PUBLIC + sep`). Upstream fetches go through a two-tier cache (in-memory `mem` with TTL, plus `.cache/` on disk for slow data like the 33-year climate archive, reduced server-side to day-of-year normals). One dead upstream should degrade one panel, not the page. `/api/bundle` returns everything for a location in one round trip; `/api/hud` reduces the same cached bundle to ~200 bytes for the desktop HUD. Deliberately **no CORS headers** — the routes are unauthenticated and reachable from the tailnet, so a wildcard would expose home coordinates to any page.

**Frontend (`public/js/`)** — no framework. `state.js` is the heart: it normalizes API data into series and holds the **time cursor**; the scrubber (`timeline.js`) moves that cursor and every view, gauge, and the sky shader re-derives from it. `main.js` runs a single rAF loop (sky shader, playback, clock); views in `views/` (deck, radar, sky, air, data, overhead) re-render on store events, not per frame. `gl/sky.js` is the WebGL sky; `perf.js` picks render tier 0–3 from power state, visibility, and frame time. `charts.js`/`plots.js` are canvas primitives and composite charts; `lib/` holds pure helpers (astro ephemeris, formatting/scales, `tonight`, `elsewhere`).

**Desktop integration** — `scripts/` plus `systemd/` units (user service, wallpaper and notify timers). `public/wallpaper.html` renders the sky alone; `atmos-wallpaper` screenshots it from the live server on the GPU and skips renders nobody would see (display off, locked, battery/night with a recent render).

## Gotchas

- **Units**: the API is queried in imperial, and Open-Meteo then switches *every length field* (visibility, freezing level, boundary-layer height, snow depth) to feet. `state.js` normalizes these back to metres at ingest using the declared units; downstream code assumes metres.
- **Model vs. measurement**: Open-Meteo's `current` is the current forecast step, not an observation. The hero number is model output; the nearest real NWS station reading is shown beside it. `/api/observations` walks outward until a station reports a non-null temperature.
- **Wallpaper filename alternates** between `sky-a.png` and `sky-b.png` on purpose: Omarchy's background plugin ignores an unchanged path and caches the image by `file://` URL. Never write the same filename twice in a row.
- **Time cursor follows wall-clock** until the user deliberately scrubs; `N` re-engages following.
- **`/api/elsewhere` validates inputs and computes facts server-side** (e.g. `betterCount`) rather than trusting the caller or the model; keep that pattern when touching model-written text.
