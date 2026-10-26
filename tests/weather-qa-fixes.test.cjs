const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Document, Element } = require('./weather-qa-dom.cjs');
const root = path.join(__dirname, '..');
// The same regression file gates canonical public/ and the exported weather/.
const frontend = fs.existsSync(path.join(root, 'weather/js/state.js')) ? 'weather' : 'public';
const read = file => {
  if (file.startsWith('css/')) {
    // Read the stylesheet actually linked by the page, including export hashes.
    const name = path.basename(file, '.css');
    const pattern = new RegExp(`(?:^|/)css/${name}(?:\\.[\\w-]+)?\\.css(?:[?#].*)?$`);
    const href = [...read('index.html').matchAll(/<link\b[^>]*href="([^"]+)"[^>]*>/g)]
      .map(match => match[1]).find(value => pattern.test(value));
    assert.ok(href, `index.html links the ${name} stylesheet`);
    file = path.join('css', path.basename(href.split(/[?#]/)[0]));
  }
  return fs.readFileSync(path.join(root, frontend, file), 'utf8');
};
// This dependency-free ES module also runs under the site's CommonJS package.
const production = import(`data:text/javascript;base64,${Buffer.from(read('js/lib/modal.js')).toString('base64')}`);

async function harness() {
  const { createModalController } = await production;
  const doc = new Document();
  doc.body.innerHTML = '<div id="app"><button id="cfgBtn"></button><button id="locBtn"></button><div id="board" tabindex="0"></div></div>'
    + read('index.html').match(/<div class="modal" id="modal" hidden>[\s\S]*?<\/div>\s*<\/div>/)[0];
  const $ = id => doc.body.querySelector(`#${id}`);
  const overlay = $('modal'), card = $('modalCard'), background = $('app'), cfg = $('cfgBtn');
  const controller = createModalController(overlay, card, background);
  const state = { settings: { voice: true }, saves: 0, save() { this.saves++; } };
  const main = read('js/main.js');
  const modalCode = main.slice(main.indexOf('export function openModal('), main.indexOf('/* -------------------------------------------------------------- search UI */')).replaceAll('export ', '');
  const settingsCode = main.slice(main.indexOf('function openSettings('), main.indexOf('function toggleSound()'));
  const { openSettings } = vm.runInNewContext(modalCode + settingsCode + '\n({openSettings})', {
    modal: controller, perf: { manual: null }, store: state,
    isAudioOn: () => false, setManualQuality() {}, toggleSound() {},
  });
  return { doc, $, overlay, card, background, cfg, state, controller, openSettings,
    press: (key, options = {}) => doc.dispatch('keydown', { key, ...options }) };
}

const simple = '<div class="hd">TEST</div><button id="first"></button><button id="middle"></button><button id="last"></button>';

test('the real Settings entry point opens a named modal, focuses its first control, and makes the app inert', async () => {
  const h = await harness();
  h.$('board').focus(); // Pointer-trigger restoration works even if the browser did not focus the gear.
  h.openSettings({ currentTarget: h.cfg });
  assert.equal(h.overlay.hidden, false);
  assert.equal(h.background.inert, true);
  assert.equal(h.card.getAttribute('role'), 'dialog');
  assert.equal(h.card.getAttribute('aria-modal'), 'true');
  assert.equal(h.card.getAttribute('tabindex'), '-1');
  assert.equal(h.card.getAttribute('aria-labelledby'), h.card.querySelector('.hd').id);
  assert.equal(h.doc.activeElement.dataset.q, 'auto');
  const event = h.press('Escape');
  assert.equal(event.defaultPrevented, true);
  assert.equal(h.overlay.hidden, true);
  assert.equal(h.doc.activeElement, h.cfg);
  assert.equal(h.background.inert, false);
});

test('Settings Tab and Shift+Tab wrap only at the edges and leave interior native traversal alone', async () => {
  const h = await harness(); h.cfg.focus(); h.openSettings();
  const buttons = h.card.querySelectorAll('button'), first = buttons[0], last = buttons.at(-1);
  assert.equal(h.press('Tab').defaultPrevented, false);
  assert.equal(h.doc.activeElement, first);
  assert.equal(h.press('Tab', { shiftKey: true }).defaultPrevented, true);
  assert.equal(h.doc.activeElement, last);
  assert.equal(h.press('Tab').defaultPrevented, true);
  assert.equal(h.doc.activeElement, first);
  last.focus();
  assert.equal(h.press('Tab', { shiftKey: true }).defaultPrevented, false);
  h.controller.close();
});

test('the trap recomputes enabled and visible controls and contains programmatic focus', async () => {
  const h = await harness(); h.cfg.focus(); h.controller.open(simple);
  h.$('first').setAttribute('disabled', '');
  h.$('last').hidden = true;
  h.$('middle').focus();
  h.press('Tab'); assert.equal(h.doc.activeElement.id, 'middle');
  h.press('Tab', { shiftKey: true }); assert.equal(h.doc.activeElement.id, 'middle');
  const outsider = new Element('button', h.doc); h.doc.body.append(outsider);
  outsider.focus(); assert.equal(h.doc.activeElement.id, 'middle');
  h.$('middle').visibility = 'hidden';
  h.card.focus(); h.press('Tab'); assert.equal(h.doc.activeElement, h.card);
  h.controller.close();
});

test('repeated open, replacement and dismiss cycles restore the original trigger without accumulating handlers', async () => {
  const h = await harness();
  for (let i = 0; i < 4; i++) {
    h.cfg.focus(); h.openSettings();
    assert.equal(h.doc.listenerCount('keydown'), 1);
    assert.equal(h.doc.listenerCount('focusin'), 1);
    h.controller.open(simple); // Replaces focused Settings controls.
    h.$('last').focus();
    h.press('Escape');
    assert.equal(h.doc.activeElement, h.cfg);
    assert.equal(h.card.innerHTML, '');
    assert.equal(h.doc.listenerCount('keydown'), 0);
    assert.equal(h.doc.listenerCount('focusin'), 0);
    const count = h.cfg.focusCount;
    h.controller.close(); assert.equal(h.cfg.focusCount, count);
  }
});

test('clicking inside keeps Settings open; clicking the backdrop dismisses and restores focus', async () => {
  const h = await harness(); h.cfg.focus(); h.openSettings();
  h.doc.dispatch('click', { target: h.$('voiceT') });
  assert.equal(h.state.settings.voice, false); assert.equal(h.state.saves, 1);
  assert.equal(h.overlay.hidden, false);
  h.doc.dispatch('click', { target: h.overlay });
  assert.equal(h.overlay.hidden, true); assert.equal(h.doc.activeElement, h.cfg);
});

test('Search keeps its requested input focus and local keyboard actions still receive events', async () => {
  const h = await harness(); let arrows = 0;
  h.$('locBtn').focus();
  h.controller.open('<div class="hd">LOCATION</div><button></button><input id="q"><button></button>', card => {
    const input = card.querySelector('#q');
    input.addEventListener('keydown', event => { if (event.key === 'ArrowDown') { arrows++; event.preventDefault(); } });
    input.focus();
  });
  assert.equal(h.doc.activeElement.id, 'q');
  h.press('ArrowDown'); assert.equal(arrows, 1);
  h.press('Escape'); assert.equal(h.doc.activeElement.id, 'locBtn');
});

test('Alerts with no controls retain dialog focus and suppress weather shortcuts until dismissed', async () => {
  const h = await harness();
  const store = { playing: false, toNow() { this.now = true; }, scrubTo() { this.scrubbed = true; }, emit() {}, span: {} };
  const main = read('js/main.js');
  const source = main.slice(main.indexOf('function onKey(e) {')).split('// Local alias')[0];
  const onKey = vm.runInNewContext(source + '\nonKey', { store, closeModal: h.controller.close, document: h.doc, VIEWS: [] });
  h.doc.addEventListener('keydown', onKey);
  h.cfg.focus(); h.controller.open('<div class="hd">ALERTS</div><div>No active alerts</div>');
  assert.equal(h.doc.activeElement, h.card);
  for (const key of ['Tab', ' ', 'n', 'ArrowRight']) h.press(key);
  h.press('Tab', { shiftKey: true });
  assert.equal(h.doc.activeElement, h.card);
  assert.equal(store.playing, false); assert.equal(store.now, undefined); assert.equal(store.scrubbed, undefined);
  h.press('Escape'); assert.equal(h.doc.activeElement, h.cfg);
  h.$('board').focus();
  // A non-control page surface still accepts the existing N shortcut.
  h.$('board').removeAttribute('tabindex'); h.press('n'); assert.equal(store.now, true);
});

test('modified Tab and composing or handled Escape do not interrupt native input', async () => {
  const h = await harness(); h.cfg.focus(); h.openSettings();
  for (const property of ['ctrlKey', 'metaKey', 'altKey']) assert.equal(h.press('Tab', { [property]: true }).defaultPrevented, false);
  for (const property of ['isComposing', 'defaultPrevented']) { h.press('Escape', { [property]: true }); assert.equal(h.overlay.hidden, false); }
  h.press('Escape'); assert.equal(h.overlay.hidden, true);
});

test('close preserves prior inert state and tolerates a removed trigger; untitled dialogs have a fallback name', async () => {
  const h = await harness(); h.cfg.focus(); h.background.inert = true;
  h.controller.open('<p>Notice</p>');
  assert.equal(h.card.getAttribute('aria-label'), 'Weather dialog');
  assert.equal(h.card.getAttribute('aria-labelledby'), null);
  h.cfg.parentNode = null;
  assert.doesNotThrow(() => h.controller.close());
  assert.equal(h.background.inert, true);
});

function declarationsFor(css, wanted) {
  const declarations = {};
  for (const [, selectors, body] of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!selectors.split(',').map(x => x.trim()).includes(wanted)) continue;
    for (const part of body.split(';')) {
      const colon = part.indexOf(':');
      if (colon >= 0) declarations[part.slice(0, colon).trim()] = part.slice(colon + 1).trim();
    }
  }
  return declarations;
}

test('short modal cards scroll their natural-height rows so focused controls stay reachable', () => {
  const css = read('css/views.css');
  assert.equal(declarationsFor(css, '.modal-card')['max-height'], '76dvh');
  assert.equal(declarationsFor(css, '.modal-card')['overflow-y'], 'auto');
  assert.equal(declarationsFor(css, '.modal-card > *')['flex-shrink'], '0');
  assert.equal(declarationsFor(read('css/core.css'), '.hd').flex, '0 0 auto');
});

test('short Sky cards have a non-shrinking content-and-chart layout with reachable overflow', () => {
  const css = read('css/views.css');
  // Source-level layout contract, not a substitute for rendered geometry QA.
  // Moon's body and Seeing's score must keep their content height when the
  // grid row is only 210px; the graph/tonight section follows, never overlays.
  assert.equal(declarationsFor(css, '.skyview > .panel > .body')['flex-shrink'], '0');
  assert.equal(declarationsFor(css, '.skyview .tn')['flex-shrink'], '0');
  assert.equal(declarationsFor(read('css/core.css'), '.hd').flex, '0 0 auto');
  assert.equal(declarationsFor(css, '.skyview > .panel:not(.dome-panel)')['overflow-y'], 'auto');
  assert.equal(declarationsFor(css, '.skyview > .dome-panel')['min-height'], '320px');
  assert.equal(declarationsFor(css, '.skyview')['grid-auto-rows'], 'minmax(210px, auto)');
  const sky = read('js/views/sky.js');
  assert.match(sky, /class="body moon-body"/);
  assert.match(sky, /id="s-moonalt" style="flex:1;min-height:58px/);
  assert.match(sky, /class="body" id="s-seeing"><\/div>\s*<div class="tn" id="s-tonight"/);
  // The phone keeps its one-column, natural-height panel flow.
  const mobile = read('css/mobile.css');
  assert.equal(declarationsFor(mobile, '.skyview').display, 'flex !important');
  assert.equal(declarationsFor(mobile, '.body').flex, '0 0 auto !important');
});
