// A deliberately small DOM/event harness. It exercises production modal logic
// without a browser dependency; rendered geometry is verified separately.
class Element {
  constructor(tag, doc, attrs = {}) {
    this.tagName = tag.toLowerCase(); this.ownerDocument = doc; this.attrs = { ...attrs };
    this.children = []; this.parentNode = null; this.listeners = new Map();
    this.scrollTop = 0; this.visibility = 'visible'; this.focusCount = 0;
    this.classList = {
      toggle: (name, on) => {
        const names = new Set((this.attrs.class || '').split(/\s+/).filter(Boolean));
        if (on ?? !names.has(name)) names.add(name); else names.delete(name);
        this.attrs.class = [...names].join(' ');
      },
    };
  }
  get id() { return this.attrs.id || ''; }
  set id(value) { this.attrs.id = value; }
  get dataset() { return Object.fromEntries(Object.entries(this.attrs).filter(([k]) => k.startsWith('data-')).map(([k, v]) => [k.slice(5), v])); }
  get tabIndex() { return 'tabindex' in this.attrs ? +this.attrs.tabindex : /^(button|input|select|textarea|summary)$/.test(this.tagName) || this.matches('a[href], [contenteditable="true"]') ? 0 : -1; }
  get hidden() { return 'hidden' in this.attrs; }
  set hidden(value) { if (value) this.attrs.hidden = ''; else delete this.attrs.hidden; }
  get inert() { return 'inert' in this.attrs; }
  set inert(value) { if (value) this.attrs.inert = ''; else delete this.attrs.inert; }
  get isConnected() { return this === this.ownerDocument.body || !!this.parentNode?.isConnected; }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  getAttribute(name) { return this.attrs[name] ?? null; }
  removeAttribute(name) { delete this.attrs[name]; }
  append(node) { node.parentNode = this; this.children.push(node); }
  matches(selectors) {
    return selectors.split(',').some(selector => {
      const s = selector.trim();
      if (s === ':disabled') return 'disabled' in this.attrs;
      if (s.startsWith('.')) return (this.attrs.class || '').split(/\s+/).includes(s.slice(1));
      if (s.startsWith('#')) return this.id === s.slice(1);
      const m = s.match(/^([\w-]+)?(?:\[([\w-]+)(?:="([^"]*)")?\])?$/);
      return !!m && (!m[1] || m[1] === this.tagName) && (!m[2] || m[2] in this.attrs && (m[3] === undefined || this.attrs[m[2]] === m[3]));
    });
  }
  closest(selector) { for (let node = this; node; node = node.parentNode) if (node.matches(selector)) return node; return null; }
  contains(node) { for (; node; node = node.parentNode) if (node === this) return true; return false; }
  querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  getClientRects() { return this.isConnected && !this.closest('[hidden]') ? [{}] : []; }
  focus() {
    if (!this.isConnected || this.closest('[hidden], [inert]') || this.matches(':disabled')) return;
    this.focusCount++;
    this.ownerDocument.activeElement = this;
    this.ownerDocument.dispatch('focusin', { target: this });
  }
  addEventListener(type, listener, capture = false) {
    const key = `${type}:${capture}`;
    if (!this.listeners.has(key)) this.listeners.set(key, new Set());
    this.listeners.get(key).add(listener);
  }
  removeEventListener(type, listener, capture = false) { this.listeners.get(`${type}:${capture}`)?.delete(listener); }
  set innerHTML(html) {
    for (const child of this.children) child.parentNode = null;
    this.children = []; this.html = html;
    const stack = [this];
    for (const match of html.matchAll(/<\/?([\w-]+)([^>]*)>/g)) {
      if (match[0][1] === '/') { stack.pop(); continue; }
      const attrs = {};
      for (const attr of match[2].matchAll(/([\w-]+)(?:="([^"]*)"|='([^']*)'|=([^\s>]+))?/g)) attrs[attr[1]] = attr[2] ?? attr[3] ?? attr[4] ?? '';
      const node = new Element(match[1], this.ownerDocument, attrs);
      stack.at(-1).append(node);
      if (!/^(input|br|hr|img|meta|link)$/.test(node.tagName)) stack.push(node);
    }
  }
  get innerHTML() { return this.html || ''; }
}

class Document extends Element {
  constructor() {
    super('document', null); this.ownerDocument = this;
    this.body = new Element('body', this); this.activeElement = this.body;
    this.defaultView = { getComputedStyle: node => ({ visibility: node.visibility }) };
  }
  dispatch(type, details = {}) {
    const event = { target: this.activeElement, defaultPrevented: false, stopped: false,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...details };
    for (const listener of [...(this.listeners.get(`${type}:true`) || [])]) listener(event);
    if (!event.stopped) for (let node = event.target; node; node = node.parentNode) {
      for (const listener of [...(node.listeners.get(`${type}:false`) || [])]) listener(event);
      if (event.stopped) break;
    }
    if (!event.stopped) for (const listener of [...(this.listeners.get(`${type}:false`) || [])]) listener(event);
    return event;
  }
  listenerCount(type) { return [...this.listeners].filter(([key]) => key.startsWith(`${type}:`)).reduce((n, [, listeners]) => n + listeners.size, 0); }
}
module.exports = { Document, Element };
