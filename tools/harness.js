/* Load the bundle in node with just enough browser to let it finish.
 *
 * check.py proves the bundle parses; this lets a test call the real
 * roomChips(), areaBuckets(), fieldKit() and the rest instead of a copy
 * pasted into the test, which is the kind of copy that passes after the
 * original has changed. The bundle is an ES module only because of one
 * import.meta.url, so that is rewritten rather than the whole file being
 * treated as one.
 *
 *   const { fieldKit } = require("./tools/harness.js");
 */

/* A real tree, not a proxy that swallows everything: the editor is mostly
 * DOM assembly, so a test has to be able to append, remove, count children
 * and querySelector them back. Unknown properties read as undefined and
 * unknown methods throw, which is the point - a silent stub turns a missing
 * method into a passing test. Add to the no-ops below when one is missing. */
const EV = Symbol("listeners");
class El {
  constructor(tag) {
    this.tagName = String(tag || "div").toUpperCase();
    this.style = {}; this.dataset = {}; this.attributes = {};
    this.children = []; this.parentNode = null; this.shadowRoot = null;
    this[EV] = {};
    this._text = ""; this._html = "";
    /* set so a read is undefined rather than a throw, the way a real
     * element answers for a property it has not been given yet */
    for (const k of ["value", "title", "type", "placeholder", "checked",
      "disabled", "hass", "icon", "header", "secondary", "expanded", "outlined",
      "leftChevron", "slot", "src", "href", "id", "className", "spellcheck",
      "open", "hidden", "name", "label", "min", "max", "step", "multiple",
      "allowCustomEntity", "includeDomains", "excludeEntities", "selector",
      "schema", "data", "computeLabel", "computeHelper", "config", "editMode",
      "tabIndex", "draggable", "rows", "cols", "autofocus", "selected",
      "textContent", "innerHTML", "onclick"]) if (!(k in this)) this[k] = undefined;
    const s = new Set();
    this.classList = {
      add: (...c) => c.forEach((x) => x && s.add(x)),
      remove: (...c) => c.forEach((x) => s.delete(x)),
      toggle: (c, on) => { const has = s.has(c);
        if (on === undefined ? has : !on) s.delete(c); else s.add(c); },
      contains: (c) => s.has(c),
    };
    this._extra = s;
  }
  /* className and classList are separate in the bundle - no element uses
   * both - but a selector has to find either. */
  _classes() {
    return new Set([...String(this.className || "").split(/\s+/).filter(Boolean),
                    ...this._extra]);
  }
  get firstChild() { return this.children[0] || null; }
  get lastChild() { return this.children[this.children.length - 1] || null; }
  get childNodes() { return this.children; }
  get isConnected() { return true; }
  appendChild(k) {
    if (!(k instanceof El)) return k;
    if (k.parentNode) k.remove();
    k.parentNode = this; this.children.push(k); return k;
  }
  append(...ks) {
    for (const k of ks) {
      if (k instanceof El) this.appendChild(k);
      else if (k != null) this._text += String(k);
    }
  }
  prepend(k) { if (k instanceof El) { k.parentNode = this; this.children.unshift(k); } }
  insertBefore(k, b) {
    const i = this.children.indexOf(b);
    if (i < 0) return this.appendChild(k);
    if (k.parentNode) k.remove();
    k.parentNode = this; this.children.splice(i, 0, k); return k;
  }
  removeChild(k) {
    const i = this.children.indexOf(k);
    if (i >= 0) { this.children.splice(i, 1); k.parentNode = null; }
    return k;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  replaceWith(n) {
    if (!this.parentNode) return;
    this.parentNode.insertBefore(n, this);
    this.remove();
  }
  get textContent() {
    return this._text + this.children.map((k) => k.textContent).join("");
  }
  set textContent(v) {
    for (const k of this.children) k.parentNode = null;
    this.children.length = 0;
    this._text = v == null ? "" : String(v);
  }
  get innerHTML() { return this._html; }
  set innerHTML(v) {
    this._html = v == null ? "" : String(v);
    if (!this._html) {
      for (const k of this.children) k.parentNode = null;
      this.children.length = 0; this._text = "";
    }
  }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return k in this.attributes ? this.attributes[k] : null; }
  removeAttribute(k) { delete this.attributes[k]; }
  hasAttribute(k) { return k in this.attributes; }
  toggleAttribute(k, on) { if (on === undefined ? !this.hasAttribute(k) : on) this.attributes[k] = ""; else delete this.attributes[k]; return this.hasAttribute(k); }
  addEventListener(t, f) { (this[EV][t] = this[EV][t] || []).push(f); }
  removeEventListener(t, f) {
    const a = this[EV][t] || []; const i = a.indexOf(f);
    if (i >= 0) a.splice(i, 1);
  }
  dispatchEvent(e) {
    for (const f of (this[EV][(e && e.type) || ""] || []).slice()) f.call(this, e);
    return true;
  }
  /* what a test presses */
  fire(type, detail) {
    return this.dispatchEvent({ type, detail, target: this,
      stopPropagation() {}, preventDefault() {} });
  }
  click() { return this.fire("click"); }
  attachShadow() { this.shadowRoot = new El("shadow-root"); return this.shadowRoot; }
  /* a very small selector engine: tag, .class, [attr], [attr="v"], and a
   * comma list of those. Enough for what the editor asks of the DOM. */
  _match(sel) {
    for (const part of String(sel).split(",").map((x) => x.trim())) {
      if (!part) continue;
      /* every class in a compound one - ".banner.off" is both, not a class
       * called "banner.off", which is what this used to look for, so a test
       * asserting there was NO such element passed whatever the page held */
      if (part[0] === ".") {
        const want = part.slice(1).split(".").filter(Boolean);
        if (want.every((c) => this._classes().has(c))) return true;
        continue;
      }
      if (part[0] === "[") {
        const m = /^\[([^\]=]+)(?:=["']?([^\]"']*)["']?)?\]$/.exec(part);
        if (m && (m[2] === undefined ? this.hasAttribute(m[1])
                                     : this.getAttribute(m[1]) === m[2])) return true;
        continue;
      }
      const m2 = /^([a-zA-Z0-9-]+)((?:\.[^.\[]+)*)((?:\[[^\]]*\])*)$/.exec(part);
      if (!m2) continue;
      if (this.tagName !== m2[1].toUpperCase()) continue;
      const cls = (m2[2].match(/\.[^.\[]+/g) || []).map((x) => x.slice(1));
      if (cls.some((c) => !this._classes().has(c))) continue;
      const at = m2[3].match(/\[[^\]]*\]/g) || [];
      if (at.some((a) => !this._match(a))) continue;
      return true;
    }
    return false;
  }
  _all(out) { for (const k of this.children) { out.push(k); k._all(out); } return out; }
  querySelectorAll(sel) { return this._all([]).filter((k) => k._match(sel)); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  getElementsByTagName(t) { return this.querySelectorAll(t); }
  closest(sel) {
    let n = this;
    while (n) { if (n._match(sel)) return n; n = n.parentNode; }
    return null;
  }
  matches(sel) { return this._match(sel); }
  contains(n) { return n === this || this._all([]).includes(n); }
  elementFromPoint() { return null; }
  getBoundingClientRect() {
    return { top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0, x: 0, y: 0 };
  }
  focus() {} blur() {} scrollIntoView() {} scrollTo() {}
  setPointerCapture() {} releasePointerCapture() {}
  select() {} setSelectionRange() {} load() {} play() {} pause() {}
  animate() { return { cancel() {}, finish() {}, finished: Promise.resolve() }; }
  cloneNode() { return new El(this.tagName); }
  insertAdjacentElement(_, k) { return this.appendChild(k); }
}
const el = (tag) => new El(tag);

global.Element = El;
global.Node = El;
global.HTMLElement = class {};
global.customElements = { _m: new Map(), define(n, c) { this._m.set(n, c); },
  get(n) { return this._m.get(n); }, whenDefined() { return Promise.resolve(); } };
global.document = { createElement: el, createElementNS: (_, t) => el(t),
  createTextNode: (t) => { const e = el("#text"); e.textContent = t; return e; },
  createDocumentFragment: () => el("#fragment"),
  querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
  body: el("body"), head: el("head"), documentElement: el("html"),
  addEventListener() {}, removeEventListener() {}, elementFromPoint: () => null };
global.window = { addEventListener() {}, removeEventListener() {},
  loadCardHelpers: async () => ({}), matchMedia: () => ({ matches: false,
    addEventListener() {}, removeEventListener() {} }),
  location: { hash: "", href: "" }, history: { replaceState() {}, pushState() {} },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  devicePixelRatio: 1, innerWidth: 1280, innerHeight: 800,
  getComputedStyle: () => ({ getPropertyValue: () => "" }),
  requestAnimationFrame: (f) => setTimeout(f, 0), cancelAnimationFrame: clearTimeout,
  setTimeout, clearTimeout, setInterval, clearInterval, document: global.document };
for (const k of ["location", "history", "localStorage", "setTimeout", "clearTimeout",
                 "setInterval", "clearInterval", "getComputedStyle",
                 "requestAnimationFrame", "cancelAnimationFrame"]) global[k] = window[k];
global.CustomEvent = class { constructor(t, o) { this.type = t; Object.assign(this, o); } };
global.Event = global.CustomEvent;
global.navigator = { clipboard: { writeText: async () => {} }, userAgent: "node" };
global.fetch = async () => ({ ok: true, json: async () => ({}), text: async () => "" });

const src = require("fs").readFileSync(
  require("path").join(__dirname, "..", "dist", "charro-cards.js"), "utf8");
// the bundle is a classic script; expose what the tests need
eval(src.replace(/import\.meta\.url/g, JSON.stringify("https://x/charro-cards.js")) +
  "\n;globalThis.__T = { roomChips, chipLook, chipCol, tileChips, roomBody, VIDEO_CSS," +
  "\n  CHIP_PAL, CHIP_SPECS, CHIP_OFF, CHIP_GROUPS, TILE_CHIPS," +
  "\n  areaBuckets, areaApply, areaChoices, entityArea, entityLabel," +
  "\n  entityRefs, AREA_TARGETS, AREA_WORDS, fieldKit, entStateLine,\n  PANEL_USED, PANEL_ADD, PANEL_OPEN, PREV_MODES, lightIds,\n  fetchAll, loadAll, loadChips, invalidateRooms,\n  loadHouse, pagePath, HOUSE_PAGE_BASE,\n  heaterFeatures, heaterCard, pumpCard, waterPart,\n  LIGHT_GROUPS, RE_LIGHT_LISTS, lightCard, materializeLayout, autoBody,\n  ROOM_LISTS, ROOM_SINGLES, ROOM_SCHEMA, ROOM_LABELS, ROOM_HELPERS,\n  ROOM_SECTIONS, FIELD_WHERE, sectionOrder,\n  hwKind, hwDiscover, hwPick, hwColor, hwSeconds, hwState, hwSummary, hwSig,\n  hwDur, hwWhen, hwLine, hwUntil, hwAct, hwRefreshSoon, hwTileDom, hwGridDom,\n  hwZoneDom, HW_COLORS, HW_PENDING_MS, _hwPend,\n  hwDayKey, hwMidnight, hwCountReq, hwRunsReq, hwDayRuns, hwDaily, hwRuns, hwWeek, hwCompare, hwLogDom,\n  hwTabsDom, HW_LOG_DAYS, HW_LOG_FETCH_DAYS,\n  blockCards, videoIsBasic, sourceSelect, screenPower, CharroVideoCard,\n  avFill, liveInputFor, volumeFor, displayMedia };");
module.exports = Object.assign(globalThis.__T, { El, el });
