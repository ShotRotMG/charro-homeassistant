/*
 * Charro Home Assistant — Lovelace cards
 *
 *   charro-room-card      a room: chip tile, its pop-up, or its full page
 *   charro-security-card  Elk zone / garage door tile, colours itself client-side
 *   charro-zone-card      RTI AD-8x single-line zone control
 *   charro-all-off-card   all zones off, both amps
 *   charro-lights-card    one room of lights, uniform rows, inline dimming
 *   charro-rooms-editor   edit the room files from inside Home Assistant
 *
 * Installed through HACS, so the Lovelace resource is registered automatically.
 * The first four render custom:button-card with a template fetched from
 * ./templates/*.json — cache: "no-store", so a hard refresh picks up edits.
 *
 * HACS replaces those files on update. To keep your own copy, put one under
 * /config/www/cards/ and set template_url on the card:
 *
 *   type: custom:charro-room-card
 *   template_url: /local/cards/room-card.json
 */

const VERSION = "4.19.0";
console.info(
  `%c CHARRO CARDS %c ${VERSION} `,
  "color:#fff;background:#4caf50;font-weight:700",
  "color:#4caf50;background:#fff"
);

/* ------------------------------------------------------------- helpers -- */

const TEMPLATE_BASE = new URL("templates/", import.meta.url).href;

const clone = (o) =>
  typeof structuredClone === "function" ? structuredClone(o) : JSON.parse(JSON.stringify(o));

const uniq = (a) => [...new Set(a.filter(Boolean))];

const slugify = (s) =>
  String(s || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function fireEvent(node, type, detail) {
  const event = new Event(type, { bubbles: true, composed: true });
  event.detail = detail || {};
  node.dispatchEvent(event);
  return event;
}

const _templates = new Map();

function loadTemplate(name, override) {
  const url = override || TEMPLATE_BASE + name;
  if (!_templates.has(url)) {
    const p = fetch(`${url}?t=${Date.now()}`, { cache: "no-store" })
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status} ${r.statusText} for ${url}`);
        return r.json();
      })
      .catch((err) => {
        _templates.delete(url);
        throw err;
      });
    _templates.set(url, p);
  }
  return _templates.get(url);
}

const ent = (domains, multiple) => ({
  entity: { multiple: !!multiple, filter: domains.map((d) => ({ domain: d })) },
});

/* --------------------------------------------------------- base card ---- */

class CharroBase extends HTMLElement {
  setConfig(config) {
    if (!config) throw new Error("Invalid configuration");
    this._config = config;
    this._card = null;
    this._building = false;
    this.innerHTML = "";
    if (this._hass) this._build();
  }

  set hass(hass) {
    this._hass = hass;
    if (this._card) this._card.hass = hass;
    else this._build();
  }

  // subclasses override
  templateName() { return ""; }
  variables() { return {}; }
  triggers() { return []; }
  overrides() { return {}; }

  async _build() {
    if (this._building || !this._hass || !this._config) return;
    this._building = true;
    try {
      const [tpl, helpers] = await Promise.all([
        loadTemplate(this.templateName(), this._config.template_url),
        window.loadCardHelpers(),
      ]);
      const cfg = clone(tpl);
      cfg.type = "custom:button-card";
      cfg.variables = { ...(tpl.variables || {}), ...this.variables() };
      const trg = this.triggers();
      if (trg.length) cfg.triggers_update = trg;
      Object.assign(cfg, this.overrides());
      delete cfg.template;

      const el = helpers.createCardElement(cfg);
      el.hass = this._hass;
      this.innerHTML = "";
      this.appendChild(el);
      this._card = el;
    } catch (err) {
      const msg = err && err.message ? err.message : err;
      this.innerHTML =
        `<ha-card style="padding:12px;color:var(--error-color);font-size:13px">` +
        `${this.localName}: ${msg}</ha-card>`;
      console.error(`${this.localName}:`, err);
    } finally {
      this._building = false;
    }
  }

  getCardSize() { return 1; }
}

/* ------------------------------------------------------- generic editor - */

function makeEditor(tag, schema, labels, helpers) {
  class Editor extends HTMLElement {
    setConfig(config) { this._config = config || {}; this._render(); }
    set hass(hass) {
      this._hass = hass;
      if (this._form) this._form.hass = hass; else this._render();
    }
    _render() {
      if (!this._hass || !this._config) return;
      if (!this._form) {
        this._form = document.createElement("ha-form");
        this._form.schema = schema;
        this._form.computeLabel = (s) => labels[s.name] || s.title || s.name;
        this._form.computeHelper = (s) => (helpers || {})[s.name] || "";
        this._form.addEventListener("value-changed", (ev) => {
          ev.stopPropagation();
          const next = { ...this._config, ...ev.detail.value };
          for (const k of Object.keys(next)) {
            if (k === "type") continue;
            const v = next[k];
            if (v === "" || v === undefined || (Array.isArray(v) && !v.length)) delete next[k];
          }
          this._config = next;
          fireEvent(this, "config-changed", { config: next });
        });
        this.appendChild(this._form);
      }
      this._form.hass = this._hass;
      this._form.data = this._config;
    }
  }
  customElements.define(tag, Editor);
}

/* ==================================================== ROOM: SHARED CONFIG = */
/*
 * A room can be defined once, in a file the cards fetch, instead of three
 * times across the tile, the pop-up and the subview page:
 *
 *   type: custom:charro-room-card      # the tile, and it owns pop-up #master
 *   room: master                     # -> /local/rooms/master.json
 *
 *   type: custom:charro-room-card      # the same room as a full page
 *   mode: page
 *   room: master
 *
 * One file per room, under /config/www/rooms/ — not in this repo, since HACS
 * replaces dist/ on every update and your rooms are your data. Keys match the
 * card's own option names, so anything set on the card overrides the file.
 *
 * Note that /local/ is served without authentication. A room file holds entity
 * ids and layout, never secrets — keep it that way.
 */

const ROOMS_DIR_DEFAULT = "/local/rooms/";
const _roomFiles = new Map();
let _indexP = null;

function roomsDir(cfg) {
  return ((cfg && cfg.rooms_dir) || ROOMS_DIR_DEFAULT).replace(/\/*$/, "/");
}

/* _index.json is the only file fetched uncached. It is tiny, and it carries
 * the revision every other room fetch is stamped with — which is what lets
 * those be cached hard (Home Assistant serves /local with a 31-day max-age)
 * while an edit still shows up on the next load. Saving bumps the revision,
 * the URLs change, and the browser refetches exactly what changed.
 * An older plain-array index has no revision, so those fall back to
 * always-fresh fetches. */
function loadIndex(cfg) {
  if (!_indexP) {
    const u = roomsDir(cfg) + "_index.json";
    _indexP = fetch(`${u}?t=${Date.now()}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => (Array.isArray(j) ? { rooms: j, rev: null }
                                     : { rooms: (j && j.rooms) || [], rev: (j && j.rev) || null }))
      .catch(() => ({ rooms: [], rev: null }));
  }
  return _indexP;
}

function roomUrl(key, cfg) {
  if (cfg && cfg.room_url) return cfg.room_url;
  return roomsDir(cfg) + key + ".json";
}

function stamped(url, rev) {
  const sep = url.includes("?") ? "&" : "?";
  return rev ? `${url}${sep}v=${encodeURIComponent(rev)}`
             : `${url}${sep}t=${Date.now()}`;
}

function fetchStamped(base, cfg, transform) {
  return loadIndex(cfg).then(({ rev }) => {
    const url = stamped(base, rev);
    if (!_roomFiles.has(url)) {
      const p = fetch(url, rev ? {} : { cache: "no-store" })
        .then((r) => {
          if (!r.ok) throw new Error(`${r.status} ${r.statusText} for ${base}`);
          return r.json();
        })
        .then((j) => (transform ? transform(j) : j))
        .catch((err) => { _roomFiles.delete(url); throw err; });
      _roomFiles.set(url, p);
    }
    return _roomFiles.get(url);
  });
}

function loadRoom(key, cfg) {
  return fetchStamped(roomUrl(key, cfg), cfg, (j) => {
    // tolerate a file that wraps the room in its own key
    if (j && !j.room_name && j[key] && typeof j[key] === "object") return j[key];
    return j;
  });
}

const roomHash = (c) => {
  let h = c.popup_hash || (c.room_name ? "#" + slugify(c.room_name) : "");
  if (h && !h.startsWith("#")) h = "#" + h;
  return h;
};

/* A light may be a plain id or {entity, name, icon, dim}. */
const lightId = (l) => (typeof l === "string" ? l : l && l.entity);
const lightIds = (list) => (list || []).map(lightId).filter(Boolean);

const RENDER_KINDS = { mushroom: "Mushroom", tile: "Tile", hue: "Hue-style" };

function lightCard(l, noDim) {
  const id = lightId(l);
  const o = typeof l === "object" && l ? l : {};
  const dims = o.dim !== undefined ? o.dim : !(noDim || []).includes(id);

  if (o.render === "tile") {
    const card = { type: "tile", entity: id, vertical: false };
    if (o.name) card.name = o.name;
    if (o.icon) card.icon = o.icon;
    if (dims) { card.features_position = "bottom"; card.features = [{ type: "light-brightness" }]; }
    return card;
  }
  if (o.render === "hue") {
    const card = { type: "custom:hue-like-light-card", entities: [id] };
    if (o.name) card.title = o.name;
    if (o.icon) card.icon = o.icon;
    return card;
  }

  const card = { type: "custom:mushroom-light-card", entity: id };
  if (o.name) card.name = o.name;
  if (o.icon) card.icon = o.icon;
  if (!dims) {
    card.show_brightness_control = false;
    card.collapsible_controls = false;
    card.hold_action = { action: "toggle" };
    card.double_tap_action = { action: "toggle" };
  }
  return card;
}

/* Body of a room, shared by the pop-up and the page. Each block appears only
 * if the room actually defines those entities, so no room needs its own
 * layout. `cards` drops raw Lovelace into a named slot for the one-offs. */
const ROOM_SECTIONS = ["climate", "media", "lights", "cameras", "security"];

/* Music Assistant players get the richer card. hass.entities carries the
 * platform, which is the authoritative answer; the attributes are the
 * fallback for older cores that don't populate it. */
function isMassPlayer(hass, id) {
  if (!id || !hass) return false;
  const e = hass.entities && hass.entities[id];
  if (e && e.platform === "music_assistant") return true;
  const a = ((hass.states || {})[id] || {}).attributes || {};
  return !!(a.mass_player_type || a.active_queue || a.mass_player_id);
}

/* Remote layouts are shared: every Samsung TV is the same card with different
 * entity ids. A room names the template and fills the blanks:
 *
 *   "remotes": [{ "use": "samsung_tv", "title": "Javon TV",
 *                 "media_player": "media_player.javon_samsung_70",
 *                 "remote": "remote.javon_samsung_70" }]
 *
 * Templates live beside the rooms, in _remotes.json. {{key}} inside a template
 * is replaced from the room's entry; a string that is exactly {{key}} takes
 * the value's own type, so numbers and lists survive.
 */
function loadRemotes(cfg) {
  const u = (cfg && cfg.remotes_url) || roomsDir(cfg) + "_remotes.json";
  return fetchStamped(u, cfg).catch(() => ({}));
}

function fillTemplate(node, vars) {
  if (typeof node === "string") {
    const whole = node.match(/^\{\{\s*([\w.-]+)\s*\}\}$/);
    if (whole) return vars[whole[1]] !== undefined ? vars[whole[1]] : node;
    return node.replace(/\{\{\s*([\w.-]+)\s*\}\}/g,
      (m, k) => (vars[k] !== undefined ? String(vars[k]) : m));
  }
  if (Array.isArray(node)) return node.map((x) => fillTemplate(x, vars));
  if (node && typeof node === "object") {
    const out = {};
    for (const [k, v] of Object.entries(node)) out[fillTemplate(k, vars)] = fillTemplate(v, vars);
    return out;
  }
  return node;
}

const OFFISH = ["off", "unavailable", "unknown", "standby"];

const isOn  = (e) => OFFISH.map((st) => ({ condition: "state", entity: e, state_not: st }));
const isOff = (e) => [{ condition: "or",
  conditions: OFFISH.map((st) => ({ condition: "state", entity: e, state: st })) }];

/* The off-state face of a remote: one tile that turns the thing on. `wake`
 * fires a script instead of media_player.turn_on, which some TVs need. */
function remoteOffCard(spec, watch) {
  if (spec.off_card) return spec.off_card;
  const act = spec.wake
    ? { action: "perform-action", perform_action: spec.wake, target: {} }
    : { action: "toggle" };
  return { type: "tile", entity: watch,
           name: spec.off_name || spec.title || "",
           icon: spec.off_icon || "mdi:television-off",
           hide_state: true, vertical: false,
           tap_action: act, icon_tap_action: act };
}

/* A remote only makes sense while its device is on, so it is paired with an
 * off-state tile and the two swap in place. Conditional cards do the watching,
 * so it follows state rather than whatever was true when the panel opened. */
function remoteCards(r, templates) {
  const out = [];
  for (const spec of r.remotes || []) {
    const tpl = templates[spec.use];
    if (!tpl) {
      out.push({ type: "markdown",
                 content: `\`_remotes.json\` has no template named **${spec.use}**.` });
      continue;
    }
    const card = fillTemplate(clone(tpl), spec);
    const watch = spec.when || spec.media_player || spec.remote || spec.entity;
    if (spec.always || !watch) { out.push(card); continue; }
    out.push({ type: "conditional", conditions: isOn(watch), card });
    if (spec.wake || spec.off_card || spec.off_icon || spec.off_name) {
      out.push({ type: "conditional", conditions: isOff(watch),
                 card: remoteOffCard(spec, watch) });
    }
  }
  return out;
}

function mediaCard(r, hass) {
  if (r.media_card) return r.media_card;          // hand-written wins
  const id = r.media_player;
  if (!id) return null;
  if (isMassPlayer(hass, id)) {
    return { type: "custom:mediocre-media-player-card", entity_id: id,
             use_art_colors: true, tap_opens_popup: true,
             options: { show_volume_step_buttons: true } };
  }
  return { type: "media-control", entity: id };
}

/* A thermostat reads better as one line than as a panel: what it's doing and
 * what the room actually is on the left, the setpoint you came to change on
 * the right. `climate_modes` adds a row of mode buttons under it for the
 * rooms that want them; `climate_card` replaces the whole thing. */
function climateCard(r) {
  if (r.climate_card) return r.climate_card;        // hand-written wins
  const card = {
    type: "tile",
    entity: r.climate_entity,
    state_content: ["hvac_action", "current_temperature"],
    features_position: "inline",
    features: [{ type: "target-temperature" }],
  };
  if (r.climate_name) card.name = r.climate_name;
  const modes = r.climate_modes;
  if (modes && modes.length) {
    card.features_position = "bottom";
    card.features.push({ type: "climate-hvac-modes", style: "icons",
                         hvac_modes: modes });
  }
  return card;
}

/* One block's worth of cards. Shared by the automatic body and the custom
 * layout, so both render a room the same way. */
function blockCards(name, r, hass) {
  const out = [];
  const push = (c) => { if (c) out.push(c); };

  if (name === "climate" && r.climate_entity) push(climateCard(r));

  if (name === "media") {
    for (const p of r.music_powers || []) {
      push({ type: "custom:charro-zone-card", entity: p,
             zone_name: r.room_name || "",
             source_entity: p.replace("_power", "_source"),
             volume_entity: p.replace("_power", "_volume") });
    }
    // A device a remote already watches doesn't want a plain tile too: the
    // remote pair covers both states, so the tile would only ever be a
    // duplicate of whichever half is showing.
    const covered = new Set();
    for (const spec of r.remotes || []) {
      const w = spec.when || spec.media_player || spec.remote || spec.entity;
      if (w) covered.add(w);
    }
    const av = [
      [r.tv_entity, "TV", "mdi:television"],
      [r.projector_entity, "Projector", "mdi:projector"],
      [r.receiver_entity, "Receiver", "mdi:audio-video"],
    ].filter(([e]) => e && !covered.has(e));
    if (av.length) {
      push({ type: "grid", columns: av.length > 2 ? 3 : av.length, square: false,
             cards: av.map(([e, n, i]) => ({ type: "tile", entity: e, name: n, icon: i })) });
    }
    for (const c of remoteCards(r, r._remotes || {})) push(c);
    push(mediaCard(r, hass));
  }

  if (name === "cameras" && (r.cameras || []).length) {
    push({ type: "grid", columns: r.cameras.length > 1 ? 2 : 1, square: false,
           cards: r.cameras.map((e) => ({ type: "picture-entity", entity: e,
                                         