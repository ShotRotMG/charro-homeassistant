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

const VERSION = "4.68.0";
console.info(
  `%c CHARRO CARDS %c ${VERSION} `,
  "color:#fff;background:#4caf50;font-weight:700",
  "color:#4caf50;background:#fff"
);

/* ------------------------------------------------------------- helpers -- */

const TEMPLATE_BASE = new URL("templates/", import.meta.url).href;

/* Whatever revision this bundle was loaded with — `?v=<version>.<mtime>` from
 * the integration, `?hacstag=…` from a Lovelace resource. The templates ship
 * next to the bundle and change only when it does, so reusing its revision
 * makes them cacheable: Home Assistant serves both with a 31-day max-age, and
 * a new release changes the URL. Before this they were fetched `no-store` on
 * every page load, which for room-card.json is ~54 KB on the critical path of
 * every card. With no revision to borrow there is nothing safe to cache
 * against, so those fall back to always-fresh. */
const ASSET_REV = (() => {
  try {
    const q = new URL(import.meta.url).search;
    return q ? q.slice(1) : "";
  } catch (err) { return ""; }
})();

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
  const base = override || TEMPLATE_BASE + name;
  const sep = base.includes("?") ? "&" : "?";
  const url = ASSET_REV ? `${base}${sep}${ASSET_REV}` : `${base}${sep}t=${Date.now()}`;
  if (!_templates.has(url)) {
    const p = fetch(url, ASSET_REV ? {} : { cache: "no-store" })
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status} ${r.statusText} for ${base}`);
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
    this._tplP = this._loadTpl(config);
    this.innerHTML = "";
    if (this._hass) this._build();
  }

  set hass(hass) {
    this._hass = hass;
    if (this._card) this._card.hass = hass;
    else this._build();
  }

  /* The template is wanted the moment the view builds the card, not when
   * `hass` first arrives — starting it here overlaps the fetch with the rest
   * of the dashboard coming up instead of queueing behind it. */
  _loadTpl(config) {
    /* Home Assistant calls setConfig before it sets hass, so a card whose
     * template depends on entity state can't choose one yet. Returning null
     * defers to _build, which runs with hass and picks correctly - starting
     * the fetch early is only worth it when the answer can't change. */
    if (!this._hass && this.templateNeedsHass()) return null;
    const name = this.templateName();
    if (!name && !(config && config.template_url)) return null;
    return loadTemplate(name, config && config.template_url).catch(() => null);
  }

  /* Subclasses override when templateName() reads hass. */
  templateNeedsHass() { return false; }

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
        // _loadTpl swallows the error so an early rejection can't go unhandled;
        // a null means refetch here and let this one surface properly.
        (this._tplP || Promise.resolve(null)).then(
          (t) => t || loadTemplate(this.templateName(), this._config.template_url)),
        window.loadCardHelpers(),
      ]);
      /* Shallow, not a deep clone: only top-level keys are touched below, and
       * button-card copies the config it is handed. Deep-cloning the room
       * template once per tile was ~54 KB of structured clone per card. */
      const cfg = { ...tpl };
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
  def(tag, Editor);
}

/* ==================================================== ROOM: SHARED CONFIG = */
/*
 * A room can be defined once, in a file the cards fetch, instead of three
 * times across the tile, the pop-up and the subview page:
 *
 *   type: custom:charro-room-card      # the tile, and it owns pop-up #master
 *   room: master                     # -> /config/charro_rooms/master.json
 *
 *   type: custom:charro-room-card      # the same room as a full page
 *   mode: page
 *   room: master
 *
 * One file per room, under /config/charro_rooms/ — not in this repo, since
 * HACS replaces dist/ on every update and your rooms are your data. They are
 * deliberately not under www: that is served at /local with no auth at all.
 * The cards read them over the websocket instead. Keys match the
 * card's own option names, so anything set on the card overrides the file.
 *
 * Note that /local/ is served without authentication. A room file holds entity
 * ids and layout, never secrets — keep it that way.
 */

/* Registering a tag twice throws, and that would take the rest of the file
 * down with it. The bundle can legitimately arrive twice — a leftover
 * Lovelace resource alongside the integration, say — so every define goes
 * through here and the first copy loaded wins. */
function def(tag, cls) {
  if (customElements.get(tag)) return;
  customElements.define(tag, cls);
}

/* Every room, fetched once per page over the websocket.
 *
 * These files used to live in /config/www and be fetched from /local, which
 * Home Assistant serves with no authentication whatsoever - a map of the
 * house, entity by entity, to anyone who could reach the instance. They now
 * come over the connection the dashboard already has open and already
 * authenticated, in a single message, which also retires the index fetch,
 * the per-room fetch and the whole revision-stamping scheme that existed
 * only to make an aggressively cached /local look fresh.
 */

let _allP = null;
let _versionTold = false;

/* A browser can end up running an older bundle than the one installed - Home
 * Assistant precaches its app shell, and a shell cached before an update
 * keeps pointing at the copy it knew about. That used to be invisible: the
 * cards were simply the wrong ones, or missing, with nothing anywhere saying
 * why. The server states which version it expects, so say so plainly once.
 */
function checkVersion(server, hass) {
  if (_versionTold || !server || server === VERSION) return;
  _versionTold = true;
  const msg = `Charro Cards: this browser is running ${VERSION}, but ` +
    `${server} is installed. Hard-refresh the page — or reset the frontend ` +
    `cache in the companion app — to pick it up.`;
  console.warn(`%c CHARRO CARDS %c stale `,
               "color:#fff;background:#ff9800;font-weight:700",
               "color:#ff9800;background:#fff", msg);
  try {
    const ha = document.querySelector("home-assistant");
    if (ha) fireEvent(ha, "hass-notification", { message: msg });
  } catch (err) { /* a toast is a nicety; the console line is the record */ }
}

function loadAll(hass) {
  if (!_allP) {
    _allP = hass.callWS({ type: "charro/get_rooms" })
      .then((d) => {
        checkVersion(d && d.version, hass);
        return { rooms: (d && d.rooms) || {}, remotes: (d && d.remotes) || {} };
      })
      .catch((err) => { _allP = null; throw err; });   // let the next card retry
  }
  return _allP;
}

/* After a save: the next card to ask gets the new copy. */
function invalidateRooms() { _allP = null; }

function loadRoom(key, hass) {
  return loadAll(hass).then(({ rooms }) => {
    const r = rooms[key];
    if (!r || typeof r !== "object")
      throw new Error(`no room "${key}" — add it in the Rooms sidebar`);
    return r;
  });
}

function loadRemotes(hass) {
  return loadAll(hass).then(({ remotes }) => remotes).catch(() => ({}));
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
/* There are two places a light can be told not to count, because there are
 * two objects describing it: the entity-list entry (`count: false` in
 * light_entities) and the layout item the editor's counter button writes to.
 * They are different objects, so for a room with a custom layout the button
 * in the tray had no effect on the chip at all. Both are honoured here
 * rather than kept in step, which would only have been one more thing to
 * drift. */
function uncountedIds(r) {
  const out = new Set();
  const walk = (items) => {
    for (const it of items || []) {
      if (!it || typeof it !== "object") continue;
      if (it.group !== undefined) { walk(it.items); continue; }
      if (it.entity && it.count === false) out.add(it.entity);
    }
  };
  walk(r && r.layout);
  walk(r && r.hidden);
  return out;
}

/* The entries of r[key] that the chip should count. Pass `skip` when doing
 * several lists at once so the layout is only walked once. */
function countedList(r, key, skip) {
  const s = skip || uncountedIds(r);
  return ((r && r[key]) || []).filter((e) => counted(e) && !s.has(lightId(e)));
}

const countedIds = (r, key, skip) =>
  countedList(r, key, skip).map(lightId).filter(Boolean);

const RENDER_KINDS = { mushroom: "Mushroom", tile: "Tile", hue: "Hue-style" };

/* The light groups aren't all lights. Ceiling fans here are Lutron dimmers in
 * the light domain, but a real fan, a plain switch or a valve can sit in the
 * same list — so pick the card by domain rather than by which list it came
 * from, and a `fan.` entity dropped into Fans behaves like the rest. */
/* Which entities this room treats as fans, whatever domain they live in.
 * A Lutron ceiling fan is a dimmer in the light domain, so it renders as a
 * light and takes the light's amber - while its chip is green, because the
 * chip goes by the list it came from. The body should agree with the chip. */
function fanIdSet(r) {
  return new Set([
    ...lightIds((r && r.fan_entities) || []),
    ...lightIds((r && r.bath_fan_entities) || []),
  ]);
}

/* Mushroom's own name for the colour its fan card and the fan chip use. It
 * only lands while the entity is on: shape-icon switches to its disabled
 * palette otherwise, so an off fan stays grey with no state handling here. */
const FAN_COLOR = "green";

function lightCard(l, noDim, fans) {
  const id = lightId(l);
  const o = typeof l === "object" && l ? l : {};
  const dims = o.dim !== undefined ? o.dim : !(noDim || []).includes(id);
  const domain = String(id || "").split(".")[0];
  // an explicit colour on the entry wins; otherwise fans go green
  const color = o.color || ((fans && fans.has(id)) ? FAN_COLOR : null);

  if (o.render === "tile") {
    const card = { type: "tile", entity: id, vertical: false };
    if (color) card.color = color;
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
  // mushroom-fan-card is already this colour; the light and entity cards
  // need telling, and neither shows it while the entity is off
  if (color && card.type !== "custom:mushroom-fan-card") card.icon_color = color;
  if (o.name) card.name = o.name;
  if (o.icon) card.icon = o.icon;
  return card;
}

/* Body of a room, shared by the pop-up and the page. Each block appears only
 * if the room actually defines those entities, so no room needs its own
 * layout. `cards` drops raw Lovelace into a named slot for the one-offs. */
const ROOM_SECTIONS = ["climate", "video", "media", "music", "lights", "water",
                       "gates", "cameras", "security"];

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
 * Templates live beside the rooms, in _remotes.json, and arrive with them in
 * the same websocket message - see loadRemotes up top. {{key}} inside a
 * template is replaced from the room's entry; a string that is exactly
 * {{key}} takes the value's own type, so numbers and lists survive.
 */

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

/* Pool and spa, and the scripts that actually drive them. A Pentair has
 * modes the switches can't express — "turn the spa on" is a script, and
 * "turn the whole thing off" is another — so a room can list actions, each
 * shown only while it's the one worth pressing. The heaters follow their
 * pump: a heater panel for a pump that's off is just a dead control. */
function waterPart(r, kind) {
  const pool = kind === "pool";
  return { sw: pool ? r.pool_switch : r.spa_switch,
           heater: pool ? r.pool_heater : r.spa_heater,
           name: (pool ? r.pool_name : r.spa_name) || (pool ? "Pool" : "Spa"),
           icon: pool ? "mdi:pool" : "mdi:hot-tub" };
}

function pumpCard(r, kind) {
  const p = waterPart(r, kind);
  if (!p.sw) return null;
  return { type: "tile", entity: p.sw, name: p.name, icon: p.icon,
           vertical: false, features_position: "bottom" };
}

/* A heater panel for a pump that's off is a dead control, so it follows
 * its pump rather than sitting there greyed out. */
function heaterCard(r, kind) {
  const p = waterPart(r, kind);
  if (!p.heater) return null;
  const card = { type: "thermostat", entity: p.heater, name: `${p.name} heater`,
                 features: [{ type: "water-heater-operation-modes" }] };
  if (!p.sw) return card;
  return { type: "conditional",
           conditions: [{ condition: "state", entity: p.sw, state: "on" }],
           card };
}

/* A Pentair has modes the switches can't express — "turn the spa on" is a
 * script, and "turn the whole thing off" is another — so each action is
 * shown only while it's the one worth pressing. */
function waterActionCard(a, r) {
  const run = a && (a.perform_action || a.script);
  if (!run) return null;
  const act = { action: "perform-action", perform_action: run, target: a.target || {} };
  const card = { type: "tile", entity: a.entity || r.spa_switch || r.pool_switch,
                 name: a.name || run, icon: a.icon || "mdi:play", hide_state: true,
                 vertical: false, tap_action: act, icon_tap_action: act };
  if (a.color) card.color = a.color;

  const on = (e) => ({ condition: "state", entity: e, state: "on" });
  const any = [].concat(a.when_on || []);
  const conds = [].concat(a.when_off || [])
    .map((e) => ({ condition: "state", entity: e, state: "off" }));
  if (any.length === 1) conds.push(on(any[0]));
  else if (any.length) conds.push({ condition: "or", conditions: any.map(on) });

  return conds.length ? { type: "conditional", conditions: conds, card } : card;
}

const waterAction = (r, name) =>
  (r.water_actions || []).find((a) => (a.name || a.script || a.perform_action) === name);

function waterCards(r) {
  const out = [];
  const pumps = ["pool", "spa"].map((k) => pumpCard(r, k)).filter(Boolean);
  if (pumps.length) {
    out.push({ type: "grid", columns: pumps.length > 1 ? 2 : 1,
               square: false, cards: pumps });
  }
  for (const k of ["pool", "spa"]) {
    const h = heaterCard(r, k);
    if (h) out.push(h);
  }
  for (const a of r.water_actions || []) {
    const c = waterActionCard(a, r);
    if (c) out.push(c);
  }
  return out;
}

/* `visibility` is handled by Home Assistant's own card wrapper, not by the
 * card — so a hand-written card we instantiate ourselves ignores it and shows
 * regardless. A `conditional` card does the same job from the inside, and
 * takes the same conditions, so translate rather than silently show. */
function asConditional(card) {
  if (!card || !card.visibility) return card;
  const inner = { ...card };
  const conditions = inner.visibility;
  delete inner.visibility;
  return { type: "conditional", conditions, card: inner };
}

/* A gate is a button, not a door: pressing it pulses a relay and there's
 * nothing to read back, so the tile's state is the last time it was opened.
 * `press` is whatever actually opens it — the relay button, or a script that
 * does more than pulse — and `confirm` guards the ones you don't want opened
 * by a mis-tap, which outdoors is most of them. */
function gateCard(g, r) {
  const o = typeof g === "object" && g ? g : {};
  const id = o.entity || (typeof g === "string" ? g : "");
  const run = o.press || o.script || o.button || id;
  if (!run) return null;

  const domain = String(run).split(".")[0];
  const service = domain === "script" ? "script.turn_on"
                : domain === "scene" ? "scene.turn_on"
                : domain === "button" ? "button.press"
                : domain === "cover" ? "cover.open_cover"
                : "homeassistant.turn_on";
  const act = { action: "perform-action", perform_action: service,
                target: { entity_id: run } };
  if (o.confirm) {
    act.confirmation = { text: o.confirm === true
      ? `Open ${o.name || "the gate"}?` : String(o.confirm) };
  }

  const card = {
    type: "tile",
    entity: o.state || id || run,
    name: o.name || "Gate",
    icon: o.icon || "mdi:gate",
    vertical: false,
    features_position: "bottom",
    tap_action: act,
    icon_tap_action: act,
  };
  if (o.hold) {
    card.hold_action = { action: "perform-action",
                         perform_action: String(o.hold).split(".")[0] === "script"
                           ? "script.turn_on" : "button.press",
                         target: { entity_id: o.hold } };
  }
  return card;
}

const gateAt = (r, name) => (r.gates || []).find(
  (g) => (typeof g === "object" ? g.name : g) === name);

/* A garage door is worth telling apart from a window sensor: it's the one
 * you'd want to know about from across the house. Explicit `garage: true`
 * wins; otherwise a cover that says it's a garage door is one. */
function isGarage(entry, hass) {
  const o = typeof entry === "object" && entry ? entry : {};
  if (o.garage !== undefined) return !!o.garage;
  const id = o.entity || (typeof entry === "string" ? entry : "");
  if (!id) return false;
  if (!id.startsWith("cover.")) return false;
  const st = hass && hass.states && hass.states[id];
  return !!(st && st.attributes && st.attributes.device_class === "garage");
}

const garageSensors = (r, hass) =>
  (r.alert_sensors || []).filter((e) => isGarage(e, hass));
const plainSensors = (r, hass) =>
  (r.alert_sensors || []).filter((e) => !isGarage(e, hass));

/* A door is more than an entity id: a garage needs the button that operates
 * it and the sensor that says the opener isn't lying. An alert_sensors entry
 * can carry those, the same way a light can carry its name and icon. */
function securityCard(s, r) {
  const o = typeof s === "object" && s ? s : {};
  const id = o.entity || (typeof s === "string" ? s : "");
  const card = { type: "custom:charro-security-card", entity: id };
  for (const k of ["label", "icon", "toggle_button", "vehicle_entity", "alert_mode",
                   "confirm_sensor"])
    if (o[k]) card[k] = o[k];
  // the card decides for itself whether the icon operates the door, and the
  // flag is how a room overrides that guess either way
  if (o.garage !== undefined) card.garage = !!o.garage;
  // the room's guard is for its garage doors; an entry door alongside them
  // isn't on that circuit, so `confirm_sensor: false` opts out
  if (o.confirm_sensor === false || o.confirm_sensor === null) delete card.confirm_sensor;
  else if (!card.confirm_sensor && r && r.confirm_sensor)
    card.confirm_sensor = r.confirm_sensor;
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
  if (name === "gates" && (r.gates || []).length) {
    const cards = r.gates.map((g) => gateCard(g, r)).filter(Boolean);
    if (cards.length) {
      push({ type: "grid", columns: cards.length > 1 ? 2 : 1, square: false, cards });
    }
  }

  if (name === "water") for (const c of waterCards(r)) push(c);

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
  const fans = fanIdSet(r);
  const extra = r.cards || {};
  const out = [];
  const push = (c) => { if (c) out.push(c); };

  for (const c of extra.start || []) push(asConditional(c));
  for (const name of order) {
    if (name === "lights") {
      const groups = LIGHT_GROUPS
        .map(([label, key]) => [label, r[key]])
        .filter(([, l]) => (l || []).length);
      for (const [label, list] of groups) {
        if (groups.length > 1)
          push({ type: "heading", heading: label, heading_style: "subtitle" });
        push({ type: "grid", columns: 2, square: false,
               cards: list.map((l) => lightCard(l, r.no_dim, fans)) });
      }
    } else {
      for (const c of blockCards(name, r, hass)) push(c);
    }
    for (const c of extra[name] || []) push(asConditional(c));
  }
  for (const c of extra.end || []) push(asConditional(c));
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
  const fans = fanIdSet(r);
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
        out.push({ type: "grid", columns: 1, square: false,
                   cards: [lightCard(it, r.no_dim, fans)] });
      } else {
        run.push(lightCard(it, r.no_dim, fans));
      }
    } else if (it.gate) {
      const c = gateCard(gateAt(r, it.gate), r);
      if (c) {
        if (it.width === "full") { flush(); out.push({ type: "grid", columns: 1, square: false, cards: [c] }); }
        else run.push(c);
      }
    } else if (it.pump) {
      const c = pumpCard(r, it.pump);
      if (c) {
        if (it.width === "full") { flush(); out.push({ type: "grid", columns: 1, square: false, cards: [c] }); }
        else run.push(c);
      }
    } else if (it.heater) {
      const c = heaterCard(r, it.heater);
      if (c) { flush(); out.push(c); }
    } else if (it.water_action) {
      const c = waterActionCard(waterAction(r, it.water_action), r);
      if (c) { flush(); out.push(c); }
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
      if (it.width === "half") run.push(asConditional(it.card));
      else { flush(); out.push(asConditional(it.card)); }
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
    } else if (name === "gates") {
      for (const g of r.gates || [])
        out.push({ gate: typeof g === "object" ? g.name : g });
    } else if (name === "water") {
      for (const k of ["pool", "spa"]) if (pumpCard(r, k)) out.push({ pump: k });
      for (const k of ["pool", "spa"]) if (heaterCard(r, k)) out.push({ heater: k });
      for (const a of r.water_actions || [])
        out.push({ water_action: a.name || a.script || a.perform_action });
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
/* THE chip palette. The tile draws its chips from room-card.json and the
 * pop-up header draws them from roomChips() below, which is two renderers
 * and was two sets of colours: the garage chip sat at 0.22 on the tile and
 * 0.20 in the header, now-playing the other way round, the projector was
 * sky on one and blue on the other, and the thermostat ran a whole set of
 * 0.18 alphas of its own. The template no longer carries any colour: it is
 * handed this object as `variables.pal` and reads it, so there is exactly
 * one place to change a chip colour and no way for the two to disagree. */
const CHIP_PAL = {
  amber:  { bg: "rgba(255,193,7,0.22)",   fg: "var(--state-light-active-color, #ffc107)" },
  green:  { bg: "rgba(76,175,80,0.22)",   fg: "var(--green-color, #4caf50)" },
  blue:   { bg: "rgba(33,150,243,0.22)",  fg: "#2196f3" },
  sky:    { bg: "rgba(3,169,244,0.22)",   fg: "#03a9f4" },
  purple: { bg: "rgba(156,39,176,0.22)",  fg: "#ce93d8" },
  violet: { bg: "rgba(179,136,255,0.22)", fg: "#b388ff" },
  orange: { bg: "rgba(255,152,0,0.22)",   fg: "#ffb74d" },
  red:    { bg: "rgba(244,67,54,0.22)",   fg: "#ef5350" },
  off:    { bg: "transparent",            fg: "var(--disabled-text-color)" },
};

const pal = (name) => [CHIP_PAL[name].bg, CHIP_PAL[name].fg];

/* Card surfaces. Every other template leaves the outer `ha-card` alone, so
 * it picks up whatever the active theme paints — which is the only way a
 * card reads correctly under a theme nobody here has seen. zone-card.json
 * was the exception: it painted its own
 *
 *     background: rgba(var(--rgb-primary-text-color), 0.02)
 *
 * which is a 2% wash of the *text* colour. Under a glass theme that lands
 * on top of the theme's own frosted panel and looks deliberate; under a
 * plain theme there is no panel underneath, so a zone row is a 2% tint over
 * the dashboard's background photo and the labels sit straight on the
 * picture. Dad's complaint, exactly.
 *
 * So the surface is a setting now, and it defaults to deferring to the
 * theme: HA's own card variables, each with the fallback chain that holds
 * when a theme defines none of them. `none` is the old painted-by-hand
 * look, kept so a dashboard that liked it can ask for it back. */
const CARD_SURFACES = {
  card: {
    bg: "var(--ha-card-background, var(--card-background-color, rgba(127,127,127,0.18)))",
    border: "var(--ha-card-border-width, 1px) solid " +
            "var(--ha-card-border-color, var(--divider-color, rgba(127,127,127,0.22)))",
    radius: "var(--ha-card-border-radius, 14px)",
    // not a core variable — glass themes that define it get matched, the
    // rest fall through to none, which is what they already had
    blur: "var(--ha-card-backdrop-filter, none)",
    shadow: "var(--ha-card-box-shadow, none)",
  },
  none: {
    bg: "rgba(var(--rgb-primary-text-color), 0.02)",
    border: "none",
    radius: "14px",
    blur: "none",
    shadow: "none",
  },
};

const cardSurface = (name) => CARD_SURFACES[name] || CARD_SURFACES.card;

const CHIP_AMBER  = pal("amber");
const CHIP_GREEN  = pal("green");
const CHIP_BLUE   = pal("blue");
const CHIP_SKY    = pal("sky");
const CHIP_PURPLE = pal("purple");
const CHIP_VIOLET = pal("violet");
const CHIP_ORANGE = pal("orange");
const CHIP_RED    = pal("red");
/* Elk zones say "Violated"; covers say "open"; binary sensors say "on" */
const OPENISH = ["violated", "on", "open", "opening"];

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

/* The name to show a human. An entry can carry its own; failing that the
 * entity registry has the unprefixed one, and friendly_name is the last
 * resort because Home Assistant prefixes it with the device. */
function entLabel(e, hass, key) {
  const o = typeof e === "object" && e ? e : {};
  const id = lightId(e);
  if (key && o[key]) return o[key];
  if (o.name) return o.name;
  const reg = hass.entities && hass.entities[id];
  if (reg && (reg.name || reg.original_name)) return reg.name || reg.original_name;
  const st = hass.states[id];
  return (st && st.attributes && st.attributes.friendly_name) || id;
}

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
  const skip = uncountedIds(r);

  for (const [key, icon, col, domain, label] of CHIP_GROUPS) {
    const list = r[key] || [];
    if (!list.length) continue;
    const real = countedList(r, key, skip);
    const on = real.filter((e) => {
      const st = hass.states[lightId(e)];
      return st && st.state === "on";
    });
    const n = on.length;
    if (!n) continue;
    /* Naming them is what makes a surprising count answerable: a light the
     * layout never placed still counts, and before this the chip gave you
     * no way to tell which one it meant. */
    const names = on.map((e) => ({ name: entLabel(e, hass) }));
    out.push({ key, icon, col, text: String(n),
               title: `${label} — ${listNames(names)} on. Tap to turn them off.`,
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
    ["projector_entity", "mdi:projector", CHIP_SKY, "Projector"],
    ["receiver_entity", "mdi:audio-video", CHIP_VIOLET, "Receiver"],
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

  // the one you'd want to know about from across the house
  const garages = garageSensors(r, hass);
  if (garages.length) {
    const open = [];
    for (const e of garages) {
      const id = typeof e === "string" ? e : e.entity;
      const st = hass.states[id];
      if (!st || !OPENISH.includes(String(st.state).toLowerCase())) continue;
      const reg = hass.entities && hass.entities[id];
      open.push((typeof e === "object" && e.label)
                || (reg && (reg.name || reg.original_name))
                || (st.attributes && st.attributes.friendly_name) || id);
    }
    if (open.length) {
      out.push({ key: "garage", icon: "mdi:garage-open-variant", col: CHIP_RED,
                 text: open.length > 1 ? String(open.length) : "",
                 title: `${listNames(open.map((n) => ({ name: n })))} open.`,
                 tap: { kind: "more-info",
                        entity: (typeof garages[0] === "string"
                                 ? garages[0] : garages[0].entity) } });
    }
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
    const plain = plainSensors(this.room, this._hass);
    if (plain.length) {
      const { all, bad } = this._sensorState(plain);
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
      const skip = uncountedIds(this.room);
      const lit = onCount(this._hass,
        [].concat(countedList(this.room, "light_entities", skip),
                  countedList(this.room, "landscape_entities", skip)));
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
  _sensorState(list) {
    const hass = this._hass;
    const all = [], bad = [];
    if (!hass || !hass.states) return { all, bad };
    for (const e of list || this.room.alert_sensors || []) {
      // an entry may be a bare id or an object carrying its label
      const id = typeof e === "string" ? e : (e && e.entity);
      const st = id && hass.states[id];
      if (!st) continue;
      const a = st.attributes || {};
      const reg = hass.entities && hass.entities[id];
      const row = {
        entity: id,
        name: (typeof e === "object" && e.label)
              || (reg && (reg.name || reg.original_name)) || a.friendly_name || id,
        violated: OPENISH.includes(String(st.state).toLowerCase()),
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

  /* Closing is normally a history.back(), so the close button and the
   * browser's back button agree and the hash stays the thing in charge.
   *
   * That assumes something is behind the pop-up, which is false whenever the
   * app is opened straight onto one — reopen Home Assistant while a room was
   * showing and it restores the URL hash and all. There the back entry
   * either doesn't exist, so back() silently does nothing and the pop-up
   * can't be closed at all, or it belongs to whatever the tab was showing
   * beforehand, so back() leaves Home Assistant entirely. Both have been
   * seen; the first is what made a reopened pop-up a dead end.
   *
   * _hashDepth counts the pop-up entries this session actually pushed, so
   * back() is only used when there is one of ours to unwind. With none, the
   * hash is dropped where it stands: the pop-up closes, the dashboard is
   * underneath, and nothing navigates. Opening straight to a pop-up keeps
   * working — that is the point — it just stops being a one-way door. */
  dismiss() {
    if (location.hash !== this.hash) { this.close(); return; }
    if (_hashDepth > 0) { history.back(); return; }
    history.replaceState(null, "", location.pathname + location.search);
    _syncHash();
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

/* How many pop-up history entries this page pushed and hasn't walked back
 * out of yet. Only our own pushes count: an entry that was already there
 * when the page loaded is not ours to unwind. */
let _hashDepth = 0;
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

  /* A popstate means one entry was walked back out of — ours or the user's
   * own back button, which should both decrement. It floors at zero so that
   * a forward navigation, which puts back an entry we never counted, can
   * only ever make dismiss() too cautious: it drops the hash in place
   * instead of stepping back. Closing still works; nothing leaves the app. */
  window.addEventListener("popstate", () => {
    if (_hashDepth > 0) _hashDepth--;
  });

  // A tap on a room tile is history.pushState. That fires no hashchange, and
  // the location-changed event it should raise doesn't always reach window —
  // which is why the panel only appeared after a reload. Watch the call.
  for (const m of ["pushState", "replaceState"]) {
    const orig = history[m];
    if (typeof orig === "function" && !orig.__charro) {
      const wrapped = function (...args) {
        const was = location.hash;
        const out = orig.apply(this, args);
        // replaceState swaps the current entry rather than adding one
        if (m === "pushState" && location.hash !== was) _hashDepth++;
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
    this._tplP = this._loadTpl(config);
    // the room arrives over the websocket, so it can't start until `hass`
    // does - _resolve kicks it off, which is the first thing _build awaits
    this._roomP = null;
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
    if (!this._roomP) {
      this._roomP = this._config.room
        ? loadRoom(this._config.room, this._hass)
        : Promise.resolve({});
    }
    const room = await this._roomP;
    if ((room.remotes || this._config.remotes || []).length || room.video)
      room._remotes = await loadRemotes(this._hass);
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
      // the tile's garage chip counts these on its own
      garage_entities: garageSensors(c, this._hass)
        .map((e) => (typeof e === "string" ? e : e.entity)).filter(Boolean),
      tv_entity: c.tv_entity || "",
      projector_entity: c.projector_entity || "",
      receiver_entity: c.receiver_entity || "",
      // the tile's chips read their colours from here, so they cannot drift
      // from the pop-up header's
      pal: CHIP_PAL,
    };
    // a light may be {entity, name, dim} in rooms.json; the tile wants ids
    // the tile's chips both count and switch off, so both skip the doubles
    const skip = uncountedIds(c);
    for (const k of ROOM_LISTS) v[k] = countedIds(c, k, skip);
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
def("charro-room-card", CharroRoomCard);

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
  { name: "page_path", selector: { text: {} } },
  { name: "popup_width", selector: { text: {} } },
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
  { type: "expandable", name: "", title: "Media", icon: "mdi:television", schema: [
    { name: "tv_entity", selector: ent(["media_player"]) },
    { name: "projector_entity", selector: ent(["switch", "media_player", "light"]) },
    { name: "receiver_entity", selector: ent(["media_player"]) },
  ]},
];
const ROOM_LABELS = {
  room: "Room file name, without .json",
  mode: "What to render",
  room_name: "Room name",
  room_icon: "Room icon",
  tile_size: "Tile width on the rooms view",
  popup_hash: "Pop-up hash (blank = from the name)",
  page_path: "Full-page path",
  popup_width: "Pop-up width",
  light_entities: "Lights",
  landscape_entities: "Landscape lights (own chip)",
  fan_entities: "Ceiling fans",
  bath_fan_entities: "Other fans",
  climate_entity: "Thermostat",
  tv_entity: "TV",
  projector_entity: "Projector",
  receiver_entity: "AV receiver",
};
const ROOM_HELPERS = {
  tile_size: 'Ignored if the card in the view sets its own grid_options.',
  popup_hash: 'The card\'s own pop-up, e.g. "#garage-east". Blank derives it from the name.',
  page_path: 'Where the pop-up\'s expand button goes. Blank derives it from the room key.',
  popup_width: 'Overrides the width the column count picks. A number is pixels, or give a CSS length.',
  landscape_entities: "Kept out of the lights count, gets a palm-tree chip.",
  fan_entities: "The Lutron fan dimmers. Gets the ceiling-fan chip.",
  bath_fan_entities: "Everything else that moves air \u2014 exhaust fans, air purifiers, tower fans. Gets its own chip. A fan. entity gets fan controls, a light-domain dimmer gets a speed slider.",
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

  /* The garage template is the one whose icon operates the door. A
   * toggle_button obviously wants it, but so does a plain garage cover: it
   * can be driven directly, so there is nothing to configure and no reason
   * for its icon to do nothing but open more-info. */
  templateName() {
    const c = this._config;
    if (c.toggle_button) return "garage-card.json";
    if (c.garage !== undefined) return c.garage ? "garage-card.json" : "security-card.json";
    return isGarage(c, this._hass) ? "garage-card.json" : "security-card.json";
  }

  /* Only the last branch above looks at the entity's device_class; the other
   * two are answerable from the config alone, so those keep the early fetch. */
  templateNeedsHass() {
    const c = this._config || {};
    return !c.toggle_button && c.garage === undefined;
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
def("charro-security-card", CharroSecurityCard);

makeEditor("charro-security-card-editor", [
  { name: "entity", required: true, selector: ent(["sensor", "binary_sensor", "cover"]) },
  { name: "label", selector: { text: {} } },
  { name: "icon", selector: { icon: {} } },
  { name: "toggle_button", selector: ent(["button", "switch", "script", "cover"]) },
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
  toggle_button: "What the round icon fires. A garage cover doesn't need one — " +
    "it's operated directly. Set it when a separate button works the door.",
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
      surface: cardSurface(c.surface),
    };
  }

  triggers() { return uniq([this._config.source_entity, this._config.volume_entity]); }
  overrides() { return { entity: this._config.entity }; }
  getGridOptions() { return { columns: 12, rows: "auto", min_columns: 6 }; }
}
def("charro-zone-card", CharroZoneCard);

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

    // two screens can both offer "Samsung" and mean different televisions,
    // so a display's own map wins over the room's
    const spec = ((d.sources || {})[src]) || (this._v.sources || {})[src];
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
def("charro-video-card", CharroVideoCard);

makeEditor("charro-zone-card-editor", [
  { name: "entity", required: true, selector: ent(["switch"]) },
  { name: "zone_name", required: true, selector: { text: {} } },
  { name: "source_entity", selector: ent(["select", "input_select"]) },
  { name: "volume_entity", selector: ent(["number", "input_number"]) },
  { name: "volume_step", selector: { number: { min: 1, max: 10, mode: "box" } } },
  { name: "surface", selector: { select: { mode: "dropdown", options: [
      { value: "card", label: "Theme card (reads on any theme)" },
      { value: "none", label: "Faint tint (the old look)" }] } } },
], {
  entity: "Zone power switch",
  zone_name: "Zone name",
  source_entity: "Source select",
  volume_entity: "Volume number",
  volume_step: "Volume step",
  surface: "Row background",
}, {
  entity: "e.g. switch.rti_ad_8x_amp2_saloon_bar_power",
  volume_step: "How much one tap of +/- moves the volume. Hold to repeat.",
  surface: "Theme card borrows the colour, border and shadow the active theme " +
           "gives every other card. Faint tint is the 2% wash this card used to " +
           "paint itself, which disappears on a theme with no panel behind it.",
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
def("charro-all-off-card", CharroAllOffCard);

/* Nothing, drawn deliberately. A grid cell has to be filled by something for
 * the next tile to land in the other column, so a gap is a card that renders
 * no card — no background, no border, no height of its own. */
class CharroGapCard extends HTMLElement {
  setConfig() {}
  set hass(_h) {}
  getCardSize() { return 0; }
  getGridOptions() { return { columns: 6, rows: "auto", min_columns: 3 }; }
}
def("charro-gap-card", CharroGapCard);

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
def("charro-lights-card", CharroLightsCard);

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
def("charro-lights-card-editor", CharroLightsCardEditor);

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
  music: "Music (every zone)", player: "Media player",
  water: "Pool & spa", gates: "Gates", cameras: "Cameras",
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
  /* What the room owns but the layout hasn't placed. A block that IS placed
   * already draws its members, so offering them individually would let you
   * add a second copy of something already on screen. */
  _lbAvail() {
    const r = this._room;
    const all = this._lbAll();
    const placed = new Set(all.map((x) => x && x.entity).filter(Boolean));
    const usedBlocks = new Set(all.map((x) => x && x.block).filter(Boolean));
    const cats = [];

    if (!usedBlocks.has("lights")) {
      for (const [label, key] of LIGHT_GROUPS) {
        const items = (r[key] || [])
          .map((l) => lightId(l))
          .filter((e) => e && !placed.has(e))
          .map((e) => ({ entity: e }));
        if (items.length) cats.push({ label, items });
      }
    }

    const sid = (x) => (typeof x === "string" ? x : (x && x.entity));
    if (!usedBlocks.has("security")) {
      const seen = new Set(all.map((x) => x && sid(x.sensor)).filter(Boolean));
      const sensors = (r.alert_sensors || [])
        .filter((x) => sid(x) && !seen.has(sid(x)))
        .map((x) => ({ sensor: x }));
      if (sensors.length) cats.push({ label: "Door / motion", items: sensors });
    }

    const zid = (z) => (typeof z === "string" ? z : (z && (z.entity || z.power)));
    if (!usedBlocks.has("music")) {
      const seen = new Set(all.map((x) => x && zid(x.zone)).filter(Boolean));
      const zones = (r.music_powers || [])
        .filter((z) => zid(z) && !seen.has(zid(z)))
        .map((z) => ({ zone: z }));
      if (zones.length) cats.push({ label: "Music zones", items: zones });
    }

    if (!usedBlocks.has("gates")) {
      const seenG = new Set(all.map((x) => x && x.gate).filter(Boolean));
      const items = (r.gates || [])
        .map((g) => (typeof g === "object" ? g.name : g))
        .filter((n) => n && !seenG.has(n))
        .map((n) => ({ gate: n }));
      if (items.length) cats.push({ label: "Gates", items });
    }

    if (!usedBlocks.has("water")) {
      const seenW = new Set(all.flatMap((x) => x ? [x.pump && "p:" + x.pump,
        x.heater && "h:" + x.heater, x.water_action && "a:" + x.water_action] : [])
        .filter(Boolean));
      const items = [];
      for (const k of ["pool", "spa"])
        if (pumpCard(r, k) && !seenW.has("p:" + k)) items.push({ pump: k });
      for (const k of ["pool", "spa"])
        if (heaterCard(r, k) && !seenW.has("h:" + k)) items.push({ heater: k });
      for (const a of r.water_actions || []) {
        const n = a.name || a.script || a.perform_action;
        if (n && !seenW.has("a:" + n)) items.push({ water_action: n });
      }
      if (items.length) cats.push({ label: "Pool & water", items });
    }

    // a section is only offered when the room has something to put in it
    const has = {
      climate: () => !!r.climate_entity,
      security: () => (r.alert_sensors || []).length,
      cameras: () => (r.cameras || []).length,
      media: () => !!(r.tv_entity || r.projector_entity || r.receiver_entity || r.remotes),
      music: () => !!((r.music_powers || []).length || r.media_player),
      video: () => !!r.video,
      player: () => !!(r.media_player || r.media_card),
      water: () => !!(r.pool_switch || r.spa_switch || (r.water_actions || []).length),
      gates: () => (r.gates || []).length,
      lights: () => LIGHT_GROUPS.some(([, k]) => (r[k] || []).length),
    };
    const blocks = Object.keys(BLOCK_LABEL)
      .filter((b) => !usedBlocks.has(b))
      .filter((b) => (has[b] ? has[b]() : true))
      .map((b) => ({ block: b }));
    if (blocks.length) cats.push({ label: "Sections", items: blocks });

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
    if (it.gate) {
      const g = gateAt(this._room, it.gate) || {};
      return { icon: g.icon || "mdi:gate", text: it.gate,
               sub: g.press || g.button || g.script || g.entity || "" };
    }
    if (it.pump) {
      const p = waterPart(this._room, it.pump);
      return { icon: p.icon, text: p.name, sub: p.sw };
    }
    if (it.heater) {
      const p = waterPart(this._room, it.heater);
      return { icon: "mdi:thermometer", text: `${p.name} heater`, sub: p.heater };
    }
    if (it.water_action) {
      const a = waterAction(this._room, it.water_action) || {};
      return { icon: a.icon || "mdi:play", text: it.water_action,
               sub: a.script || a.perform_action || "" };
    }
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
        const on = this._counted(it.entity);
        cnt.title = on
          ? "Counted in the chip — click to leave it out (for groups and duplicates)"
          : "Not counted in the chip — click to count it";
        cnt.innerHTML = `<ha-icon icon="${on
          ? "mdi:counter" : "mdi:numeric-0-box-multiple-outline"}"></ha-icon>`;
        if (!on) cnt.style.color = "var(--primary-color)";
        cnt.addEventListener("click", () => {
          this._setCounted(it.entity, !on);
          delete it.count;                 // the placement no longer holds it
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
        || it.sensor || it.pump || it.heater || it.water_action || it.gate) {
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
    const rowEls = [];
    r.layout.forEach((it, i) => {
      const el = it && it.group !== undefined ? this._lbGroup(it, i)
                                             : this._lbRow(it, "layout", i);
      rowEls[i] = el;
      list.appendChild(el);
    });
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
    let panel = null;
    if (this._cardCtx) {
      panel = this._cardPanel();
      const ctx = this._cardCtx;
      const anchor = ctx.key === "layout" && typeof ctx.index === "number"
        ? rowEls[ctx.index] : null;
      if (anchor && anchor.parentNode === list) anchor.after(panel);
      else wrap.insertBefore(panel, bar.nextSibling);
    }
    wrap.append(ah, tray, hh, hz);
    this._layoutBox.appendChild(wrap);
    if (panel) {
      requestAnimationFrame(() => {
        try { panel.scrollIntoView({ block: "center", behavior: "smooth" }); }
        catch (err) { panel.scrollIntoView(); }
      });
    }
  },
};


/* Entity ids that Home Assistant doesn't have.
 *
 * A renamed or deleted entity leaves a tile that renders and does nothing,
 * and nothing anywhere says so - you find out when you press it. Rather than
 * enumerate the thirty-odd keys a room can hang an entity on, this walks the
 * whole config and treats anything shaped like an entity id as one.
 *
 * `{{var}}` and button-card's `[[[ ]]]` are skipped: in a remote template
 * those are blanks a room fills in, not references. So is _remotes itself,
 * which is the shared template library rather than this room's wiring.
 */
const ENTITY_RE = /^[a-z_][a-z0-9_]*\.[a-z0-9_]+$/;

/* A domain is believable if the instance has one, or if it is a core domain
 * that happens to have no entities right now. Anything else - "foo.bar" in a
 * heading, say - isn't an entity reference and isn't worth a warning. */
const CORE_DOMAINS = new Set([
  "light", "switch", "cover", "sensor", "binary_sensor", "climate", "fan",
  "media_player", "remote", "script", "scene", "button", "select", "number",
  "text", "lock", "camera", "vacuum", "valve", "humidifier", "water_heater",
  "automation", "person", "device_tracker", "update", "event", "siren",
  "alarm_control_panel", "input_select", "input_boolean", "input_number",
  "input_text", "input_datetime", "todo", "timer", "counter", "group",
]);

function entityRefs(node, out, path) {
  if (typeof node === "string") {
    if (node.includes("{{") || node.includes("[[[")) return;
    if (ENTITY_RE.test(node)) {
      if (!out.has(node)) out.set(node, new Set());
      out.get(node).add(path || "room");
    }
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => entityRefs(v, out, `${path}[${i}]`));
    return;
  }
  if (!node || typeof node !== "object") return;
  for (const [k, v] of Object.entries(node)) {
    if (k === "_remotes") continue;            // the shared template library
    entityRefs(v, out, path ? `${path}.${k}` : k);
  }
}

function unknownEntities(room, hass) {
  if (!room || !hass || !hass.states) return [];
  const refs = new Map();
  entityRefs(room, refs, "");
  const live = hass.states;
  const seenDomains = new Set(Object.keys(live).map((id) => id.split(".")[0]));
  const out = [];
  for (const [id, paths] of refs) {
    const domain = id.split(".")[0];
    if (!seenDomains.has(domain) && !CORE_DOMAINS.has(domain)) continue;
    if (live[id]) continue;
    out.push({ id, paths: [...paths].sort() });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/* "22 minutes ago" beats a timestamp when you are trying to remember what
 * you broke and roughly when. */
function ago(ts) {
  const sec = Math.max(0, Math.round(Date.now() / 1000 - ts));
  if (sec < 45) return "just now";
  const mins = Math.round(sec / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  const days = Math.round(hrs / 24);
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

const RE_LIGHT_LISTS = ["light_entities", "landscape_entities", "fan_entities",
                        "bath_fan_entities", "fountain_entities"];
/* How a save gets to disk, best available first:
 *   "ws"      the charro integration's websocket command — admin-only, and
 *             the reason nothing has to go in configuration.yaml
 *   "service" shell_command.charro_write_room, the pre-integration path
 *   "copy"    neither is there: hand the JSON to the clipboard
 */
const SAVE_SERVICE = ["shell_command", "charro_write_room"];
const WS_SAVE = "charro/save_room";
const WS_SNAPS = "charro/list_snapshots";
const WS_SNAP = "charro/get_snapshot";
const WS_LIST = "charro/list_rooms";

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
/* Each column scrolls on its own inside a fixed-height workspace, so
 * reaching the bottom of the layout doesn't take the form and the preview
 * with it. Height is the viewport minus HA's header and this card's chrome. */
.grid2{
  display:grid; gap:18px; align-items:stretch;
  grid-template-columns:170px minmax(240px,.72fr) minmax(330px,.95fr) minmax(300px,.5fr);
  height:calc(100vh - 210px); min-height:420px;
}
.grid2.pop{
  grid-template-columns:170px minmax(220px,.6fr) minmax(280px,.8fr) minmax(430px,1.4fr);
}
.colscroll{ overflow-y:auto; overflow-x:hidden; padding-right:6px; min-height:0; }
.colscroll::-webkit-scrollbar{ width:8px; }
.colscroll::-webkit-scrollbar-thumb{
  background:rgba(127,127,127,.34); border-radius:4px;
}
.h4row.sticky, .colscroll > h4:first-child{
  position:sticky; top:0; z-index:2; margin-top:0;
  background:var(--ha-card-background, var(--card-background-color, #fff));
}
/* the room list: what exists, and which one you're in */
.rail{
  overflow-y:auto; min-height:0; display:flex; flex-direction:column; gap:2px;
  border-right:1px solid var(--divider-color); padding-right:8px;
}
.railhd{
  position:sticky; top:0; z-index:2; padding:2px 2px 6px;
  background:var(--ha-card-background, var(--card-background-color, #fff));
  font-size:11px; letter-spacing:.08em; text-transform:uppercase;
  color:var(--secondary-text-color);
}
.railit{
  text-align:left; background:transparent; border:none; cursor:pointer;
  padding:6px 9px; border-radius:7px; font-size:13px; font-weight:500;
  color:var(--primary-text-color); white-space:nowrap; overflow:hidden;
  text-overflow:ellipsis;
}
.railit:hover{ background:rgba(127,127,127,.14); }
.railit.on{ background:var(--primary-color); color:var(--text-primary-color,#fff);
  font-weight:600; }
/* the bar follows you down the page */
.bar{
  position:sticky; top:0; z-index:5; padding:4px 0 10px;
  background:var(--ha-card-background, var(--card-background-color, #fff));
  border-bottom:1px solid var(--divider-color);
}
.warnbox{
  margin:0 0 12px; padding:9px 12px; border-radius:10px; font-size:12.5px;
  background:rgba(255,152,0,.12); border:1px solid rgba(255,152,0,.42);
  max-height:150px; overflow-y:auto;
}
.warnhd{ font-weight:600; margin-bottom:5px; color:var(--primary-text-color); }
.warnrow{ display:flex; gap:10px; align-items:baseline; padding:1px 0; }
.warnrow code{
  font-family:ui-monospace,Menlo,monospace; font-size:11.5px;
  background:rgba(127,127,127,.16); padding:1px 5px; border-radius:4px;
}
.warnwhere{ font-size:11px; color:var(--secondary-text-color); }
.railbad{
  margin-left:auto; min-width:17px; height:17px; padding:0 4px; box-sizing:border-box;
  border-radius:9px; background:rgba(255,152,0,.9); color:#000;
  font-size:10.5px; font-weight:700; line-height:17px; text-align:center;
}
.railit{ display:flex; align-items:center; gap:6px; }
.histwrap{ position:relative; display:inline-block; }
.histbox{
  position:absolute; right:0; top:calc(100% + 6px); z-index:20; min-width:240px;
  max-height:320px; overflow-y:auto; padding:6px;
  background:var(--card-background-color); border:1px solid var(--divider-color);
  border-radius:10px; box-shadow:0 8px 28px rgba(0,0,0,.28);
}
.histhd{ font-size:11px; color:var(--secondary-text-color); padding:4px 8px 6px; }
.histrow{
  display:flex; width:100%; gap:10px; justify-content:space-between;
  align-items:center; background:none; border-radius:6px; padding:7px 8px;
  font-size:13px; font-weight:500; text-align:left;
}
button.histrow:hover{ background:rgba(127,127,127,.16); }
.histsz{ font-size:11px; color:var(--secondary-text-color);
  font-variant-numeric:tabular-nums; }
.autow{ display:inline-flex; align-items:center; gap:6px; font-size:13px;
  color:var(--secondary-text-color); cursor:pointer; }
@media (max-width:1280px){
  .grid2, .grid2.pop{ grid-template-columns:150px minmax(0,1fr) minmax(300px,.8fr); }
  .preview{ display:none; }
}
@media (max-width:820px){
  .grid2, .grid2.pop{ grid-template-columns:1fr; height:auto; }
  .colscroll{ overflow:visible; }
  .rail{ flex-direction:row; flex-wrap:wrap; border-right:none;
    border-bottom:1px solid var(--divider-color); padding:0 0 8px; }
  .railhd{ display:none; }
}
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

/* Sidebar page: HA gives the panel the whole content area, so drop the card
 * chrome and let the workspace take the height the dashboard header used. */
:host(.panelmode) ha-card{
  box-shadow:none; border-radius:0; border:none; background:none;
  padding:6px 16px 16px;
}
:host(.panelmode) .grid2{ height:calc(100vh - 150px); }
:host(.panelmode) .foot{ display:none; }
@media (max-width:820px){
  :host(.panelmode) .grid2{ height:auto; }
}
` + LB_CSS;

class CharroRoomsEditor extends HTMLElement {
  static getStubConfig() { return { type: "custom:charro-rooms-editor", rooms: [] }; }

  setConfig(config) {
    this._config = config || {};
    this._keys = (config && config.rooms) || null;   // null = discover
    this.classList.toggle("panelmode", !!this._config.panel);
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

  _path(k) { return `/config/charro_rooms/${k}.json`; }
  _canWrite() { return this._saveMode() !== "copy"; }

  _saveMode() {
    const h = this._hass;
    const c = h && h.config && h.config.components;
    const has = Array.isArray(c) ? c.includes("charro")
              : c && typeof c.has === "function" ? c.has("charro") : false;
    if (has) return "ws";
    const s = h && h.services;
    if (s && s[SAVE_SERVICE[0]] && s[SAVE_SERVICE[0]][SAVE_SERVICE[1]]) return "service";
    return "copy";
  }

  /* ---------------------------------------------------------- workspace -- */
  _autoOn() {
    if (this._autoMem !== undefined) return this._autoMem;
    try {
      const v = localStorage.getItem("charro-autosave");
      return v === null ? true : v === "1";       // on unless turned off
    } catch (e) { return true; }
  }

  _dirty() {
    if (!this._room) return false;
    const save = { ...this._room };
    delete save._remotes;
    return JSON.stringify(save) !== JSON.stringify(this._orig || {});
  }

  /* Wait for the typing to stop before writing — a keystroke per save would
   * hammer the shell command and race itself. */
  _queueSave() {
    if (!this._autoOn() || !this._canWrite() || !this._key) return;
    clearTimeout(this._autoT);
    this._autoT = setTimeout(() => {
      if (this._autoOn() && this._dirty() && !this._saving) this._doSave(true);
    }, 1500);
  }

  /* The "don't count" flag belongs to the light, not to where it happens to
   * sit. It used to be written on the layout item, which is a different
   * object from the entity-list entry the chips actually count — so the
   * button did nothing at all, and even once that was honoured, dragging an
   * item out and back would have dropped the flag silently. These read and
   * write the entity list, and _migrateCounts moves any old ones across. */
  _countEntry(entity) {
    for (const key of RE_LIGHT_LISTS) {
      const list = this._room && this._room[key];
      if (!Array.isArray(list)) continue;
      const i = list.findIndex((e) => lightId(e) === entity);
      if (i >= 0) return { list, i };
    }
    return null;
  }

  _counted(entity) {
    const at = this._countEntry(entity);
    const e = at && at.list[at.i];
    if (e && typeof e === "object" && e.count === false) return false;
    // an older file may still carry it on the placement
    return !(this._layoutFlagged(entity));
  }

  _layoutFlagged(entity) {
    let hit = false;
    const walk = (items) => {
      for (const it of items || []) {
        if (!it || typeof it !== "object" || hit) continue;
        if (it.group !== undefined) { walk(it.items); continue; }
        if (it.entity === entity && it.count === false) hit = true;
      }
    };
    walk(this._room && this._room.layout);
    walk(this._room && this._room.hidden);
    return hit;
  }

  _setCounted(entity, on) {
    const at = this._countEntry(entity);
    if (!at) return false;
    const cur = at.list[at.i];
    if (on) {
      if (cur && typeof cur === "object") {
        delete cur.count;
        const keys = Object.keys(cur);
        if (keys.length === 1 && keys[0] === "entity") at.list[at.i] = cur.entity;
      }
    } else {
      at.list[at.i] = cur && typeof cur === "object"
        ? { ...cur, count: false } : { entity, count: false };
    }
    return true;
  }

  /* Move any flag an older file kept on its layout item onto the light, so
   * there is one place it lives. Returns how many moved. */
  _migrateCounts() {
    let moved = 0;
    const walk = (items) => {
      for (const it of items || []) {
        if (!it || typeof it !== "object") continue;
        if (it.group !== undefined) { walk(it.items); continue; }
        if (it.entity && it.count === false) {
          if (this._setCounted(it.entity, false)) moved++;
          delete it.count;
        }
      }
    };
    walk(this._room && this._room.layout);
    walk(this._room && this._room.hidden);
    return moved;
  }

  /* The room list as a rail, so switching is one click and you can see what
   * exists — the dropdown hid 20 rooms behind a chevron. */
  _renderRail() {
    if (!this._rail) return;
    this._rail.innerHTML = "";
    const h = document.createElement("div");
    h.className = "railhd"; h.textContent = "Rooms";
    this._rail.appendChild(h);
    for (const k of this._keys || []) {
      const b = document.createElement("button");
      b.className = "railit" + (k === this._key ? " on" : "");
      const name = document.createElement("span");
      name.textContent = k;
      b.appendChild(name);
      const bad = (this._unknownCounts || {})[k];
      if (bad) {
        const n = document.createElement("span");
        n.className = "railbad";
        n.textContent = String(bad);
        n.title = `${bad} entity id${bad > 1 ? "s" : ""} Home Assistant doesn't have`;
        b.appendChild(n);
      }
      b.title = k;
      b.addEventListener("click", () => { if (k !== this._key) this._load(k); });
      this._rail.appendChild(b);
    }
  }

  /* ------------------------------------------------------------ chrome -- */
  _build() {
    const root = this.shadowRoot || this.attachShadow({ mode: "open" });
    const style = document.createElement("style"); style.textContent = RE_CSS;
    const card = document.createElement("ha-card");

    /* The bar stays put: on a long room the save button used to be a
     * thousand pixels below whatever you were editing. */
    const bar = document.createElement("div"); bar.className = "bar";
    if (this._config.title) {
      const t = document.createElement("div");
      t.className = "ttl"; t.textContent = this._config.title;
      bar.appendChild(t);
    }
    this._crumb = document.createElement("div");
    this._crumb.className = "ttl";
    bar.appendChild(this._crumb);

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
    bar.append(add, this._exp);

    const sp = document.createElement("div"); sp.className = "sp";

    /* Autosave is on unless you turn it off, and the choice is remembered
     * per browser. Revert still goes back to the file as it was when the
     * room was opened, not to the last autosave. */
    const auto = document.createElement("label");
    auto.className = "autow";
    const asw = document.createElement("ha-switch");
    asw.checked = this._autoOn();
    asw.addEventListener("change", () => {
      try { localStorage.setItem("charro-autosave", asw.checked ? "1" : "0"); }
      catch (e) { this._autoMem = asw.checked; }
      this._autoMem = asw.checked;
      this._saveLabel();
      if (asw.checked && this._dirty()) this._queueSave();
    });
    const at = document.createElement("span"); at.textContent = "Autosave";
    auto.append(asw, at);

    this._revert = document.createElement("button");
    this._revert.textContent = "Revert";
    this._revert.addEventListener("click", () => this._load(this._key, true));
    /* Autosave writes over the file 1.5s after you stop typing, so the only
     * thing standing between a mis-click and losing a room is this. Every
     * save keeps the version it replaced. */
    this._hist = document.createElement("button");
    this._hist.textContent = "History";
    this._hist.title = "Earlier versions of this room";
    this._hist.addEventListener("click", (ev) => {
      ev.stopPropagation();
      this._toggleHistory();
    });
    this._histBox = document.createElement("div");
    this._histBox.className = "histbox";
    this._histBox.hidden = true;
    const histWrap = document.createElement("div");
    histWrap.className = "histwrap";
    histWrap.append(this._hist, this._histBox);

    this._save = document.createElement("button");
    this._save.className = "primary";
    this._save.addEventListener("click", () => this._doSave());
    bar.append(sp, auto, histWrap, this._revert, this._save);

    /* Three columns that scroll on their own. Reaching row 30 of the layout
     * shouldn't scroll the form and the preview off the top. */
    const cols = document.createElement("div"); cols.className = "grid2";
    this._rail = document.createElement("div"); this._rail.className = "rail";
    this._left = document.createElement("div"); this._left.className = "colscroll";
    this._mid = document.createElement("div"); this._mid.className = "colscroll";
    const right = document.createElement("div"); right.className = "preview colscroll";
    const prow = document.createElement("div"); prow.className = "h4row sticky";
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
    cols.append(this._rail, this._left, this._mid, right);

    this._warn = document.createElement("div");
    this._warn.className = "warnbox";
    this._warn.hidden = true;
    this._status = document.createElement("div"); this._status.className = "status";
    this._foot = document.createElement("div"); this._foot.className = "foot";

    card.append(bar, this._warn, cols, this._status, this._foot);
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
    this._renderRail();
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

    /* With the integration installed the folder can simply be listed, which
     * is the only source here that sees a room nothing references yet. */
    if (this._saveMode() === "ws") {
      try {
        const r = await this._hass.callWS({ type: WS_LIST });
        for (const k of (r && r.rooms) || []) keys.add(k);
      } catch (err) { /* older integration, or not admin */ }
    }

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
      const { rooms } = await loadAll(this._hass);
      for (const k of Object.keys(rooms)) keys.add(k);
      // every room is in hand here, so count the dead ids for all of them at
      // once rather than only noticing when you happen to open one
      const counts = {};
      for (const [k, r] of Object.entries(rooms)) {
        const n = unknownEntities(r, this._hass).length;
        if (n) counts[k] = n;
      }
      this._unknownCounts = counts;
    } catch (err) { /* integration not answering; the dashboard scan stands */ }

    return [...keys].sort();
  }

  _saveLabel() {
    const mode = this._saveMode();
    const w = mode !== "copy";
    const auto = w && this._autoOn();
    this._save.textContent = w ? (auto ? "Save now" : "Save") : "Copy JSON";
    this._save.title = w
      ? `Writes ${this._key ? this._path(this._key) : "the room file"}`
      : "No way to write the file from here — this copies the JSON instead";
    if (!this._foot) return;
    const path = this._key ? this._path(this._key) : "/config/charro_rooms/&lt;room&gt;.json";
    const via = mode === "ws"
      ? "the <code>Charro Cards</code> integration"
      : "<code>shell_command.charro_write_room</code>";
    this._foot.innerHTML = w
      ? `Saves to <code>${path}</code> through ${via}. Other cards show the change ` +
        `after a page refresh.`
      : `Copies the JSON for <code>${path}</code> — neither the <code>Charro Cards</code> ` +
        `integration nor <code>shell_command.charro_write_room</code> is set up, so it ` +
        `can't write the file itself.`;
  }
  _say(msg, cls) { this._status.textContent = msg; this._status.className = "status " + (cls || ""); }

  /* -------------------------------------------------------------- load -- */
  async _load(key, quiet) {
    if (!key) return;
    this._key = key;
    if (this._crumb) this._crumb.textContent = key;
    this._renderRail();
    this._saveLabel();
    try {
      // always from the server, never the copy the cards are holding
      invalidateRooms();
      const { rooms, remotes } = await loadAll(this._hass);
      const j = JSON.parse(JSON.stringify(rooms[key] || {}));
      if (!rooms[key]) throw new Error("no such room");
      // the editor always wants the template list, so the source dropdown
      // can offer them before a room has any remotes of its own
      j._remotes = remotes;
      this._room = j; this._orig = JSON.parse(JSON.stringify(j));
      // after _orig, so the room reads as changed and the move gets saved
      const moved = this._migrateCounts();
      if (!quiet) {
        this._say(moved
          ? `Moved ${moved} "don't count" flag${moved > 1 ? "s" : ""} onto the ` +
            `lights themselves — save to keep it.`
          : "");
      }
      this._renderForm();
      if (moved) this._queueSave();
    } catch (err) {
      this._room = null;
      this._say(`Could not read ${this._path(key)} — ${err.message}`, "err");
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
      this._renderRail();
    }
    this._key = key;
    if (this._crumb) this._crumb.textContent = key;
    this._renderRail();
    this._saveLabel();

    // opening beats clobbering: if the file is already there, load it
    try {
      invalidateRooms();
      const { rooms } = await loadAll(this._hass);
      if (rooms[key]) {
        this._say(`${key}.json already exists — opened it.`);
        return this._load(key, true);
      }
    } catch (err) { /* can't ask; fall through and start a new one */ }

    this._room = { room_name: key.charAt(0).toUpperCase() + key.slice(1),
                   room_icon: "mdi:home", light_entities: [] };
    this._orig = null;
    this._say(`New room — Save writes ${this._path(key)}`);
    this._renderForm();
  }

  /* -------------------------------------------------------------- form -- */
  _renderForm() {
    if (!this._room) return;
    this._renderUnknowns();
    this._renderRail();        // the rail's badge follows what you just fixed
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
    // than sprawl open under them. Each list-of-objects gets its own group,
    // so the left column reads as sections rather than one long form.
    this._videoBox = document.createElement("div");
    this._zoneBox = document.createElement("div");
    this._waterBox = document.createElement("div");
    this._doorsBox = document.createElement("div");
    this._gatesBox = document.createElement("div");

    const videoHost = this._panel("Video / remotes",
      "Screens, their sources, and every remote", "mdi:remote-tv",
      "_videoOpen", this._videoBox);
    const zoneHost = this._panel("Music",
      "Zones, the player, and what each input carries", "mdi:music",
      "_zoneOpen", this._zoneBox);
    const waterHost = this._panel("Pool & water",
      "Pumps, heaters, water features and their scripts", "mdi:pool",
      "_waterOpen", this._waterBox);
    const doorsHost = this._panel("Door / motion alert",
      "Doors, windows, motion, garages — and what opens them", "mdi:door-open",
      "_doorsOpen", this._doorsBox);
    const gatesHost = this._panel("Gates",
      "What opens each one, and whether to ask first", "mdi:gate",
      "_gatesOpen", this._gatesBox);

    /* Sections and the raw cards blob still do real work — sections orders
     * and filters the automatic body, and a room can carry cards a layout
     * hasn't been built from yet — but neither is the way you'd reach for
     * now, so they fold away too. */
    const h5 = document.createElement("h4");
    h5.textContent = "Media player card override (JSON)";
    const mc = document.createElement("textarea");
    mc.spellcheck = false;
    mc.style.minHeight = "120px";
    mc.value = this._room.media_card ? JSON.stringify(this._room.media_card, null, 2) : "";
    mc.placeholder = '{ "type": "media-control", "entity": "media_player.x" }';
    mc.addEventListener("change", () => {
      const t = mc.value.trim();
      if (!t) { delete this._room.media_card; this._say(""); this._renderPreview(); return; }
      try { this._room.media_card = JSON.parse(t); this._say(""); this._renderPreview(); }
      catch (err) { this._say(`Media card: ${err.message}`, "err"); }
    });

    const advBody = document.createElement("div");
    advBody.append(h2, secs, h5, mc, h3, ta);
    const advanced = this._panel("Advanced",
      "Section order, the media card override, and raw cards", "mdi:tune",
      "_advOpen", advBody);

    this._left.append(videoHost, zoneHost, waterHost, doorsHost,
                     gatesHost, advanced);
    this._renderVideo();
    this._renderZonePlayers();
    this._renderWaterActions();
    this._renderDoors();
    this._renderGates();
    this._lbEnsure();
    this._lbRender();
    this._renderLights();
    this._renderPreview();
  }

  /* Six of these panels want the same collapsible shell, so it lives once. */
  _panel(header, secondary, iconName, openKey, body) {
    if (!customElements.get("ha-expansion-panel")) {
      const d = document.createElement("div");
      const h = document.createElement("h4"); h.textContent = header;
      d.append(h, body);
      return d;
    }
    const p = document.createElement("ha-expansion-panel");
    p.header = header;
    if (secondary) p.secondary = secondary;
    p.outlined = true;
    p.leftChevron = false;
    p.expanded = !!this[openKey];
    p.addEventListener("expanded-changed", (ev) => {
      this[openKey] = ev.detail ? ev.detail.expanded : !this[openKey];
    });
    const ic = document.createElement("ha-icon");
    ic.icon = iconName; ic.slot = "leading-icon";
    ic.style.cssText = "--mdc-icon-size:22px;color:var(--secondary-text-color)";
    p.append(ic, body);
    return p;
  }

  /* Remotes that aren't behind a video switcher — a room with one TV and one
   * box. Same specs the `remotes` list takes. */


  /* Which player each amplifier input is carrying. */
  _remotesInto(box) {
    const f = this._fields(() => { this._renderVideo(); this._renderPreview(); });
    const list = this._room.remotes || [];
    const tpls = Object.keys(this._room._remotes || {});

    list.forEach((spec, i) => {
      const row = f.rowBox();
      const sel = document.createElement("div");
      sel.className = "vfield";
      const t = document.createElement("span"); t.textContent = "Remote template";
      const dd = document.createElement("select");
      for (const v of ["", ...tpls]) {
        const o = document.createElement("option");
        o.value = v; o.textContent = v || "— pick one —";
        if (spec.use === v) o.selected = true;
        dd.appendChild(o);
      }
      dd.addEventListener("change", () => {
        if (dd.value) spec.use = dd.value; else delete spec.use;
        this._renderVideo(); this._renderPreview();
      });
      sel.append(t, dd);
      row.appendChild(sel);

      const set = (k) => (v) => { if (v) spec[k] = v; else delete spec[k]; };
      row.appendChild(f.text("Title", spec.title, set("title"), "Javon TV"));
      row.appendChild(f.ent("Media player", spec.media_player, ["media_player"],
        set("media_player")));
      row.appendChild(f.ent("Remote entity", spec.remote, ["remote"], set("remote")));
      row.appendChild(f.ent("Volume goes to", spec.volume, ["media_player"], set("volume")));
      row.appendChild(f.ent("Show it while this is on", spec.when,
        ["media_player", "switch", "remote", "binary_sensor"], set("when")));
      row.appendChild(f.ent("Waking it runs", spec.wake, ["script", "scene", "button"],
        set("wake")));
      row.appendChild(f.text("Off tile name", spec.off_name, set("off_name"), "Javon TV"));
      row.appendChild(f.icon("Off tile icon", spec.off_icon, set("off_icon")));
      row.appendChild(f.del("Remove remote", () => {
        this._room.remotes.splice(i, 1);
        if (!this._room.remotes.length) delete this._room.remotes;
      }));
      box.appendChild(row);
    });

    box.appendChild(f.add("+ Remote", () => {
      (this._room.remotes = this._room.remotes || []).push({});
    }));
  }

  /* The zones, the player, and which player each amplifier input carries —
   * one subject, so one panel. */
  _renderZonePlayers() {
    const box = this._zoneBox;
    if (!box) return;
    box.innerHTML = "";
    const redraw = () => { this._renderZonePlayers(); this._renderPreview(); };
    const f = this._fields(redraw);
    const r = this._room;

    box.appendChild(f.many("Music zone power switches", (r.music_powers || [])
      .map((z) => (typeof z === "string" ? z : (z && (z.entity || z.power)))), ["switch"],
      (v) => { if (v.length) r.music_powers = v; else delete r.music_powers; }));
    const n1 = document.createElement("div");
    n1.className = "vnote";
    n1.textContent = "The chip shows how many of these are on.";
    box.appendChild(n1);

    box.appendChild(f.ent("Media player (hold the chip)", r.music_player,
      ["media_player"], (v) => { if (v) r.music_player = v; else delete r.music_player; }));

    box.appendChild(f.cap("What each amplifier input is carrying"));
    const map = r.zone_players || {};
    for (const [value, entity] of Object.entries(map)) {
      const row = f.rowBox();
      row.appendChild(f.text("Source value", value, (v) => {
        if (!v || v === value) return;
        const next = {};
        for (const [kk, e] of Object.entries(r.zone_players)) next[kk === value ? v : kk] = e;
        r.zone_players = next;
      }, "1"));
      row.appendChild(f.ent("Player on that input", entity, ["media_player"], (v) => {
        if (v) r.zone_players[value] = v; else delete r.zone_players[value];
      }));
      row.appendChild(f.del("Remove input", () => {
        delete r.zone_players[value];
        if (!Object.keys(r.zone_players).length) delete r.zone_players;
      }));
      box.appendChild(row);
    }
    box.appendChild(f.add("+ Input", () => {
      const m = r.zone_players = r.zone_players || {};
      let n = 1;
      while (m[String(n)]) n++;
      m[String(n)] = "";
    }));
  }

  /* The scripts a Pentair needs that its switches can't express. */
  /* The pumps, their heaters, the water features, and the scripts a Pentair
   * needs that its switches can't express. */
  _renderWaterActions() {
    const box = this._waterBox;
    if (!box) return;
    box.innerHTML = "";
    const redraw = () => { this._renderWaterActions(); this._renderPreview(); };
    const f = this._fields(redraw);
    const r = this._room;
    const set = (k) => (v) => { if (v) r[k] = v; else delete r[k]; };

    for (const [cap, sw, nm, ht] of [
      ["Pool", "pool_switch", "pool_name", "pool_heater"],
      ["Spa", "spa_switch", "spa_name", "spa_heater"],
    ]) {
      const row = f.rowBox();
      row.appendChild(f.ent(`${cap} pump`, r[sw], ["switch"], set(sw)));
      row.appendChild(f.text(`${cap} tile name`, r[nm], set(nm), cap));
      row.appendChild(f.ent(`${cap} heater`, r[ht], ["water_heater", "climate"], set(ht)));
      box.appendChild(row);
    }
    const n1 = document.createElement("div");
    n1.className = "vnote";
    n1.textContent = "The heater only shows while its pump is on. "
      + "The chip takes its temperature and warming colour from the heater.";
    box.appendChild(n1);

    box.appendChild(f.many("Water features", lightIds(r.fountain_entities),
      ["switch", "light", "valve"], (v) => this._setLightList("fountain_entities", v)));
    const n2 = document.createElement("div");
    n2.className = "vnote";
    n2.textContent = "Fountain, spill, water wall. One chip with a count; "
      + "tapping turns them all off.";
    box.appendChild(n2);

    box.appendChild(f.cap("Scripts the switches can't express"));
    const list = r.water_actions || [];
    list.forEach((a, i) => {
      const row = f.rowBox();
      const sa = (k) => (v) => { if (v) a[k] = v; else delete a[k]; };
      row.appendChild(f.text("Name", a.name, sa("name"), "Turn Spa On"));
      row.appendChild(f.icon("Icon", a.icon, sa("icon")));
      row.appendChild(f.ent("Tapping it runs", a.script,
        ["script", "scene", "button", "automation"], sa("script")));
      row.appendChild(f.text("Colour", a.color, sa("color"), "light-green"));
      row.appendChild(f.ent("Show while this is off", a.when_off,
        ["switch", "light", "water_heater", "binary_sensor"], sa("when_off")));
      row.appendChild(f.many("Show while any of these is on", a.when_on,
        ["switch", "light", "water_heater", "binary_sensor"], (v) => {
          if (v.length) a.when_on = v; else delete a.when_on;
        }));
      row.appendChild(f.del("Remove action", () => {
        r.water_actions.splice(i, 1);
        if (!r.water_actions.length) delete r.water_actions;
      }));
      box.appendChild(row);
    });
    box.appendChild(f.add("+ Action", () => {
      (r.water_actions = r.water_actions || []).push({ name: "" });
    }));
  }

  /* Gates: what opens them, and whether a tap should have to be meant. */
  _renderGates() {
    const box = this._gatesBox;
    if (!box) return;
    box.innerHTML = "";
    const f = this._fields(() => { this._renderGates(); this._renderPreview(); });
    const list = this._room.gates || [];

    list.forEach((gRaw, i) => {
      const g = typeof gRaw === "object" ? gRaw : { name: String(gRaw) };
      if (typeof gRaw !== "object") this._room.gates[i] = g;
      const set = (k) => (v) => { if (v) g[k] = v; else delete g[k]; };
      const row = f.rowBox();
      row.appendChild(f.text("Name", g.name, set("name"), "East Gate"));
      row.appendChild(f.icon("Icon", g.icon, set("icon")));
      row.appendChild(f.ent("Opening it runs", g.press,
        ["button", "script", "scene", "switch", "cover"], set("press")));
      row.appendChild(f.ent("Holding it runs", g.hold, ["button", "script"], set("hold")));
      row.appendChild(f.ent("Open/closed sensor", g.state,
        ["binary_sensor", "cover", "sensor"], set("state")));

      const ask = document.createElement("label");
      ask.className = "vfield";
      const t = document.createElement("span");
      t.textContent = "Ask before opening";
      const cb = document.createElement("ha-switch");
      cb.checked = !!g.confirm;
      cb.addEventListener("change", () => {
        if (cb.checked) g.confirm = true; else delete g.confirm;
        this._renderGates(); this._renderPreview();
      });
      ask.append(t, cb);
      row.appendChild(ask);

      row.appendChild(f.del("Remove gate", () => {
        this._room.gates.splice(i, 1);
        if (!this._room.gates.length) delete this._room.gates;
      }));
      box.appendChild(row);
    });

    box.appendChild(f.add("+ Gate", () => {
      (this._room.gates = this._room.gates || []).push({ name: "" });
    }));
  }

  /* A door's label and the button that operates it, for rooms that never
   * take their layout over — where the layout row would be the only way. */
  /* Picking the sensors and setting them up were two panels for no reason
   * other than one being an ha-form field. One list: each sensor is a row
   * you can swap, remove, and open for its label, its opener and its guard. */
  _renderDoors() {
    const box = this._doorsBox;
    if (!box) return;
    box.innerHTML = "";
    const redraw = () => { this._renderDoors(); this._renderPreview(); };
    const f = this._fields(redraw);
    const r = this._room;
    const list = r.alert_sensors || [];

    const idOf = (x) => (typeof x === "string" ? x : (x && x.entity) || "");
    const objAt = (i) => {
      if (typeof r.alert_sensors[i] === "string")
        r.alert_sensors[i] = { entity: r.alert_sensors[i] };
      return r.alert_sensors[i];
    };

    box.appendChild(f.cap("Door / window / motion / garage sensors"));

    list.forEach((sRaw, i) => {
      const id = idOf(sRaw);
      const o = typeof sRaw === "object" ? sRaw : {};
      const st = this._hass.states[id];
      const reg = this._hass.entities && this._hass.entities[id];
      const shown = o.label || (reg && (reg.name || reg.original_name))
                    || (st && st.attributes.friendly_name) || id;
      const set = (k) => (v) => {
        if (v) objAt(i)[k] = v;
        else if (typeof r.alert_sensors[i] === "object") delete r.alert_sensors[i][k];
      };

      const body = document.createElement("div");
      body.appendChild(f.ent("Sensor", id, ["sensor", "binary_sensor", "cover"], (v) => {
        if (!v) r.alert_sensors.splice(i, 1);
        else if (typeof r.alert_sensors[i] === "object") r.alert_sensors[i].entity = v;
        else r.alert_sensors[i] = v;
        if (!r.alert_sensors.length) delete r.alert_sensors;
      }));
      body.appendChild(f.text("Label", o.label, set("label"), "Door 1"));
      body.appendChild(f.icon("Icon", o.icon, set("icon")));
      body.appendChild(f.ent("Button that opens it", o.toggle_button,
        ["button", "switch", "script", "cover"], set("toggle_button")));
      body.appendChild(f.ent("Vehicle sensor", o.vehicle_entity, ["binary_sensor"],
        set("vehicle_entity")));

      /* Both of these are three-state: inherit, or say yes/no for this one.
       * A switch couldn't tell "use the room's guard" from "no guard". */
      const tri = (label, value, onPick, options) => {
        const w = document.createElement("div");
        w.className = "vfield";
        const t = document.createElement("span"); t.textContent = label;
        const dd = document.createElement("select");
        for (const [v, lab] of options) {
          const op = document.createElement("option");
          op.value = v; op.textContent = lab;
          if (String(value) === v) op.selected = true;
          dd.appendChild(op);
        }
        dd.addEventListener("change", () => { onPick(dd.value); redraw(); });
        w.append(t, dd);
        return w;
      };

      body.appendChild(tri("Counts as a garage door",
        o.garage === undefined ? "auto" : String(!!o.garage),
        (v) => {
          if (v === "auto") {
            if (typeof r.alert_sensors[i] === "object") delete r.alert_sensors[i].garage;
          } else objAt(i).garage = v === "true";
        },
        [["auto", "Work it out from the entity"], ["true", "Yes"], ["false", "No"]]));

      const guard = o.confirm_sensor === false ? "off"
                  : o.confirm_sensor ? "own" : "room";
      body.appendChild(tri("Only alert when also open", guard, (v) => {
        const t = objAt(i);
        if (v === "room") delete t.confirm_sensor;
        else if (v === "off") t.confirm_sensor = false;
        else if (typeof t.confirm_sensor !== "string") t.confirm_sensor = "";
      }, [["room", "Use the room's sensor"], ["off", "No guard for this one"],
          ["own", "Its own sensor"]]));

      if (guard === "own") {
        body.appendChild(f.ent("Its guard sensor",
          typeof o.confirm_sensor === "string" ? o.confirm_sensor : "",
          ["sensor", "binary_sensor"], (v) => { objAt(i).confirm_sensor = v || ""; }));
      }

      body.appendChild(f.del("Remove sensor", () => {
        r.alert_sensors.splice(i, 1);
        if (!r.alert_sensors.length) delete r.alert_sensors;
      }));

      // one collapsed row per sensor, so the list stays a list
      const sub = isGarage(sRaw, this._hass) ? "garage door"
                : (st ? `${id}` : "not found");
      box.appendChild(this._panel(shown, sub,
        isGarage(sRaw, this._hass) ? "mdi:garage" : "mdi:door-closed",
        `_door${i}Open`, body));
    });

    box.appendChild(f.add("+ Sensor", () => {
      (r.alert_sensors = r.alert_sensors || []).push("");
    }));

    box.appendChild(f.cap("Only alert when this is also open"));
    box.appendChild(f.ent("The room's guard sensor", r.confirm_sensor,
      ["sensor", "binary_sensor"], (v) => {
        if (v) r.confirm_sensor = v; else delete r.confirm_sensor;
      }));
    const note = document.createElement("div");
    note.className = "vnote";
    note.textContent = "Guards the garages against a false ratgdo Opening. "
      + "A sensor can opt out above.";
    box.appendChild(note);
  }

  /* A light list's entries may be objects carrying name, icon, dim and count.
   * Editing which entities are in the list must not flatten those, so match
   * the new ids back to whatever the room already knew about them. */
  _setLightList(key, ids) {
    const keep = {};
    for (const l of this._room[key] || [])
      if (l && typeof l === "object" && l.entity) keep[l.entity] = l;
    const next = ids.map((e) => keep[e] || e);
    if (next.length) this._room[key] = next; else delete this._room[key];
  }

  /* Every one of these panels edits a list of objects, which `ha-form` has no
   * good shape for, so they all build rows out of the same three fields.
   * `redraw` is what to re-run after a change — the panel plus the preview. */
  _fields(redraw) {
    const wrap = (label, el) => {
      const w = document.createElement("div");
      w.className = "vfield";
      const t = document.createElement("span"); t.textContent = label;
      w.append(t, el);
      return w;
    };
    const text = (label, value, onChange, placeholder) => {
      const i = document.createElement("input");
      i.type = "text"; i.value = value || ""; i.placeholder = placeholder || "";
      i.addEventListener("change", () => { onChange(i.value.trim()); redraw(); });
      return wrap(label, i);
    };
    const ent = (label, value, domains, onChange, hint) => {
      if (!customElements.get("ha-entity-picker")) return text(label, value, onChange, hint);
      const p = document.createElement("ha-entity-picker");
      p.hass = this._hass;
      p.value = value || "";
      p.allowCustomEntity = true;
      if (domains && domains.length) p.includeDomains = domains;
      p.addEventListener("value-changed", (ev) => {
        ev.stopPropagation();
        onChange((ev.detail && ev.detail.value) || "");
        redraw();
      });
      return wrap(label, p);
    };
    const icon = (label, value, onChange) => {
      if (!customElements.get("ha-icon-picker"))
        return text(label, value, onChange, "mdi:…");
      const p = document.createElement("ha-icon-picker");
      p.hass = this._hass;
      p.value = value || "";
      p.addEventListener("value-changed", (ev) => {
        ev.stopPropagation();
        onChange(((ev.detail && ev.detail.value) || "").trim());
        redraw();
      });
      return wrap(label, p);
    };
    /* A list of entities, as one picker per entry plus an empty one to
     * grow into — simpler to reason about than a multi-select. */
    const many = (label, values, domains, onChange) => {
      const box = document.createElement("div");
      box.className = "vfield";
      const t = document.createElement("span"); t.textContent = label;
      box.appendChild(t);
      const list = [].concat(values || []);
      [...list, ""].forEach((v, i) => {
        const row = ent("", v, domains, (nv) => {
          const next = [...list];
          if (i < next.length) { if (nv) next[i] = nv; else next.splice(i, 1); }
          else if (nv) next.push(nv);
          onChange(next);
        });
        row.querySelector("span").remove();
        box.appendChild(row);
      });
      return box;
    };
    /* A remove button that reads as one */
    const del = (label, onClick) => {
      const b = document.createElement("button");
      b.className = "vdel"; b.textContent = label;
      b.addEventListener("click", () => { onClick(); redraw(); });
      return b;
    };
    const add = (label, onClick) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.addEventListener("click", () => { onClick(); redraw(); });
      return b;
    };
    const cap = (t) => {
      const d = document.createElement("div");
      d.className = "vcap"; d.textContent = t;
      return d;
    };
    const rowBox = () => {
      const d = document.createElement("div");
      d.className = "vrowbox";
      return d;
    };
    return { text, ent, icon, many, del, add, cap, rowBox };
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
      this._plainRemotes(box);
      return;
    }

    const { text: field, ent, icon: iconField } = this._fields(() => {
      this._renderVideo(); this._renderPreview();
    });

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
    this._plainRemotes(box);
  }

  /* A room with one screen and one box needs no switcher — its remotes live
   * in the same panel rather than a second one about the same subject. */
  _plainRemotes(box) {
    const cap = document.createElement("div");
    cap.className = "vcap";
    cap.textContent = "Remotes with no screen picker";
    box.appendChild(cap);
    this._remotesInto(box);
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
    h.textContent = "Per-light name, icon, render, dimming and counting";
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
      "<thead><tr><th>Entity</th><th>Name</th><th>Icon</th><th>Render</th><th>Dims</th>" +
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
      const trd = document.createElement("td");
      const rsel = document.createElement("select");
      for (const [v, lab] of Object.entries(RENDER_KINDS)) {
        const op = document.createElement("option");
        op.value = v; op.textContent = lab;
        if (o_render(obj) === v) op.selected = true;
        rsel.appendChild(op);
      }
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
        if (rsel.value !== "mushroom") next.render = rsel.value;
        const arr = this._room[list];
        const i = arr.findIndex((x) => lightId(x) === id);
        arr[i] = Object.keys(next).length > 1 ? next : id;
        this._renderPreview();
      };
      nm.addEventListener("change", write);
      ic.addEventListener("change", write);
      sw.addEventListener("change", write);
      cw.addEventListener("change", write);
      rsel.addEventListener("change", write);

      tn.appendChild(nm); ti.appendChild(ic); trd.appendChild(rsel);
      td.appendChild(sw); tc.appendChild(cw);
      tr.append(te, tn, ti, trd, td, tc);
      tb.appendChild(tr);
    }
    tbl.appendChild(tb);
    this._lightsBox.append(row, tbl);
  }

  async _renderPreview() {
    this._queueSave();
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

  /* --------------------------------------------------------- unknowns -- */
  _renderUnknowns() {
    if (!this._warn) return;
    this._warn.innerHTML = "";
    const bad = unknownEntities(this._room, this._hass);
    if (this._key) {
      this._unknownCounts = this._unknownCounts || {};
      if (bad.length) this._unknownCounts[this._key] = bad.length;
      else delete this._unknownCounts[this._key];
    }
    this._warn.hidden = !bad.length;
    if (!bad.length) return;

    const head = document.createElement("div");
    head.className = "warnhd";
    head.textContent = `${bad.length} entity id${bad.length > 1 ? "s" : ""} ` +
      `Home Assistant doesn't have — renamed, removed, or a typo`;
    this._warn.appendChild(head);

    for (const row of bad) {
      const line = document.createElement("div");
      line.className = "warnrow";
      const id = document.createElement("code");
      id.textContent = row.id;
      const where = document.createElement("span");
      where.className = "warnwhere";
      where.textContent = row.paths.join(", ");
      line.append(id, where);
      this._warn.appendChild(line);
    }
  }

  /* ----------------------------------------------------------- history -- */
  _toggleHistory() {
    if (!this._histBox.hidden) return this._closeHistory();
    this._openHistory();
  }

  _closeHistory() {
    this._histBox.hidden = true;
    if (this._histAway) {
      document.removeEventListener("click", this._histAway);
      this._histAway = null;
    }
  }

  async _openHistory() {
    const box = this._histBox;
    box.innerHTML = "";
    box.hidden = false;
    this._histAway = () => this._closeHistory();
    document.addEventListener("click", this._histAway);

    if (this._saveMode() !== "ws" || !this._key) {
      box.textContent = "History needs the Charro Cards integration.";
      return;
    }
    const wait = document.createElement("div");
    wait.className = "histrow"; wait.textContent = "Loading…";
    box.appendChild(wait);

    let rows;
    try {
      const r = await this._hass.callWS({ type: WS_SNAPS, key: this._key });
      rows = (r && r.snapshots) || [];
    } catch (err) {
      box.innerHTML = "";
      const e = document.createElement("div");
      e.className = "histrow"; e.textContent = `Couldn't read history: ${err.message}`;
      box.appendChild(e);
      return;
    }

    box.innerHTML = "";
    const head = document.createElement("div");
    head.className = "histhd";
    head.textContent = rows.length
      ? "Loads it into the editor — nothing is lost either way"
      : "No earlier versions yet";
    box.appendChild(head);

    for (const row of rows) {
      const b = document.createElement("button");
      b.className = "histrow";
      const when = document.createElement("span");
      when.textContent = ago(row.ts);
      const size = document.createElement("span");
      size.className = "histsz";
      size.textContent = `${Math.max(1, Math.round(row.bytes / 1024))} KB`;
      b.append(when, size);
      b.title = new Date(row.ts * 1000).toLocaleString();
      b.addEventListener("click", (ev) => {
        ev.stopPropagation();
        this._closeHistory();
        this._restoreSnap(row.ts);
      });
      box.appendChild(b);
    }
  }

  async _restoreSnap(ts) {
    try {
      const r = await this._hass.callWS({ type: WS_SNAP, key: this._key, ts });
      const cfg = r && r.config;
      if (!cfg || typeof cfg !== "object") throw new Error("not a room");
      const remotes = this._room && this._room._remotes;
      this._room = cfg;
      if (remotes) this._room._remotes = remotes;
      this._renderForm();
      /* Saving this is itself snapshotted, so the version being replaced is
       * kept too - going back and forth costs nothing. */
      this._say(`Restored the version from ${ago(ts)}. ` +
                (this._autoOn() ? "Saving now — what you had is kept in history."
                                : "Press Save to keep it, or Revert to undo."), "ok");
      if (this._autoOn()) this._queueSave();
    } catch (err) {
      this._say(`Couldn't restore: ${err.message}`, "err");
    }
  }

  /* -------------------------------------------------------------- save -- */
  async _doSave(quiet) {
    if (!this._room || !this._key || this._saving) return;
    this._saving = true;
    try { await this._writeRoom(quiet); } finally { this._saving = false; }
  }

  async _writeRoom(quiet) {
    const save = { ...this._room };
    delete save._remotes;                       // fetched, not part of the file
    const json = JSON.stringify(save, null, 2);

    const mode = this._saveMode();
    if (mode !== "copy") {
      try {
        if (mode === "ws") {
          await this._hass.callWS({
            type: WS_SAVE, key: this._key, config: save });
        } else {
          const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(json)));
          await this._hass.callService(SAVE_SERVICE[0], SAVE_SERVICE[1],
                                       { name: this._key, payload: b64 });
        }
        this._orig = JSON.parse(json);
        invalidateRooms();   // every card shares one copy; make them re-ask
        this._say(quiet
          ? `Autosaved ${this._key}.json`
          : `Saved to ${this._path(this._key)} — hard-refresh to see it elsewhere.`, "ok");
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
def("charro-rooms-editor", CharroRoomsEditor);

/* --------------------------------------------------------------- panel -- *

 * The sidebar page. Home Assistant hands a custom panel `hass`, `narrow`,
 * `route` and `panel`; everything below is a header with the sidebar toggle
 * plus the same editor the card uses, told it is running as a page.
 */

const PANEL_CSS = `
:host{ display:block; height:100%; background:var(--primary-background-color); }
.top{
  display:flex; align-items:center; gap:4px; height:var(--header-height, 56px);
  padding:0 4px 0 8px; box-sizing:border-box;
  background:var(--app-header-background-color, var(--primary-color));
  color:var(--app-header-text-color, var(--text-primary-color, #fff));
  font-size:20px; font-weight:400;
}
.top .t{ margin-left:8px; }
.top ha-icon-button{ --mdc-icon-button-size:40px; color:inherit; }
.body{ height:calc(100% - var(--header-height, 56px)); overflow:auto; }
`;

class CharroRoomsPanel extends HTMLElement {
  set hass(h) {
    this._hass = h;
    this._render();
    if (this._editor) this._editor.hass = h;
  }
  set narrow(n) { this._narrow = n; this._syncMenu(); }
  set route(r) { this._route = r; }
  set panel(p) { this._panelCfg = p; }

  _render() {
    if (this._built) return;
    this._built = true;
    const root = this.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = PANEL_CSS;

    const top = document.createElement("div"); top.className = "top";
    this._menu = document.createElement("ha-icon-button");
    this._menu.setAttribute("label", "Menu");
    this._menu.addEventListener("click", () => {
      this.dispatchEvent(new Event("hass-toggle-menu", { bubbles: true, composed: true }));
    });
    const mi = document.createElement("ha-svg-icon");
    // mdi:menu, inlined — a panel header shouldn't need the icon set loaded
    mi.setAttribute("path", "M3,6H21V8H3V6M3,11H21V13H3V11M3,16H21V18H3V16Z");
    this._menu.appendChild(mi);
    const title = document.createElement("div");
    title.className = "t";
    title.textContent = (this._panelCfg && this._panelCfg.title) || "Rooms";
    top.append(this._menu, title);
    this._syncMenu();

    const body = document.createElement("div"); body.className = "body";
    const ed = document.createElement("charro-rooms-editor");
    ed.setConfig({ type: "custom:charro-rooms-editor", panel: true });
    ed.hass = this._hass;
    this._editor = ed;
    body.appendChild(ed);

    root.append(style, top, body);
  }

  /* Wide screens already show the sidebar, so the hamburger is only useful
   * when it is collapsed — but HA keeps it visible there too, and a missing
   * button is worse than a redundant one. */
  _syncMenu() {
    if (this._menu) this._menu.style.display = "";
  }
}
def("charro-rooms-panel", CharroRoomsPanel);


/* ========================================================= HEADER TABS == */
/*
 * Home Assistant draws the view tabs as 56px icon-only squares with a 1px
 * underline under the active one, straight onto whatever is behind the
 * header. On a dashboard with a background photo that means four grey icons
 * floating on the picture and an active marker you have to look for. On a
 * theme with no frosted panel behind the header it is worse still, which is
 * where this started.
 *
 * What follows lifts them out of the header entirely and floats them as a
 * dock along the bottom of the screen: a label under each icon, a filled
 * pill on the active one, and a blurred surface so the strip reads against
 * any photo. In the header the capsule read as a bar inside a bar, and the
 * tabs are easier to hit at the bottom on a phone anyway. Three things make
 * it safe to ship rather than a standing maintenance cost:
 *
 *   - It styles through `::part(nav)`, `::part(tabs)`, `::part(base)` and the
 *     `--ha-tab-*` custom properties. Those are the component's public
 *     styling API, not selectors scraped out of its shadow DOM.
 *   - It is purely additive. If a future core renames `hui-root` or
 *     `ha-tab-group`, findHuiRoot returns nothing, no style is injected, and
 *     the tabs render exactly as they ship. The failure mode is "looks like
 *     it used to", never a broken header.
 *   - It touches nothing functional: routing, the menu button, the action
 *     items and the hidden-view class are all left alone.
 *
 * Deliberately NOT built on the `--rgb-*` theme variables, which look like
 * the obvious source and are a trap. Frosted Glass Dark reports
 * `--rgb-primary-text-color: 33,33,33` while `--primary-text-color` is
 * near-white, and `--rgb-primary-color` teal while `--primary-color` is
 * indigo — they are copies a theme can forget to update, so a nav built on
 * them is wrong on this theme and differently wrong on the next one.
 * Everything below reads the plain variables and thins them with color-mix().
 */

const TAB_STYLE_ID = "charro-tabs";

const TAB_CSS = `
/* An element with backdrop-filter becomes the containing block for its
 * position:fixed descendants, and .header has one — so a fixed tab strip
 * inside it is pinned to a 56px band at the top of the screen and can never
 * reach the bottom. Moving that blur to a pseudo-element keeps the header
 * looking identical (its own background is near-transparent on a glass
 * theme, so without the blur the action icons would sit raw on the photo)
 * while letting the dock below escape to the viewport. */
:host(:not([charro-edit])) .header { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }
:host(:not([charro-edit])) .header::before {
  content: ""; position: absolute; inset: 0; z-index: -1; pointer-events: none;
  -webkit-backdrop-filter: blur(20px) saturate(1.3);
  backdrop-filter: blur(20px) saturate(1.3);
}

:host(:not([charro-edit])) ha-tab-group {
  --ha-tab-track-color: transparent;
  --ha-tab-indicator-color: transparent;
  --track-width: 0px;
  --padding: 0px;
  position: fixed;
  z-index: 6;
  margin: 0;
  /* top and height are both set by the component, and a fixed box with top
   * AND bottom stretches between them — which made the dock the full height
   * of the window with a 68px strip at the bottom of it. */
  top: auto !important;
  height: auto !important;
  bottom: calc(18px + env(safe-area-inset-bottom, 0px));
  /* Centred on the content, not the window: with the sidebar open those are
   * 128px apart. --ha-sidebar-width is Home Assistant's own variable for the
   * offset it gives the content area, so the dock tracks the sidebar being
   * expanded or collapsed. */
  left: var(--charro-dock-x);
  transform: translateX(-50%);
}
/* Below the sidebar's breakpoint it is an overlay rather than a column, so
 * the variable stops describing an offset and the window is the content. */
:host { --charro-dock-x: calc(var(--ha-sidebar-width, 0px) + (100vw - var(--ha-sidebar-width, 0px)) / 2); }
@media (max-width: 869px) {
  :host { --charro-dock-x: 50vw; }
}

:host(:not([charro-edit])) ha-tab-group::part(base) { height: auto; }
:host(:not([charro-edit])) ha-tab-group::part(body) { display: none; }   /* the empty tab panel */
:host(:not([charro-edit])) ha-tab-group::part(nav) { border: none; }
:host(:not([charro-edit])) ha-tab-group::part(tabs) {
  gap: 2px;
  padding: 5px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--card-background-color, #1e1e1e) 78%, transparent);
  -webkit-backdrop-filter: blur(22px) saturate(1.4);
  backdrop-filter: blur(22px) saturate(1.4);
  border: 1px solid var(--ha-card-border-color, var(--divider-color, transparent));
  box-shadow: 0 6px 24px rgba(0,0,0,0.38);
}

:host(:not([charro-edit])) ha-tab-group-tab::part(base) {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  height: 50px;
  min-width: 64px;
  padding: 0 10px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0.3px;
  line-height: 1;
  color: var(--secondary-text-color);
  transition: background 200ms ease, color 200ms ease;
}
:host(:not([charro-edit])) ha-tab-group-tab ha-icon { --mdc-icon-size: 22px; }
:host(:not([charro-edit])) ha-tab-group-tab:not([aria-selected="true"]):hover::part(base) {
  background: color-mix(in srgb, var(--primary-text-color, #fff) 9%, transparent);
  color: var(--primary-text-color);
}
:host(:not([charro-edit])) ha-tab-group-tab[aria-selected="true"]::part(base) {
  background: color-mix(in srgb, var(--primary-color, #6a74d3) 32%, transparent);
  color: var(--primary-text-color);
  font-weight: 600;
}
/* Desktop and iPad have the room for a bigger target and bigger glyphs. */
@media (min-width: 870px) {
  :host(:not([charro-edit])) ha-tab-group-tab::part(base) { height: 58px; min-width: 84px; font-size: 11px; gap: 4px; }
  :host(:not([charro-edit])) ha-tab-group-tab ha-icon { --mdc-icon-size: 27px; }
}

/* Only tabs Home Assistant rendered icon-only get a label added; a view with
 * no icon already shows its title as text and must not get it twice. */
:host(:not([charro-edit])) ha-tab-group-tab.icon-only::part(base)::after { content: var(--charro-tab-label, ""); }

/* So the last row of cards can be scrolled clear of a dock that floats over
 * them: 68px of dock, 18px of gap, and room to breathe. */
:host(:not([charro-edit])) hui-view-container { padding-bottom: 110px; }


/* ---- the top bar, and the dots that bring it back ---------------------
 *
 * The dock lives inside .header, so the bar can't simply be display:none —
 * that would take the dock with it. Instead the header is emptied: nothing
 * of it paints, and it stops catching clicks so the cards underneath are
 * reachable through where it used to be. The box stays, holding the dock.
 *
 * Everything here is switched off while the dashboard is in edit mode. The
 * edit toolbar is the same .action-items row, so hiding it there would take
 * the Save button with it.
 */
:host(:not([charro-edit])) .header { background: none !important; pointer-events: none; }
:host(:not([charro-edit])) .header::before { display: none !important; }
:host(:not([charro-edit])) .toolbar > ha-menu-button,
:host(:not([charro-edit])) .toolbar .main-title { display: none !important; }
:host(:not([charro-edit])) .toolbar .action-items { display: none !important; }
:host(:not([charro-edit])) ha-tab-group { pointer-events: auto; }

/* Tapping the dots floats the real controls — Home Assistant's own add,
 * search, assist and edit buttons, plus its overflow menu — just above the
 * dock. Nothing is reimplemented and nothing is moved in the DOM; the row
 * is simply positioned somewhere else. */
:host(:not([charro-edit])[charro-extras]) .toolbar {
  position: fixed;
  top: auto;
  z-index: 7;
  height: 52px;
  width: fit-content;
  padding: 0 4px;
  border-radius: 999px;
  pointer-events: auto;
  bottom: calc(102px + env(safe-area-inset-bottom, 0px));
  /* centred with auto margins rather than translateX: a transform on this
   * element would make it the containing block for the fixed dock nested
   * inside it, and the dock would fly off to sit in this capsule */
  left: var(--ha-sidebar-width, 0px);
  right: 0;
  margin-inline: auto;
  background: color-mix(in srgb, var(--card-background-color, #1e1e1e) 78%, transparent);
  border: 1px solid var(--ha-card-border-color, var(--divider-color, transparent));
  box-shadow: 0 6px 24px rgba(0,0,0,0.38);
}
@media (max-width: 869px) {
  :host(:not([charro-edit])[charro-extras]) .toolbar { left: 0; }
}
:host(:not([charro-edit])[charro-extras]) .toolbar::before {
  content: ""; position: absolute; inset: 0; z-index: -1;
  border-radius: 999px; pointer-events: none;
  -webkit-backdrop-filter: blur(22px) saturate(1.4);
  backdrop-filter: blur(22px) saturate(1.4);
}
/* Home Assistant only fills the menu button in when the sidebar is hidden,
 * so on a phone this is the one way back to it. */
:host(:not([charro-edit])[charro-extras]) .toolbar > ha-menu-button { display: block !important; }
:host(:not([charro-edit])[charro-extras]) .toolbar .action-items {
  display: flex !important;
  align-items: center;
}

:host(:not([charro-edit])) #charro-extras-btn {
  position: fixed;
  z-index: 7;
  width: 44px;
  height: 44px;
  border-radius: 999px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  color: var(--secondary-text-color);
  background: color-mix(in srgb, var(--card-background-color, #1e1e1e) 78%, transparent);
  -webkit-backdrop-filter: blur(22px) saturate(1.4);
  backdrop-filter: blur(22px) saturate(1.4);
  border: 1px solid var(--ha-card-border-color, var(--divider-color, transparent));
  box-shadow: 0 6px 24px rgba(0,0,0,0.38);
  transition: background 200ms ease, color 200ms ease;
  /* sits off the dock's right edge, centred against its height; both are
   * measured and published as custom properties because the dock's width
   * depends on how many views the dashboard has */
  bottom: calc(18px + (var(--charro-dock-h, 68px) - 44px) / 2 + env(safe-area-inset-bottom, 0px));
  left: calc(var(--charro-dock-x) + var(--charro-dock-half, 170px) + 10px);
}
:host(:not([charro-edit])) #charro-extras-btn:hover { color: var(--primary-text-color); }
:host([charro-extras]) #charro-extras-btn {
  background: color-mix(in srgb, var(--primary-color, #6a74d3) 32%, transparent);
  color: var(--primary-text-color);
}
/* While editing, the real toolbar is back; the dots would be a duplicate. */
:host([charro-edit]) #charro-extras-btn { display: none; }
`;

let _huiRoot = null;

/* hui-root sits several shadow roots down and the path to it is not stable
 * enough to hard-code, so it is searched for — but only once per dashboard:
 * it survives view changes, so the cache hits on every navigation inside a
 * dashboard and the walk runs again only when one is torn down. The node
 * budget is there so a panel that has no hui-root at all (Settings, HACS)
 * costs a bounded scan rather than a full-document crawl. */
function findHuiRoot() {
  if (_huiRoot && _huiRoot.isConnected) return _huiRoot;
  _huiRoot = null;
  const seen = new Set();
  const stack = [document];
  let budget = 3000;
  while (stack.length && budget > 0) {
    const root = stack.pop();
    if (!root || seen.has(root)) continue;
    seen.add(root);
    const hit = root.querySelector && root.querySelector("hui-root");
    if (hit) { _huiRoot = hit; return hit; }
    if (!root.querySelectorAll) continue;
    for (const el of root.querySelectorAll("*")) {
      if (--budget <= 0) break;
      if (el.shadowRoot) stack.push(el.shadowRoot);
    }
  }
  return _huiRoot;
}

/* A ::part pseudo-element can't read an attribute off the host, so each tab
 * is stamped with its own title as a custom property and the pseudo reads
 * that back. Custom properties inherit through the shadow boundary, which is
 * what makes this work without knowing anything about the tab's internals —
 * and it means a view added or renamed later labels itself. */
function stampTabLabels(sr) {
  for (const t of sr.querySelectorAll("ha-tab-group-tab")) {
    const want = JSON.stringify(t.getAttribute("aria-label") || "");
    if (t.style.getPropertyValue("--charro-tab-label") !== want) {
      t.style.setProperty("--charro-tab-label", want);
    }
  }
}

const EXTRAS_BTN_ID = "charro-extras-btn";

/* mdi:dots-vertical, inlined — the dock shouldn't wait on the icon set */
const DOTS_SVG =
  '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" ' +
  'd="M12,16A2,2 0 0,1 14,18A2,2 0 0,1 12,20A2,2 0 0,1 10,18A2,2 0 0,1 12,16M12,10A2,2 0 0,1 ' +
  '14,12A2,2 0 0,1 12,14A2,2 0 0,1 10,12A2,2 0 0,1 12,10M12,4A2,2 0 0,1 14,6A2,2 0 0,1 12,8A2,2 ' +
  '0 0,1 10,6A2,2 0 0,1 12,4Z"/></svg>';

let _outsideHooked = false;

/* The dots button's left edge is the dock's right edge, and the dock's width
 * depends on how many views the dashboard has — so it is measured rather
 * than assumed, and published for the stylesheet to position against. */
function measureDock(sr, host) {
  const grp = sr.querySelector("ha-tab-group");
  if (!grp) return;
  const b = grp.getBoundingClientRect();
  if (!b.width) return;
  host.style.setProperty("--charro-dock-half", b.width / 2 + "px");
  host.style.setProperty("--charro-dock-h", b.height + "px");
}

function mountExtras(sr, host) {
  if (sr.getElementById(EXTRAS_BTN_ID)) return;
  const btn = document.createElement("div");
  btn.id = EXTRAS_BTN_ID;
  btn.setAttribute("role", "button");
  btn.setAttribute("tabindex", "0");
  btn.setAttribute("aria-label", "More");
  btn.innerHTML = DOTS_SVG;
  const toggle = (ev) => {
    ev.stopPropagation();
    host.toggleAttribute("charro-extras");
    if (host.hasAttribute("charro-extras")) measureDock(sr, host);
  };
  btn.addEventListener("click", toggle);
  btn.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); toggle(ev); }
  });
  sr.appendChild(btn);

  /* Anything else tapped — a card, one of the buttons that just floated up,
   * the background — puts the row away again. The dots stop propagation, so
   * they toggle rather than close-then-open. Hooked once per page, not per
   * dashboard, or switching dashboards would stack listeners. */
  if (!_outsideHooked) {
    _outsideHooked = true;
    document.addEventListener("click", () => {
      if (_huiRoot && _huiRoot.isConnected) _huiRoot.removeAttribute("charro-extras");
    });
  }
}

/* Edit mode puts the real toolbar back. It is the same .action-items row
 * this hides, so leaving it hidden there would hide the Save button with
 * it — everything above switches off while the wrapper carries .edit-mode. */
function watchEditMode(sr, host) {
  const wrap = sr.querySelector("div");
  if (!wrap || wrap.__charroEdit) return;
  const sync = () => {
    const editing = wrap.classList.contains("edit-mode");
    host.toggleAttribute("charro-edit", editing);
    if (editing) host.removeAttribute("charro-extras");
    measureDock(sr, host);
  };
  const obs = new MutationObserver(sync);
  obs.observe(wrap, { attributes: true, attributeFilter: ["class"] });
  wrap.__charroEdit = obs;
  sync();
}

function paintTabs() {
  if (window.CHARRO_NO_TAB_STYLE) return;
  let sr;
  try {
    const root = findHuiRoot();
    sr = root && root.shadowRoot;
  } catch (err) { return; }
  if (!sr) return;

  if (!sr.getElementById(TAB_STYLE_ID)) {
    const st = document.createElement("style");
    st.id = TAB_STYLE_ID;
    st.textContent = TAB_CSS;
    sr.appendChild(st);
  }
  stampTabLabels(sr);

  /* Views can be added, renamed or reordered without a navigation, so the
   * group is watched. `style` is not in the filter, so the stamp below can't
   * retrigger the observer that called it. */
  const grp = sr.querySelector("ha-tab-group");
  if (grp && !grp.__charroObs) {
    const obs = new MutationObserver(() => { stampTabLabels(sr); measureDock(sr, sr.host); });
    obs.observe(grp, {
      childList: true, subtree: true,
      attributes: true, attributeFilter: ["aria-label"],
    });
    grp.__charroObs = obs;
  }

  watchEditMode(sr, sr.host);
  mountExtras(sr, sr.host);
  measureDock(sr, sr.host);
}

/* The bundle is evaluated in the app shell, which can be before the first
 * dashboard has rendered — so a few backoff attempts, stopping as soon as
 * hui-root is in hand. */
function scheduleTabPaint() {
  let tries = 0;
  const tick = () => {
    paintTabs();
    if (++tries < 4 && !(_huiRoot && _huiRoot.isConnected)) {
      setTimeout(tick, 300 * tries);
    }
  };
  tick();
}

if (typeof window !== "undefined") {
  scheduleTabPaint();
  window.addEventListener("location-changed", scheduleTabPaint);
  window.addEventListener("popstate", scheduleTabPaint);
  /* The 870px breakpoint changes the dock's height and width, so the dots
   * have to be repositioned against it. Debounced, and paintTabs is a cache
   * hit by then, so a drag costs one measurement at the end. */
  let _rz;
  window.addEventListener("resize", () => {
    clearTimeout(_rz);
    _rz = setTimeout(() => {
      if (_huiRoot && _huiRoot.isConnected && _huiRoot.shadowRoot) {
        measureDock(_huiRoot.shadowRoot, _huiRoot);
      }
    }, 150);
  });
}


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
