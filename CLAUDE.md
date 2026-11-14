# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

ATMOS//NET is a weather console built for one machine: a fullscreen web portal with a live WebGL sky, six views, and a time scrubber that moves the whole interface through the forecast. A zero-dependency Node server (`server.mjs`) serves a vanilla-JS ES-module frontend (`public/`) and is a caching proxy for free, keyless upstream APIs (Open-Meteo, NWS, NHC, RainViewer, NOAA SWPC, pollen.com, volunteer ADS-B feeds). Optional Linux desktop integration (Omarchy / Hyprland) runs it as a systemd user service, paints the live sky as the wallpaper and sends rain and alert notifications. It starts on New York City, overridable with `ATMOS_HOME_*`. `README.md` covers features, shortcuts and configuration.

What the code optimises for. Use these to decide anything this file does not cover:

1. **Honest data.** A model value is never shown as a measurement. "No data", "zero" and "could not check" are three different answers and are never merged.
2. **One dead upstream degrades one panel, never the page.** A bad value costs one cell.
3. **Everything on screen is a pure function of (series, time cursor).** Scrub the cursor and every number, chart and the sky follow.
4. **No dependencies and no build step,** on purpose (`CONTRIBUTING.md`).
5. **It earns its frame rate.** Nothing does per frame what it can do per event, and nothing polls while nobody is looking.
6. **Free upstreams are favours.** Cache them, time them out, ask rarely.
7. **There is no authentication, so nothing is trusted and nothing is exposed.** No CORS headers; no caller text reaches an upstream URL or a model prompt unvalidated.

## How it's built

**Server (`server.mjs`, one file).** A `routes` object maps `/api/*` paths to `async (q: URLSearchParams) => object` handlers; the return value is sent as JSON. `throw new HttpError(400, msg)` for bad input; any other throw becomes a 502 `{error}`. Every other path is a static file from `public/`, sent with `Cache-Control: no-cache` after a containment check against `PUBLIC + path.sep`. Upstream calls go through `cachedJSON(key, ttl, url, opts)`: an in-memory `Map` with TTLs from 10 s (aircraft) to 30 days (climate archive), capped at 200 entries, plus `.cache/` on disk (`disk: true`) for slow, stable data. `soft(label, fn)` turns a failed source into `{ok: false}` and logs it. `/api/bundle` returns forecast, air quality, alerts and space weather for a point in one round trip, each as `{ok, data}`; `/api/hud` reduces the same cached bundle to a few hundred bytes for the desktop HUD. `atcf.mjs` is the pure parser for the NHC storm-track files behind `/api/storms`.

**Data flow in the browser.** `api.js` → `store` (`state.js`). `ingest()` zips Open-Meteo's parallel arrays into records with short keys (`temp`, `pop`, `windDir`: see the `*_MAP` tables) and an epoch-ms `t`, giving `store.hours`, `days`, `min15` and `air`. `store.frame(t = store.cursor)` interpolates them and adds the decoded weather code and the sun and moon positions. Views, gauges, audio and the sky shader all read `frame()`. Side feeds (`radar`, `pollen`, `observed`, `climate`, `models`) load after the bundle and each emits its own event. The bundle refreshes every 5 minutes while the tab is visible. The page fetches only its own origin; map and radar tiles, loaded as images from Esri and RainViewer, are the one exception.

**Time cursor.** `store.cursor` follows wall-clock time (`following = true`) until the user scrubs. `scrubTo(t)` is a deliberate move and stops following. `setCursor(t)` is an ambient one (the playback tick, the radar loop) and does not. `toNow()` re-engages (`N`).

**Loop and views.** `main.js` runs the main `requestAnimationFrame` loop: sky shader, playback, follow-now sync, clock, audio. Views re-render on store events, and only the visible one (`views[store.view].update()`). A view is a factory, `createX(root)` → `{ update, onShow?, onHide? }`. There are six: DECK, RADAR, SKY, AIR, DATA and ABOVE (`overhead` in code and in the URL hash). RADAR and ABOVE each own a `SlippyMap` and are built lazily on first open. STORMS (the hurricane atlas) is a mode of RADAR loaded by dynamic `import()`; SATELLITES is a mode of ABOVE that loads SGP4 on first use.

**Drawing.** `charts.js` holds the palette, `mount(canvas, draw)` (device pixel ratio, resize, hover, tap-to-inspect) and the primitives. `plots.js` holds the composite charts. `map.js` is the canvas slippy map. `gl/sky.js` is one fragment shader whose uniforms ease toward `store.skyParams()`. `perf.js` picks render tier 0–3 from power state, tab visibility, handheld detection, reduced-motion and measured frame time, and writes it to `html[data-q]`.

**Desktop.** `public/wallpaper.html` renders the sky plus a small readout; `scripts/atmos-wallpaper` screenshots it with headless Chromium and sets it as the background. `systemd/` holds unit templates that `scripts/install-desktop.sh` fills in and copies to `~/.config/systemd/user`.

## Map

```
server.mjs               routes, cache, upstream URLs, static host (no tests: verify with curl)
atcf.mjs                 pure parser for NHC ATCF b-deck / a-deck files
public/
  index.html             app shell: top bar, six view sections, scrubber, modal, boot log
  wallpaper.html         sky + readout for the desktop background (read its LAYOUT CONTRACT)
  places.json            the places ELSEWHERE compares against
  css/core.css           design tokens, panel, type, top bar, shared components
  css/views.css          per-view grids, scrubber, modal, per-view components
  css/mobile.css         the <= 700px layout: overrides only
  css/fonts.css          self-hosted Chakra Petch and JetBrains Mono (assets/fonts/)
  js/main.js             boot, view routing, rAF loop, keyboard, search / alerts / settings
  js/state.js            the store: ingest, unit normalisation, cursor, frame(), skyParams()
  js/api.js              one method per /api route
  js/perf.js             adaptive quality tier
  js/timeline.js         the scrubber
  js/charts.js           palette, mount(), canvas primitives, label fitting
  js/plots.js            meteogram, spreadFan, climateEnvelope, kpChart
  js/map.js              SlippyMap, Esri tile sources, map drawing helpers
  js/activity.js         activity scores and windows, precipitation nowcast
  js/brief.js            the written and spoken briefing
  js/audio.js            generative soundscape (Web Audio, no samples)
  js/elsewhere.js        ELSEWHERE panel (network + DOM); its rules are in lib/elsewhere.js
  js/gl/sky.js           the sky shader and its Sky class
  js/views/              deck, radar (+ storms), sky, air, data, overhead (+ satellites)
  js/lib/                pure helpers: util (formatting, WMO codes, scales, makeTimeFmt),
                         astro, tonight, elsewhere, storms, stormpack, sats, satcats, modal
  js/lib/satellite/      vendored satellite.js (MIT). Do not edit.
scripts/                 atmos-portal, atmos-wallpaper, atmos-wallpaper-guard, atmos-notify,
                         atmos-check, install-desktop.sh, uninstall-desktop.sh (bash + python3)
systemd/                 unit templates with __PROJECT__ / __NODE__ placeholders
tests/                   node:test regressions (*.test.cjs) and a small DOM stub
.cache/                  disk cache, created at runtime, gitignored
```

## Commands

```bash
npm start                                    # node server.mjs → http://localhost:7777
npm run dev                                  # node --watch server.mjs: restarts on server edits
ATMOS_PORT=7778 ATMOS_HOST=127.0.0.1 node server.mjs    # a second copy when 7777 is taken
node --test tests/*.test.cjs                 # every regression: deterministic, offline, ~1 s
node --test tests/weather-storms.test.cjs    # one file
node --test --test-name-pattern='radar' tests/*.test.cjs
curl -s '127.0.0.1:7778/api/hud'             # every route is a plain GET returning JSON
```

There is no build, bundler, linter, formatter or `npm install`. Node >= 20; CI runs the tests on Node 20 and 22. Static files are read on every request, so a frontend edit needs only a reload. A `server.mjs` edit needs a restart.

To look at the page without a display (the Chromium the wallpaper script already uses):

```bash
chromium --headless --no-sandbox --hide-scrollbars --user-data-dir="$(mktemp -d)" \
  --enable-unsafe-swiftshader --use-gl=angle --use-angle=swiftshader \
  --window-size=1600,1000 --force-device-scale-factor=1 --virtual-time-budget=9000 \
  --screenshot=/tmp/atmos.png 'http://127.0.0.1:7778/?q=1#radar'
```

Use `--window-size=390,844` for the phone layout. Add `--enable-logging=stderr --v=0 2>&1 | grep CONSOLE` to read the page's console. `#deck|radar|sky|air|data|overhead` deep-links a view and `?q=0`–`3` pins the render tier. In a browser console, `window.ATMOS` is `{ store, sky, perf, setView, views }`.

Desktop commands act on the real desktop, so see *Running desktop scripts to "test"* below before using them: `./scripts/atmos-check` (read-only health check), `systemctl --user status atmos-net`, `./scripts/atmos-wallpaper [--force]`, `./scripts/install-desktop.sh`, `./scripts/uninstall-desktop.sh`.

Environment: `ATMOS_PORT` / `PORT` (7777); `ATMOS_HOST` (`::`, dual-stack on purpose for Tailscale and iOS AAAA lookups; `127.0.0.1` for local-only); `ATMOS_HOME_NAME`, `_ADMIN1`, `_COUNTRY`, `_LAT`, `_LON`, `_TZ`; `ANTHROPIC_API_KEY` (optional: lets `/api/elsewhere` return a model-written sentence; without it the route answers `{text: null}` and the page keeps its rules-written one). Script-only switches are documented at the top of each script.

## How to work here

1. Find the owning file in the map. Read the whole function you will change and the comment above it. That comment usually names a failure the code exists to prevent. Do not reintroduce it.
2. Grep for the other users and the twins of what you are changing before you change it.
3. Make the smallest change that does the job, in the style of the file you are in.
4. Verify at the level the change lives: tests for logic, `curl` for routes, a rendered page for anything visible.
5. Report what you verified and what you did not. If you notice an unrelated problem, say so; do not fix it unasked.

Where common changes go:

- **New forecast variable.** Add it to `HOURLY` / `DAILY` / `MIN15` / `AQ_VARS` in `server.mjs`, then add `shortKey: 'api_name'` to the matching `*_MAP` in `state.js`, then read it from `store.frame()` or `store.hours`. A value that must not be blended goes in `DISCRETE`. An hourly or 15-minute length is converted to metres automatically when the API declares `ft`.
- **New route.** `async '/api/name'(q)` in `routes`; validate first (`point(q)`, a regex, a range); fetch through `cachedJSON` with a prefixed key and a TTL matched to how fast the source changes; wrap each independent upstream in `soft()`; return only the fields the UI draws; add a method to `public/js/api.js`; make the caller keep its last good state on rejection.
- **New panel.** Markup in the view's template (`.panel` > `.hd` + `.body`) with ids carrying the view's prefix (`d-`, `r-`, `s-`, `a-`, `d2-`, `o-`, `st-`, `ew-`); fill it in `update()`; place it in the view's grid in `views.css`; check the 1250px and 700px layouts.
- **New chart.** A `<canvas>` in the template, then `const c = mount($('id'), (ctx, w, h, hover) => { … })` drawing from `store` with `charts.js` primitives, then `c.render()` from `update()` and `onShow()`. `mount()` draws once immediately, so helpers the draw function calls must be function declarations, not `const`s defined further down.
- **New view (rare).** Nav button and `<section>` in `index.html`; `VIEWS`, the mount (`lazyView` if it owns a map), the `'1'`–`'6'` key range and the key help in `main.js`; a factory in `views/` that sets `root.className = 'view yourview'`; a root grid in `views.css`; the root added to the one-column stack list in `mobile.css`.

## Coding rules

**Style.** Plain ES modules, no TypeScript, no framework. Two-space indent, single quotes, semicolons, trailing commas in multi-line literals, `const` unless reassigned, arrow functions for small helpers, `== null` to test for null-or-undefined, HTML built with template literals. Match the file you are in, including its spelling (`colour` and `color` both exist; do not normalise).

**Comments are the project's memory.** They say why, usually by recording the failure that produced the code, with the measurement ("Measured at 390px: all six overlapped."). Keep that density. When you change behaviour, update the comment beside it. When you fix a bug, record at the fix what was observed. Never delete a rationale comment because the code looks obvious, and never add one that narrates what a line does.

**Server.**
- Every upstream `fetch` has a timeout (`AbortSignal.timeout`), including the ones that bypass `cachedJSON`.
- Cache keys carry a prefix and rounded coordinates (`toFixed(3)` for a bundle, coarser for slow data). The memory cache holds 200 entries, so never key on something unique per request.
- Map only the specific status that means "nothing here" to an empty answer (NWS 400 outside the US, adsbdb 404, NHC 404 before it publishes). Everything else stays a failure so `soft()` logs it.
- Caller input never reaches an upstream URL or a prompt unvalidated. `/api/elsewhere` rebuilds its facts from validated fields and counts `betterCount` itself; `/api/storms` takes no input at all.
- Every path through the request handler ends in `send()`. A throw outside the route's `try` is only logged as `[unhandled]` and leaves the socket hanging.
- Log lines keep their tags: `[api]`, `[soft]`, `[slow]`, `[unhandled]`.

**Frontend.**
- Read weather through `store.frame()`, `store.hours` and the other store series. Never keep a private copy of the bundle or a private clock.
- Print every time with `store.fmt` (the location's zone, safe on invalid dates) and every number with `fmt` from `lib/util.js`, which prints `--` for null.
- Escape every upstream or user string that goes into `innerHTML` with `escapeHtml` (imported as `esc`). Prefer `textContent`.
- Call the server only through `api.js`. A new upstream means a new server route, never a cross-origin `fetch` from the page.
- A timer or loop belongs to a view: start it in `onShow`, stop it in `onHide`, and return early when `store.view` is not yours or `document.hidden`.
- `update()` runs on every cursor event, which is every frame while dragging or playing, and it rebuilds `innerHTML`. Keep it cheap, hold UI state (an open row, a selection) in a closure variable and re-render from it, and put listeners on the stable container (`openAct` in `views/deck.js` is the pattern).
- Files in `lib/` stay pure: no DOM, no network, no storage, no `Date.now()` and no zero-argument `new Date()`. Time and dependencies arrive as arguments, which is what lets Node test them.
- `localStorage` access is always inside try/catch. Settings go through `store.settings` and `store.save()`.
- Use only what Node 20 and Safari (JavaScriptCore) support. Several bugs here came from V8-only leniency and from APIs Safari lacks.

**Tests.** `node:test`, CommonJS files that load the real ES modules, no network, no browser. They also pin source text: read *Renaming code the tests cut out by text* below before touching `main.js`, `state.js`, `views/radar.js`, `views/sky.js` or the CSS.

**Git.** Commit or push only when asked. Subjects are plain imperative sentences ("Add a wallpaper guard and a post-reboot health check", "/api/pollen: require a five-digit postcode from the reverse geocoder too"), not conventional-commit prefixes. A pull request follows `.github/PULL_REQUEST_TEMPLATE.md`: what and why, and how it was checked.

## Design rules

**Look.** A neon console on deep blue-slate: a `--void` ground that is never black, near-opaque panels with chamfered corners (`clip-path` with `--cut`) rather than rounded ones, cyan for structure, magenta as counterpoint, Chakra Petch for interface text and JetBrains Mono with tabular numerals for values. Glow is a faint, distant halo, never bloom. Fonts are self-hosted so the shell renders with no network: do not link a CDN.

**Colour.** Tokens live in `core.css :root`: accents `--cy` (primary), `--mg` (highlight), `--am` (warm, caution), `--lm` (good), `--vi` (space, night), `--rd` (danger), `--ice` (cold); text `--ink` > `--dim` > `--faint` (captions and labels only). `--ghost` is for rules and fills, never text. A panel takes its accent from `--ac`. `charts.js` repeats the tokens as `SERIES`, `STATUS`, `INK`, `DIM`, `FAINT`, `GROUND` and `SURFACE` because a canvas cannot read custom properties cheaply: change both together. A colour comes from a token, one of those constants, or an existing scale function (`tempColor`, `aqiCategory`, `uvCategory`, `kpCategory`, `dewpointComfort`, `alertColor`, the storm `category`). Do not introduce a new hex.

**Type.** Nothing a reader needs is under 12px in the DOM or 11.5px on a canvas. Every small size is written `max(<size>, var(--fs-floor, 0px))`, in CSS and in inline styles inside view templates. Canvas text uses `MONO`, `MONO_SM` or `UI_LBL`. Contrast stays between 4.5:1 and about 14:1; headings mix their accent 65% toward `--ink` to get there.

**Components.** Reuse before inventing: `.panel` (`.bare` for a full-bleed canvas, `.grow`), `.hd` with `.rule` and `.val`, `.body`, `.kv` rows in a `<dl>`, `.stat`, `.chip`, `.meter`, `.lbl`, `.num`, `.nodata`, `.tl-btn`, `.oh-chip`. A new clickable thing is a `<button>` with `aria-pressed` or `aria-expanded`, as the activity, aircraft and storm rows are. Dialogs go through `openModal(html, onMount, trigger)`, which traps focus, makes the app inert and returns focus to the trigger; the dialog's `.hd` is its accessible name. Global shortcuts must keep ignoring native controls (the guard at the top of `onKey`).

**Charts** (the header of `charts.js` is the rule set).
- One measure per plot area. Two measures share an x-axis as stacked panels, never a second y-axis.
- Categorical series take `SERIES` in fixed order and never cycle. Lime is not a series colour.
- `STATUS` colours mean state and always sit beside a word.
- A diverging measure (an anomaly) runs amber to ice through grey. Uncertainty is one hue at graded opacity. No rainbows.
- Grid and axes recede; the data is the brightest thing drawn. Two or more series get a legend (`tagRow`). Extremes are labelled directly, not every point.
- Every plot has a hover crosshair and a readout, pinned away from the finger on touch: `tooltip(…, { pin: hover.coarse })`.
- Label density comes from measured pixels (`fitTicks`, `fitStride`, `fitHours`, `fitLabel`, `tagRow`), never from a constant. Text drawn over a fill uses `haloText`.

**Layout.** The desktop is a fixed shell with one grid per view, and `body` never scrolls. At <= 1250px the views reflow to fewer columns and scroll. At <= 700px (`mobile.css`) every view is one scrolling column with 44px touch targets and no `backdrop-filter`. The narrowest supported width is 320px. Because the body never scrolls, anything that overflows is unreachable: wrap it, or scroll it inside its panel. Text inputs stay at 16px or iOS zooms the page.

**Motion and cost.** Blur, grain and sweep are gated by `html[data-q]`; the shader gates octaves and particles on `uQuality`. A new effect is off at tier 0 and respects `prefers-reduced-motion`.

**Words.** Flat and factual: declarative, present tense, figures stated plainly, no evaluative adjectives, no exclamation marks ("It is raining now and should ease within 12 minutes."). Say where a number came from and how old it is when that matters. Storm text is life-safety text: "closest forecast approach", "passed within", "similar"; never "safe", "arrive", "will hit" or "no threat".

## Mistakes a weaker model makes here

Each of these looks reasonable and is wrong in this repo.

1. **Checking the wrong server.** If the desktop integration is installed, port 7777 already belongs to the systemd service, and that service may be running a different checkout. *Instead:* `systemctl --user cat atmos-net | grep ExecStart`, start your copy on a spare port, and name the URL you verified.
2. **Adding a dependency, bundler, framework, TypeScript or lint config.** *Instead:* write it in plain JS, as the repo did for its map, its charts and its ephemeris. If you think one is unavoidable, stop and ask.
3. **Presenting model output as an observation.** Open-Meteo's `current` block is a forecast step. The store deliberately ignores it and the hero number interpolates the hourly series. *Instead:* a measurement comes only from `/api/observations` and is labelled with its station, distance and age. (ELSEWHERE does read `current`, to compare places, using its declared units.)
4. **Guessing units.** The API is queried in imperial, and Open-Meteo then reports every length in feet. `state.js` converts lengths to metres at ingest from the declared `*_units`, so store data is °F, mph, inches, hPa and **metres**. *Instead:* convert for display at the edge (`fmt.miles`, `fmt.pressure`). Anything that reads the raw bundle (`hudSummary`, `elsewhere.js`, the scripts) must read `*_units` or expect imperial.
5. **Using the browser's clock or zone.** `getHours()`, `toLocaleTimeString()` and `new Date('2026-09-06')` are wrong for a location in another zone, and `Intl.DateTimeFormat.format()` throws on an Invalid Date. *Instead:* epoch ms everywhere, `store.fmt.*` to print, `epochFrom()` and `utcIso()` in `state.js` to parse Open-Meteo's local strings. A date-only string needs `T00:00:00` before the `Z`, or iOS fails at boot.
6. **Moving the cursor with the wrong call.** `setCursor` for a user's action is undone by the follow-now sync within 20 s. `scrubTo` for an ambient update silently stops the console tracking real time. *Instead:* user intent is `store.playing = false; store.scrubTo(t)`; ambient motion is `setCursor(t)`; a change of play state also needs `store.emit('play', store.playing)`.
7. **Working per frame, or while hidden.** A DOM write or layout read in the rAF loop, or an interval that keeps running after its view is left. *Instead:* render on store events, skip rebuilds whose inputs did not change (`renderSide` in `views/radar.js` is the pattern), and stop in `onHide`.
8. **Building the lazy views.** `views.radar` and `views.overhead` are getters that construct a map and fetch about 70 tiles on first read. *Instead:* read `views[name]` only for the view being shown. Never iterate `views`.
9. **Renaming code the tests cut out by text.** The tests slice real source between markers. In `main.js`: `function onKey(e) {` to `// Local alias`, `export function openModal(` to the `search UI` ruler, and `function openSettings(` to `function toggleSound()`. In `views/radar.js`: `function renderSide() {` to the `controls` ruler, plus the `let lastSideKey` and `let lastSideData` lines. Also the modal markup in `index.html`, specific declarations in `views.css`, `core.css` and `mobile.css`, and markup strings in `views/sky.js`. `state.js` is run with its `import` lines stripped by a one-line regex against a fixed set of stubs. *Instead:* keep the markers, keep each `state.js` import on one line, and when a test has to change, change it in the same commit and say so.
10. **"Repairing" what is deliberately absent.** This repo is the standalone console. The same code also ships inside a larger website, which is why comments mention files that are not here (`scripts/fetch-storms.mjs`, `api-throttle.sh`, `spend-check.mjs`, `pinch-audit.mjs`, `inject-backlink.py`, the `read-audit` and `label-audit` checks, a palette-parity test) and why `/storms/*` and `/sats/*` answer 404, so the hurricane archive and SATELLITES say "not available here". *Instead:* leave those paths, the `cfg?.public` branches and the document-relative base in `api.js` alone. Do not create stubs, and do not fetch NHC or CelesTrak from the browser. Live storms (`/api/storms`) do work here.
11. **Blurring failure into emptiness.** Returning `[]` from a `catch` makes "could not check" read as "none". *Instead:* keep the states apart, as the code does for storms (`ok` / `none` / `fail` per part, and a 502 when NHC cannot be asked), aircraft (feeds down or an empty sky), pollen (no coverage or a low count) and wind radii (not measured or measured as none).
12. **Trusting the caller.** Interpolating a query parameter into an upstream URL, or handing caller text to the model. *Instead:* `point(q)` for coordinates (a bare `Number()` reads a missing parameter as 0, the equator), a strict regex for ids, and facts computed on the server for prompts.
13. **A fetch with no timeout, no cache or no failure path.** A bundle waits for its slowest source. *Instead:* `cachedJSON` plus `soft()`, a deadline sized to how much the source matters, and a briefly remembered failure where a slow source would otherwise be retried on every request (`airFor`).
14. **Leaning on volunteer feeds.** Shorter polling, enriching every aircraft, a second caller for the same data. *Instead:* keep the 10 s cache and the 0.1° key snapping, look up a route only for the aircraft that was tapped, and poll only while the view is on screen.
15. **"Hardening" the server.** Adding `Access-Control-Allow-Origin`, binding `0.0.0.0`, or simplifying the static path check. *Instead:* no CORS (a wildcard would let any page read the home coordinates), `::` (iOS over Tailscale needs the AAAA record), and the `PUBLIC + path.sep` comparison stays.
16. **Changing one copy of a shared constant.** *Instead:* grep for the twin first. Known sets: the rain thresholds 0.002 and 0.08 in `hudSummary`, `scripts/atmos-notify` and `activity.js`; the leap-inclusive day-of-year table in `server.mjs`, `lib/util.js`, `views/deck.js` and `brief.js`; the palette in `core.css` and `charts.js`; the storm models in `STORM_MODELS` (`server.mjs`), `MODELS` (`lib/storms.js`) and `MODEL_COLOUR` (`views/storms.js`); `VIEWS` in `main.js` against the nav and sections in `index.html`; the JSON shapes of `/api/config` and `/api/hud`, which the scripts and the external SYS//NET HUD parse.
17. **Trusting the README over the code.** The README drifts behind the source. *Instead:* take colours from `core.css` and behaviour from the source, and fix the README when you touch the feature.
18. **Typing a size, a colour or a label position by hand.** A bare `font-size: .6rem`, a new hex, or three y-ticks hardcoded on a panel 40px tall: each looks right at 1600px and fails at 390px or in the contrast numbers. *Instead:* the type floor, the tokens and the `fit*` helpers from the design rules, and a look at phone width.
19. **Breaking the wallpaper's contracts.** *Instead:* keep the alternation between `sky-a.png` and `sky-b.png` (Omarchy ignores an unchanged path and caches the image by URL); keep `#hud` in `vw` / `vh` inside the bounds in the LAYOUT CONTRACT comment, because the SYS//NET HUD lines up with it; keep `document.title = 'READY'` and `'ERROR …'`; keep the render to a few frames.
20. **Running desktop scripts to "test".** `install-desktop.sh` edits `~/.config/hypr/bindings.lua` and enables units, `uninstall-desktop.sh` deletes state and resets the background, `atmos-wallpaper` changes the wallpaper and `atmos-notify` sends notifications. *Instead:* run them only when asked. Editing `systemd/*` changes nothing until the installer is re-run, and an installed service needs `systemctl --user restart atmos-net` to pick up a `server.mjs` edit.
21. **"Simplifying" `store.refresh()`.** It is transactional on purpose. A request id drops stale responses. A new bundle is normalised into a scratch object and committed in one step. A failed city change keeps the old city with its own readings. Side feeds are not awaited, so boot is not held by the slowest. *Instead:* preserve all four; `tests/weather-reliability.test.cjs` pins them.
22. **Reformatting, renaming or tidying beyond the task.** *Instead:* the smallest diff that does the job, in the file's existing shape. Report anything else you noticed.
23. **Saying it works without having looked.** The tests cover the store, the keyboard guard, the radar side-panel cache, the modal, a few CSS contracts and the storm rules. Nothing tests `server.mjs`, `atcf.mjs`, the charts, the shader or real layout. *Instead:* run the checklist below and report exactly what you exercised.

## Before calling a task done

1. **Diff.** It contains only what was asked, no stray formatting, and the comments beside changed code are still true.
2. **Tests.** `node --test tests/*.test.cjs` passes. If a test changed, the reason is in your report.
3. **Server change.** You started this checkout on a spare port, called the route with a good request, a missing parameter and a garbage one (expect 400, not 502 and not a hang), and read the log for `[api]`, `[soft]`, `[slow]` and `[unhandled]`.
4. **Frontend change.** You loaded the changed view from this checkout's server at about 1600×1000 and at 390×844 (and at 320 wide if layout or labels changed). No console errors, no clipped or overlapping text.
5. **Cursor.** You dragged the scrubber and pressed `N`: the change follows the cursor and returns to live.
6. **Empty and failing states.** With no data, with null fields and with its source down, the panel still says something true and the rest of the page still works.
7. **Quality tiers.** `?q=0` and `?q=3` both look right if you touched an effect, the shader or `perf.js`.
8. **Twins.** Every shared constant, colour, field name or JSON shape was changed in all its copies.
9. **Upstreams.** Any new fetch has a timeout, a cache TTL, a failure path and a polling rate you could defend to the people who run the feed.
10. **Docs.** `README.md` and this file still describe the commands, routes, environment variables and views.
11. **Report.** What changed, what you verified and how (URL, window sizes), and what you could not verify. Nothing is committed or pushed unless that was asked for.
