# ATMOS//NET

A cyberpunk weather console for one machine. Fullscreen web portal, live WebGL
sky, five views, and a time scrubber that moves the entire interface — including
the sky — through the forecast.

Starts on **New York City** by default (see [Configuration](#configuration)); it
will show anywhere on Earth via search.

```
node server.mjs          # then open http://localhost:7777
```

---

## The five views

| Key | View | What it is for |
|-----|------|----------------|
| `1` | **DECK** | Everything at a glance: conditions, six instruments, 48-hour meteogram, nowcast, activity windows, 16-day outlook |
| `2` | **RADAR** | Animated precipitation over a neon map, alert polygons, convective energy |
| `3` | **SKY** | Real sun and moon positions on a celestial dome, solar day, geomagnetic activity, observing conditions |
| `4` | **AIR** | AQI and pollutant breakdown against EPA/WHO limits, pollen, UV and burn time, comfort |
| `5` | **DATA** | Forecast against 33 years of local record, multi-model agreement, long-term trend, derived aggregates |

## The time scrubber

The strip along the bottom spans two days back to sixteen days forward. Drag it
and **everything** re-derives from the cursor: the sky shader's sun angle and
cloud decks, every gauge, every number, the meteogram, the outlook. `Space`
plays through the forecast; `N` returns to now.

Left alone, the cursor **follows wall-clock time**, so a portal open for hours
keeps showing now rather than freezing at whatever moment the tab loaded. Any
deliberate scrub stops it following until you press `N` or the NOW button.

## Keyboard

| Key | Action | | Key | Action |
|-----|--------|-|-----|--------|
| `1`–`5` | switch view | | `/` | search location |
| `Space` | play / pause forecast | | `A` | alerts |
| `←` `→` | step one hour | | `B` | briefing (with speech) |
| `Shift`+`←` `→` | step six hours | | `S` | ambient audio |
| `N` | return to now | | `F` | fullscreen |
| `R` | force refresh | | `,` | settings |

Views are deep-linkable: `http://localhost:7777/#radar`.
`?q=0`–`3` pins the render quality.

## Data sources

All free, none require an API key or an account.

| Source | Provides |
|--------|----------|
| [Open-Meteo](https://open-meteo.com) | Forecast (hourly + 15-minute), air quality, 1994– archive, multi-model ensemble, geocoding |
| [NWS](https://www.weather.gov/documentation/services-web-api) | US watches, warnings and advisories |
| [RainViewer](https://www.rainviewer.com/api.html) | Global precipitation radar, past and nowcast |
| [NOAA SWPC](https://services.swpc.noaa.gov) | Kp index, solar wind, geomagnetic scales |
| [pollen.com](https://www.pollen.com) | US pollen index and allergen triggers |
| [Esri](https://www.arcgis.com) | Dark Gray Canvas map tiles |

### Model output vs. measurement

Almost everything here is a *model*, including Open-Meteo's `current` block —
that is the current step of its 15-minute forecast, not a thermometer. The two
routinely disagree: at the time of writing the model said 74 °F while the
nearest real station, 5 miles away, read 68 °F.

So the hero number is model output (it has to be, or it would contradict the
forecast curve drawn directly beneath it), and the nearest genuine NWS station
observation is shown next to it with its distance and age. `/api/observations`
walks outward from your point until a station actually reports a temperature —
the closest one often returns `null` and needs a fallback to its recent list.

The server proxies and caches all of them, so a page reload costs nothing and a
single dead upstream degrades one panel rather than the page. The 33-year
climate archive is cached to disk and reduced server-side to day-of-year
normals and records.

### Units

The API is queried in imperial. One consequence worth knowing: Open-Meteo
switches **every length field** (visibility, freezing level, boundary layer
height, snow depth) to feet when `precipitation_unit=inch`. `state.js`
normalizes them back to metres at ingest using the units the API declares, so
everything downstream can assume one unit.

## Signature systems

**Live sky** — one fragment shader draws the atmosphere as it actually is:
sun and moon at their true altitude and azimuth, three cloud decks drifting at
the real wind bearing, precipitation, fog, lightning, aurora, stars, the Milky
Way, and a neon city horizon. Thick cloud both dims the palette and occludes
the sun, so an overcast storm looks like one.

**Activity intelligence** — seven activities scored 0–100 per hour from the
conditions that matter to each, with windows grown outward from their peak
hour and the limiting factor named.

**Ambient audio** (`S`) — no samples. Rain is filtered noise whose bandwidth
tracks drop size, wind is a swept noise band, thunder is synthesised in step
with the shader's lightning, and a drone underneath tracks temperature.

**Briefing** (`B`) — a written summary ordered by how much each fact should
change your plans, optionally read aloud.

**Adaptive quality** — render tier 0–3 chosen from power state, tab visibility
and measured frame time. On battery it drops octaves, particles and resolution;
plugged in it runs everything.

## Remote access over Tailscale

The server binds dual-stack (`::`) so it answers on both IPv4 and IPv6.
MagicDNS publishes an A *and* an AAAA record for a tailnet node, and iOS
prefers the AAAA — binding `0.0.0.0` makes the portal silently unreachable
from exactly the devices most likely to open it remotely.

If `ufw` is enabled with a default-deny input policy, allow the port on the
Tailscale interface only, so the tailnet reaches it and the local network
still cannot:

```bash
sudo ufw allow in on tailscale0 to any port 7777 proto tcp
```

Then any device on the tailnet can open **http://<your-hostname>:7777**.

There is no authentication — the tailnet is the security boundary. Scope the
rule to `tailscale0` rather than opening the port globally, and set
`ATMOS_HOST=127.0.0.1` if you ever want it local-only.

## Desktop integration

```
./scripts/install-desktop.sh      # wire it in
./scripts/uninstall-desktop.sh    # take it all back out
```

The installer backs up every file it touches and:

- runs the server as a **systemd user service** (`atmos-net.service`), started on login
- binds **`SUPER` + `SHIFT` + `W`** to open the portal fullscreen
  *(`SUPER`+`W` is Omarchy's "close window" and is deliberately left alone)*
- sets the **desktop background to the live sky**, re-rendered every 20 minutes
  from the same shader at your monitor's resolution, into
  `~/.local/state/atmos-net/wallpaper/`
- sends **desktop notifications** for severe weather and rain starting within
  the hour, deduplicated so nothing is announced twice

```bash
systemctl --user status atmos-net        # server
systemctl --user list-timers 'atmos*'    # wallpaper + notification schedule
./scripts/atmos-wallpaper                # regenerate the background now
```

The wallpaper alternates between `sky-a.png` and `sky-b.png` on purpose.
Omarchy's background plugin returns early when the path is unchanged
(`Background.qml`: `if (!path || (!force && finalPath === currentBackground))
return`), and its `Image` is cached against a bare `file://` URL, so writing the
same filename every time meant every refresh was silently discarded and the
desktop kept showing the very first render. Alternating two paths defeats both,
and keeps exactly two files on disk. They live outside the theme's backgrounds
directory so they do not clutter `omarchy theme bg next` or the background
switcher.

**Not included:** a status-bar widget. Omarchy's bar plugins are Quickshell QML
against an undocumented `BarWidget` contract (500–960 lines in every stock
example), and a widget that throws at runtime degrades the whole bar. The
stock `omarchy.weather` pill already occupies that slot.

## Layout

```
server.mjs              caching proxy + static host, zero dependencies
public/
  index.html            app shell
  wallpaper.html        the sky alone, for the desktop background
  css/                  design system (core) + view layouts
  js/
    main.js             boot, routing, main loop, global input
    state.js            normalized series, the time cursor, sky parameters
    api.js  perf.js     fetch layer; adaptive quality
    timeline.js         the scrubber
    activity.js         activity scoring and precipitation nowcast
    audio.js  brief.js  generative soundscape; written/spoken briefing
    charts.js plots.js  canvas primitives; composite charts
    map.js              canvas slippy map
    gl/sky.js           the sky shader
    lib/astro.js        solar and lunar ephemeris
    lib/util.js         formatting, WMO codes, comfort/AQI/UV scales
    views/              deck · radar · sky · air · data
scripts/                launcher, wallpaper, notifier, install/uninstall
systemd/                unit templates
```

## Charts

Charts follow one rule set: one measure per plot area (temperature and
precipitation share an x-axis but never a y-axis), categorical colours assigned
in fixed order and never cycled, status colours reserved and always paired with
a word, recessive grid, hover readout on everything.

The categorical palette is `#00eaff · #ff2d8f · #ffb02e · #a75cff · #8ab6ff`.
Lime is deliberately excluded from it — against amber it falls to ΔE 6.6 under
deuteranopia — and is reserved for status, where a label always accompanies it.

## Requirements

Node 20+ and a browser with WebGL2. No npm install; there are no dependencies.

## Configuration

All optional; set them in the environment (or the systemd unit).

| Variable | Default | Purpose |
|----------|---------|---------|
| `ATMOS_PORT` / `PORT` | `7777` | Port to listen on |
| `ATMOS_HOST` | `::` | Address to bind. `::` is dual-stack; use `127.0.0.1` for local-only |
| `ATMOS_HOME_NAME` `_ADMIN1` `_COUNTRY` | New York | Name of the starting location |
| `ATMOS_HOME_LAT` `_LON` | 40.7128, -74.006 | Its coordinates |
| `ATMOS_HOME_TZ` | from the forecast | IANA time zone, e.g. `Europe/London` |
| `ANTHROPIC_API_KEY` | unset | Lets the ELSEWHERE panel write its sentence with a model |

The places ELSEWHERE compares against are in `public/places.json`.

**There is no authentication.** Run it on localhost or a private network. If you
set `ANTHROPIC_API_KEY`, anyone who can reach the server can cause model calls
on your account, so do not expose it to the internet.

## Data sources and terms

No API keys are needed, but each feed has its own terms. Please read them
before running this anywhere public.

- **Open-Meteo**: forecast, air quality, archive, ensemble and geocoding.
  CC BY 4.0, attribution required; the free API is for non-commercial use.
- **NWS (api.weather.gov)**: US alerts and observations. Public domain; the
  server identifies itself with a contact URL in its `User-Agent`.
- **RainViewer**: radar tiles; attribution required, see their API terms.
- **NOAA SWPC**: space weather. Public domain.
- **Esri**: the Dark Gray Canvas basemap is requested from Esri's public tile
  service without a key and is subject to Esri's terms and attribution.
- **pollen.com**: the pollen route calls an undocumented endpoint with no
  official API; it can change or break without notice.
- **adsb.lol, adsb.fi, adsbdb, wheretheiss.at, CelesTrak**: community feeds for
  the overhead view.

## License

MIT, see [LICENSE](LICENSE). The bundled Chakra Petch and JetBrains Mono fonts
are under the SIL Open Font License; see
[public/assets/fonts/NOTICE.md](public/assets/fonts/NOTICE.md).
