'use strict';

// Run the real store in a VM with deterministic feeds. This same file runs
// against public/ in the canonical Weather repo and weather/ in the site.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const root = path.join(__dirname, '..');
const frontend = fs.existsSync(path.join(root, 'weather/js/state.js')) ? 'weather' : 'public';
const read = name => fs.readFileSync(path.join(root, frontend, 'js', name), 'utf8');
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
const PORTLAND = { name: 'Portland', latitude: 45.52, longitude: -122.68, timezone: 'America/Los_Angeles' };
const TOKYO = { name: 'Tokyo', latitude: 35.68, longitude: 139.69, timezone: 'Asia/Tokyo' };
const PARIS = { name: 'Paris', latitude: 48.86, longitude: 2.35, timezone: 'Europe/Paris' };
const TIMES = ['2026-10-09T00:00', '2026-10-09T01:00'];

function bundle(temp, timezone = 'UTC', air = true) {
  return {
    forecast: { ok: true, data: { timezone, utc_offset_seconds: 0, elevation: temp,
      hourly: { time: TIMES, temperature_2m: [temp, temp], wind_direction_10m: [350, 10] },
      daily: { time: ['2026-10-09'], temperature_2m_max: [temp] } } },
    air: air ? { ok: true, data: { hourly: { time: TIMES, us_aqi: [temp, temp] }, current: { us_aqi: temp } } } : { ok: false },
    alerts: { ok: true, data: { features: [] } }, space: { ok: true, data: { temp } },
  };
}

function harness(saved = {}) {
  const calls = {}, api = {};
  for (const method of ['bundle', 'radar', 'pollen', 'observations', 'climate', 'models']) {
    calls[method] = [];
    api[method] = (...args) => new Promise((resolve, reject) => calls[method].push({ args, resolve, reject }));
  }
  let persisted = saved;
  const context = vm.createContext({
    api, Date, Intl, console: { error() {} },
    localStorage: { getItem: () => JSON.stringify(persisted), setItem: (_, value) => { persisted = JSON.parse(value); } },
    clamp: (v, lo, hi) => Math.min(hi, Math.max(lo, v)), lerp: (a, b, f) => a + (b - a) * f,
    makeTimeFmt: tz => ({ isoDate: t => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(t) }),
    wx: code => ({ code }), sunPosition: () => ({ altitude: 0, azimuth: 0 }),
    moonPosition: () => ({ altitude: 0, azimuth: 0 }), moonIllumination: () => ({}),
    sunTimes: () => ({}), moonTimes: () => ({}), toCompass: () => 'N',
  });
  const source = read('state.js').replace(/^import .*;\r?\n/gm, '')
    .replace('export const store =', 'const store =').replace(/^export \{.*\};?\r?\n?/gm, '');
  const { store, blend, sampleSeries } = vm.runInContext(source + '\n;({ store, blend, sampleSeries });', context);
  function settleSides(index, label) {
    for (const method of ['radar', 'pollen', 'observations', 'climate', 'models']) {
      const payload = method === 'models' ? { hourly: { time: TIMES, temperature_2m_test: [label, label] } } : { label };
      calls[method][index]?.resolve(payload);
    }
  }
  async function select(loc, value, air) {
    const index = calls.bundle.length, pending = store.setLocation(loc);
    calls.bundle[index].resolve(bundle(value, loc.timezone || loc.tz, air));
    await flush();
    settleSides(calls.radar.length - 1, value);
    await pending;
  }
  return { store, blend, sampleSeries, calls, settleSides, select, persisted: () => persisted };
}

test('latest city wins when bundles resolve out of order, including timezone and persistence', async () => {
  const h = harness(), events = [];
  h.store.on('data', () => events.push([h.store.loc.name, h.store.hours[0]?.temp]));
  const first = h.store.setLocation(PORTLAND), second = h.store.setLocation(TOKYO);
  h.calls.bundle[1].resolve(bundle(80, TOKYO.timezone)); await flush(); h.settleSides(0, 80); await second;
  h.calls.bundle[0].resolve(bundle(50, PORTLAND.timezone)); await flush(); h.settleSides(1, 50); await first;
  assert.equal(h.store.loc.name, 'Tokyo'); assert.equal(h.store.tz, TOKYO.timezone);
  assert.equal(h.store.hours[0].temp, 80); assert.equal(h.persisted().loc.name, 'Tokyo');
  assert.equal(h.calls.radar.length, 1); assert.ok(events.every(([city, temp]) => city === 'Tokyo' && temp === 80));
});

for (const failure of ['reject', 'forecast unavailable', 'empty forecast']) {
  test(`failed city change keeps the previous location and readings together: ${failure}`, async () => {
    const h = harness(); await h.select(PORTLAND, 50);
    const before = h.store.raw, pending = h.store.setLocation(PARIS);
    assert.equal(h.store.loc.name, 'Portland'); assert.equal(h.store.status, 'load');
    if (failure === 'reject') h.calls.bundle[1].reject(new Error('offline'));
    else h.calls.bundle[1].resolve(failure === 'empty forecast' ? { forecast: { ok: true, data: { hourly: { time: [] } } } } : { forecast: { ok: false } });
    await flush(); h.settleSides(1, 65); await pending;
    assert.equal(h.store.loc.name, 'Portland'); assert.equal(h.store.tz, PORTLAND.timezone);
    assert.equal(h.store.hours[0].temp, 50); assert.equal(h.store.raw, before);
    assert.equal(h.persisted().loc.name, 'Portland'); assert.equal(h.store.status, 'err');
    const retry = h.store.refresh();
    assert.deepEqual(h.calls.bundle[2].args, [PARIS.latitude, PARIS.longitude]);
    h.calls.bundle[2].resolve(bundle(65, PARIS.timezone)); await flush(); h.settleSides(1, 65); await retry;
    assert.equal(h.store.loc.name, 'Paris'); assert.equal(h.store.hours[0].temp, 65);
  });
}

test('a late rejection cannot turn the newest successful selection into an error', async () => {
  const h = harness(), errors = []; h.store.on('error', e => errors.push(e));
  const first = h.store.setLocation(PORTLAND); await h.select(TOKYO, 80);
  h.calls.bundle[0].reject(new Error('late failure')); await first;
  assert.equal(h.store.status, 'ok'); assert.equal(h.store.loc.name, 'Tokyo'); assert.equal(errors.length, 0);
});

test('older success is ignored after the latest selection fails', async () => {
  const h = harness(); await h.select(PORTLAND, 50);
  const older = h.store.setLocation(TOKYO), newer = h.store.setLocation(PARIS);
  h.calls.bundle[2].reject(new Error('offline')); await newer;
  h.calls.bundle[1].resolve(bundle(80, TOKYO.timezone)); await flush(); h.settleSides(1, 80); await older;
  assert.equal(h.store.loc.name, 'Portland'); assert.equal(h.store.hours[0].temp, 50); assert.equal(h.store.status, 'err');
});

test('every secondary feed and final data notification obeys request identity', async () => {
  const h = harness(), events = []; h.store.on('data', () => events.push(h.store.loc.name));
  const first = h.store.setLocation(PORTLAND); h.calls.bundle[0].resolve(bundle(50, PORTLAND.timezone)); await flush();
  const second = h.store.setLocation(TOKYO); h.calls.bundle[1].resolve(bundle(80, TOKYO.timezone, false)); await flush();
  for (const field of ['radar', 'pollen', 'observed', 'climate', 'models']) assert.equal(h.store[field], null);
  assert.equal(h.store.air.length, 0); assert.equal(h.store.airNow, null);
  h.settleSides(1, 80); await second; await flush(); const count = events.length; // the final notify lands once the side feeds settle, no longer inside refresh()
  h.settleSides(0, 50); await first; await flush();
  for (const field of ['radar', 'pollen', 'observed', 'climate']) assert.equal(h.store[field].label, 80);
  assert.equal(h.store.models.rows[0].mean, 80); assert.equal(events.length, count);
});

test('overlapping refreshes of the same city keep the newest readings', async () => {
  const h = harness(); await h.select(PORTLAND, 50);
  const first = h.store.refresh(), second = h.store.refresh();
  h.calls.bundle[2].resolve(bundle(55, PORTLAND.timezone)); await flush(); h.settleSides(1, 55); await second;
  h.calls.bundle[1].resolve(bundle(49, PORTLAND.timezone)); await flush(); h.settleSides(2, 49); await first;
  assert.equal(h.store.hours[0].temp, 55); assert.equal(h.store.status, 'ok');
});

test('models retry independently after climate succeeds and models fails', async () => {
  const h = harness(), first = h.store.setLocation(PORTLAND);
  h.calls.bundle[0].resolve(bundle(50, PORTLAND.timezone)); await flush();
  h.calls.models[0].reject(new Error('models unavailable')); h.settleSides(0, 50); await first;
  assert.equal(h.store.models, null); assert.equal(h.store.climate.label, 50);
  const retry = h.store.refresh(); h.calls.bundle[1].resolve(bundle(55, PORTLAND.timezone)); await flush();
  assert.equal(h.calls.climate.length, 1); assert.equal(h.calls.models.length, 2);
  h.settleSides(1, 55); await retry; assert.equal(h.store.models.rows[0].mean, 55);
});

test('malformed optional alerts degrade to no alerts without breaking a city change', async () => {
  const h = harness(); await h.select(PORTLAND, 50);
  const changed = h.store.setLocation(TOKYO), b = bundle(80, TOKYO.timezone);
  b.alerts = { ok: true, data: null }; h.calls.bundle[1].resolve(b); await flush(); h.settleSides(1, 80); await changed;
  assert.equal(h.store.loc.name, 'Tokyo'); assert.equal(h.store.hours[0].temp, 80);
  assert.equal(h.store.status, 'ok'); assert.equal(h.store.alerts.length, 0); assert.equal(h.persisted().loc.name, 'Tokyo');
});

test('failed normalization cannot partially commit location, readings, caches or persistence', async () => {
  const h = harness(); await h.select(PORTLAND, 50);
  const original = { loc: h.store.loc, raw: h.store.raw, hours: h.store.hours, climate: h.store.climate, tz: h.store.tz };
  const changed = h.store.setLocation(TOKYO), b = bundle(80, TOKYO.timezone);
  Object.defineProperty(b.forecast.data, 'daily', { get() { throw new Error('malformed daily payload'); } });
  h.calls.bundle[1].resolve(b); await changed;
  for (const key of Object.keys(original)) assert.equal(h.store[key], original[key]);
  assert.equal(h.store.status, 'err'); assert.equal(h.persisted().loc.name, 'Portland');
});

test('first-load failure can retry without a saved or visible city', async () => {
  const h = harness(), first = h.store.setLocation(TOKYO, { remember: false });
  h.calls.bundle[0].reject(new Error('offline')); await first;
  assert.equal(h.store.loc, null); assert.equal(h.store.frame(), null);
  const retry = h.store.refresh(); h.calls.bundle[1].resolve(bundle(80, TOKYO.timezone));
  await flush(); h.settleSides(0, 80); await retry;
  assert.equal(h.store.loc.name, 'Tokyo'); assert.equal(h.persisted().loc, undefined);
});

test('favorites normalize both coordinate shapes, deduplicate by coordinates, and retain timezone', () => {
  const h = harness(); h.store.addFavorite(PORTLAND); h.store.addFavorite(TOKYO);
  assert.equal(h.store.favorites.length, 2);
  h.store.addFavorite({ name: 'Portland again', lat: '45.5201', lon: '-122.6801', tz: PORTLAND.timezone });
  assert.equal(h.store.favorites.length, 2); assert.equal(h.store.favorites[0].name, 'Portland again');
  assert.equal(h.store.favorites[0].timezone, PORTLAND.timezone);
  h.store.addFavorite({ name: 'Equator', lat: 0, lon: 0 }); assert.equal(h.store.favorites.length, 3);
});

test('malformed persisted or incoming coordinates are discarded, not coerced into NaN or zero', async () => {
  const h = harness({ loc: { name: 'invalid', lat: 'NaN', lon: 2 }, favorites: [PORTLAND, { lat: '', lon: 0 }, null] });
  assert.equal(h.store.loc, null); assert.equal(h.store.favorites.length, 1);
  for (const lat of [undefined, null, '', ' ', 'NaN', Infinity, 91, true]) {
    h.store.addFavorite({ lat, lon: 0 }); await h.store.setLocation({ lat, lon: 0 });
  }
  assert.equal(h.calls.bundle.length, 0); assert.equal(h.store.favorites.length, 1);
});

test('restored short coordinate names and saved timezone survive a reload', async () => {
  const h = harness({ loc: { name: 'Tokyo', lat: 35.68, lon: 139.69, tz: TOKYO.timezone }, favorites: [{ name: 'Tokyo', lat: 35.68, lon: 139.69, tz: TOKYO.timezone }] });
  const pending = h.store.setLocation(h.store.loc);
  assert.deepEqual(h.calls.bundle[0].args, [35.68, 139.69]);
  const b = bundle(80); delete b.forecast.data.timezone; h.calls.bundle[0].resolve(b);
  await flush(); h.settleSides(0, 80); await pending;
  assert.equal(h.store.tz, TOKYO.timezone); assert.equal(h.store.favorites[0].latitude, 35.68);
});

test('wind follows the shortest angular arc while numeric and discrete fields keep their rules', () => {
  const h = harness();
  for (const [from, to, want] of [[350, 10, 0], [10, 350, 0], [90, 180, 135], [0, 360, 0], [0, 180, 270]]) {
    const actual = h.blend({ windDir: from, temp: 10, code: 1 }, { windDir: to, temp: 20, code: 2 }, 0.5);
    assert.equal(actual.windDir, want); assert.equal(actual.temp, 15); assert.equal(actual.code, 2);
  }
  assert.equal(h.sampleSeries([{ t: 0, windDir: 350 }, { t: 100, windDir: 10 }], 25).windDir, 355);
  assert.equal(h.blend({ windDir: null }, { windDir: 10 }, 0.5).windDir, 10);
});

function keyboard() {
  const store = { playing: false, following: true, view: 'deck', cursor: 100, span: { hi: 1e12 }, emit() {}, scrubTo() { this.scrubbed = true; }, toNow() { this.live = true; }, refresh() { this.refreshed = true; } };
  let closed = 0;
  const start = read('main.js').indexOf('function onKey(e) {');
  const source = read('main.js').slice(start).split('// Local alias')[0];
  const onKey = vm.runInNewContext(source + '\nonKey', { store, closeModal: () => closed++, Date, VIEWS: [], setView() {}, openSearch() {}, openAlerts() {}, showBriefing() {}, toggleSound() {}, openSettings() {}, document: {} });
  return { store, onKey, closed: () => closed };
}

for (const target of ['button', 'a[href]', 'input', 'textarea', 'select', 'summary', '[contenteditable]', '[role="button"]', '[role="slider"]']) {
  test(`weather shortcuts leave native ${target} controls and their descendants alone`, () => {
    const h = keyboard(); let prevented = 0;
    for (const key of [' ', 'ArrowLeft', 'ArrowRight', 'n', 'r']) {
      h.onKey({ key, target: { closest: selectors => selectors.split(',').map(x => x.trim()).includes(target) ? {} : null, matches: () => ['input', 'textarea', '[contenteditable]'].includes(target) }, preventDefault: () => prevented++ });
    }
    assert.equal(h.store.playing, false); assert.equal(h.store.scrubbed, undefined);
    assert.equal(h.store.live, undefined); assert.equal(h.store.refreshed, undefined); assert.equal(prevented, 0);
  });
}

test('weather canvas shortcuts still work; modifiers, composition and handled events are ignored', () => {
  const h = keyboard(), target = { closest: () => null, matches: () => false }; let prevented = 0;
  for (const flag of ['ctrlKey', 'metaKey', 'altKey', 'isComposing', 'defaultPrevented']) {
    h.onKey({ key: ' ', target, [flag]: true, preventDefault: () => prevented++ });
    assert.equal(h.store.playing, false);
  }
  h.onKey({ key: ' ', target, preventDefault: () => prevented++ });
  assert.equal(h.store.playing, true); assert.equal(h.store.following, false); assert.equal(prevented, 1);
  h.onKey({ key: 'Escape', target: { closest: () => ({}), blur() {} } }); assert.equal(h.closed(), 1);
});

function radarSidebar() {
  const source = read('views/radar.js');
  const start = source.indexOf('  function renderSide() {');
  const end = source.indexOf('  /* ------------------------------------------------------------ controls */', start);
  assert.ok(start >= 0 && end > start, 'extract the real radar sidebar renderer');
  const cacheDeclarations = source.match(/^  let lastSide(?:Key|Data) = .*;$/gm) || [];
  assert.ok(cacheDeclarations.length, 'extract the real sidebar cache variables');
  const now = Date.parse('2026-10-09T12:00:00Z');
  const elements = new Map();
  let writes = 0;
  const $ = id => {
    if (!elements.has(id)) {
      let html = '';
      elements.set(id, {
        textContent: '',
        get innerHTML() { return html; },
        set innerHTML(value) { html = value; writes++; },
      });
    }
    return elements.get(id);
  };
  const frame = { t: now, precip: 0, cape: 0, cloud: 0, freezing: 2000, wx: { label: 'CLEAR' } };
  const store = {
    loc: PORTLAND, raw: {}, cursor: now, following: false,
    frame: () => frame,
    fmt: { weekday: () => 'Fri', hm: () => '12:00' },
    alerts: [{ event: 'Old warning', areaDesc: 'Portland', severity: 'Moderate' }],
    hours: [{ t: now + 3600_000, precip: 0.25, pop: 20, cape: 100 }],
  };
  const render = vm.runInNewContext(cacheDeclarations.join('\n') + '\n'
    + source.slice(start, end) + '\nrenderSide', {
    store, $, Date: { now: () => now },
    STATUS: { good: 'green', warn: 'yellow', serious: 'orange', crit: 'red' },
    SERIES: ['blue'], clamp: (v, lo, hi) => Math.min(hi, Math.max(lo, v)),
    kv: (key, value) => `${key}=${value};`, esc: value => value,
    alertColor: () => 'red',
  });
  return { store, frame, render, element: $, writes: () => writes, now };
}

for (const switchCity of [true, false]) {
  test(`radar refreshes paused sidebar after ${switchCity ? 'a city switch' : 'a same-city bundle'} with an unchanged condition key`, () => {
    const h = radarSidebar();
    h.render();
    assert.match(h.element('r-alertlist').innerHTML, /Old warning/);
    assert.match(h.element('r-cover').innerHTML, /Next 6h total=0\.25 in/);
    const writes = h.writes();
    h.render();
    assert.equal(h.writes(), writes, 'an unchanged bundle keeps the render cache');

    // City, alerts and future totals change while cursor/current conditions,
    // alert count and hourly row count (the old cache key) stay identical.
    if (switchCity) h.store.loc = TOKYO;
    h.store.raw = { fetched: h.now + 1 };
    h.store.alerts = [{ event: 'Updated warning', areaDesc: switchCity ? 'Tokyo' : 'Portland', severity: 'Severe' }];
    h.store.hours = [{ t: h.now + 3600_000, precip: 1.5, pop: 90, cape: 1800 }];
    h.render();
    assert.match(h.element('r-alertlist').innerHTML, /Updated warning/);
    assert.doesNotMatch(h.element('r-alertlist').innerHTML, /Old warning/);
    assert.match(h.element('r-alertlist').innerHTML, switchCity ? /Tokyo/ : /Portland/);
    assert.match(h.element('r-cover').innerHTML, /Next 6h total=1\.50 in/);
    assert.match(h.element('r-cover').innerHTML, /Peak chance 6h=90%/);
    assert.match(h.element('r-conv').innerHTML, /Peak CAPE 24h=1800/);
    assert.equal(h.frame.t, h.now, 'the paused cursor has not moved');
    const updatedWrites = h.writes();
    h.render();
    assert.equal(h.writes(), updatedWrites, 'the new bundle can be cached after rendering');
  });
}

test('setLocation resolves on the bundle alone; the five side feeds never hold the boot', async () => {
  const h = harness(); let done = false;
  const p = h.store.setLocation(PORTLAND).then(() => { done = true; });
  h.calls.bundle[0].resolve(bundle(50, PORTLAND.timezone)); await flush(); await p;
  assert.equal(done, true); assert.equal(h.store.hours[0].temp, 50);
  for (const field of ['radar', 'pollen', 'observed', 'climate', 'models']) assert.equal(h.store[field], null, field);
  const events = []; h.store.on('data', () => events.push(1));
  h.settleSides(0, 50); await flush();
  assert.equal(h.store.radar.label, 50); assert.equal(events.length, 1, 'one final data notification once they land');
});
