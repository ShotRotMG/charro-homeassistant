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

const VERSION = "4.37.0";
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

/* A Lutron group and its members are the same bulbs twice, so counting both
 * makes the chip read high and "turn them all off" do the same work twice.
 * `count: false` keeps a light controllable but out of the arithmetic — it
 * still renders, it just isn't represented in the chip. */
const counted = (l) => !(l && typeof l === "object" && l.count === false);
const countedIds = (list) => (list || []).filter(counted).map(lightId).filter(Boolean);

const RENDER_KINDS = { mushroom: "Mushroom", tile: "Tile", hue: "Hue-style" };

/* The light groups aren't all lights. Ceiling fans here are Lutron dimmers in
 * the light domain, but a real fan, a plain switch or a valve can sit in the
 * same list — so pick the card by domain rather than by which list it came
 * from, and a `fan.` entity dropped into Fans behaves like the rest. */
function lightCard(l, noDim) {
  const id = lightId(l);
  const o = typeof l === "object" && l ? l : {};
  const dims = o.dim !== undefined ? o.dim : !(noDim || []).includes(id);
  const domain = String(id || "").split(".")[0];

  if (o.render === "tile") {
    const card = { type: "tile", entity: id, vertical: false };
    if (o.name) card.name = o.name;
    if (o.icon) card.icon = o.icon;
    const feat = domain === "fan" ? "fan-speed"
               : domain === "light" ? "light-brightness" : null;
    if (dims && feat) { card.features_position = "bottom"; card.features = [{ type: feat }]; }
    return card;
  }
  if (o.render === "hue" && domain === "light") {
    const card = { type: "custom:hue-like-light-card", entities: [id] };
    if (o.name) card.title = o.name;
    if (o.icon) card.icon = o.icon;
    return card;
  }

  let card;
  if (domain === "fan") {
    card = { type: "custom:mushroom-fan-card", entity: id,
             icon_animation: true, show_percentage_control: dims,
             show_oscillate_control: false, collapsible_controls: true,
             layout: "horizontal" };
  } else if (domain === "light") {
    card = { type: "custom:mushroom-light-card", entity: id };
    if (!dims) {
      card.show_brightness_control = false;
      card.collapsible_controls = false;
      card.hold_action = { action: "toggle" };
      card.double_tap_action = { action: "toggle" };
    }
  } else {
    card = { type: "custom:mushroom-entity-card", entity: id,
             tap_action: { action: "toggle" }, layout: "horizontal" };
  }
  if (o.name) card.name = o.name;
  if (o.icon) card.icon = o.icon;
  return card;
}

/* Body of a room, shared by the pop-up and the page. Each block appears only
 * if the room actually defines those entities, so no room needs its own
 * layout. `cards` drops raw Lovelace into a named slot for the one-offs. */
const ROOM_SECTIONS = ["climate", "video", "media", "music", "lights", "cameras", "security"];

/* `music` was carved out of `media` in 4.20, so a room that spelled out its
 * sections before then names only `media`. Rather than silently dropping its
 * player, put `music` back in right behind it. */
function sectionOrder(r) {
  const order = r.sections && r.sections.length ? [...r.sections] : [...ROOM_SECTIONS];
  // `music` (4.20) and `video` (4.29) were carved out of `media`, so a room
  // that spelled out its sections before then names only `media`. Slot the
  // newer blocks in around it rather than silently dropping their content.
  if (order.includes("media")) {
    if (!order.includes("music"))
      order.splice(order.indexOf("media") + 1, 0, "music");
    if (!order.includes("video"))
      order.splice(order.indexOf("media"), 0, "video");
  }
  return order;
}

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

function playerCard(id, hass) {
  if (!id) return null;
  if (isMassPlayer(hass, id)) {
    return { type: "custom:mediocre-media-player-card", entity_id: id,
             use_art_colors: true, tap_opens_popup: true,
             options: { show_volume_step_buttons: true } };
  }
  return { type: "media-control", entity: id };
}

function mediaCard(r, hass) {
  if (r.media_card) return r.media_card;          // hand-written wins
  return playerCard(r.media_player, hass);
}

/* A zone is an amplifier channel, not a player: what you're actually hearing
 * depends on which input it's switched to. `zone_players` maps the source
 * value to the player feeding it, so the zone card can be followed by the
 * controls for whatever is on it. Conditional cards rather than a state read,
 * because the pop-up body is built once and these have to follow along. */
function zonePlayerCards(p, r, hass) {
  const o = typeof p === "object" && p ? p : {};
  const power = o.entity || o.power || (typeof p === "string" ? p : "");
  if (!power) return [];
  const stem = String(power).replace(/^[^.]*\./, "").replace(/_power$/, "");
  const source = o.source_entity || o.source || `select.${stem}_source`;
  const map = o.players || r.zone_players;
  if (!map) return [];

  const out = [];
  for (const [value, entity] of Object.entries(map)) {
    const card = playerCard(entity, hass);
    if (!card) continue;
    out.push({
      type: "conditional",
      conditions: [
        { condition: "state", entity: power, state: "on" },
        { condition: "state", entity: source, state: String(value) },
      ],
      card,
    });
  }
  return out;
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

/* A door is more than an entity id: a garage needs the button that operates
 * it and the sensor that says the opener isn't lying. An alert_sensors entry
 * can carry those, the same way a light can carry its name and icon. */
function securityCard(s, r) {
  const o = typeof s === "object" && s ? s : {};
  const id = o.entity || (typeof s === "string" ? s : "");
  const card = { type: "custom:charro-security-card", entity: id };
  for (const k of ["label", "icon", "toggle_button", "vehicle_entity", "alert_mode"])
    if (o[k]) card[k] = o[k];
  if (!card.confirm_sensor && r && r.confirm_sensor) card.confirm_sensor = r.confirm_sensor;
  return card;
}

/* An RTI zone is three entities in three different domains that share one
 * name: switch.<zone>_power, select.<zone>_source, number.<zone>_volume.
 * Swapping only the suffix leaves the domain wrong — switch.<zone>_source
 * doesn't exist, which is why the source read back as "S?" — so rebuild the
 * id from the stem instead. A music_powers entry may also be an object that
 * names any of them outright. */
function zoneCard(p, r, hass) {
  const o = typeof p === "object" && p ? p : {};
  const power = o.entity || o.power || (typeof p === "string" ? p : "");
  const stem = String(power).replace(/^[^.]*\./, "").replace(/_power$/, "");
  return {
    type: "custom:charro-zone-card",
    entity: power,
    zone_name: o.zone_name || o.name || zoneName(power, stem, r, hass),
    source_entity: o.source_entity || o.source || `select.${stem}_source`,
    volume_entity: o.volume_entity || o.volume || `number.${stem}_volume`,
  };
}

/* A room can drive more than one zone — the Lanai owns both Lanai and
 * Barbeque — so naming every one after the room labels them identically.
 * friendly_name is no good on its own either: HA prefixes it with the device,
 * giving "RTI AD-8x (amp1) Lanai Power". The entity registry keeps the
 * unprefixed name, so prefer that, then strip the device name off
 * friendly_name by hand, then fall back to the id. */
function zoneName(power, stem, r, hass) {
  const reg = hass && hass.entities && hass.entities[power];
  let name = (reg && (reg.name || reg.original_name)) || "";

  if (!name) {
    const st = hass && hass.states && hass.states[power];
    name = (st && st.attributes && st.attributes.friendly_name) || "";
    const dev = reg && hass.devices && hass.devices[reg.device_id];
    const devName = dev && (dev.name_by_user || dev.name);
    if (devName && name.startsWith(devName)) name = name.slice(devName.length);
  }
  if (!name) {
    name = stem.replace(/_/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }
  name = name.replace(/\s*power\s*$/i, "").trim();
  return name || r.room_name || "";
}

/* One block's worth of cards. Shared by the automatic body and the custom
 * layout, so both render a room the same way. */
function blockCards(name, r, hass) {
  const out = [];
  const push = (c) => { if (c) out.push(c); };

  if (name === "climate" && r.climate_entity) push(climateCard(r));

  /* Audio and video want sorting separately — a player you glance at all day
   * rarely belongs in the same run as a TV remote. */
  if (name === "player") push(mediaCard(r, hass));

  if (name === "music") {
    for (const p of r.music_powers || []) {
      push(zoneCard(p, r, hass));
      for (const c of zonePlayerCards(p, r, hass)) push(c);
    }
    push(mediaCard(r, hass));
  }

  if (name === "video" && r.video) {
    push({ type: "custom:charro-video-card", video: r.video,
           templates: r._remotes || {} });
  }

  if (name === "media") {
    // A device a remote already watches doesn't want a plain tile too: the
    // remote pair covers both states, so the tile would only ever be a
    // duplicate of whichever half is showing.
    const covered = new Set();
    for (const spec of r.remotes || []) {
      const w = spec.when || spec.media_player || spec.remote || spec.entity;
      if (w) covered.add(w);
    }
    // a screen the video block owns doesn't want a second tile either
    for (const d of (r.video && r.video.displays) || []) {
      if (d.power) covered.add(d.power);
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
  }

  if (name === "cameras" && (r.cameras || []).length) {
    push({ type: "grid", columns: r.cameras.length > 1 ? 2 : 1, square: false,
           cards: r.cameras.map((e) => ({ type: "picture-entity", entity: e,
                                          camera_view: "auto", show_state: false })) });
  }

  if (name === "security" && (r.alert_sensors || []).length) {
    push({ type: "grid", columns: 2, square: false,
           cards: r.alert_sensors.map((e) => securityCard(e, r)) });
  }

  return out;
}

const LIGHT_GROUPS = [
  ["Lights", "light_entities"],
  ["Landscape", "landscape_entities"],
  ["Fans", "fan_entities"],
  ["Other fans", "bath_fan_entities"],
  ["Water", "fountain_entities"],
];

/* The default: blocks in order, lights grouped by the list they came from. */
function autoBody(r, hass) {
  const order = sectionOrder(r);
  const extra = r.cards || {};
  const out = [];
  const push = (c) => { if (c) out.push(c); };

  for (const c of extra.start || []) push(c);
  for (const name of order) {
    if (name === "lights") {
      const groups = LIGHT_GROUPS
        .map(([label, key]) => [label, r[key]])
        .filter(([, l]) => (l || []).length);
      for (const [label, list] of groups) {
        if (groups.length > 1)
          push({ type: "heading", heading: label, heading_style: "subtitle" });
        push({ type: "grid", columns: 2, square: false,
               cards: list.map((l) => lightCard(l, r.no_dim)) });
      }
    } else {
      for (const c of blockCards(name, r, hass)) push(c);
    }
    for (const c of extra[name] || []) push(c);
  }
  for (const c of extra.end || []) push(c);
  return out;
}

/* A room can instead spell out its own order: headings, individual lights and
 * whole blocks, arranged however you like. Anything parked in `hidden` simply
 * isn't rendered. Consecutive lights collapse into one two-column grid. */
/* A group is a column. Consecutive groups sit side by side on a wide panel
 * and stack once there isn't room, so a remote, a light grid and a player can
 * share a row instead of running down the page. */
function groupNode(g, r, hass) {
  const title = g.title !== undefined ? g.title
              : (typeof g.group === "string" ? g.group : "");
  return { _group: true, span: Number(g.span) || 1, title,
           cards: layoutBody({ ...r, layout: g.items || [] }, hass) };
}

function layoutBody(r, hass) {
  const out = [];
  let run = [];
  const flush = () => {
    if (!run.length) return;
    out.push({ type: "grid", columns: 2, square: false, cards: run });
    run = [];
  };
  for (const it of r.layout || []) {
    if (!it || it.hidden) continue;
    if (it.group !== undefined) {
      flush();
      out.push(groupNode(it, r, hass));
    } else if (it.heading !== undefined) {
      flush();
      out.push({ type: "heading", heading: it.heading, heading_style: "subtitle" });
    } else if (it.entity) {
      // a full-width item breaks the two-up run and takes the row to itself
      if (it.width === "full") {
        flush();
        out.push({ type: "grid", columns: 1, square: false, cards: [lightCard(it, r.no_dim)] });
      } else {
        run.push(lightCard(it, r.no_dim));
      }
    } else if (it.sensor) {
      if (it.width === "full") {
        flush();
        out.push({ type: "grid", columns: 1, square: false,
                   cards: [securityCard(it.sensor, r)] });
      } else {
        run.push(securityCard(it.sensor, r));
      }
    } else if (it.zone) {
      // a single music zone, so it can sit with its own room's lights
      // rather than being stuck in the block with every other zone
      flush();
      out.push(zoneCard(it.zone, r, hass));
      for (const c of zonePlayerCards(it.zone, r, hass)) out.push(c);
    } else if (it.gap) {
      // an empty cell: the next tile lands in the other column, or on the
      // next row, without anything being drawn here
      run.push({ type: "custom:charro-gap-card" });
    } else if (it.card) {
      // a card takes the row to itself unless it's asked to share, which is
      // what pairs a door with the light above it
      if (it.width === "half") run.push(it.card);
      else { flush(); out.push(it.card); }
    } else if (it.block) {
      flush();
      for (const c of blockCards(it.block, r, hass)) out.push(c);
    }
  }
  flush();
  return out;
}

/* Turns what roomBody returns into elements. Card configs go through the
 * Lovelace helpers; a group becomes a column, and neighbouring columns get
 * wrapped in a flex row. Styles are inline so this works the same in the
 * pop-up's shadow root and in the page's light DOM. */
/* How many columns the widest row of this body actually wants. Groups only
 * sit side by side in a run, and a group's span is how many columns' worth it
 * asks for, so the widest run is what decides whether extra width would be
 * used or just stretch a single column across the screen. */
function widestRun(nodes) {
  let best = 1, run = 0;
  for (const n of nodes || []) {
    if (n && n._group) run += Math.max(1, Number(n.span) || 1);
    else { if (run > best) best = run; run = 0; }
  }
  return run > best ? run : best;
}

async function renderBody(nodes, hass, target) {
  const helpers = await window.loadCardHelpers();
  const made = [];
  const card = (cfg, into) => {
    try {
      const el = helpers.createCardElement(cfg);
      el.hass = hass;
      el.style.display = "block";
      into.appendChild(el);
      made.push(el);
    } catch (err) { console.error("charro-room-card:", cfg && cfg.type, err); }
  };

  let i = 0;
  while (i < nodes.length) {
    const n = nodes[i];
    if (!n || !n._group) {
      const holder = document.createElement("div");
      holder.style.cssText = "display:block;margin-bottom:8px";
      card(n, holder);
      target.appendChild(holder);
      i++;
      continue;
    }
    // a run of groups shares one row
    const row = document.createElement("div");
    row.style.cssText =
      "display:flex;flex-wrap:wrap;gap:10px;align-items:flex-start;margin-bottom:8px";
    while (i < nodes.length && nodes[i] && nodes[i]._group) {
      const g = nodes[i];
      const col = document.createElement("div");
      col.style.cssText =
        `flex:${g.span} 1 260px;min-width:0;display:flex;flex-direction:column;gap:8px`;
      if (g.title) {
        const h = document.createElement("div");
        h.style.cssText =
          "font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;" +
          "color:var(--secondary-text-color);padding:2px 2px 0";
        h.textContent = g.title;
        col.appendChild(h);
      }
      for (const c of g.cards) card(c, col);
      row.appendChild(col);
      i++;
    }
    target.appendChild(row);
  }
  return made;
}

/* Same story for a layout saved before the split: it names `media` and knows
 * nothing about `music`, so drop a music node in behind the media one rather
 * than let the player disappear until someone drags it back. Hidden counts as
 * knowing about it — if you parked music, it stays parked. */
function migrateMusic(r) {
  const layout = r.layout;
  if (!Array.isArray(layout) || !layout.length) return r;
  const seen = (list) => (list || []).some((it) =>
    it && (it.block === "music"
           || (it.group !== undefined && seen(it.items))));
  if (seen(layout) || seen(r.hidden)) return r;

  const insert = (list) => {
    const out = [];
    let done = false;
    for (const it of list) {
      if (it && it.group !== undefined && !done) {
        const inner = insert(it.items || []);
        if (inner.changed) { out.push({ ...it, items: inner.list }); done = true; continue; }
      }
      out.push(it);
      if (!done && it && it.block === "media") { out.push({ block: "music" }); done = true; }
    }
    return { list: out, changed: done };
  };
  const res = insert(layout);
  return res.changed ? { ...r, layout: res.list } : r;
}

function roomBody(r, hass) {
  if (!(r.layout && r.layout.length)) return autoBody(r, hass);
  return layoutBody(migrateMusic(r), hass);
}

/* Turn a room's automatic arrangement into an explicit layout it can then be
 * rearranged from, so switching to a custom layout starts where you left off. */
function materializeLayout(r) {
  const order = sectionOrder(r);
  const extra = r.cards || {};
  const out = [];
  for (const c of extra.start || []) out.push({ card: c });
  for (const name of order) {
    if (name === "lights") {
      const groups = LIGHT_GROUPS
        .map(([label, key]) => [label, r[key]])
        .filter(([, l]) => (l || []).length);
      for (const [label, list] of groups) {
        if (groups.length > 1) out.push({ heading: label });
        for (const l of list)
          out.push(typeof l === "string" ? { entity: l } : { ...l });
      }
    } else if (name === "security") {
      for (const e of r.alert_sensors || []) out.push({ sensor: e });
    } else if (name === "music") {
      // split, so each zone can be dragged to the room it belongs to
      for (const p of r.music_powers || []) out.push({ zone: p });
      if (r.media_player || r.media_card) out.push({ block: "player" });
    } else {
      out.push({ block: name });
    }
    for (const c of extra[name] || []) out.push({ card: c });
  }
  for (const c of extra.end || []) out.push({ card: c });
  return out;
}

/* ------------------------------------------------------- room pop-up ----- */
/* Rendered into document.body so the grid can't clip it, and keyed on the
 * hash so the browser back button closes it. One owner per hash, or a room
 * that appears on two views would open two panels. */

const _popupOwners = new Map();          // hash -> Set(card)

function claimHash(hash, card) {
  if (!_popupOwners.has(hash)) _popupOwners.set(hash, new Set());
  _popupOwners.get(hash).add(card);
}
function unclaimHash(hash, card) {
  const set = _popupOwners.get(hash);
  if (!set) return;
  set.delete(card);
  if (!set.size) _popupOwners.delete(hash);
}
/* Whoever is actually on screen and has hass. A card that was torn down by a
 * view switch shouldn't keep the hash hostage. */
function ownerFor(hash) {
  const set = _popupOwners.get(hash);
  if (!set) return null;
  for (const c of set) if (c.isConnected && c._hass) return c;
  return null;
}

const POPUP_CSS = `
.charro-pop-backdrop{
  position:fixed; inset:0; z-index:8;
  background:rgba(0,0,0,.45); backdrop-filter:blur(10px);
  -webkit-backdrop-filter:blur(10px);
  opacity:0; transition:opacity .22s ease;
}
.charro-pop-backdrop.in{ opacity:1; }
.charro-pop{
  position:fixed; left:0; right:0; bottom:0; z-index:9;
  max-height:88vh; overflow:auto; box-sizing:border-box;
  padding:14px 14px calc(18px + env(safe-area-inset-bottom,0px));
  background:var(--ha-card-background, var(--card-background-color, #fff));
  border-radius:24px 24px 0 0;
  box-shadow:0 -8px 40px rgba(0,0,0,.35);
  transform:translateY(100%); transition:transform .26s cubic-bezier(.2,.8,.3,1);
}
.charro-pop.in{ transform:translateY(0); }
/* --charro-pop-w is set per room by _sizeTo() from how many columns the body
 * actually has: one column stays at 680px however big the screen is, and only
 * a room with groups side by side asks for more. The vw caps keep even the
 * widest off the screen edges. */
@media (min-width:870px){
  .charro-pop{
    left:50%; right:auto; bottom:auto; top:50%;
    transform:translate(-50%,-46%) scale(.98); opacity:0;
    width:min(var(--charro-pop-w,680px),92vw); max-height:84vh; border-radius:24px;
    transition:transform .2s ease, opacity .2s ease;
  }
  .charro-pop.in{ transform:translate(-50%,-50%) scale(1); opacity:1; }
}
@media (min-width:1400px){
  .charro-pop{ width:min(var(--charro-pop-w,680px),88vw); max-height:86vh; }
}
@media (min-width:1900px){
  .charro-pop{ width:min(var(--charro-pop-w,680px),82vw); }
}
/* Room icon, name and chips travel together as one centred cluster, taken
 * out of the flow so neither the door on the left nor the buttons on the
 * right can push it off centre or squeeze the chips. Below 900px the cluster
 * rejoins the flow, where overlapping would be the worse problem. */
.charro-pop-hd{
  position:relative; display:flex; align-items:center; gap:8px;
  margin:2px 4px 14px; min-height:34px;
}
.charro-pop-hd .mid{
  position:absolute; left:50%; transform:translateX(-50%);
  display:flex; align-items:center; gap:14px; max-width:78%;
}
/* ha-icon lays out inline, so it sits on the text baseline and reads low
 * beside a 24px title however the row is aligned. Make each one its own
 * flex box of a known size and the row can centre it properly. */
.charro-pop-hd ha-icon{
  display:flex; align-items:center; justify-content:center; line-height:0;
}
.charro-pop-hd .mid > ha-icon{
  --mdc-icon-size:26px; width:26px; height:26px;
  color:var(--primary-text-color); flex:none;
}
.charro-pop-hd .t{
  pointer-events:none; min-width:0;
  font-size:24px; font-weight:650; letter-spacing:-.02em; text-align:center;
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
}
.charro-pop-hd .tail{
  display:flex; align-items:center; gap:6px; margin-left:auto; flex:none;
}
/* the door is the far-left marker for the whole room, not part of the name */
.charro-pop-hd .door{
  --mdc-icon-size:24px; width:24px; height:24px;
  color:var(--secondary-text-color); cursor:default; flex:none;
}
.charro-pop-hd .door.open{ color:#ef5350; cursor:pointer; }
/* Only the round icon buttons — a chip is a button too, and this rule's
 * fixed 32px box was squaring it and stacking the count under the icon. */
.charro-pop-hd .tail > button{
  border:none; background:rgba(127,127,127,.16); color:var(--primary-text-color);
  width:32px; height:32px; border-radius:50%; cursor:pointer;
  display:grid; place-items:center; font:inherit; flex:none;
}
.charro-pop-hd .tail > button:hover{ background:rgba(127,127,127,.28); }
.charro-pop-hd .tail > button ha-icon{ --mdc-icon-size:18px; }
.charro-chips{ display:flex; align-items:center; gap:5px; flex:none; }
.charro-chip{
  display:inline-flex; flex-direction:row; flex-wrap:nowrap; align-items:center;
  gap:4px; cursor:pointer; border:none; font:inherit;
  width:auto; height:auto; min-width:0; padding:3px 9px; border-radius:999px;
  font-size:13.5px; font-weight:700; line-height:1.45; white-space:nowrap;
}
.charro-chip ha-icon{
  --mdc-icon-size:17px; width:17px; height:17px; flex:none;
  display:flex; align-items:center; justify-content:center; line-height:0;
}
.charro-chip span{ flex:none; line-height:1; }
.charro-chip:hover{ filter:brightness(1.25); }
.charro-chip:focus-visible{ outline:2px solid var(--primary-color); outline-offset:1px; }
@media (max-width:900px){
  .charro-pop-hd{ flex-wrap:wrap; }
  .charro-pop-hd .mid{
    position:static; transform:none; max-width:none; flex:1 1 auto;
    gap:10px; min-width:0;
  }
  .charro-pop-hd .t{ text-align:left; font-size:20px; }
  .charro-chips{ flex-wrap:wrap; }
}
.charro-pop-body > *{ margin-bottom:8px; display:block; }
@media (prefers-reduced-motion:reduce){
  .charro-pop,.charro-pop-backdrop{ transition:none; }
}
`;

/* "Saloon Lanai Door and Kitchen Lanai Door", not "2 sensors" — the names are
 * the useful part and there are never many of them in one room. */
function listNames(rows) {
  const n = (rows || []).map((r) => r.name);
  if (!n.length) return "No sensors";
  if (n.length === 1) return n[0];
  return `${n.slice(0, -1).join(", ")} and ${n[n.length - 1]}`;
}

/* The same chips the room tile shows, described in one place so the pop-up
 * header and the tile can't drift apart on colour or meaning. Each is only
 * produced when it has something to say, and carries what a tap should do. */
const CHIP_AMBER  = ["rgba(255,193,7,0.22)", "var(--state-light-active-color, #ffc107)"];
const CHIP_GREEN  = ["rgba(76,175,80,0.22)", "#4caf50"];
const CHIP_BLUE   = ["rgba(33,150,243,0.22)", "#2196f3"];
const CHIP_PURPLE = ["rgba(156,39,176,0.22)", "#ce93d8"];
const CHIP_ORANGE = ["rgba(255,152,0,0.22)", "#ffb74d"];
const CHIP_RED    = ["rgba(244,67,54,0.20)", "#ef5350"];

const CHIP_GROUPS = [
  ["light_entities",     "mdi:lightbulb",     CHIP_AMBER,  "light",  "Lights"],
  ["landscape_entities", "mdi:palm-tree",     CHIP_AMBER,  "light",  "Landscape"],
  ["fan_entities",       "mdi:ceiling-fan",   CHIP_GREEN,  "light",  "Ceiling fans"],
  ["bath_fan_entities",  "mdi:fan",           CHIP_GREEN,  "light",  "Other fans"],
  ["fountain_entities",  "mdi:fountain",      CHIP_BLUE,   "light",  "Water"],
];

const onCount = (hass, list) =>
  (list || []).map(lightId).filter((e) => e && hass.states[e]
                                       && hass.states[e].state === "on").length;

/* what the thermostat is doing beats what it is set to */
function climateChip(hass, id) {
  const st = hass.states[id];
  if (!st || st.state === "off" || st.state === "unavailable") return null;
  const a = st.attributes || {};
  const act = a.hvac_action;
  const cur = a.current_temperature, set = a.temperature;
  const known = cur != null && set != null;
  let col = CHIP_GREEN, icon = "mdi:thermostat";
  if (act === "cooling") col = CHIP_BLUE;
  else if (act === "heating") col = CHIP_RED;
  else if (act === "idle" || act === "fan") col = CHIP_GREEN;
  else if (st.state === "cool") col = (known && cur <= set) ? CHIP_GREEN : CHIP_BLUE;
  else if (st.state === "heat") col = (known && cur >= set) ? CHIP_GREEN : CHIP_RED;
  else if (st.state === "heat_cool") col = CHIP_PURPLE;
  const unit = (hass.config && hass.config.unit_system
                && hass.config.unit_system.temperature) || "°";
  return { key: "climate", icon, col,
           text: cur != null ? `${Math.round(cur)}${unit}` : "",
           title: `${st.attributes.friendly_name || id} — ${act || st.state}`,
           tap: { kind: "more-info", entity: id } };
}

function roomChips(r, hass) {
  if (!hass || !hass.states) return [];
  const out = [];

  for (const [key, icon, col, domain, label] of CHIP_GROUPS) {
    const list = r[key] || [];
    if (!list.length) continue;
    const real = list.filter(counted);
    const n = onCount(hass, real);
    if (!n) continue;
    out.push({ key, icon, col, text: String(n),
               title: `${label} — ${n} on. Tap to turn them off.`,
               tap: { kind: "off", domain, entities: lightIds(real) } });
  }

  const zones = (r.music_powers || []).filter(
    (p) => { const id = typeof p === "string" ? p : (p && (p.entity || p.power));
             return id && hass.states[id] && hass.states[id].state === "on"; });
  if (zones.length) {
    out.push({ key: "music", icon: "mdi:music", col: CHIP_PURPLE,
               text: String(zones.length),
               title: `${zones.length} music zone${zones.length > 1 ? "s" : ""} on. Tap to turn them off.`,
               tap: { kind: "off", domain: "switch",
                      entities: zones.map((p) => typeof p === "string" ? p : (p.entity || p.power)) } });
  }

  const mp = r.media_player && hass.states[r.media_player];
  if (mp && mp.state === "playing") {
    const a = mp.attributes || {};
    out.push({ key: "nowplaying", icon: "mdi:music-note", col: CHIP_PURPLE, text: "",
               title: a.media_title ? `${a.media_title}${a.media_artist ? " — " + a.media_artist : ""}`
                                    : "Playing",
               tap: { kind: "more-info", entity: r.media_player } });
  }

  for (const [key, icon, col, label] of [
    ["tv_entity", "mdi:television", CHIP_ORANGE, "TV"],
    ["projector_entity", "mdi:projector", CHIP_BLUE, "Projector"],
    ["receiver_entity", "mdi:audio-video", CHIP_PURPLE, "Receiver"],
  ]) {
    const id = r[key];
    const st = id && hass.states[id];
    if (!st || OFFISH.includes(st.state) || st.state === "idle") continue;
    out.push({ key, icon, col, text: "",
               title: `${label} — ${st.state}`,
               tap: { kind: "more-info", entity: id } });
  }

  if (r.climate_entity) {
    const c = climateChip(hass, r.climate_entity);
    if (c) out.push(c);
  }
  return out;
}

/* The panel has to live inside <home-assistant>, not in document.body.
 * Home Assistant's gesture layer doesn't reach elements outside its own tree:
 * a mushroom or tile card rendered in document.body draws correctly, shows
 * the right state, and quietly ignores every tap. Verified both ways. */
function popupHost() {
  const ha = document.querySelector("home-assistant");
  return (ha && ha.shadowRoot) || document.body;
}

function ensurePopupCss(root) {
  // a shadow root doesn't inherit document styles, so the sheet goes with it
  const has = root.getElementById
    ? root.getElementById("charro-pop-css")
    : root.querySelector("#charro-pop-css");
  if (has) return;
  const s = document.createElement("style");
  s.id = "charro-pop-css";
  s.textContent = POPUP_CSS;
  root.appendChild(s);
}

class RoomPopup {
  constructor(hash, room, hass, bodyFn, title) {
    this.hash = hash; this.room = room; this._hass = hass;
    this.bodyFn = bodyFn || null; this.titleOverride = title || null;
    this.el = null; this.backdrop = null;
    this._hd = null; this._hdSig = null;
  }
  set hass(h) {
    this._hass = h;
    for (const c of this._cards || []) c.hass = h;
    // hass ticks constantly; only redraw the header when something it shows
    // has actually moved, or a busy house would rebuild it hundreds of times
    if (!this._hd) return;
    const sig = this._headerSig();
    if (sig === this._hdSig) return;
    this._hdSig = sig;
    const next = this._header();
    this._hd.replaceWith(next);
    this._hd = next;
  }

  _headerSig() {
    const hass = this._hass;
    if (!hass || !hass.states) return "";
    const r = this.room;
    const ids = [].concat(
      lightIds(r.light_entities), lightIds(r.landscape_entities),
      lightIds(r.fan_entities), lightIds(r.bath_fan_entities),
      lightIds(r.fountain_entities), r.alert_sensors || [],
      (r.music_powers || []).map((p) => typeof p === "string" ? p : (p && (p.entity || p.power))),
      [r.media_player, r.tv_entity, r.projector_entity, r.receiver_entity, r.climate_entity],
    ).filter(Boolean);
    let s = "";
    for (const e of ids) {
      const st = hass.states[e];
      s += st ? `${e}=${st.state};` : `${e}=_;`;
    }
    const cl = r.climate_entity && hass.states[r.climate_entity];
    if (cl) {
      const a = cl.attributes || {};
      s += `a=${a.hvac_action}|${a.current_temperature}|${a.temperature};`;
    }
    return s;
  }
  async open() {
    if (this.el) return;
    const host = popupHost();
    ensurePopupCss(host);
    const helpers = await window.loadCardHelpers();
    if (this.el) return;                      // opened while we awaited

    this.backdrop = document.createElement("div");
    this.backdrop.className = "charro-pop-backdrop";
    this.backdrop.addEventListener("click", () => this.dismiss());

    this.el = document.createElement("div");
    this.el.className = "charro-pop";
    this.el.setAttribute("role", "dialog");
    this.el.setAttribute("aria-modal", "true");

    const hd = this._header();
    this._hd = hd;
    this._hdSig = this._headerSig();

    const body = document.createElement("div");
    body.className = "charro-pop-body";
    const nodes = this.bodyFn ? this.bodyFn(this.room, this._hass)
                              : roomBody(this.room, this._hass);
    this._sizeTo(widestRun(nodes));
    this._cards = await renderBody(nodes, this._hass, body);

    const panel = this.el, back = this.backdrop;
    panel.append(hd, body);
    host.append(back, panel);
    requestAnimationFrame(() => {
      // close() may already have run and nulled these
      if (this.el !== panel) return;
      back.classList.add("in");
      panel.classList.add("in");
    });

    this._key = (ev) => { if (ev.key === "Escape") this.dismiss(); };
    window.addEventListener("keydown", this._key);
  }
  /* The header reads like the room's own tile: the door alone at the far
   * left, then the room icon, name and chips as one centred cluster, then
   * the panel buttons. Rebuilt on state changes so the chips stay live. */
  _header() {
    const hd = document.createElement("div");
    hd.className = "charro-pop-hd";

    // the far-left marker for the room as a whole: grey while everything's
    // shut, red the moment something isn't
    if ((this.room.alert_sensors || []).length) {
      const { all, bad } = this._sensorState();
      const d = document.createElement("ha-icon");
      d.className = bad.length ? "door open" : "door";
      d.icon = bad.length ? "mdi:door-open" : "mdi:door-closed";
      d.title = bad.length
        ? `${listNames(bad)} violated.`
        : `${listNames(all)} closed.`;
      if (bad.length) d.addEventListener("click", () => this._moreInfo(bad[0].entity));
      d.setAttribute("aria-label", d.title);
      hd.appendChild(d);
    }

    const mid = document.createElement("div");
    mid.className = "mid";
    if (this.room.room_icon) {
      const i = document.createElement("ha-icon");
      i.icon = this.room.room_icon;
      // amber whenever anything in the room is lit, exactly as on the tile
      const lit = onCount(this._hass,
        [].concat(this.room.light_entities || [],
                  this.room.landscape_entities || []).filter(counted));
      if (lit) i.style.color = "var(--state-light-active-color, #ffc107)";
      mid.appendChild(i);
    }

    const t = document.createElement("div");
    t.className = "t";
    t.textContent = this.titleOverride || this.room.room_name || "";
    mid.appendChild(t);

    const chips = this._chipStrip();
    if (chips.childElementCount) mid.appendChild(chips);

    const tail = document.createElement("div");
    tail.className = "tail";

    if (this.room.page_path) {
      const go = document.createElement("button");
      go.title = "Open the full page";
      go.setAttribute("aria-label", "Open the full page");
      go.innerHTML = `<ha-icon icon="mdi:open-in-new"></ha-icon>`;
      go.addEventListener("click", () => {
        this.dismiss();
        history.pushState(null, "", this.room.page_path);
        window.dispatchEvent(new CustomEvent("location-changed", { bubbles: true, composed: true }));
      });
      tail.appendChild(go);
    }
    const x = document.createElement("button");
    x.title = "Close";
    x.setAttribute("aria-label", "Close");
    x.innerHTML = `<ha-icon icon="mdi:close"></ha-icon>`;
    x.addEventListener("click", () => this.dismiss());
    tail.appendChild(x);

    hd.append(mid, tail);
    return hd;
  }

  _chipStrip() {
    const strip = document.createElement("div");
    strip.className = "charro-chips";
    for (const c of roomChips(this.room, this._hass)) {
      const b = document.createElement("button");
      b.className = "charro-chip";
      b.style.background = c.col[0];
      b.style.color = c.col[1];
      b.title = c.title;
      b.setAttribute("aria-label", c.title);
      const i = document.createElement("ha-icon");
      i.icon = c.icon;
      b.appendChild(i);
      if (c.text) {
        const s = document.createElement("span");
        s.textContent = c.text;
        b.appendChild(s);
      }
      b.addEventListener("click", () => this._chipTap(c.tap));
      strip.appendChild(b);
    }
    return strip;
  }

  _chipTap(tap) {
    if (!tap || !this._hass) return;
    if (tap.kind === "more-info") return this._moreInfo(tap.entity);
    if (tap.kind === "off" && (tap.entities || []).length) {
      this._hass.callService(tap.domain, "turn_off", { entity_id: tap.entities });
    }
  }

  _moreInfo(entity) {
    const ev = new CustomEvent("hass-more-info", {
      detail: { entityId: entity }, bubbles: true, composed: true,
    });
    (this.el || document.querySelector("home-assistant")).dispatchEvent(ev);
  }

  /* The alert sensors here aren't binary_sensors — the Elk zones are plain
   * sensors reading "Normal" or "Violated", so testing for "on" called a
   * violated zone closed. Take every shape these come in. */
  _sensorState() {
    const hass = this._hass;
    const all = [], bad = [];
    if (!hass || !hass.states) return { all, bad };
    for (const e of this.room.alert_sensors || []) {
      const st = hass.states[e];
      if (!st) continue;
      const a = st.attributes || {};
      const reg = hass.entities && hass.entities[e];
      const s = String(st.state).toLowerCase();
      const row = {
        entity: e,
        name: (reg && (reg.name || reg.original_name)) || a.friendly_name || e,
        violated: s === "violated" || s === "on" || s === "open" || s === "opening",
      };
      all.push(row);
      if (row.violated) bad.push(row);
    }
    return { all, bad };
  }

  /* Width follows the content. A single-column room stays narrow however big
   * the monitor is — stretching one column of tiles across 1300px reads worse,
   * not better. Extra width is only worth taking when there are columns to put
   * in it. `popup_width` on the room overrides the lot. */
  _sizeTo(cols) {
    const w = this.room.popup_width;
    const px = w ? (typeof w === "number" ? `${w}px` : String(w))
              : cols >= 3 ? "1320px"
              : cols === 2 ? "1040px"
              : "680px";
    this.el.style.setProperty("--charro-pop-w", px);
  }

  dismiss() {
    // let the hash drive it, so the back button and the close button agree
    if (location.hash === this.hash) history.back();
    else this.close();
  }
  close() {
    if (this._key) { window.removeEventListener("keydown", this._key); this._key = null; }
    const el = this.el, bd = this.backdrop;
    this.el = null; this.backdrop = null; this._cards = [];
    this._hd = null; this._hdSig = null;
    if (!el) return;
    try { el.classList.remove("in"); if (bd) bd.classList.remove("in"); } catch (e) {}
    setTimeout(() => { try { el.remove(); if (bd) bd.remove(); } catch (e) {} }, 260);
  }
}

/* ============================================================ ROOM CARD == */

let _hashWired = false;
let _syncHash = () => {};
function wireRoomHash() {
  if (_hashWired) return;
  _hashWired = true;
  const sync = () => {
    const now = location.hash;
    for (const [hash, set] of _popupOwners)
      if (hash !== now) for (const c of set) c._closePopup(hash);
    const owner = ownerFor(now);
    if (owner) owner._openPopup(now);
  };
  _syncHash = sync;
  for (const ev of ["hashchange", "location-changed", "popstate"])
    window.addEventListener(ev, sync);

  // A tap on a room tile is history.pushState. That fires no hashchange, and
  // the location-changed event it should raise doesn't always reach window —
  // which is why the panel only appeared after a reload. Watch the call.
  for (const m of ["pushState", "replaceState"]) {
    const orig = history[m];
    if (typeof orig === "function" && !orig.__charro) {
      const wrapped = function (...args) {
        const out = orig.apply(this, args);
        setTimeout(sync, 0);
        return out;
      };
      wrapped.__charro = true;
      history[m] = wrapped;
    }
  }

  // last resort: cheap, and it costs one string compare twice a second
  let seen = location.hash;
  setInterval(() => {
    if (location.hash === seen) return;
    seen = location.hash;
    sync();
  }, 400);

  setTimeout(sync, 0);
}

const ROOM_LISTS = [
  "light_entities", "landscape_entities", "fan_entities",
  "bath_fan_entities", "music_powers", "alert_sensors", "fountain_entities",
];
const ROOM_SINGLES = ["climate_entity", "confirm_sensor",
                      "tv_entity", "projector_entity", "receiver_entity",
                      "pool_switch", "pool_heater", "spa_switch", "spa_heater"];

class CharroRoomCard extends CharroBase {
  static getConfigElement() { return document.createElement("charro-room-card-editor"); }
  static getStubConfig() {
    return { type: "custom:charro-room-card", room_name: "New Room", room_icon: "mdi:home" };
  }
  templateName() { return "room-card.json"; }

  setConfig(config) {
    if (!config) throw new Error("Invalid configuration");
    this._config = config;
    this._card = null;
    this._building = false;
    this._merged = null;
    this._roomP = config.room
      ? loadRoom(config.room, config).then((r) => {
          if (!r || typeof r !== "object")
            throw new Error(`${roomUrl(config.room, config)} is not a room`);
          return r;
        })
      : Promise.resolve({});
    this.innerHTML = "";
    if (this._hass) this._build();
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (this._popup) this._popup.hass = hass;
    if (this._pageCards) for (const c of this._pageCards) c.hass = hass;
    if (this._card) this._card.hass = hass;
    else this._build();
    if (first && (this._hash || this._mediaHash)) _syncHash();
  }

  connectedCallback() {
    try {
      // Leaving the view disconnects the card, which releases its hash and
      // clears _hash. Coming back must re-derive it from the room rather than
      // trust a field the release just nulled — otherwise nothing owns the
      // hash, the URL changes and no pop-up opens until a reload.
      if (this._merged) this._claimHash(this._merged);
      else if (this._hass) this._build();
    } catch (err) { console.error("charro-room-card connect:", err); }
  }

  disconnectedCallback() {
    // Home Assistant re-parents cards while it renders, which fires this even
    // though the card is coming straight back. Tearing down here killed the
    // card. Wait a tick and only act if it really has gone.
    setTimeout(() => {
      try {
        if (this.isConnected) return;
        this._closePopup();
        this._releaseHash();
      } catch (err) { console.error("charro-room-card disconnect:", err); }
    }, 0);
  }

  /* anything set on the card wins over the shared file */
  async _resolve() {
    if (this._merged) return this._merged;
    const room = await this._roomP;
    if ((room.remotes || this._config.remotes || []).length || room.video)
      room._remotes = await loadRemotes(this._config);
    const m = { ...room, ...this._config };
    for (const k of ROOM_LISTS) if (!m[k]) m[k] = room[k] || [];
    if (!m.room_name) m.room_name = room.room_name || this._config.room || "";
    if (!m.room_icon) m.room_icon = room.room_icon || "mdi:home";
    if (!m.page_path && this._config.room) m.page_path = `/d-charro/${this._config.room}`;
    this._merged = m;
    return m;
  }

  _fail(err) {
    const msg = err && err.message ? err.message : err;
    this.innerHTML =
      `<ha-card style="padding:12px;color:var(--error-color);font-size:13px">` +
      `charro-room-card: ${msg}</ha-card>`;
    console.error("charro-room-card:", err);
  }

  async _build() {
    if (this._building || !this._hass || !this._config) return;
    let m;
    try { m = await this._resolve(); } catch (err) { return this._fail(err); }

    const mode = this._config.mode || "tile";
    if (mode === "page") return this._buildPage(m);
    if (mode === "popup") { this._claimHash(m); return; }

    await super._build();          // the chip tile, via button-card
    this._claimHash(m);
    if (m.tile_size && !this._sized) {
      this._sized = true;
      fireEvent(this, "card-visibility-changed");   // re-ask for grid options
    }
  }

  async _buildPage(m) {
    if (this._building) return;
    this._building = true;
    try {
      const frag = document.createDocumentFragment();
      this._pageCards = await renderBody(roomBody(m, this._hass), this._hass, frag);
      this.innerHTML = "";
      this.appendChild(frag);
    } catch (err) {
      this._fail(err);
    } finally {
      this._building = false;
    }
  }

  /* ------------------------------------------------------ the pop-up ---- */

  _claimHash(m) {
    if (this._config.popup === false) return;
    const h = roomHash(m);
    if (!h) return;
    if (this._hash !== h) {
      this._releaseHash();
      this._hash = h;
      claimHash(h, this);
    }
    // the now-playing chip opens the media card on its own hash
    const mh = m.media_player ? h + "-media" : null;
    if (mh && this._mediaHash !== mh) { this._mediaHash = mh; claimHash(mh, this); }
    wireRoomHash();
    // the hash may already be set — a card that mounts after the navigation
    // has to catch up, or the panel never appears until a reload
    _syncHash();
  }
  _releaseHash() {
    for (const h of [this._hash, this._mediaHash]) if (h) unclaimHash(h, this);
    this._hash = null; this._mediaHash = null;
  }
  async _openPopup(hash) {
    const want = hash || this._hash;
    if (!this._hass || !want) return;
    if (this._popup && this._popup.hash === want) return;
    if (this._opening === want) return;
    this._opening = want;
    const m = this._merged || (await this._resolve().catch(() => null));
    this._opening = null;
    if (!m || location.hash !== want) return;   // navigated away while resolving
    if (this._popup && this._popup.hash === want) return;
    this._closePopup();
    this._popup = want === this._mediaHash
      ? new RoomPopup(want, m, this._hass,
                      (r, h) => [mediaCard(r, h)].filter(Boolean),
                      `${m.room_name || ""} — Now playing`.trim())
      : new RoomPopup(want, m, this._hass);
    await this._popup.open();
  }
  _closePopup(hash) {
    if (!this._popup) return;
    if (hash && this._popup.hash !== hash) return;
    this._popup.close();
    this._popup = null;
  }

  /* -------------------------------------------- tile data (button-card) - */

  variables() {
    const c = this._merged || this._config;
    const v = {
      room_name: c.room_name || "",
      room_icon: c.room_icon || "mdi:home",
      popup_hash: roomHash(c),
      pool_switch: c.pool_switch || "",
      pool_heater: c.pool_heater || "",
      spa_switch: c.spa_switch || "",
      spa_heater: c.spa_heater || "",
      climate_entity: c.climate_entity || "",
      music_player: c.music_player || "",
      confirm_sensor: c.confirm_sensor || "",
      tv_entity: c.tv_entity || "",
      projector_entity: c.projector_entity || "",
      receiver_entity: c.receiver_entity || "",
    };
    // a light may be {entity, name, dim} in rooms.json; the tile wants ids
    // the tile's chips both count and switch off, so both skip the doubles
    for (const k of ROOM_LISTS) v[k] = countedIds(c[k]);
    if (c.fountain_entity && !v.fountain_entities.includes(c.fountain_entity)) {
      v.fountain_entities = [c.fountain_entity, ...v.fountain_entities];
    }
    return v;
  }

  triggers() {
    const c = this._merged || this._config;
    const out = [];
    for (const k of ROOM_LISTS) out.push(...lightIds(c[k]));
    for (const k of ROOM_SINGLES) if (c[k]) out.push(c[k]);
    if (c.fountain_entity) out.push(c.fountain_entity);
    return uniq(out);
  }

  getGridOptions() {
    if ((this._config.mode || "tile") === "page") return { columns: 12, rows: "auto" };
    // the room decides; a grid_options on the card in the view still wins
    const size = (this._merged && this._merged.tile_size) || this._config.tile_size || "half";
    return { columns: size === "full" ? 12 : 6, rows: "auto", min_columns: 3 };
  }
}
customElements.define("charro-room-card", CharroRoomCard);

const ROOM_SCHEMA = [
  { name: "room", selector: { text: {} } },
  { name: "mode", selector: { select: { mode: "dropdown", options: [
      { value: "tile", label: "Tile (and owns its pop-up)" },
      { value: "page", label: "Full page" },
      { value: "popup", label: "Pop-up only" }] } } },
  { name: "room_name", selector: { text: {} } },
  { name: "room_icon", selector: { icon: {} } },
  { name: "tile_size", selector: { select: { mode: "dropdown", options: [
      { value: "half", label: "Half width" },
      { value: "full", label: "Full width" }] } } },
  { name: "popup_hash", selector: { text: {} } },
  { type: "expandable", name: "", title: "Lights", icon: "mdi:lightbulb", schema: [
    { name: "light_entities", selector: ent(["light", "switch"], true) },
    { name: "landscape_entities", selector: ent(["light", "switch"], true) },
  ]},
  { type: "expandable", name: "", title: "Fans", icon: "mdi:ceiling-fan", schema: [
    { name: "fan_entities", selector: ent(["light", "fan", "switch"], true) },
    { name: "bath_fan_entities", selector: ent(["light", "fan", "switch"], true) },
  ]},
  { type: "expandable", name: "", title: "Climate", icon: "mdi:thermostat", schema: [
    { name: "climate_entity", selector: ent(["climate"]) },
  ]},
  { type: "expandable", name: "", title: "Pool & water", icon: "mdi:pool", schema: [
    { name: "pool_switch", selector: ent(["switch"]) },
    { name: "pool_heater", selector: ent(["water_heater", "climate"]) },
    { name: "spa_switch", selector: ent(["switch"]) },
    { name: "spa_heater", selector: ent(["water_heater", "climate"]) },
    { name: "fountain_entities", selector: ent(["switch", "light"], true) },
  ]},
  { type: "expandable", name: "", title: "Music", icon: "mdi:music", schema: [
    { name: "music_powers", selector: ent(["switch"], true) },
    { name: "music_player", selector: ent(["media_player"]) },
  ]},
  { type: "expandable", name: "", title: "Media", icon: "mdi:television", schema: [
    { name: "tv_entity", selector: ent(["media_player"]) },
    { name: "projector_entity", selector: ent(["switch", "media_player", "light"]) },
    { name: "receiver_entity", selector: ent(["media_player"]) },
  ]},
  { type: "expandable", name: "", title: "Door / motion alert", icon: "mdi:door-open", schema: [
    { name: "alert_sensors", selector: ent(["sensor", "binary_sensor", "cover"], true) },
    { name: "confirm_sensor", selector: ent(["sensor", "binary_sensor"]) },
  ]},
];
const ROOM_LABELS = {
  room: "Room file name, without .json",
  mode: "What to render",
  room_name: "Room name",
  room_icon: "Room icon",
  tile_size: "Tile width on the rooms view",
  rooms_dir: "Folder holding the room files",
  popup_hash: "Pop-up hash (blank = from the name)",
  light_entities: "Lights",
  landscape_entities: "Landscape lights (own chip)",
  fan_entities: "Ceiling fans",
  bath_fan_entities: "Other fans",
  climate_entity: "Thermostat",
  pool_switch: "Pool pump",
  pool_heater: "Pool heater",
  spa_switch: "Spa pump",
  spa_heater: "Spa heater",
  fountain_entities: "Water features",
  music_powers: "Music zone power switches",
  music_player: "Media player (hold the chip)",
  tv_entity: "TV",
  projector_entity: "Projector",
  receiver_entity: "AV receiver",
  alert_sensors: "Door / window / motion / garage sensors",
  confirm_sensor: "Only alert when this is also open",
};
const ROOM_HELPERS = {
  tile_size: 'Ignored if the card in the view sets its own grid_options.',
  popup_hash: 'The card\'s own pop-up, e.g. "#garage-east". Blank derives it from the name.',
  landscape_entities: "Kept out of the lights count, gets a palm-tree chip.",
  fan_entities: "The Lutron fan dimmers. Gets the ceiling-fan chip.",
  bath_fan_entities: "Everything else that moves air \u2014 exhaust fans, air purifiers, tower fans. Gets its own chip. A fan. entity gets fan controls, a light-domain dimmer gets a speed slider.",
  music_powers: "The chip shows how many of these are on.",
  confirm_sensor: "Guards the garages against a false ratgdo Opening.",
  pool_switch: "The pool chip appears only while this is on.",
  pool_heater: "Supplies the temperature and the warming/at-temp colour.",
  fountain_entities: "Fountain, spill, water wall. One chip with a count; tapping turns them all off.",
  tv_entity: "Chip appears only while the TV is on.",
  receiver_entity: "Chip shows the current source while the receiver is on.",
};
makeEditor("charro-room-card-editor", ROOM_SCHEMA, ROOM_LABELS, ROOM_HELPERS);


/* ======================================================== SECURITY CARD == */

class CharroSecurityCard extends CharroBase {
  static getConfigElement() { return document.createElement("charro-security-card-editor"); }
  static getStubConfig() {
    return { type: "custom:charro-security-card", entity: "", icon: "mdi:shield-check" };
  }

  // a toggle_button means the icon press operates the door
  templateName() {
    return this._config.toggle_button ? "garage-card.json" : "security-card.json";
  }

  variables() {
    const c = this._config;
    const isCover = String(c.entity || "").startsWith("cover.");
    return {
      label: c.label || "",
      icon: c.icon || (isCover ? "" : "mdi:shield-check"),
      alert_mode: c.alert_mode || (isCover ? "open" : "violated"),
      vehicle_entity: c.vehicle_entity || "",
      toggle_button: c.toggle_button || "",
    };
  }

  triggers() { return uniq([this._config.vehicle_entity]); }
  overrides() { return { entity: this._config.entity }; }
  getGridOptions() { return { columns: 6, rows: 1, min_columns: 3 }; }
}
customElements.define("charro-security-card", CharroSecurityCard);

makeEditor("charro-security-card-editor", [
  { name: "entity", required: true, selector: ent(["sensor", "binary_sensor", "cover"]) },
  { name: "label", selector: { text: {} } },
  { name: "icon", selector: { icon: {} } },
  { name: "toggle_button", selector: ent(["button", "switch", "script"]) },
  { name: "vehicle_entity", selector: ent(["binary_sensor"]) },
  { name: "alert_mode", selector: { select: { mode: "dropdown", options: [
      { value: "violated", label: "Red when Violated (Elk sensor)" },
      { value: "open", label: "Red when not closed (cover)" },
  ]}}},
], {
  entity: "Entity",
  label: "Label (blank = friendly name)",
  icon: "Icon",
  toggle_button: "Button the icon press fires",
  vehicle_entity: "Vehicle-detected sensor",
  alert_mode: "Alert mode (blank = from the entity)",
}, {
  toggle_button: "Set this for garage doors — tapping the round icon operates the door.",
  vehicle_entity: "Green when a car is in the bay, white when closed and empty.",
});

/* ============================================================ ZONE CARD == */

class CharroZoneCard extends CharroBase {
  static getConfigElement() { return document.createElement("charro-zone-card-editor"); }
  static getStubConfig() { return { type: "custom:charro-zone-card", entity: "" }; }
  templateName() { return "zone-card.json"; }

  variables() {
    const c = this._config;
    return {
      zone_name: c.zone_name || "",
      source_entity: c.source_entity || "",
      volume_entity: c.volume_entity || "",
      amp_key: c.amp_key || "",
      zone_num: c.zone_num || 0,
      volume_step: c.volume_step || 1,
    };
  }

  triggers() { return uniq([this._config.source_entity, this._config.volume_entity]); }
  overrides() { return { entity: this._config.entity }; }
  getGridOptions() { return { columns: 12, rows: "auto", min_columns: 6 }; }
}
customElements.define("charro-zone-card", CharroZoneCard);

/* ------------------------------------------------------- video switch --- */
/* A room with a matrix has three separate questions — which screen, what's
 * feeding it, and what are the buttons for — and the obvious build answers
 * them with one conditional card per (screen × source) pair. The Saloon's
 * three screens and four sources would be twelve heavy remote cards all
 * instantiated in the DOM so eleven could be hidden. This asks the same
 * questions in order and builds the one remote the answers land on.
 *
 *   "video": {
 *     "focus": "input_select.saloon_device_select",
 *     "off_option": "Off",
 *     "displays": [
 *       { "name": "Bar", "icon": "mdi:glass-cocktail",
 *         "source": "input_select.saloon_bar_media_select",
 *         "power": "media_player.saloon_bar_samsung_q60_55" }
 *     ],
 *     "sources": { "SuperBox": { "use": "superbox" } }
 *   }
 *
 * `use` names a template in _remotes.json, so the buttons live in one place
 * however many screens can show that box.
 */
const VIDEO_CSS = `
:host{ display:block; }
.vwrap{ display:flex; flex-direction:column; gap:10px; }
.vrow{ display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
.vrow .sp{ margin-left:auto; }
.vchip{
  display:inline-flex; align-items:center; gap:6px; cursor:pointer;
  border:1px solid var(--divider-color); background:transparent;
  color:var(--secondary-text-color); font:inherit; font-size:13.5px;
  font-weight:600; padding:6px 12px; border-radius:999px; line-height:1;
}
.vchip ha-icon{
  --mdc-icon-size:18px; width:18px; height:18px;
  display:flex; align-items:center; justify-content:center;
}
.vchip:hover{ background:rgba(127,127,127,.14); }
/* lit means that screen is on, so the row reads as status as well as choice */
.vchip.live{ color:var(--primary-text-color); border-color:transparent;
  background:rgba(255,152,0,.18); }
.vchip.sel{ outline:2px solid var(--primary-color); outline-offset:1px;
  color:var(--primary-text-color); }
.vchip.off{ margin-left:auto; color:#ef5350; border-color:rgba(244,67,54,.4); }
.vchip.off:hover{ background:rgba(244,67,54,.16); }
.vnote{ font-size:13px; color:var(--secondary-text-color); padding:2px 2px 0; }
.vslot > *{ display:block; }
`;

class CharroVideoCard extends HTMLElement {
  setConfig(config) {
    if (!config || !config.video) throw new Error("charro-video-card needs a video block");
    this._config = config;
    this._v = config.video;
    this._templates = config.templates || {};
    this.attachShadow({ mode: "open" });
    this.shadowRoot.innerHTML = `<style>${VIDEO_CSS}</style><div class="vwrap"></div>`;
    this._wrap = this.shadowRoot.querySelector(".vwrap");
  }

  set hass(h) {
    this._hass = h;
    for (const c of this._live || []) c.hass = h;
    const sig = this._sig();
    if (sig === this._lastSig) return;
    this._lastSig = sig;
    this._render();
  }

  getCardSize() { return 6; }

  /* focus and every source select — the remote only changes when one does */
  _sig() {
    const h = this._hass;
    if (!h || !h.states) return "";
    const ids = [this._v.focus].filter(Boolean).concat(
      (this._v.displays || []).flatMap((d) => [d.source, d.power].filter(Boolean)));
    return ids.map((e) => `${e}=${h.states[e] ? h.states[e].state : "_"}`).join(";");
  }

  /* A room with one screen has nothing to choose between, so it needs no
   * focus select and no chip row — that screen is always the focused one. */
  _single() {
    const d = this._v.displays || [];
    return !this._v.focus && d.length === 1 ? d[0] : null;
  }
  _focusName() {
    const one = this._single();
    if (one) return one.name;
    const st = this._hass.states[this._v.focus];
    return st ? st.state : "";
  }
  _display(name) {
    return (this._v.displays || []).find((d) => d.name === name) || null;
  }
  _sourceOf(d) {
    if (!d || !d.source) return "";
    const st = this._hass.states[d.source];
    return st ? st.state : "";
  }
  _isLive(d) {
    if (!d) return false;
    if (d.power) {
      const st = this._hass.states[d.power];
      if (st) return !OFFISH.includes(st.state);
    }
    const s = this._sourceOf(d);
    return !!s && s !== (this._v.off_option || "Off");
  }

  _pick(value) {
    if (!this._v.focus) return;
    this._hass.callService("input_select", "select_option",
      { entity_id: this._v.focus, option: value });
  }

  async _render() {
    const h = this._hass;
    if (!h || !this._wrap) return;
    const off = this._v.off_option || "Off";
    const focus = this._focusName();
    this._wrap.textContent = "";
    this._live = [];

    // ---- which screen (skipped entirely when there's only the one)
    const row = document.createElement("div");
    row.className = "vrow";
    for (const d of (this._single() ? [] : this._v.displays || [])) {
      const b = document.createElement("button");
      const live = this._isLive(d);
      b.className = "vchip" + (live ? " live" : "") + (focus === d.name ? " sel" : "");
      if (d.icon) {
        const i = document.createElement("ha-icon");
        i.icon = d.icon;
        b.appendChild(i);
      }
      const s = document.createElement("span");
      s.textContent = d.name;
      b.appendChild(s);
      const src = this._sourceOf(d);
      b.title = live && src && src !== off ? `${d.name} — ${src}` : `${d.name} — off`;
      b.addEventListener("click", () => this._pick(d.name));
      row.appendChild(b);
    }
    if (this._v.focus && (this._v.displays || []).length) {
      const o = document.createElement("button");
      o.className = "vchip off";
      o.innerHTML = `<ha-icon icon="mdi:power"></ha-icon>`;
      const sp = document.createElement("span");
      sp.textContent = "All off";
      o.appendChild(sp);
      o.title = "Turn every screen in this room off";
      o.addEventListener("click", () => this._pick(off));
      row.appendChild(o);
    }
    if (row.childElementCount) this._wrap.appendChild(row);

    const d = this._display(focus);
    if (!d) return;                       // Off, or a name with no display

    const helpers = await window.loadCardHelpers();
    if (this._focusName() !== focus) return;   // changed while we awaited

    const add = (cfg) => {
      try {
        const el = helpers.createCardElement(cfg);
        el.hass = h;
        const slot = document.createElement("div");
        slot.className = "vslot";
        slot.appendChild(el);
        this._wrap.appendChild(slot);
        this._live.push(el);
      } catch (err) { console.error("charro-video-card:", cfg && cfg.type, err); }
    };

    // ---- what's feeding it
    if (d.source) {
      add({ type: "custom:mushroom-select-card", entity: d.source,
            name: `${d.name} source`, layout: "horizontal",
            fill_container: false, secondary_info: "none" });
    }

    // ---- and the buttons for it
    const src = this._sourceOf(d);
    if (!src || src === off) {
      if (d.power) {
        add({ type: "tile", entity: d.power, name: d.name,
              icon: d.off_icon || "mdi:television-off", hide_state: true,
              tap_action: { action: "toggle" }, icon_tap_action: { action: "toggle" } });
      } else {
        const n = document.createElement("div");
        n.className = "vnote";
        n.textContent = `${d.name} is off. Pick a source to turn it on.`;
        this._wrap.appendChild(n);
      }
      return;
    }

    const spec = (this._v.sources || {})[src];
    if (!spec) {
      const n = document.createElement("div");
      n.className = "vnote";
      n.textContent = `No remote is configured for "${src}".`;
      this._wrap.appendChild(n);
      return;
    }
    if (spec.card) { add(spec.card); return; }
    const tpl = this._templates[spec.use];
    if (!tpl) {
      const n = document.createElement("div");
      n.className = "vnote";
      n.textContent = `\`_remotes.json\` has no template named "${spec.use}".`;
      this._wrap.appendChild(n);
      return;
    }
    // the display's own volume, so the buttons act on the screen you're at
    add(fillTemplate(clone(tpl), { title: spec.title || src, ...spec,
                                   display: d.name, display_media: d.power || "" }));
  }
}
customElements.define("charro-video-card", CharroVideoCard);

makeEditor("charro-zone-card-editor", [
  { name: "entity", required: true, selector: ent(["switch"]) },
  { name: "zone_name", required: true, selector: { text: {} } },
  { name: "source_entity", selector: ent(["select", "input_select"]) },
  { name: "volume_entity", selector: ent(["number", "input_number"]) },
  { name: "volume_step", selector: { number: { min: 1, max: 10, mode: "box" } } },
], {
  entity: "Zone power switch",
  zone_name: "Zone name",
  source_entity: "Source select",
  volume_entity: "Volume number",
  volume_step: "Volume step",
}, {
  entity: "e.g. switch.rti_ad_8x_amp2_saloon_bar_power",
  volume_step: "How much one tap of +/- moves the volume. Hold to repeat.",
});

/* ========================================================= ALL-OFF CARD == */

class CharroAllOffCard extends CharroBase {
  static getConfigElement() { return document.createElement("charro-all-off-card-editor"); }
  static getStubConfig() {
    return { type: "custom:charro-all-off-card", label: "All Zones Off", entities: [] };
  }
  templateName() { return "all-off-card.json"; }

  variables() {
    const c = this._config;
    return { label: c.label || "All Zones Off", entities: c.entities || [] };
  }

  triggers() { return uniq(this._config.entities || []); }

  overrides() {
    const c = this._config;
    const tap = {
      action: "call-service",
      service: c.service || "script.all_zones_off",
    };
    if (c.confirm !== false) {
      tap.confirmation = { text: c.confirm_text || "Turn **off all zones** on both amps?" };
    }
    return { tap_action: tap };
  }

  getGridOptions() { return { columns: 12, rows: "auto", min_columns: 6 }; }
}
customElements.define("charro-all-off-card", CharroAllOffCard);

/* Nothing, drawn deliberately. A grid cell has to be filled by something for
 * the next tile to land in the other column, so a gap is a card that renders
 * no card — no background, no border, no height of its own. */
class CharroGapCard extends HTMLElement {
  setConfig() {}
  set hass(_h) {}
  getCardSize() { return 0; }
  getGridOptions() { return { columns: 6, rows: "auto", min_columns: 3 }; }
}
customElements.define("charro-gap-card", CharroGapCard);

makeEditor("charro-all-off-card-editor", [
  { name: "label", selector: { text: {} } },
  { name: "entities", required: true, selector: ent(["switch"], true) },
  { name: "service", selector: { text: {} } },
  { name: "confirm", selector: { boolean: {} } },
  { name: "confirm_text", selector: { text: {} } },
], {
  label: "Label",
  entities: "Zone power switches to count",
  service: "Service to call (default script.all_zones_off)",
  confirm: "Ask before firing",
  confirm_text: "Confirmation text",
}, {
  entities: "The border goes green when any of these is on, red when all are off.",
});

/* ========================================================== LIGHTS CARD == */
/*
 * charro-lights-card — one room, one card, every row the same height.
 *
 * The brightness control lives inside the row as a fill bar instead of a
 * slider underneath it, so a row is exactly as tall whether the light is on,
 * off, dimmable or a relay. Drag across a lit dimmable row to set brightness;
 * tap anywhere to toggle; hold for more-info.
 *
 * Honours an input_select filter with the options
 * All / On / Lutron / Other / Fountains. Lutron vs Other is read live from
 * each entity's homeworks_address attribute, so it needs no config.
 */

const LC_FOUNTAIN = /fountain|water ?feature|water ?wall|spill|cascade/i;
const LC_ROW = 46;

const LC_CSS = `
:host { display:block; height:100%; }
ha-card {
  padding:10px 10px 12px; height:100%; box-sizing:border-box;
  display:flex; flex-direction:column;
}
.hd {
  display:flex; align-items:center; gap:8px;
  padding:0 4px 8px; min-height:22px;
}
.hd ha-icon { --mdc-icon-size:19px; color:var(--secondary-text-color); flex:none; }
.hd .t {
  font-size:15px; font-weight:600; letter-spacing:-.01em;
  color:var(--primary-text-color); white-space:nowrap;
  overflow:hidden; text-overflow:ellipsis;
}
.hd .n {
  margin-left:auto; flex:none; font-size:12px; font-weight:500;
  color:var(--secondary-text-color); font-variant-numeric:tabular-nums;
}
.hd .n.lit { color:var(--state-light-active-color, #ffc107); }
.list { display:flex; flex-direction:column; gap:4px; flex:0 0 auto; }
.row {
  position:relative; height:var(--lc-row,46px); border-radius:12px;
  overflow:hidden; cursor:pointer; user-select:none;
  -webkit-user-select:none; -webkit-tap-highlight-color:transparent;
  touch-action:pan-y; background:rgba(127,127,127,.13);
}
.row:focus-visible { outline:2px solid var(--primary-color); outline-offset:1px; }
.row[hidden] { display:none; }
.fill {
  position:absolute; inset:0 auto 0 0; width:0;
  background:var(--lc-accent, #ffc107); opacity:.30;
  transition:width .18s ease, opacity .18s ease; pointer-events:none;
}
.row.drag .fill { transition:none; }
.row.unav { opacity:.45; cursor:default; }
.face {
  position:relative; height:100%; display:flex; align-items:center;
  gap:10px; padding:0 12px; pointer-events:none;
}
.face ha-icon { --mdc-icon-size:21px; flex:none; color:var(--state-icon-color, var(--secondary-text-color)); }
.row.on .face ha-icon { color:var(--lc-accent, #ffc107); }
.nm {
  font-size:14px; font-weight:500; color:var(--primary-text-color);
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0;
}
.val {
  margin-left:auto; flex:none; font-size:12.5px; font-weight:500;
  color:var(--secondary-text-color); font-variant-numeric:tabular-nums;
}
.row.on .val { color:var(--primary-text-color); }
.empty {
  padding:6px 4px 2px; font-size:13px; color:var(--secondary-text-color);
}
@media (prefers-reduced-motion:reduce){ .fill{ transition:none; } }
`;

class CharroLightsCard extends HTMLElement {
  static getConfigElement() { return document.createElement("charro-lights-card-editor"); }
  static getStubConfig(hass) {
    const first = Object.keys(hass && hass.states ? hass.states : {})
      .filter((e) => e.startsWith("light.")).slice(0, 4);
    return { type: "custom:charro-lights-card", title: "Lights", entities: first };
  }

  setConfig(config) {
    if (!config || !Array.isArray(config.entities) || !config.entities.length)
      throw new Error("charro-lights-card: `entities` is required");
    this._config = config;
    this._items = config.entities.map((e) => (typeof e === "string" ? { entity: e } : { ...e }));
    this._rows = null;
    this._drag = null;
    if (this.shadowRoot) this.shadowRoot.innerHTML = "";
    if (this._hass) this._build();
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._rows) this._build();
    this._update();
  }

  getCardSize() { return 1 + Math.ceil(this._items.length * 0.7); }
  getGridOptions() { return { columns: 12, min_columns: 6, rows: "auto" }; }

  /* ------------------------------------------------------------ build -- */

  _build() {
    const root = this.shadowRoot || this.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = LC_CSS;

    const card = document.createElement("ha-card");
    if (this._config.row_height)
      card.style.setProperty("--lc-row", `${this._config.row_height}px`);

    const hd = document.createElement("div");
    hd.className = "hd";
    if (this._config.icon) {
      const i = document.createElement("ha-icon");
      i.icon = this._config.icon;
      hd.appendChild(i);
    }
    const t = document.createElement("div");
    t.className = "t";
    t.textContent = this._config.title || "";
    hd.appendChild(t);
    this._count = document.createElement("div");
    this._count.className = "n";
    hd.appendChild(this._count);
    if (this._config.title || this._config.icon) card.appendChild(hd);

    const list = document.createElement("div");
    list.className = "list";
    this._rows = new Map();

    for (const item of this._items) {
      const row = document.createElement("div");
      row.className = "row";
      row.tabIndex = 0;
      row.setAttribute("role", "button");

      const fill = document.createElement("div");
      fill.className = "fill";
      const face = document.createElement("div");
      face.className = "face";
      const ico = document.createElement("ha-icon");
      const nm = document.createElement("span");
      nm.className = "nm";
      const val = document.createElement("span");
      val.className = "val";
      face.append(ico, nm, val);
      row.append(fill, face);

      this._wire(row, item);
      list.appendChild(row);
      this._rows.set(item.entity, { row, fill, ico, nm, val, item });
    }

    this._empty = document.createElement("div");
    this._empty.className = "empty";
    this._empty.textContent = "Nothing on in here.";
    this._empty.hidden = true;

    card.append(list, this._empty);
    root.innerHTML = "";
    root.append(style, card);
  }

  /* ----------------------------------------------------- interaction --- */

  _wire(row, item) {
    let sx = 0, moved = false, hold = null, pct = 0;

    const stopHold = () => { if (hold) { clearTimeout(hold); hold = null; } };

    const pctAt = (clientX) => {
      const r = row.getBoundingClientRect();
      if (!r.width) return 0;
      return Math.max(1, Math.min(100, Math.round(((clientX - r.left) / r.width) * 100)));
    };

    row.addEventListener("pointerdown", (ev) => {
      if (ev.button != null && ev.button !== 0) return;
      const st = this._hass && this._hass.states[item.entity];
      if (!st || st.state === "unavailable") return;
      sx = ev.clientX; moved = false;
      row.setPointerCapture(ev.pointerId);
      hold = setTimeout(() => {
        hold = null; moved = true;
        fireEvent(this, "hass-more-info", { entityId: item.entity });
      }, 500);
    });

    row.addEventListener("pointermove", (ev) => {
      if (!row.hasPointerCapture || !row.hasPointerCapture(ev.pointerId)) return;
      if (Math.abs(ev.clientX - sx) < 7) return;
      const st = this._hass.states[item.entity];
      if (!this._dims(item, st) || st.state !== "on") return;
      stopHold();
      moved = true;
      row.classList.add("drag");
      pct = pctAt(ev.clientX);
      this._paint(item.entity, pct);
    });

    const end = (ev) => {
      if (row.hasPointerCapture && row.hasPointerCapture(ev.pointerId))
        row.releasePointerCapture(ev.pointerId);
      const wasDrag = row.classList.contains("drag");
      row.classList.remove("drag");
      stopHold();
      if (wasDrag) {
        this._hass.callService("light", "turn_on",
          { entity_id: item.entity, brightness_pct: pct });
      } else if (!moved) {
        const st = this._hass.states[item.entity];
        if (st && st.state !== "unavailable")
          this._hass.callService(item.entity.split(".")[0], "toggle", { entity_id: item.entity });
      }
      moved = false;
    };
    row.addEventListener("pointerup", end);
    row.addEventListener("pointercancel", (ev) => {
      stopHold(); row.classList.remove("drag"); moved = false;
      if (row.hasPointerCapture && row.hasPointerCapture(ev.pointerId))
        row.releasePointerCapture(ev.pointerId);
    });

    row.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter" && ev.key !== " ") return;
      ev.preventDefault();
      this._hass.callService(item.entity.split(".")[0], "toggle", { entity_id: item.entity });
    });
  }

  _paint(entity, pct) {
    const r = this._rows.get(entity);
    if (!r) return;
    r.fill.style.width = `${pct}%`;
    r.val.textContent = `${pct}%`;
  }

  /* --------------------------------------------------------- filtering - */

  _mode() {
    const fe = this._config.filter_entity;
    const s = fe && this._hass.states[fe];
    return s ? String(s.state) : "All";
  }

  _isLutron(st) { return !!(st && st.attributes && st.attributes.homeworks_address); }

  _isFountain(item, st) {
    if (item.fountain !== undefined) return !!item.fountain;
    const n = ((st && st.attributes && st.attributes.friendly_name) || "") + " " +
              (item.name || "") + " " + item.entity;
    return LC_FOUNTAIN.test(n);
  }

  _dims(item, st) {
    if (item.dim !== undefined) return !!item.dim;
    const m = (st && st.attributes && st.attributes.supported_color_modes) || [];
    return m.some((x) => x !== "onoff" && x !== "unknown");
  }

  _visible(item, st) {
    switch (this._mode()) {
      case "On":        return !!st && st.state === "on";
      case "Lutron":    return this._isLutron(st);
      case "Other":     return !this._isLutron(st);
      case "Fountains": return this._isFountain(item, st);
      default:          return true;
    }
  }

  /* ------------------------------------------------------------ update - */

  _update() {
    if (!this._hass || !this._rows) return;
    let shown = 0, on = 0;

    for (const { row, fill, ico, nm, val, item } of this._rows.values()) {
      const st = this._hass.states[item.entity];
      const vis = !!st && this._visible(item, st);
      row.hidden = !vis;
      if (!vis) continue;
      shown++;

      const lit = st.state === "on";
      if (lit) on++;
      const unav = st.state === "unavailable" || st.state === "unknown";
      const fountain = this._isFountain(item, st);

      row.classList.toggle("on", lit);
      row.classList.toggle("unav", unav);
      row.style.setProperty("--lc-accent", fountain ? "#03a9f4"
        : "var(--state-light-active-color, #ffc107)");

      const name = item.name || st.attributes.friendly_name || item.entity;
      if (nm.textContent !== name) nm.textContent = name;
      row.setAttribute("aria-label", name);

      const icon = item.icon || st.attributes.icon ||
        (fountain ? "mdi:fountain" : lit ? "mdi:lightbulb" : "mdi:lightbulb-outline");
      if (ico.icon !== icon) ico.icon = icon;

      if (row.classList.contains("drag")) continue;

      if (unav) {
        fill.style.width = "0%"; val.textContent = "—";
      } else if (!lit) {
        fill.style.width = "0%"; val.textContent = "Off";
      } else if (this._dims(item, st) && st.attributes.brightness != null) {
        const pct = Math.max(1, Math.round((st.attributes.brightness / 255) * 100));
        fill.style.width = `${pct}%`; val.textContent = `${pct}%`;
      } else {
        fill.style.width = "100%"; val.textContent = "On";
      }
    }

    this._count.textContent = shown ? `${on}/${shown}` : "";
    this._count.classList.toggle("lit", on > 0);
    if (this._empty) this._empty.hidden = shown > 0;
    this.style.display = shown || this._config.keep_empty ? "" : "none";
  }
}
customElements.define("charro-lights-card", CharroLightsCard);

/* ------------------------------------------------- lights card editor --- */

const LC_SCHEMA = [
  { name: "title", selector: { text: {} } },
  { name: "icon", selector: { icon: {} } },
  { name: "filter_entity", selector: { entity: { filter: [{ domain: "input_select" }] } } },
  { name: "row_height", selector: { number: { min: 32, max: 80, step: 2, mode: "slider" } } },
  { name: "entities", selector: { entity: { multiple: true,
      filter: [{ domain: "light" }, { domain: "switch" }] } } },
];
const LC_LABELS = {
  title: "Room", icon: "Icon", filter_entity: "Filter dropdown",
  row_height: "Row height (px)", entities: "Lights",
};
const LC_HELPERS = {
  filter_entity: "An input_select with the options All / On / Lutron / Other / Fountains.",
  entities: "Per-light overrides (name, icon, dim: false, fountain: true) are kept when you edit here, but can only be added in YAML.",
};

class CharroLightsCardEditor extends HTMLElement {
  setConfig(config) { this._config = config || {}; this._render(); }
  set hass(hass) {
    this._hass = hass;
    if (this._form) this._form.hass = hass; else this._render();
  }
  _render() {
    if (!this._hass || !this._config) return;
    if (!this._form) {
      this._form = document.createElement("ha-form");
      this._form.schema = LC_SCHEMA;
      this._form.computeLabel = (s) => LC_LABELS[s.name] || s.name;
      this._form.computeHelper = (s) => LC_HELPERS[s.name] || "";
      this._form.addEventListener("value-changed", (ev) => {
        ev.stopPropagation();
        const next = { ...this._config, ...ev.detail.value };

        // ha-form hands back a plain string list — re-attach any per-light
        // overrides the YAML had, so editing the room doesn't wipe them.
        if (Array.isArray(next.entities)) {
          const keep = new Map();
          for (const e of this._config.entities || [])
            if (e && typeof e === "object" && e.entity) keep.set(e.entity, e);
          next.entities = next.entities.map((e) =>
            typeof e === "string" ? keep.get(e) || e : e);
        }
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
    this._form.data = {
      ...this._config,
      entities: (this._config.entities || []).map((e) =>
        typeof e === "string" ? e : e.entity),
    };
  }
}
customElements.define("charro-lights-card-editor", CharroLightsCardEditor);

/* ========================================================= ROOMS EDITOR == */
/*
 * charro-rooms-editor — edit the files behind `room:` from inside Home
 * Assistant instead of from a text editor.
 *
 *   type: custom:charro-rooms-editor
 *   rooms: [master, lanai, saloon]
 *
 * A browser cannot write to /config, so Save goes one of two ways: it calls
 * shell_command.charro_write_room when that exists, and otherwise copies the
 * JSON and tells you where to paste it. The README has the four lines of
 * config for the first route.
 */

/* ------------------------------------------------- layout builder UI ---- */

const LB_CSS = `
.lbwrap{ display:flex; flex-direction:column; gap:6px; }
.lbhint{ font-size:12px; color:var(--secondary-text-color); margin:-2px 0 4px; }
.lb{ display:flex; flex-direction:column; gap:4px; min-height:24px; }
.lb.over{ outline:2px dashed var(--primary-color); outline-offset:3px; border-radius:8px; }
.it{
  display:flex; align-items:center; gap:8px; padding:6px 8px;
  border:1px solid var(--divider-color); border-radius:8px;
  background:var(--card-background-color);
  /* a narrow panel wraps the controls onto a second line rather than
     squeezing the name to one character per row and pushing the rest off */
  flex-wrap:wrap; row-gap:6px;
}
.it.drag{ opacity:.4; }
.it.head{ background:rgba(127,127,127,.14); border-style:dashed; }
.it.blk{ border-left:3px solid var(--primary-color); }
.it.dropbefore{ box-shadow:0 -3px 0 -1px var(--primary-color); }
.it.dropafter{ box-shadow:0 3px 0 -1px var(--primary-color); }
.grip{ cursor:grab; color:var(--secondary-text-color); --mdc-icon-size:18px; flex:none; }
.grip:active{ cursor:grabbing; }
.it .lbl{ flex:1 1 130px; min-width:110px; font-size:13px; overflow:hidden; }
.it .lbl, .it .sub{ white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.it .sub{ font-family:ui-monospace,monospace; font-size:11px; color:var(--secondary-text-color); }
.it input[type=text]{ padding:4px 6px; font-size:12.5px; min-width:0; }
.it .nm{ flex:1 1 110px; width:auto; min-width:84px; }
.it .ic{ flex:0 1 92px; width:auto; min-width:66px; }
/* the real picker is a combobox, so it needs more room than the text box did */
.it .ic.pick{ flex:1 1 160px; min-width:130px; --mdc-icon-size:18px; }
.it .ic.pick::part(base){ --text-field-padding:0 8px; }
.it select{ flex:0 1 auto; min-width:0; }
.it .btn{
  border:none; background:none; cursor:pointer; padding:3px; border-radius:6px;
  color:var(--secondary-text-color); --mdc-icon-size:17px; flex:none;
}
.it .btn:hover{ background:rgba(127,127,127,.18); color:var(--primary-text-color); }
.lbbar{ display:flex; gap:6px; flex-wrap:wrap; margin:10px 0 2px; }
.lbbar button{ padding:6px 11px; font-size:12.5px; font-weight:500; }
.cardpanel{
  border:1px solid var(--primary-color); border-radius:10px; padding:10px;
  margin:8px 0; display:flex; flex-direction:column; gap:8px;
  background:rgba(127,127,127,.06);
}
.cardpanel .top{ display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.cardpanel .top select{ flex:1 1 220px; min-width:0; padding:6px 8px;
  border-radius:8px; border:1px solid var(--divider-color);
  background:var(--card-background-color); }
.cardpanel .note{ font-size:12px; color:var(--secondary-text-color); }
.cardpanel .note.bad{ color:var(--error-color,#f44336); }
.cardpanel ha-yaml-editor{ display:block; }
.cardpanel textarea{ width:100%; min-height:200px; box-sizing:border-box;
  font-family:ui-monospace,Menlo,monospace; font-size:12.5px; line-height:1.5;
  border-radius:8px; border:1px solid var(--divider-color); padding:8px;
  background:var(--card-background-color); }
.cardpanel .acts{ display:flex; gap:6px; }
.hid{ opacity:.62; }
.hidzone{
  border:1px dashed var(--divider-color); border-radius:8px; padding:6px;
  min-height:44px; display:flex; flex-direction:column; gap:4px;
}
.hidzone.over{ border-color:var(--primary-color); background:rgba(127,127,127,.08); }
.hidempty{ font-size:12px; color:var(--secondary-text-color); padding:6px 2px; }
.grp{
  border:1px solid var(--divider-color); border-left:3px solid var(--primary-color);
  border-radius:10px; padding:6px; display:flex; flex-direction:column; gap:5px;
  background:rgba(127,127,127,.06);
}
.grp > .it{ background:rgba(127,127,127,.15); border-style:solid; }
.lb.inner{ padding-left:16px; min-height:30px; }
.lb.inner.over{ outline:2px dashed var(--primary-color); outline-offset:2px; border-radius:8px; }
.spn{ width:54px; }
.it .cap{ font-size:10.5px; letter-spacing:.06em; text-transform:uppercase;
  color:var(--secondary-text-color); flex:none; }
.it select{ font-size:12px; padding:3px 4px; border-radius:6px;
  border:1px solid var(--divider-color); background:var(--card-background-color); }
.tray{ display:flex; flex-direction:column; gap:8px; }
.vcap{ font-size:11px; letter-spacing:.07em; text-transform:uppercase;
  color:var(--secondary-text-color); margin:12px 0 4px; }
.vrowbox{
  border:1px solid var(--divider-color); border-radius:8px; padding:8px;
  margin-bottom:6px; display:flex; flex-direction:column; gap:6px;
}
.vfield{ display:flex; flex-direction:column; gap:2px; }
.vfield > span{ font-size:11.5px; color:var(--secondary-text-color); }
.vfield input, .vfield select{
  padding:5px 7px; font-size:12.5px; border-radius:7px;
  border:1px solid var(--divider-color); background:var(--card-background-color);
  color:var(--primary-text-color); font:inherit; width:100%; box-sizing:border-box;
}
button.vdel{ background:rgba(244,67,54,.16); color:#ef5350; align-self:flex-start;
  padding:5px 10px; font-size:12px; }
ha-expansion-panel{ display:block; margin:14px 0 4px; --expansion-panel-content-padding:0 10px 10px; }
ha-expansion-panel h4:first-of-type{ margin-top:4px; }

.vfield ha-entity-picker, .vfield ha-icon-picker{ display:block; width:100%; }


.traycat .cap{ display:block; margin:2px 2px 4px; }
`;

const o_render = (it) => it.render || "mushroom";

const BLOCK_LABEL = {
  climate: "Climate", video: "Video / remotes", media: "Media",
  music: "Music (every zone)", player: "Media player", cameras: "Cameras",
  security: "Door / motion alert", lights: "All lights",
};

/* The core cards worth offering, with a starting config each so picking one
 * lands something that renders rather than a bare type that errors. */
const CORE_CARDS = [
  ["tile", "Tile", { type: "tile", entity: "" }],
  ["entities", "Entities", { type: "entities", entities: [] }],
  ["button", "Button", { type: "button", entity: "" }],
  ["gauge", "Gauge", { type: "gauge", entity: "" }],
  ["light", "Light", { type: "light", entity: "" }],
  ["thermostat", "Thermostat", { type: "thermostat", entity: "" }],
  ["media-control", "Media control", { type: "media-control", entity: "" }],
  ["picture-entity", "Picture entity", { type: "picture-entity", entity: "" }],
  ["markdown", "Markdown", { type: "markdown", content: "" }],
  ["history-graph", "History graph", { type: "history-graph", entities: [] }],
  ["statistic", "Statistic", { type: "statistic", entity: "" }],
  ["weather-forecast", "Weather", { type: "weather-forecast", entity: "" }],
  ["todo-list", "To-do list", { type: "todo-list", entity: "" }],
  ["map", "Map", { type: "map", entities: [] }],
  ["calendar", "Calendar", { type: "calendar", entities: [] }],
  ["conditional", "Conditional", { type: "conditional", conditions: [], card: {} }],
  ["grid", "Grid", { type: "grid", columns: 2, square: false, cards: [] }],
  ["vertical-stack", "Vertical stack", { type: "vertical-stack", cards: [] }],
  ["horizontal-stack", "Horizontal stack", { type: "horizontal-stack", cards: [] }],
];

/* Installed cards register themselves on window.customCards, so the library
 * is whatever this install actually has rather than a list that goes stale.
 * Group by the vendor prefix, which is how they read on screen anyway. */
const CARD_VENDORS = {
  mushroom: "Mushroom", mediocre: "Mediocre", charro: "Charro",
  bubble: "Bubble", "button-card": "Button Card",
};
function cardLibrary() {
  const cats = [{ label: "Home Assistant", items: CORE_CARDS.map(([t, n, seed]) =>
    ({ type: t, name: n, seed })) }];
  const buckets = new Map();
  for (const c of window.customCards || []) {
    if (!c || !c.type) continue;
    if (c.type.startsWith("charro-")) continue;          // our own, not room content
    const key = Object.keys(CARD_VENDORS).find((k) => c.type.startsWith(k)) || "";
    const label = CARD_VENDORS[key] || "Other custom cards";
    if (!buckets.has(label)) buckets.set(label, []);
    buckets.get(label).push({ type: `custom:${c.type}`,
                              name: c.name || c.type,
                              seed: { type: `custom:${c.type}` } });
  }
  for (const [label, items] of [...buckets].sort((a, b) => a[0].localeCompare(b[0]))) {
    items.sort((a, b) => a.name.localeCompare(b.name));
    cats.push({ label, items });
  }
  return cats;
}

/* Mixed into CharroRoomsEditor. Kept apart because it is all one feature. */
const LayoutUI = {
  /* Paste or build a card and it becomes an ordinary layout row: draggable,
   * hideable, droppable into a column. HA's own YAML editor does the parsing
   * when it's available — it is, on a plain dashboard load — so this takes
   * YAML or JSON and says where the syntax error is. */
  _openCard(ctx) {
    this._cardCtx = ctx;
    this._lbRender();
  },
  _closeCard() { this._cardCtx = null; this._lbRender(); },

  _cardPanel() {
    const ctx = this._cardCtx;
    const list = ctx.index === null ? null : this._lbList(ctx.key);
    const existing = list && list[ctx.index] ? list[ctx.index].card : null;
    let cfg = existing ? clone(existing) : { type: "tile", entity: "" };
    let valid = true;

    const panel = document.createElement("div");
    panel.className = "cardpanel";

    const top = document.createElement("div");
    top.className = "top";
    const sel = document.createElement("select");
    const keep = document.createElement("option");
    keep.value = ""; keep.textContent = existing ? "— keep this card —" : "— pick a card —";
    sel.appendChild(keep);
    for (const cat of cardLibrary()) {
      const g = document.createElement("optgroup");
      g.label = cat.label;
      for (const it of cat.items) {
        const o = document.createElement("option");
        o.value = it.type; o.textContent = it.name;
        o._seed = it.seed;
        g.appendChild(o);
      }
      sel.appendChild(g);
    }
    top.appendChild(sel);

    const note = document.createElement("div");
    note.className = "note";
    note.textContent = existing ? "Editing this card." : "Pick a type, or paste a card below.";

    const acts = document.createElement("div");
    acts.className = "acts";
    const ok = document.createElement("button");
    ok.className = "primary";
    ok.textContent = existing ? "Save card" : "Add card";
    const cancel = document.createElement("button");
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => this._closeCard());
    acts.append(ok, cancel);

    let setCfg;
    if (customElements.get("ha-yaml-editor")) {
      const y = document.createElement("ha-yaml-editor");
      y.hass = this._hass;
      y.addEventListener("value-changed", (ev) => {
        ev.stopPropagation();
        valid = ev.detail.isValid !== false;
        if (valid && ev.detail.value && typeof ev.detail.value === "object") {
          cfg = ev.detail.value;
        }
        note.classList.toggle("bad", !valid);
        note.textContent = valid ? "Looks like valid YAML." : "That YAML doesn't parse yet.";
        ok.disabled = !valid;
      });
      panel.append(top, y, note, acts);
      // setValue only lands once the element has rendered its editor
      Promise.resolve(y.updateComplete).then(() => y.setValue(cfg));
      setCfg = (v) => { cfg = v; y.setValue(v); };
    } else {
      const ta = document.createElement("textarea");
      ta.spellcheck = false;
      ta.value = JSON.stringify(cfg, null, 2);
      ta.addEventListener("input", () => {
        try { cfg = JSON.parse(ta.value); valid = true; }
        catch (err) { valid = false; }
        note.classList.toggle("bad", !valid);
        note.textContent = valid ? "Valid JSON." : "That JSON doesn't parse yet.";
        ok.disabled = !valid;
      });
      note.textContent = "HA's YAML editor isn't loaded — paste JSON here.";
      panel.append(top, ta, note, acts);
      setCfg = (v) => { cfg = v; ta.value = JSON.stringify(v, null, 2); };
    }

    sel.addEventListener("change", () => {
      const o = sel.selectedOptions[0];
      if (!o || !o._seed) return;
      setCfg(clone(o._seed));
      valid = true; ok.disabled = false;
      note.classList.remove("bad");
      note.textContent = "Fill in the entity and anything else it needs.";
    });

    ok.addEventListener("click", () => {
      if (!valid) return;
      if (!cfg || typeof cfg !== "object" || Array.isArray(cfg) || !cfg.type) {
        note.classList.add("bad");
        note.textContent = "A card needs to be an object with a `type`.";
        return;
      }
      const target = this._lbList(ctx.key);
      if (ctx.index === null) target.push({ card: cfg });
      else target[ctx.index] = { ...target[ctx.index], card: cfg };
      this._cardCtx = null;
      this._lbRender(); this._lbChanged();
    });

    return panel;
  },

  _lbEnsure() {
    const r = this._room;
    if (!Array.isArray(r.layout)) r.layout = [];
    if (!Array.isArray(r.hidden)) r.hidden = [];
    // show the split the pop-up already renders, so Save doesn't undo it
    if (r.layout.length) {
      const m = migrateMusic(r);
      if (m !== r) r.layout = m.layout;
    }
  },

  /* Containers are addressed by key: "layout", "hidden", or "g:<index>" for a
   * group's items. _lbChanged() drops an empty layout/hidden to keep the saved
   * JSON tidy, so always come back through here instead of holding a ref. */
  _lbList(key) {
    const r = this._room;
    if (key === "hidden") {
      if (!Array.isArray(r.hidden)) r.hidden = [];
      return r.hidden;
    }
    if (String(key).startsWith("g:")) {
      const g = (r.layout || [])[Number(String(key).slice(2))];
      if (!g) return [];
      if (!Array.isArray(g.items)) g.items = [];
      return g.items;
    }
    if (!Array.isArray(r.layout)) r.layout = [];
    return r.layout;
  },

  /* Everything the room owns but hasn't placed: lights still loose, and any
   * block not in use. Derived, never stored — dragging one out creates the
   * item, it doesn't move it. */
  _lbAvail() {
    const r = this._room;
    const placed = new Set(this._lbAll().map((x) => x && x.entity).filter(Boolean));
    const usedBlocks = new Set(this._lbAll().map((x) => x && x.block).filter(Boolean));
    const cats = [];
    for (const [label, key] of LIGHT_GROUPS) {
      const items = (r[key] || [])
        .map((l) => lightId(l))
        .filter((e) => e && !placed.has(e))
        .map((e) => ({ entity: e }));
      if (items.length) cats.push({ label, items });
    }
    const sid = (x) => (typeof x === "string" ? x : (x && x.entity));
    const placedSensors = new Set(this._lbAll().map((x) => x && sid(x.sensor)).filter(Boolean));
    const sensors = (r.alert_sensors || [])
      .filter((x) => sid(x) && !placedSensors.has(sid(x)))
      .map((x) => ({ sensor: x }));
    if (sensors.length) cats.push({ label: "Door / motion", items: sensors });

    const zid = (z) => (typeof z === "string" ? z : (z && (z.entity || z.power)));
    const placedZones = new Set(this._lbAll().map((x) => x && zid(x.zone)).filter(Boolean));
    const zones = (r.music_powers || [])
      .filter((z) => zid(z) && !placedZones.has(zid(z)))
      .map((z) => ({ zone: z }));
    if (zones.length) cats.push({ label: "Music zones", items: zones });

    const blocks = Object.keys(BLOCK_LABEL)
      .filter((b) => b !== "lights" && !usedBlocks.has(b))
      .filter((b) => {
        if (b === "climate") return !!r.climate_entity;
        if (b === "security") return (r.alert_sensors || []).length;
        if (b === "cameras") return (r.cameras || []).length;
        if (b === "media") return !!(r.tv_entity || r.projector_entity
                                     || r.receiver_entity || r.remotes);
        if (b === "music") return !!((r.music_powers || []).length || r.media_player);
        if (b === "video") return !!r.video;
        if (b === "player") return !!(r.media_player || r.media_card);
        return true;
      })
      .map((b) => ({ block: b }));
    if (blocks.length) cats.push({ label: "Blocks", items: blocks });
    // one flat list backs the drag indices
    this._avail = cats.flatMap((c) => c.items);
    return cats;
  },

  /* every item anywhere, for the form-to-layout sync */
  _lbAll() {
    const out = [];
    for (const it of this._room.layout || []) {
      out.push(it);
      if (it && it.group !== undefined) out.push(...(it.items || []));
    }
    out.push(...(this._room.hidden || []));
    return out;
  },

  _lbLabel(it) {
    if (it.heading !== undefined) return null;
    if (it.block) return { icon: "mdi:view-agenda-outline", text: BLOCK_LABEL[it.block] || it.block };
    if (it.sensor) {
      const id = typeof it.sensor === "string" ? it.sensor : it.sensor.entity;
      const st = this._hass.states[id];
      const reg = this._hass.entities && this._hass.entities[id];
      return { icon: (typeof it.sensor === "object" && it.sensor.icon) || "mdi:door-closed",
               text: (typeof it.sensor === "object" && it.sensor.label)
                     || (reg && (reg.name || reg.original_name))
                     || (st && st.attributes.friendly_name) || id,
               sub: id };
    }
    if (it.zone) {
      const id = typeof it.zone === "string" ? it.zone : (it.zone.entity || it.zone.power);
      const stem = String(id).replace(/^[^.]*\./, "").replace(/_power$/, "");
      return { icon: "mdi:speaker", text: zoneName(id, stem, this._room, this._hass),
               sub: id };
    }
    if (it.gap) return { icon: "mdi:crop-free", text: "Gap" };
    if (it.card) return { icon: "mdi:code-braces", text: it.card.type || "card" };
    const st = this._hass.states[it.entity];
    return { icon: it.icon || (st && st.attributes.icon) || "mdi:lightbulb",
             text: (st && st.attributes.friendly_name) || it.entity, sub: it.entity };
  },

  /* HA's own icon picker is registered on a plain dashboard load, so use it
   * rather than asking you to remember mdi names — it searches, previews and
   * completes. If a future frontend stops defining it, fall back to the text
   * box rather than losing the field. */
  _iconField(it) {
    const commit = (v) => {
      const s = (v || "").trim();
      if (s) it.icon = s; else delete it.icon;
      this._lbChanged();
    };
    if (customElements.get("ha-icon-picker")) {
      const p = document.createElement("ha-icon-picker");
      p.className = "ic pick";
      p.hass = this._hass;
      p.value = it.icon || "";
      p.placeholder = "Icon";
      p.addEventListener("value-changed", (ev) => {
        ev.stopPropagation();
        commit(ev.detail && ev.detail.value);
      });
      return p;
    }
    const inp = document.createElement("input");
    inp.type = "text"; inp.className = "ic"; inp.value = it.icon || "";
    inp.placeholder = "mdi:…";
    inp.addEventListener("change", () => commit(inp.value));
    return inp;
  },

  _lbRow(it, list, i) {
    const row = document.createElement("div");
    row.className = "it" + (it.heading !== undefined ? " head" : "")
                  + (it.block ? " blk" : "") + (list === "hidden" ? " hid" : "");

    const grip = document.createElement("ha-icon");
    grip.className = "grip"; grip.icon = "mdi:drag";
    row.appendChild(grip);

    if (it.heading !== undefined) {
      const inp = document.createElement("input");
      inp.type = "text"; inp.className = "lbl"; inp.value = it.heading;
      inp.placeholder = "Heading";
      inp.addEventListener("change", () => { it.heading = inp.value; this._lbChanged(); });
      row.appendChild(inp);
    } else {
      const meta = this._lbLabel(it);
      const ic = document.createElement("ha-icon");
      ic.icon = meta.icon; ic.style.cssText = "--mdc-icon-size:18px;flex:none;color:var(--secondary-text-color)";
      const lbl = document.createElement("div");
      lbl.className = "lbl";
      lbl.textContent = meta.text;
      // the row clips rather than wraps now, so keep the full text on hover
      lbl.title = meta.sub ? `${meta.text}\n${meta.sub}` : meta.text;
      if (meta.sub) {
        const s = document.createElement("div"); s.className = "sub"; s.textContent = meta.sub;
        lbl.appendChild(s);
      }
      row.append(ic, lbl);

      if (it.entity && list !== "avail") {
        const st = this._hass.states[it.entity];
        const nm = document.createElement("input");
        nm.type = "text"; nm.className = "nm"; nm.value = it.name || "";
        nm.placeholder = (st && st.attributes.friendly_name) || "Name";
        nm.addEventListener("change", () => {
          if (nm.value.trim()) it.name = nm.value.trim(); else delete it.name;
          this._lbChanged();
        });
        const icf = this._iconField(it);
        const dim = document.createElement("button");
        dim.className = "btn";
        dim.title = it.dim === false ? "Doesn't dim — click to allow" : "Dims — click if it can't";
        dim.innerHTML = `<ha-icon icon="${it.dim === false ? "mdi:lightbulb-on-outline" : "mdi:brightness-percent"}"></ha-icon>`;
        dim.addEventListener("click", () => {
          if (it.dim === false) delete it.dim; else it.dim = false;
          this._lbRender(); this._lbChanged();
        });

        const wide = document.createElement("button");
        wide.className = "btn";
        wide.title = it.width === "full" ? "Full row — click for half" : "Half row — click for full";
        wide.innerHTML = `<ha-icon icon="${it.width === "full"
          ? "mdi:arrow-expand-horizontal" : "mdi:arrow-collapse-horizontal"}"></ha-icon>`;
        wide.addEventListener("click", () => {
          if (it.width === "full") delete it.width; else it.width = "full";
          this._lbRender(); this._lbChanged();
        });

        // a Lutron group and its members are the same bulbs twice
        const cnt = document.createElement("button");
        cnt.className = "btn";
        cnt.title = it.count === false
          ? "Not counted in the chip — click to count it"
          : "Counted in the chip — click to leave it out (for groups and duplicates)";
        cnt.innerHTML = `<ha-icon icon="${it.count === false
          ? "mdi:numeric-0-box-multiple-outline" : "mdi:counter"}"></ha-icon>`;
        if (it.count === false) cnt.style.color = "var(--primary-color)";
        cnt.addEventListener("click", () => {
          if (it.count === false) delete it.count; else it.count = false;
          this._lbRender(); this._lbChanged();
        });

        const rend = document.createElement("select");
        for (const [v, label] of Object.entries(RENDER_KINDS)) {
          const op = document.createElement("option");
          op.value = v; op.textContent = label;
          op.selected = (o_render(it) === v);
          rend.appendChild(op);
        }
        rend.title = "How this light is drawn";
        rend.addEventListener("change", () => {
          if (rend.value === "mushroom") delete it.render; else it.render = rend.value;
          this._lbChanged();
        });

        row.append(nm, icf, rend, dim, wide, cnt);
      }
    }

    if (list === "avail") {
      const add = document.createElement("button");
      add.className = "btn"; add.title = "Add to the layout";
      add.innerHTML = `<ha-icon icon="mdi:plus"></ha-icon>`;
      add.addEventListener("click", () => {
        this._lbList("layout").push({ ...it });
        this._lbRender(); this._lbChanged();
      });
      row.appendChild(add);
      this._lbWireDrag(row, list, i);
      return row;
    }

    if (it.sensor) {
      // promote a bare id the moment you set something on it
      const obj = () => {
        if (typeof it.sensor === "string") it.sensor = { entity: it.sensor };
        return it.sensor;
      };
      const o = typeof it.sensor === "object" ? it.sensor : {};

      const lbl = document.createElement("input");
      lbl.type = "text"; lbl.className = "nm"; lbl.value = o.label || "";
      lbl.placeholder = "Label";
      lbl.addEventListener("change", () => {
        const v = lbl.value.trim();
        if (v) obj().label = v; else if (typeof it.sensor === "object") delete it.sensor.label;
        this._lbChanged();
      });
      row.appendChild(lbl);

      // a garage door needs the button that operates it
      const tog = customElements.get("ha-entity-picker")
        ? document.createElement("ha-entity-picker")
        : document.createElement("input");
      if (tog.tagName === "HA-ENTITY-PICKER") {
        tog.className = "ic pick";
        tog.hass = this._hass;
        tog.value = o.toggle_button || "";
        tog.allowCustomEntity = true;
        tog.includeDomains = ["button", "switch", "script", "cover"];
        tog.addEventListener("value-changed", (ev) => {
          ev.stopPropagation();
          const v = (ev.detail && ev.detail.value) || "";
          if (v) obj().toggle_button = v;
          else if (typeof it.sensor === "object") delete it.sensor.toggle_button;
          this._lbChanged();
        });
      } else {
        tog.type = "text"; tog.className = "ic"; tog.value = o.toggle_button || "";
        tog.placeholder = "opens it";
        tog.addEventListener("change", () => {
          const v = tog.value.trim();
          if (v) obj().toggle_button = v;
          else if (typeof it.sensor === "object") delete it.sensor.toggle_button;
          this._lbChanged();
        });
      }
      row.appendChild(tog);

      const w = document.createElement("button");
      w.className = "btn";
      w.title = it.width === "full" ? "Full row — click for half" : "Half row — click for full";
      w.innerHTML = `<ha-icon icon="${it.width === "full"
        ? "mdi:arrow-expand-horizontal" : "mdi:arrow-collapse-horizontal"}"></ha-icon>`;
      w.addEventListener("click", () => {
        if (it.width === "full") delete it.width; else it.width = "full";
        this._lbRender(); this._lbChanged();
      });
      row.appendChild(w);
    }

    if (it.card) {
      // a card defaults to the full row; half lets it pair with a light
      const half = document.createElement("button");
      half.className = "btn";
      half.title = it.width === "half"
        ? "Half row — click for full"
        : "Full row — click for half, to sit beside a light";
      half.innerHTML = `<ha-icon icon="${it.width === "half"
        ? "mdi:arrow-collapse-horizontal" : "mdi:arrow-expand-horizontal"}"></ha-icon>`;
      half.addEventListener("click", () => {
        if (it.width === "half") delete it.width; else it.width = "half";
        this._lbRender(); this._lbChanged();
      });
      row.appendChild(half);

      const edit = document.createElement("button");
      edit.className = "btn"; edit.title = "Edit this card";
      edit.innerHTML = `<ha-icon icon="mdi:pencil-outline"></ha-icon>`;
      edit.addEventListener("click", () => this._openCard({ key: list, index: i }));
      row.appendChild(edit);
    }

    const move = document.createElement("button");
    move.className = "btn";
    move.title = list === "hidden" ? "Put back in the layout" : "Hide";
    move.innerHTML = `<ha-icon icon="${list === "hidden" ? "mdi:eye-outline" : "mdi:eye-off-outline"}"></ha-icon>`;
    move.addEventListener("click", () => {
      const from = this._lbList(list);
      const to   = this._lbList(list === "hidden" ? "layout" : "hidden");
      const [moved] = from.splice(i, 1);
      if (moved) to.push(moved);
      this._lbRender(); this._lbChanged();
    });
    row.appendChild(move);

    if (it.heading !== undefined || it.card || it.block || it.gap || it.zone
        || it.sensor) {
      const del = document.createElement("button");
      del.className = "btn";
      del.title = it.block
        ? "Remove — + Block can add it back"
        : "Remove";
      del.innerHTML = `<ha-icon icon="mdi:close"></ha-icon>`;
      del.addEventListener("click", () => {
        this._lbList(list).splice(i, 1);
        this._lbRender(); this._lbChanged();
      });
      row.appendChild(del);
    }

    this._lbWireDrag(row, list, i);
    return row;
  },

  _lbWireDrag(row, list, i) {
    row.draggable = true;
    row.dataset.list = list; row.dataset.i = String(i);
    row.addEventListener("dragstart", (ev) => {
      this._drag = { list, i };
      row.classList.add("drag");
      ev.stopPropagation();
      ev.dataTransfer.effectAllowed = "move";
      try { ev.dataTransfer.setData("text/plain", `${list}:${i}`); } catch (e) {}
    });
    row.addEventListener("dragend", () => {
      row.classList.remove("drag"); this._drag = null; this._lbClearMarks();
    });
    row.addEventListener("dragover", (ev) => {
      if (!this._drag) return;
      // a group can't be dropped inside a group
      if (this._dragIsGroup && String(list).startsWith("g:")) return;
      ev.preventDefault(); ev.stopPropagation();
      ev.dataTransfer.dropEffect = "move";
      const r = row.getBoundingClientRect();
      const after = ev.clientY > r.top + r.height / 2;
      this._lbClearMarks();
      row.classList.add(after ? "dropafter" : "dropbefore");
      this._dropAt = { list, i: after ? i + 1 : i };
    });
    row.addEventListener("drop", (ev) => {
      ev.preventDefault(); ev.stopPropagation(); this._lbDrop();
    });
  },

  get _dragIsGroup() {
    const d = this._drag;
    if (!d) return false;
    const src = d.list === "avail" ? (this._avail || []) : this._lbList(d.list);
    const it = src[d.i];
    return !!(it && it.group !== undefined);
  },

  /* a group row: its own header, plus a droppable list of what's inside */
  _lbGroup(g, idx) {
    const box = document.createElement("div");
    box.className = "grp";

    const head = document.createElement("div");
    head.className = "it";
    const grip = document.createElement("ha-icon");
    grip.className = "grip"; grip.icon = "mdi:drag";
    const cap = document.createElement("span");
    cap.className = "cap"; cap.textContent = "Column";
    const title = document.createElement("input");
    title.type = "text"; title.className = "lbl"; title.value = g.group || "";
    title.placeholder = "Column label (blank for none)";
    title.addEventListener("change", () => { g.group = title.value; this._lbChanged(); });
    const spanCap = document.createElement("span");
    spanCap.className = "cap"; spanCap.textContent = "span";
    const span = document.createElement("input");
    span.type = "text"; span.className = "spn"; span.value = String(g.span || 1);
    span.addEventListener("change", () => {
      const v = Number(span.value);
      if (v > 0) g.span = v; else delete g.span;
      this._lbChanged();
    });
    const del = document.createElement("button");
    del.className = "btn"; del.title = "Remove the column — its items move out";
    del.innerHTML = `<ha-icon icon="mdi:close"></ha-icon>`;
    del.addEventListener("click", () => {
      const L = this._lbList("layout");
      L.splice(idx, 1, ...(g.items || []));     // keep what was inside
      this._lbRender(); this._lbChanged();
    });
    head.append(grip, cap, title, spanCap, span, del);
    this._lbWireDrag(head, "layout", idx);

    const inner = document.createElement("div");
    inner.className = "lb inner";
    (g.items || []).forEach((it, i) => inner.appendChild(this._lbRow(it, "g:" + idx, i)));
    if (!(g.items || []).length) {
      const e = document.createElement("div");
      e.className = "hidempty"; e.textContent = "Empty column — drag items in.";
      inner.appendChild(e);
    }
    inner.addEventListener("dragover", (ev) => {
      if (!this._drag || this._dragIsGroup) return;
      ev.preventDefault(); this._lbClearMarks();
      inner.classList.add("over");
      this._dropAt = { list: "g:" + idx, i: (g.items || []).length };
    });
    inner.addEventListener("dragleave", () => inner.classList.remove("over"));
    inner.addEventListener("drop", (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      inner.classList.remove("over"); this._lbDrop();
    });

    box.append(head, inner);
    return box;
  },

  _lbClearMarks() {
    for (const el of this.shadowRoot.querySelectorAll(".dropbefore,.dropafter"))
      el.classList.remove("dropbefore", "dropafter");
  },

  _lbDrop() {
    const d = this._drag, t = this._dropAt;
    this._lbClearMarks();
    if (!d || !t) return;
    const to = this._lbList(t.list);
    if (d.list === "avail") {
      const src = (this._avail || [])[d.i];
      if (!src) { this._lbRender(); return; }
      to.splice(Math.max(0, Math.min(t.i, to.length)), 0, { ...src });
      this._drag = null; this._dropAt = null;
      this._lbRender(); this._lbChanged();
      return;
    }
    const from = this._lbList(d.list);
    const [item] = from.splice(d.i, 1);
    if (!item) { this._lbRender(); return; }
    let at = t.i;
    if (from === to && d.i < at) at--;                 // the splice shifted it
    to.splice(Math.max(0, Math.min(at, to.length)), 0, item);
    this._drag = null; this._dropAt = null;
    this._lbRender(); this._lbChanged();
  },

  _lbChanged() {
    if (Array.isArray(this._room.layout) && !this._room.layout.length)
      delete this._room.layout;
    if (Array.isArray(this._room.hidden) && !this._room.hidden.length)
      delete this._room.hidden;
    this._renderPreview();
  },

  _lbRender() {
    if (!this._layoutBox) return;
    const r = this._room;
    this._layoutBox.innerHTML = "";
    const custom = Array.isArray(r.layout) && r.layout.length;

    const head = document.createElement("div");
    head.className = "h4row";
    const h = document.createElement("h4");
    h.textContent = custom ? "Layout" : "Layout (automatic)";
    const n = document.createElement("span");
    n.className = "n";
    n.textContent = custom
      ? `${this._lbAll().length - (r.hidden || []).length} items`
      : "";
    head.append(h, n);
    this._layoutBox.appendChild(head);

    if (!custom) {
      const hint = document.createElement("div");
      hint.className = "lbhint";
      hint.textContent =
        "This room arranges itself from its entity lists. Take it over to " +
        "reorder things, group them under your own headings, or hide them.";
      const go = document.createElement("button");
      go.className = "primary";
      go.textContent = "Customise layout";
      go.addEventListener("click", () => {
        this._room.layout = materializeLayout(this._room);
        this._room.hidden = this._room.hidden || [];
        this._lbRender(); this._lbChanged();
      });
      // adding a card is a reason to take the layout over, so do both at
      // once rather than making "+ Card" something you can only reach after
      // pressing an unrelated button first
      const card = document.createElement("button");
      card.textContent = "+ Card";
      card.title = "Paste or build any Lovelace card — takes the layout over too";
      card.addEventListener("click", () => {
        this._room.layout = materializeLayout(this._room);
        this._room.hidden = this._room.hidden || [];
        this._lbChanged();
        this._openCard({ key: "layout", index: null });
      });
      const bar = document.createElement("div"); bar.className = "lbbar";
      bar.append(go, card);
      this._layoutBox.append(hint, bar);
      return;
    }

    const wrap = document.createElement("div"); wrap.className = "lbwrap";
    const list = document.createElement("div"); list.className = "lb";
    r.layout.forEach((it, i) => list.appendChild(
      it && it.group !== undefined ? this._lbGroup(it, i) : this._lbRow(it, "layout", i)));
    if (!r.layout.length) {
      const e = document.createElement("div");
      e.className = "hidempty"; e.textContent = "Empty — drag something here.";
      list.appendChild(e);
    }
    // dropping onto the gap at the end
    list.addEventListener("dragover", (ev) => {
      if (!this._drag || ev.target !== list) return;
      ev.preventDefault(); this._lbClearMarks();
      list.classList.add("over"); this._dropAt = { list: "layout", i: r.layout.length };
    });
    list.addEventListener("dragleave", () => list.classList.remove("over"));
    list.addEventListener("drop", (ev) => {
      ev.preventDefault(); list.classList.remove("over"); this._lbDrop();
    });

    const bar = document.createElement("div"); bar.className = "lbbar";
    const addHead = document.createElement("button");
    addHead.textContent = "+ Heading";
    addHead.addEventListener("click", () => {
      this._lbList("layout").push({ heading: "New heading" });
      this._lbRender(); this._lbChanged();
    });
    const addBlock = document.createElement("button");
    addBlock.textContent = "+ Block";
    addBlock.addEventListener("click", () => {
      const used = new Set(this._lbList("layout").concat(this._lbList("hidden"))
        .map(x => x.block).filter(Boolean));
      const free = Object.keys(BLOCK_LABEL).filter(b => b !== "lights" && !used.has(b));
      if (!free.length) { this._say("Every block is already placed.", "err"); return; }
      this._lbList("layout").push({ block: free[0] });
      this._lbRender(); this._lbChanged();
    });
    const addGap = document.createElement("button");
    addGap.textContent = "+ Gap";
    addGap.title = "An empty half-width cell, to push the next tile across or down";
    addGap.addEventListener("click", () => {
      this._lbList("layout").push({ gap: true });
      this._lbRender(); this._lbChanged();
    });
    const addCard = document.createElement("button");
    addCard.textContent = "+ Card";
    addCard.title = "Paste or build any Lovelace card";
    addCard.addEventListener("click", () => this._openCard({ key: "layout", index: null }));
    const addGroup = document.createElement("button");
    addGroup.textContent = "+ Column";
    addGroup.title = "Neighbouring columns share a row and stack when narrow";
    addGroup.addEventListener("click", () => {
      this._lbList("layout").push({ group: "New column", span: 1, items: [] });
      this._lbRender(); this._lbChanged();
    });
    const reset = document.createElement("button");
    reset.textContent = "Back to automatic";
    reset.addEventListener("click", () => {
      delete r.layout; delete r.hidden; this._lbRender(); this._lbChanged();
    });
    bar.append(addHead, addBlock, addCard, addGap, addGroup, reset);

    // ---- Available: owned but not placed ----
    const cats = this._lbAvail();
    const availTotal = (this._avail || []).length;
    const ah = document.createElement("div"); ah.className = "h4row";
    const ahh = document.createElement("h4"); ahh.textContent = "Available";
    const an = document.createElement("span"); an.className = "n";
    an.textContent = String(availTotal);
    ah.append(ahh, an);

    const tray = document.createElement("div"); tray.className = "hidzone tray";
    if (!availTotal) {
      const e = document.createElement("div");
      e.className = "hidempty";
      e.textContent = "Everything this room has is placed.";
      tray.appendChild(e);
    } else {
      let n0 = 0;
      for (const c of cats) {
        const cat = document.createElement("div"); cat.className = "traycat";
        const cap = document.createElement("span");
        cap.className = "cap"; cap.textContent = c.label;
        cat.appendChild(cap);
        for (const it of c.items) {
          cat.appendChild(this._lbRow(it, "avail", n0));
          n0++;
        }
        tray.appendChild(cat);
      }
    }

    const hh = document.createElement("div");
    hh.className = "h4row";
    const hhh = document.createElement("h4"); hhh.textContent = "Hidden";
    const hn = document.createElement("span"); hn.className = "n";
    hn.textContent = `${(r.hidden || []).length}`;
    hh.append(hhh, hn);

    const hz = document.createElement("div"); hz.className = "hidzone";
    (r.hidden || []).forEach((it, i) => hz.appendChild(this._lbRow(it, "hidden", i)));
    if (!(r.hidden || []).length) {
      const e = document.createElement("div");
      e.className = "hidempty";
      e.textContent = "Nothing hidden. Drag here, or use the eye, to park something.";
      hz.appendChild(e);
    }
    hz.addEventListener("dragover", (ev) => {
      if (!this._drag) return;
      ev.preventDefault(); this._lbClearMarks();
      hz.classList.add("over");
      this._dropAt = { list: "hidden", i: (r.hidden || []).length };
    });
    hz.addEventListener("dragleave", () => hz.classList.remove("over"));
    hz.addEventListener("drop", (ev) => {
      ev.preventDefault(); hz.classList.remove("over"); this._lbDrop();
    });

    wrap.append(list, bar);
    if (this._cardCtx) wrap.appendChild(this._cardPanel());
    wrap.append(ah, tray, hh, hz);
    this._layoutBox.appendChild(wrap);
  },
};


const RE_LIGHT_LISTS = ["light_entities", "landscape_entities", "fan_entities",
                        "bath_fan_entities", "fountain_entities"];
const SAVE_SERVICE = ["shell_command", "charro_write_room"];

const RE_CSS = `
:host{ display:block; }
ha-card{ padding:14px; }
.bar{ display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-bottom:12px; }
.bar .sp{ margin-left:auto; }
select,input,textarea,button{ font:inherit; color:var(--primary-text-color); }
select,input[type=text],textarea{
  background:var(--card-background-color); border:1px solid var(--divider-color);
  border-radius:8px; padding:7px 9px; box-sizing:border-box; max-width:100%;
}
textarea{ width:100%; min-height:280px; resize:vertical;
  font-family:ui-monospace,Menlo,monospace; font-size:12.5px; line-height:1.5; }
button{
  border:none; border-radius:8px; padding:8px 14px; cursor:pointer; font-weight:600;
  background:rgba(127,127,127,.16);
}
button.primary{ background:var(--primary-color); color:var(--text-primary-color,#fff); }
button:disabled{ opacity:.5; cursor:default; }
h4{
  margin:20px 0 8px; font-size:12px; letter-spacing:.08em; text-transform:uppercase;
  color:var(--secondary-text-color); border-bottom:1px solid var(--divider-color);
  padding-bottom:6px;
}
.grid2{
  display:grid; gap:22px; align-items:start;
  grid-template-columns:minmax(240px,.72fr) minmax(330px,.95fr) minmax(300px,.5fr);
}
.grid2.pop{ grid-template-columns:minmax(220px,.6fr) minmax(300px,.8fr) minmax(430px,1.4fr); }
@media (max-width:1280px){
  .grid2, .grid2.pop{ grid-template-columns:minmax(0,1fr) minmax(300px,.8fr); }
}
@media (max-width:820px){ .grid2, .grid2.pop{ grid-template-columns:1fr; } }
.ttl{ font-size:16px; font-weight:600; letter-spacing:-.01em; margin-right:4px; }
.seg{ display:inline-flex; border:1px solid var(--divider-color); border-radius:8px; overflow:hidden; }
.seg button{
  border:none; border-radius:0; padding:5px 12px; font-size:12.5px; font-weight:600;
  background:transparent; color:var(--secondary-text-color);
}
.seg button[aria-pressed="true"]{ background:var(--primary-color); color:var(--text-primary-color,#fff); }
.h4row{ display:flex; align-items:center; gap:8px; margin:20px 0 8px;
  border-bottom:1px solid var(--divider-color); padding-bottom:6px; }
.h4row h4{ margin:0; border:none; padding:0; }
.h4row .n{ font-size:11px; color:var(--secondary-text-color); font-variant-numeric:tabular-nums; }
.h4row button{ margin-left:auto; padding:4px 10px; font-size:12px; font-weight:500; }
.popbox{
  background:var(--ha-card-background, var(--card-background-color));
  border:1px solid var(--divider-color); border-radius:20px; padding:12px;
  box-shadow:0 6px 24px rgba(0,0,0,.22);
}
.popbox > *{ display:block; margin-bottom:8px; }
table{ width:100%; border-collapse:collapse; }
th{
  text-align:left; font-size:11px; letter-spacing:.05em; text-transform:uppercase;
  color:var(--secondary-text-color); font-weight:600; padding:4px 6px;
}
td{ padding:3px 6px; vertical-align:middle; }
td.e{ font-family:ui-monospace,monospace; font-size:12px; color:var(--secondary-text-color);
      max-width:230px; overflow-wrap:anywhere; }
td input[type=text]{ width:100%; padding:5px 7px; font-size:13px; }
.status{ font-size:13px; color:var(--secondary-text-color); min-height:18px; margin-top:10px; }
.foot{
  margin-top:16px; padding-top:10px; border-top:1px solid var(--divider-color);
  font-size:12px; line-height:1.55; color:var(--secondary-text-color);
}
.foot code{
  font-family:ui-monospace,Menlo,monospace; font-size:11.5px;
  background:rgba(127,127,127,.14); padding:1px 5px; border-radius:4px;
}
.status.err{ color:var(--error-color); }
.status.ok{ color:var(--success-color, #2d6a4f); }
.path{ font-family:ui-monospace,monospace; font-size:12px; }
.preview{ position:sticky; top:8px; }
` + LB_CSS;

class CharroRoomsEditor extends HTMLElement {
  static getStubConfig() { return { type: "custom:charro-rooms-editor", rooms: [] }; }

  setConfig(config) {
    this._config = config || {};
    this._keys = (config && config.rooms) || null;   // null = discover
    this._key = null; this._room = null; this._orig = null;
    if (this.shadowRoot) this.shadowRoot.innerHTML = "";
    this._built = false;
    if (this._hass) this._build();
  }
  set hass(h) {
    this._hass = h;
    if (!this._built) this._build();
    if (this._form) this._form.hass = h;
    if (Array.isArray(this._prev)) for (const c of this._prev) c.hass = h;
    else if (this._prev) this._prev.hass = h;
  }
  getCardSize() { return 12; }

  _dir() { return (this._config.rooms_dir || ROOMS_DIR_DEFAULT).replace(/\/*$/, "/"); }
  _path(k) { return `/config/www/${this._dir().replace(/^\/local\//, "")}${k}.json`; }
  _canWrite() {
    const s = this._hass && this._hass.services;
    return !!(s && s[SAVE_SERVICE[0]] && s[SAVE_SERVICE[0]][SAVE_SERVICE[1]]);
  }

  /* ------------------------------------------------------------ chrome -- */
  _build() {
    const root = this.shadowRoot || this.attachShadow({ mode: "open" });
    const style = document.createElement("style"); style.textContent = RE_CSS;
    const card = document.createElement("ha-card");

    const bar = document.createElement("div"); bar.className = "bar";
    if (this._config.title) {
      const t = document.createElement("div");
      t.className = "ttl"; t.textContent = this._config.title;
      bar.appendChild(t);
    }
    this._sel = document.createElement("select");
    this._sel.addEventListener("change", () => this._load(this._sel.value));
    const add = document.createElement("button");
    add.textContent = "Open / new";
    add.title = "Type a room key — opens its file if there is one, otherwise starts a new room";
    add.addEventListener("click", () => this._newRoom());
    this._exp = document.createElement("button");
    this._expanded = false;
    this._exp.textContent = "Expand all";
    this._exp.addEventListener("click", () => {
      this._expanded = !this._expanded;
      this._exp.textContent = this._expanded ? "Collapse all" : "Expand all";
      if (this._form) this._form.schema = this._schema();
    });
    bar.appendChild(this._exp);

    const sp = document.createElement("div"); sp.className = "sp";
    this._revert = document.createElement("button");
    this._revert.textContent = "Revert";
    this._revert.addEventListener("click", () => this._load(this._key, true));
    this._save = document.createElement("button");
    this._save.className = "primary";
    this._save.addEventListener("click", () => this._doSave());
    bar.append(this._sel, add, sp, this._revert, this._save);

    const cols = document.createElement("div"); cols.className = "grid2";
    this._left = document.createElement("div");
    this._mid = document.createElement("div");
    const right = document.createElement("div"); right.className = "preview";
    const prow = document.createElement("div"); prow.className = "h4row";
    const ph = document.createElement("h4"); ph.textContent = "Preview";
    const seg = document.createElement("div"); seg.className = "seg";
    seg.style.marginLeft = "auto";
    this._pmode = "tile";
    for (const [k, label] of [["tile", "Tile"], ["popup", "Pop-up"]]) {
      const b = document.createElement("button");
      b.textContent = label;
      b.setAttribute("aria-pressed", String(k === this._pmode));
      b.addEventListener("click", () => {
        this._pmode = k;
        seg.querySelectorAll("button").forEach((x, i) =>
          x.setAttribute("aria-pressed", String(["tile", "popup"][i] === k)));
        cols.classList.toggle("pop", k === "popup");
        this._renderPreview();
      });
      seg.appendChild(b);
    }
    prow.append(ph, seg);
    this._prevWrap = document.createElement("div");
    right.append(prow, this._prevWrap);
    cols.append(this._left, this._mid, right);

    this._status = document.createElement("div"); this._status.className = "status";
    this._foot = document.createElement("div"); this._foot.className = "foot";

    card.append(bar, cols, this._status, this._foot);
    root.innerHTML = ""; root.append(style, card);
    this._built = true;

    this._saveLabel();
    this._fill();
  }

  async _fill(select) {
    if (!this._keys) {
      this._say("Finding rooms…");
      this._keys = await this._discover();
    }
    this._sel.innerHTML = this._keys.map((k) => `<option value="${k}">${k}</option>`).join("");
    if (!this._keys.length) {
      this._say("No rooms found yet — nothing on a dashboard uses `room:` and there's " +
                "no _index.json. Use Open / new and type a key: if the file already " +
                "exists it opens, otherwise you get a blank room.", "err");
      return;
    }
    this._say("");
    this._load(select || this._keys[0]);
  }

  /* Which rooms exist: every `room:` already placed on a dashboard, plus
   * anything in _index.json, which the save script keeps up to date. A
   * browser can't list a folder, so those two together stand in for it. */
  async _discover() {
    const keys = new Set();
    try {
      const dbs = await this._hass.callWS({ type: "lovelace/dashboards/list" });
      const paths = [null, ...(dbs || []).map((d) => d.url_path)];
      for (const url_path of paths) {
        let cfg;
        try { cfg = await this._hass.callWS({ type: "lovelace/config", url_path }); }
        catch (err) { continue; }               // YAML-mode or no access
        const walk = (o) => {
          if (Array.isArray(o)) return o.forEach(walk);
          if (!o || typeof o !== "object") return;
          if (o.type === "custom:charro-room-card" && typeof o.room === "string")
            keys.add(o.room);
          Object.values(o).forEach(walk);
        };
        walk(cfg);
      }
    } catch (err) { /* older core, or no lovelace access */ }

    try {
      const r = await fetch(`${this._dir()}_index.json?t=${Date.now()}`, { cache: "no-store" });
      if (r.ok) {
        const j = await r.json();
        for (const k of (Array.isArray(j) ? j : (j && j.rooms) || []))
          if (k && !k.startsWith("_")) keys.add(k);
      }
    } catch (err) { /* no index yet */ }

    return [...keys].sort();
  }

  _saveLabel() {
    const w = this._canWrite();
    this._save.textContent = w ? "Save" : "Copy JSON";
    this._save.title = w
      ? `Writes ${this._key ? this._path(this._key) : "the room file"}`
      : "shell_command.charro_write_room isn't configured — this copies instead";
    if (!this._foot) return;
    const path = this._key ? this._path(this._key) : `${this._dir()}&lt;room&gt;.json`;
    this._foot.innerHTML = w
      ? `Saves to <code>${path}</code> through ` +
        `<code>shell_command.charro_write_room</code>. Other cards show the change ` +
        `after a page refresh.`
      : `Copies the JSON for <code>${path}</code> — ` +
        `<code>shell_command.charro_write_room</code> isn't configured, so it can't ` +
        `write the file itself. Other cards show the change after a page refresh.`;
  }
  _say(msg, cls) { this._status.textContent = msg; this._status.className = "status " + (cls || ""); }

  /* -------------------------------------------------------------- load -- */
  async _load(key, quiet) {
    if (!key) return;
    this._key = key; this._sel.value = key;
    this._saveLabel();
    try {
      const url = `${this._dir()}${key}.json?t=${Date.now()}`;
      const r = await fetch(url, { cache: "no-store" });
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      let j = await r.json();
      if (j && !j.room_name && j[key] && typeof j[key] === "object") j = j[key];
      // the editor always wants the template list, so the source dropdown
      // can offer them before a room has any remotes of its own
      j._remotes = await loadRemotes(this._config);
      this._room = j; this._orig = JSON.parse(JSON.stringify(j));
      if (!quiet) this._say("");
      this._renderForm();
    } catch (err) {
      this._room = null;
      this._say(`Could not read ${this._dir()}${key}.json — ${err.message}`, "err");
      this._left.innerHTML = ""; this._prevWrap.innerHTML = "";
    }
  }

  async _newRoom() {
    const key = (prompt("Room key (file name, no .json)") || "").trim()
      .toLowerCase().replace(/[^a-z0-9_-]/g, "");
    if (!key) return;

    this._keys = this._keys || [];
    if (!this._keys.includes(key)) {
      this._keys.push(key); this._keys.sort();
      this._sel.innerHTML = this._keys.map((k) => `<option value="${k}">${k}</option>`).join("");
    }
    this._key = key; this._sel.value = key;
    this._saveLabel();

    // opening beats clobbering: if the file is already there, load it
    try {
      const r = await fetch(`${this._dir()}${key}.json?t=${Date.now()}`, { cache: "no-store" });
      if (r.ok) {
        this._say(`${key}.json already exists — opened it.`);
        return this._load(key, true);
      }
    } catch (err) { /* not there, fall through to a new one */ }

    this._room = { room_name: key.charAt(0).toUpperCase() + key.slice(1),
                   room_icon: "mdi:home", light_entities: [] };
    this._orig = null;
    this._say(`New room — Save writes ${this._path(key)}`);
    this._renderForm();
  }

  /* -------------------------------------------------------------- form -- */
  _renderForm() {
    if (!this._room) return;
    this._left.innerHTML = "";

    // ha-form handles everything except per-light overrides
    this._form = document.createElement("ha-form");
    this._form.hass = this._hass;
    this._form.schema = this._schema();
    this._form.computeLabel = (s) => ROOM_LABELS[s.name] || s.name;
    this._form.computeHelper = (s) => ROOM_HELPERS[s.name] || "";
    this._form.data = this._formData();
    this._form.addEventListener("value-changed", (ev) => {
      ev.stopPropagation();
      this._applyForm(ev.detail.value);
      this._lbRender();
      this._renderLights();
      this._renderPreview();
    });
    this._left.appendChild(this._form);

    this._mid.innerHTML = "";
    this._layoutBox = document.createElement("div");
    this._lightsBox = document.createElement("div");
    this._mid.append(this._layoutBox, this._lightsBox);

    const h2 = document.createElement("h4"); h2.textContent = "Sections";
    const secs = document.createElement("input");
    secs.type = "text"; secs.style.width = "100%";
    secs.placeholder = ROOM_SECTIONS.join(", ");
    secs.value = (this._room.sections || []).join(", ");
    secs.addEventListener("change", () => {
      const v = secs.value.split(",").map((x) => x.trim()).filter(Boolean);
      if (v.length) this._room.sections = v; else delete this._room.sections;
      this._renderPreview();
    });

    const h3 = document.createElement("h4"); h3.textContent = "Extra cards (JSON)";
    const ta = document.createElement("textarea");
    ta.spellcheck = false;
    ta.value = this._room.cards ? JSON.stringify(this._room.cards, null, 2) : "";
    ta.placeholder = '{ "start": [ { "type": "custom:universal-remote-card" } ] }';
    ta.addEventListener("change", () => {
      const t = ta.value.trim();
      if (!t) { delete this._room.cards; this._say(""); this._renderPreview(); return; }
      try { this._room.cards = JSON.parse(t); this._say(""); this._renderPreview(); }
      catch (err) { this._say(`Extra cards: ${err.message}`, "err"); }
    });

    // an expansion panel, to sit with the ha-form groups above it rather
    // than sprawl open under them
    this._videoBox = document.createElement("div");
    let videoHost = this._videoBox;
    if (customElements.get("ha-expansion-panel")) {
      const p = document.createElement("ha-expansion-panel");
      p.header = "Video / remotes";
      p.outlined = true;
      p.leftChevron = false;
      p.expanded = !!this._videoOpen;
      p.addEventListener("expanded-changed", (ev) => {
        this._videoOpen = ev.detail ? ev.detail.expanded : !this._videoOpen;
      });
      const ic = document.createElement("ha-icon");
      ic.icon = "mdi:remote-tv";
      ic.slot = "leading-icon";
      ic.style.cssText = "--mdc-icon-size:22px;color:var(--secondary-text-color)";
      p.append(ic, this._videoBox);
      videoHost = p;
    }

    /* Sections and the raw cards blob still do real work — sections orders
     * and filters the automatic body, and a room can carry cards a layout
     * hasn't been built from yet — but neither is the way you'd reach for
     * now, so they fold away instead of sitting open above the layout. */
    let advanced = document.createElement("div");
    if (customElements.get("ha-expansion-panel")) {
      const p = document.createElement("ha-expansion-panel");
      p.header = "Advanced";
      p.secondary = "Section order, and cards not yet in the layout";
      p.outlined = true;
      p.leftChevron = false;
      p.expanded = !!this._advOpen;
      p.addEventListener("expanded-changed", (ev) => {
        this._advOpen = ev.detail ? ev.detail.expanded : !this._advOpen;
      });
      const ic = document.createElement("ha-icon");
      ic.icon = "mdi:tune"; ic.slot = "leading-icon";
      ic.style.cssText = "--mdc-icon-size:22px;color:var(--secondary-text-color)";
      p.append(ic, h2, secs, h3, ta);
      advanced = p;
    } else {
      advanced.append(h2, secs, h3, ta);
    }

    this._left.append(videoHost, advanced);
    this._renderVideo();
    this._lbEnsure();
    this._lbRender();
    this._renderLights();
    this._renderPreview();
  }

  /* Screens and sources are lists of objects, which ha-form has no good shape
   * for, so they get their own rows: add, fill in, remove. A room with one
   * screen needs no focus select at all, which is the common case. */
  _renderVideo() {
    const box = this._videoBox;
    if (!box) return;
    box.innerHTML = "";
    const v = this._room.video;

    if (!v) {
      const b = document.createElement("button");
      b.textContent = "+ Add video switching";
      b.title = "Screens, their sources, and one remote for whatever is on";
      b.addEventListener("click", () => {
        this._room.video = { displays: [{ name: "TV" }], sources: {} };
        this._renderVideo(); this._renderPreview();
      });
      box.appendChild(b);
      return;
    }

    const changed = () => { this._renderVideo(); this._renderPreview(); };
    const field = (label, value, onChange, placeholder) => {
      const wrap = document.createElement("label");
      wrap.className = "vfield";
      const t = document.createElement("span"); t.textContent = label;
      const i = document.createElement("input");
      i.type = "text"; i.value = value || ""; i.placeholder = placeholder || "";
      i.addEventListener("change", () => { onChange(i.value.trim()); changed(); });
      wrap.append(t, i);
      return wrap;
    };
    /* An entity id is a thing to pick, not a string to remember — HA's own
     * picker searches and validates, and it's registered on a plain dashboard
     * load. Falls back to the text box if a future frontend drops it. */
    const ent = (label, value, domains, onChange, hint) => {
      if (!customElements.get("ha-entity-picker")) return field(label, value, onChange, hint);
      const wrap = document.createElement("div");
      wrap.className = "vfield";
      const t = document.createElement("span"); t.textContent = label;
      const p = document.createElement("ha-entity-picker");
      p.hass = this._hass;
      p.value = value || "";
      p.allowCustomEntity = true;
      if (domains && domains.length) p.includeDomains = domains;
      p.addEventListener("value-changed", (ev) => {
        ev.stopPropagation();
        onChange((ev.detail && ev.detail.value) || "");
        changed();
      });
      wrap.append(t, p);
      return wrap;
    };
    const iconField = (label, value, onChange) => {
      if (!customElements.get("ha-icon-picker")) return field(label, value, onChange, "mdi:television");
      const wrap = document.createElement("div");
      wrap.className = "vfield";
      const t = document.createElement("span"); t.textContent = label;
      const p = document.createElement("ha-icon-picker");
      p.hass = this._hass;
      p.value = value || "";
      p.addEventListener("value-changed", (ev) => {
        ev.stopPropagation();
        onChange(((ev.detail && ev.detail.value) || "").trim());
        changed();
      });
      wrap.append(t, p);
      return wrap;
    };

    // one screen needs no picker; more than one does
    const many = (v.displays || []).length > 1;
    if (many || v.focus) {
      box.appendChild(ent("Screen picker", v.focus, ["input_select", "select"],
        (s) => { if (s) v.focus = s; else delete v.focus; },
        "input_select.saloon_device_select"));
      box.appendChild(field("Its “all off” option", v.off_option,
        (s) => { if (s) v.off_option = s; else delete v.off_option; }, "Off"));
    }

    const dh = document.createElement("div");
    dh.className = "vcap";
    dh.textContent = many ? "Screens" : "Screen";
    box.appendChild(dh);

    (v.displays || []).forEach((d, i) => {
      const row = document.createElement("div");
      row.className = "vrowbox";
      row.appendChild(field("Name", d.name, (s) => { d.name = s; },
        many ? "must match a picker option" : "TV"));
      row.appendChild(iconField("Icon", d.icon,
        (s) => { if (s) d.icon = s; else delete d.icon; }));
      row.appendChild(ent("Source select", d.source, ["input_select", "select"],
        (s) => { if (s) d.source = s; else delete d.source; },
        "input_select.kitchen_media_select"));
      row.appendChild(ent("The screen itself", d.power,
        ["media_player", "switch", "remote"],
        (s) => { if (s) d.power = s; else delete d.power; },
        "media_player.kitchen_samsung_55_2"));
      const x = document.createElement("button");
      x.className = "vdel"; x.textContent = "Remove screen";
      x.addEventListener("click", () => { v.displays.splice(i, 1); changed(); });
      row.appendChild(x);
      box.appendChild(row);
    });

    const addD = document.createElement("button");
    addD.textContent = "+ Screen";
    addD.addEventListener("click", () => {
      (v.displays = v.displays || []).push({ name: "" }); changed();
    });
    box.appendChild(addD);

    const sh = document.createElement("div");
    sh.className = "vcap";
    sh.textContent = "Sources — one row per option in the source select";
    box.appendChild(sh);

    const tpls = Object.keys(this._room._remotes || {});
    for (const [key, spec] of Object.entries(v.sources || {})) {
      const row = document.createElement("div");
      row.className = "vrowbox";
      row.appendChild(field("Option text", key, (s) => {
        if (!s || s === key) return;
        const next = {};
        for (const [k, val] of Object.entries(v.sources)) next[k === key ? s : k] = val;
        v.sources = next;
      }, "SuperBox"));

      const sel = document.createElement("label");
      sel.className = "vfield";
      const st = document.createElement("span"); st.textContent = "Remote template";
      const dd = document.createElement("select");
      for (const t of ["", ...tpls]) {
        const o = document.createElement("option");
        o.value = t; o.textContent = t || "— pick one —";
        if (spec.use === t) o.selected = true;
        dd.appendChild(o);
      }
      dd.addEventListener("change", () => {
        if (dd.value) spec.use = dd.value; else delete spec.use;
        changed();
      });
      sel.append(st, dd);
      row.appendChild(sel);

      row.appendChild(field("Title", spec.title, (s) => {
        if (s) spec.title = s; else delete spec.title; }, key));
      row.appendChild(ent("Remote entity", spec.remote, ["remote"], (s) => {
        if (s) spec.remote = s; else delete spec.remote; }, "remote.charro_superbox"));
      row.appendChild(ent("Media player", spec.media_player, ["media_player"], (s) => {
        if (s) spec.media_player = s; else delete spec.media_player; },
        "media_player.charro_superbox"));
      row.appendChild(ent("Volume goes to", spec.volume, ["media_player"], (s) => {
        if (s) spec.volume = s; else delete spec.volume; },
        "the screen's own media_player"));

      const x = document.createElement("button");
      x.className = "vdel"; x.textContent = "Remove source";
      x.addEventListener("click", () => { delete v.sources[key]; changed(); });
      row.appendChild(x);
      box.appendChild(row);
    }

    const addS = document.createElement("button");
    addS.textContent = "+ Source";
    addS.addEventListener("click", () => {
      v.sources = v.sources || {};
      let n = "New source", i = 2;
      while (v.sources[n]) n = `New source ${i++}`;
      v.sources[n] = {};
      changed();
    });
    const rm = document.createElement("button");
    rm.className = "vdel";
    rm.textContent = "Remove video switching";
    rm.addEventListener("click", () => { delete this._room.video; changed(); });
    box.append(addS, rm);
  }

  _schema() {
    return ROOM_SCHEMA
      .filter((f) => !["room", "mode"].includes(f.name))
      .map((f) => (f.type === "expandable" ? { ...f, expanded: this._expanded } : f));
  }

  _formData() {
    const d = { ...this._room };
    for (const k of RE_LIGHT_LISTS) if (d[k]) d[k] = lightIds(d[k]);
    delete d.cards; delete d.sections;
    return d;
  }

  /* ha-form hands back plain ids — keep the name/icon/dim overrides */
  _applyForm(value) {
    const keep = {};
    for (const k of RE_LIGHT_LISTS)
      for (const l of this._room[k] || [])
        if (l && typeof l === "object" && l.entity) keep[l.entity] = l;
    const next = { ...this._room, ...value };
    for (const k of RE_LIGHT_LISTS) {
      if (!Array.isArray(next[k])) continue;
      next[k] = next[k].map((e) => (typeof e === "string" ? keep[e] || e : e));
      if (!next[k].length) delete next[k];
    }
    for (const k of Object.keys(next))
      if (next[k] === "" || next[k] === undefined) delete next[k];
    this._room = next;
    this._lbSync();
  }

  /* A light added or removed in the form has to show up in a custom layout,
   * or the form and the layout quietly disagree about what the room holds. */
  _lbSync() {
    const r = this._room;
    if (!Array.isArray(r.layout) || !r.layout.length) return;
    r.hidden = r.hidden || [];
    const placed = new Set(this._lbAll().map(x => x && x.entity).filter(Boolean));
    const all = [];
    for (const [, key] of LIGHT_GROUPS) for (const l of r[key] || []) all.push(lightId(l));
    // anything new shows up in Available rather than silently landing at the end
    const live = new Set(all);
    const keep = (arr) => arr.filter(x => !x || !x.entity || live.has(x.entity));
    r.layout = keep(r.layout);
    for (const g of r.layout) if (g && g.group !== undefined) g.items = keep(g.items || []);
    r.hidden = keep(r.hidden);
  }

  _renderLights() {
    this._lightsBox.innerHTML = "";
    if (this._room && Array.isArray(this._room.layout) && this._room.layout.length) return;
    const rows = [];
    for (const k of RE_LIGHT_LISTS)
      for (const l of this._room[k] || []) rows.push([k, l]);
    if (!rows.length) return;

    const row = document.createElement("div"); row.className = "h4row";
    const h = document.createElement("h4");
    h.textContent = "Per-light name, icon, dimming and counting";
    const n = document.createElement("span"); n.className = "n";
    n.textContent = `${rows.length} total`;
    const hide = document.createElement("button");
    hide.textContent = this._lightsHidden ? "Show" : "Hide";
    hide.addEventListener("click", () => {
      this._lightsHidden = !this._lightsHidden;
      hide.textContent = this._lightsHidden ? "Show" : "Hide";
      tbl.hidden = this._lightsHidden;
    });
    row.append(h, n, hide);
    const tbl = document.createElement("table");
    tbl.hidden = !!this._lightsHidden;
    tbl.innerHTML =
      "<thead><tr><th>Entity</th><th>Name</th><th>Icon</th><th>Dims</th>" +
      "<th title=\"Off for a group whose members are also listed\">Counts</th></tr></thead>";
    const tb = document.createElement("tbody");

    for (const [list, l] of rows) {
      const id = lightId(l);
      const obj = typeof l === "object" ? l : { entity: id };
      const st = this._hass.states[id];
      const tr = document.createElement("tr");

      const te = document.createElement("td"); te.className = "e"; te.textContent = id;
      const tn = document.createElement("td");
      const nm = document.createElement("input"); nm.type = "text";
      nm.value = obj.name || "";
      nm.placeholder = (st && st.attributes.friendly_name) || id;
      const ti = document.createElement("td");
      const ic = document.createElement("input"); ic.type = "text";
      ic.value = obj.icon || ""; ic.placeholder = "mdi:…";
      const td = document.createElement("td");
      const sw = document.createElement("ha-switch");
      sw.checked = obj.dim !== false;
      // a group and its members are the same bulbs twice
      const tc = document.createElement("td");
      const cw = document.createElement("ha-switch");
      cw.checked = obj.count !== false;
      cw.title = "Counted in the room's light chip";

      const write = () => {
        const next = { entity: id };
        if (nm.value.trim()) next.name = nm.value.trim();
        if (ic.value.trim()) next.icon = ic.value.trim();
        if (!sw.checked) next.dim = false;
        if (!cw.checked) next.count = false;
        const arr = this._room[list];
        const i = arr.findIndex((x) => lightId(x) === id);
        arr[i] = Object.keys(next).length > 1 ? next : id;
        this._renderPreview();
      };
      nm.addEventListener("change", write);
      ic.addEventListener("change", write);
      sw.addEventListener("change", write);
      cw.addEventListener("change", write);

      tn.appendChild(nm); ti.appendChild(ic); td.appendChild(sw); tc.appendChild(cw);
      tr.append(te, tn, ti, td, tc);
      tb.appendChild(tr);
    }
    tbl.appendChild(tb);
    this._lightsBox.append(row, tbl);
  }

  async _renderPreview() {
    if (!this._room) return;
    try {
      const helpers = await window.loadCardHelpers();
      this._prevWrap.innerHTML = "";

      if (this._pmode === "popup") {
        const box = document.createElement("div");
        box.className = "popbox";
        const hd = document.createElement("div");
        hd.style.cssText = "display:flex;align-items:center;gap:10px;margin:2px 4px 12px";
        if (this._room.room_icon) {
          const ic = document.createElement("ha-icon");
          ic.icon = this._room.room_icon;
          ic.style.color = "var(--secondary-text-color)";
          hd.appendChild(ic);
        }
        const t = document.createElement("div");
        t.style.cssText = "font-size:19px;font-weight:600;letter-spacing:-.01em";
        t.textContent = this._room.room_name || "";
        hd.appendChild(t);
        box.appendChild(hd);
        this._prev = await renderBody(roomBody(this._room, this._hass), this._hass, box);
        this._prevWrap.appendChild(box);
        return;
      }

      const el = helpers.createCardElement({
        type: "custom:charro-room-card", popup: false, ...this._room });
      el.hass = this._hass;
      this._prevWrap.appendChild(el);
      this._prev = el;
    } catch (err) {
      this._prevWrap.textContent = String(err && err.message ? err.message : err);
    }
  }

  /* -------------------------------------------------------------- save -- */
  async _doSave() {
    if (!this._room || !this._key) return;
    const save = { ...this._room };
    delete save._remotes;                       // fetched, not part of the file
    const json = JSON.stringify(save, null, 2);

    if (this._canWrite()) {
      try {
        const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(json)));
        await this._hass.callService(SAVE_SERVICE[0], SAVE_SERVICE[1],
                                     { name: this._key, payload: b64 });
        this._orig = JSON.parse(json);
        _roomFiles.clear();               // the revision moved; drop the old URLs
        _indexP = null;                   // and re-read it
        this._say(`Saved to ${this._path(this._key)} — hard-refresh to see it elsewhere.`, "ok");
      } catch (err) {
        this._say(`Save failed: ${err.message}`, "err");
      }
      return;
    }

    try {
      await navigator.clipboard.writeText(json);
      this._say(`Copied. Paste into ${this._path(this._key)}`, "ok");
    } catch (err) {
      const ta = document.createElement("textarea");
      ta.value = json; ta.style.width = "100%"; ta.style.minHeight = "220px";
      this._say(`Copy this into ${this._path(this._key)}`);
      this._status.appendChild(ta);
      ta.select();
    }
  }
}
Object.assign(CharroRoomsEditor.prototype, LayoutUI);
customElements.define("charro-rooms-editor", CharroRoomsEditor);

/* ------------------------------------------------------------ registry -- */

window.customCards = window.customCards || [];
window.customCards.push(
  { type: "charro-room-card", name: "Charro Room Card",
    description: "Room summary — lights, fans, climate, music, door alert.", preview: false },
  { type: "charro-security-card", name: "Charro Security Tile",
    description: "Elk zone or garage door, coloured client-side.", preview: false },
  { type: "charro-zone-card", name: "Charro Zone Card",
    description: "RTI AD-8x single-line zone control.", preview: false },
  { type: "charro-all-off-card", name: "Charro All Zones Off",
    description: "Turn every RTI zone off on both amps.", preview: false },
  { type: "charro-lights-card", name: "Charro Lights Card",
    description: "One room of lights — equal rows, dim by dragging the row.", preview: false },
  { type: "charro-rooms-editor", name: "Charro Rooms Editor",
    description: "Edit the files behind `room:` without leaving Home Assistant.", preview: false }
);
