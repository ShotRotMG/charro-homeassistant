/*
 * Charro Home Assistant — Lovelace cards
 *
 *   charro-room-card      a room: chip tile, its pop-up, or its full page
 *   charro-security-card  Elk zone / garage door tile, colours itself client-side
 *   charro-zone-card      RTI AD-8x single-line zone control
 *   charro-all-off-card   all zones off, both amps
 *   charro-lights-card    one room of lights, uniform rows, inline dimming
 *   charro-rooms-editor   edit the room files from inside Home Assistant
 *   charro-unifi-panel    UniFi diagnostics panel, at /charro-unifi
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

const VERSION = "5.11.0";
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

/* "Unknown command." is not a failure, it is "not yet".
 *
 * On a Home Assistant restart the frontend reconnects its websocket as soon
 * as core answers, and every card on an open dashboard asks for its rooms
 * immediately - well before this integration's config entry has been set up
 * and its websocket commands registered. Home Assistant answers
 * unknown_command, and the card rendered that as a permanent error, so a
 * dashboard came back from a restart as a wall of red that only a manual
 * refresh cleared.
 *
 * Start order cannot be fixed from here. Home Assistant decides it from
 * core's own stage lists, and a custom integration cannot promote itself
 * into the early ones; even if it could, the browser reconnects earlier
 * still. So the cards wait instead - which also covers the socket dropping
 * partway through a restart. Two and a half minutes of patience, and after
 * that the error is real and is shown. */
/* The two rejections come in two different shapes, which is worth writing
 * down because guessing it wrong makes this whole retry dead code. A
 * command-level refusal rejects with an object -
 * {code:"unknown_command", message:"Unknown command."} - while a
 * connection-level failure rejects with a bare number from
 * home-assistant-js-websocket: 1 is cannot-connect, 3 is connection-lost.
 * Both were verified against a live instance. */
const WS_WAIT = /unknown[_ ]command|connection[_ ]lost|not[_ ]ready/i;
const WS_CONN_ERRS = [1, 3];
const WS_TRIES = 30;

function wsRetryable(err) {
  if (typeof err === "number") return WS_CONN_ERRS.indexOf(err) >= 0;
  return WS_WAIT.test(String((err && (err.code || err.message)) || err));
}

async function fetchAll(hass) {
  let wait = 500;
  for (let n = 0; ; n++) {
    try {
      const d = await hass.callWS({ type: "charro/get_rooms" });
      if (n) console.info("charro: integration is up, cards loading");
      checkVersion(d && d.version, hass);
      return { rooms: (d && d.rooms) || {}, remotes: (d && d.remotes) || {} };
    } catch (err) {
      if (n >= WS_TRIES || !wsRetryable(err)) throw err;
      if (!n) console.info("charro: waiting for the integration to start\u2026");
      await new Promise((go) => setTimeout(go, wait));
      wait = Math.min(Math.round(wait * 1.5), 5000);
    }
  }
}

function loadAll(hass) {
  // one wait shared by every card on the page, not one wait per card
  if (!_allP) _allP = fetchAll(hass).catch((err) => { _allP = null; throw err; });
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
const ROOM_SECTIONS = ["climate", "media", "music", "lights", "water",
                       "gates", "cameras", "security"];

/* A room's own `sections` list is honoured as written, with two exceptions,
 * both from blocks that have moved. `music` was carved out of `media` in
 * 4.20, so a room that spelled its sections out before then names only
 * `media` and would silently drop its player. And `video` was carved out in
 * 4.29 and merged back in 4.84, so a room may name either or both. */
function sectionOrder(r) {
  let order = r.sections && r.sections.length ? [...r.sections] : [...ROOM_SECTIONS];
  const namedMedia = order.includes("media");

  /* 4.84: one block for the screens, the remotes and the player. Whichever
   * of the two came first keeps its position, so merging doesn't drop a
   * room's televisions to the bottom of the page. */
  const first = order.findIndex((s) => s === "video" || s === "media");
  if (first >= 0) {
    order = order.filter((s) => s !== "video" && s !== "media");
    order.splice(first, 0, "media");
  }

  /* 4.20: `music` sits right behind the media it was split from. Only for a
   * room that actually named `media` — a room that named only `video` never
   * had a music block and shouldn't grow one now. */
  if (namedMedia && !order.includes("music"))
    order.splice(order.indexOf("media") + 1, 0, "music");

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

/* What the off tile should actually do, in order of how specific it is.
 *
 * `media_player.turn_on` is the default and is the thing that quietly fails
 * on a Samsung: the integration turns it into a wake-on-LAN packet aimed at
 * 255.255.255.255, which leaves by whatever interface holds the default
 * route. On a Home Assistant with a second NIC for the TV subnet that is
 * the wrong one, and the packet never reaches the television's segment.
 *
 * `wake_mac` sends the packet directly instead, and `wake_broadcast` aims
 * it at the TV's own subnet rather than the whole world, which is what
 * makes the kernel pick the interface that can actually deliver it. No
 * script and nothing in configuration.yaml — the room file carries it. */
function wakeAction(spec) {
  if (spec.wake) {
    return { action: "perform-action", perform_action: spec.wake, target: {} };
  }
  if (spec.wake_mac) {
    const data = { mac: spec.wake_mac };
    if (spec.wake_broadcast) data.broadcast_address = spec.wake_broadcast;
    return { action: "perform-action",
             perform_action: "wake_on_lan.send_magic_packet",
             data, target: {} };
  }
  return { action: "toggle" };
}

/* The off-state face of a remote: one tile that turns the thing on. */
function remoteOffCard(spec, watch) {
  if (spec.off_card) return spec.off_card;
  const act = wakeAction(spec);
  return { type: "tile", entity: watch,
           name: spec.off_name || spec.title || "",
           icon: spec.off_icon || "mdi:television-off",
           hide_state: true, vertical: false,
           tap_action: act, icon_tap_action: act };
}

/* A remote only makes sense while its device is on, so it is paired with an
 * off-state tile and the two swap in place. Conditional cards do the watching,
 * so it follows state rather than whatever was true when the panel opened. */
/* The entity a remote spec follows: what decides whether you are looking at
 * the remote or at its off-state tile. */
function remoteWatch(spec) {
  return (spec && (spec.when || spec.media_player || spec.remote || spec.entity)) || "";
}

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
    const watch = remoteWatch(spec);
    if (spec.always || !watch) { out.push(card); continue; }
    out.push({ type: "conditional", conditions: isOn(watch), card });
    if (spec.wake || spec.wake_mac || spec.off_card || spec.off_icon || spec.off_name) {
      out.push({ type: "conditional", conditions: isOff(watch),
                 card: remoteOffCard(spec, watch) });
    }
  }
  return out;
}

/* "Basic TV only". The screens and sources stay exactly as configured — this
 * just skips the switcher and renders each screen as what it actually is
 * while nothing else is plugged into it yet: a button that turns the TV on,
 * which becomes that TV's own remote once it is on.
 *
 * It reuses remoteCards rather than inventing a second way to do the same
 * thing, so it gets the conditional pair that follows state instead of
 * whatever was true when the pop-up opened.
 *
 * A screen's "own" remote is the source whose media_player IS the screen —
 * for a smart TV running its own apps, that is the TV itself. A screen with
 * no such source, or whose source names no remote template, falls back to a
 * plain tile, which still turns it on and off and says so. */
/* A switcher with nothing to switch between is just a television with extra
 * steps. A room gets the basic pair automatically when there are no sources
 * at all, or when no screen has a source select to pick between them —
 * which is the state a room is in before any of that is wired up. The
 * "Basic TV only" box forces the same thing for a room that has sources
 * configured but isn't using them yet. */
/* A source can carry what picking it should do, written in Home Assistant's
 * own action shape - the same thing you would write in an automation, pasted
 * straight across:
 *
 *   "AppleTV": { "input": "AppleTV", "use": "apple_tv",
 *                "do": [ { "action": "media_player.turn_on",
 *                          "target": { "entity_id": ["media_player.vsx_lx305"] } } ] }
 *
 * This is what replaces a per-room input_select and one automation per
 * source. Anything an automation can do, a source can do - a Harmony
 * send_command with its repeats and delays included - because there is no
 * little language in the middle to run out of road.
 *
 * `Off` is an ordinary entry with its own actions. It is deliberately not
 * derived from the others: a room that has to send a PowerOff to a Harmony
 * cannot be guessed at, and a wrong guess turns the wrong things off.
 *
 * A step is an action, or { "delay": 1.5 } to wait between two of them. One
 * failing step is logged and the rest still run, because a receiver that is
 * already on shouldn't stop the projector coming up. */
async function runActions(hass, steps) {
  for (const step of steps || []) {
    if (!step) continue;
    if (step.delay !== undefined) {
      await new Promise((r) => setTimeout(r, (Number(step.delay) || 0) * 1000));
      continue;
    }
    const name = step.action || step.service;
    if (!name || !String(name).includes(".")) continue;
    const [domain, service] = String(name).split(".");
    try {
      await hass.callService(domain, service, step.data || {},
                             step.target || undefined);
    } catch (err) {
      console.error("Charro Cards: action failed", name, err);
    }
  }
}

function videoIsBasic(v) {
  if (!v) return true;
  if (v.simple) return true;
  if (!Object.keys(v.sources || {}).length) return true;
  return !(v.displays || []).some((d) => d && d.source);
}

/* Which remote template fits a screen nobody has assigned one to.
 *
 * The templates in _remotes.json are named after what they drive —
 * `samsung_tv`, `superbox` — so the first word of the name is the thing to
 * look for in the entity id. It is a guess and it is treated like one: a
 * configured source always wins, and a screen that matches nothing gets a
 * plain tile rather than a remote full of buttons that go nowhere. */
function guessRemote(entity, templates) {
  if (!entity) return null;
  const id = entity.replace(/^[a-z_]+\./, "");
  let best = null;
  for (const key of Object.keys(templates || {})) {
    const word = String(key).split("_")[0].toLowerCase();
    if (word.length > 3 && id.includes(word)) {
      if (!best || word.length > best.word.length) best = { key, word };
    }
  }
  return best && best.key;
}

function videoSimpleCards(r, hass) {
  const v = (r && r.video) || {};
  const templates = (r && r._remotes) || {};
  const out = [];
  for (const d of v.displays || []) {
    if (!d || !screenPower(d)) continue;
    /* What a remote would drive. For a screen on the matrix that is its own
     * media_player, not the CEC switch that powers it. */
    const tv = screenTv(d);
    let own = null;
    for (const src of Object.values(v.sources || {})) {
      if (src && (src.media_player === screenPower(d) || src.media_player === tv)) { own = src; break; }
    }
    /* Nothing configured for this screen: work out what it is. The remote
     * entity is the same object id in the remote domain, which is how both
     * Samsung integrations name their pair — only used when it really
     * exists, so a guess can't invent an entity. */
    if (!own) {
      const use = guessRemote(tv, templates);
      if (use) {
        /* Both Samsung integrations name the pair with the same object id in
         * two domains, so whichever half the room gave us, look for the
         * other - and only use it if it really exists, so a guess can't
         * invent an entity. */
        const stem = tv.replace(/^[a-z_]+\./, "");
        const isRemote = tv.startsWith("remote.");
        own = isRemote ? { use, remote: tv } : { use, media_player: tv };
        const mate = (isRemote ? "media_player." : "remote.") + stem;
        if (hass && hass.states && hass.states[mate]) {
          if (isRemote) own.media_player = mate; else own.remote = mate;
        }
      }
    }
    if (!own || !own.use) {
      const bare = { type: "tile", entity: screenPower(d),
                     name: d.name || "", icon: d.icon || "mdi:television" };
      // no remote template, but a MAC still beats a turn_on that goes nowhere
      if (d.wake || d.wake_mac) {
        const act = wakeAction(d);
        bare.tap_action = act;
        bare.icon_tap_action = act;
      }
      out.push(bare);
      continue;
    }
    const spec = Object.assign({}, own, {
      when: screenPower(d),
      // remoteCards only draws the off face when the spec asks for one
      off_name: d.name || own.title || "TV",
      off_icon: d.icon || "mdi:television",
      // the switcher fills these in; a template that uses them for volume
      // shouldn't render a literal {{display_media}} just because the room
      // isn't using the switcher
      display: d.name || "",
      // volume belongs to a player. A remote-only screen has none, and a
      // template that asks for one should get a blank rather than a remote
      // entity it will try to read a volume level off.
      display_media: own.media_player
                     || (tv.startsWith("media_player.") ? tv : ""),
    });
    // waking belongs to the screen, not to whichever box is feeding it
    if (d.wake) spec.wake = d.wake;
    if (d.wake_mac) spec.wake_mac = d.wake_mac;
    if (d.wake_broadcast) spec.wake_broadcast = d.wake_broadcast;
    for (const c of remoteCards({ remotes: [spec] }, templates)) out.push(c);
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
 * the right. `climate_card` replaces the whole thing.
 *
 * That one line stops working the moment the thermostat is off. An off
 * thermostat reports no target temperature, so the +/- renders blank and
 * sets nothing — the control is there, it just has nothing to do. And the
 * thing you actually came to do, turn it on to heat or cool, isn't offered
 * at all.
 *
 * So the two swap places. Off: the mode buttons, and no setpoint at all,
 * because a dead +/- is worse than no +/-. Running: the setpoint on its one
 * line, and no buttons, because they would be noise. The modes come from
 * whatever the entity says it supports rather than a list anyone has to
 * maintain. `climate_modes` still pins an explicit list and keeps it in
 * both states, for a room that wants that — the setpoint still goes away
 * while it's off even then.
 *
 * The pop-up hands its cards new hass but never rebuilds them, so which of
 * the two you get is settled when the pop-up opens: turn it on from here and
 * the buttons stay until you close and reopen it — useful, as it happens,
 * for changing your mind. */
/* The one boundary the thermostat card's shape turns on. Shared so the
 * builder and the watcher can never disagree about which side it is on. */
function climateIdle(r, hass) {
  const ent = r && r.climate_entity;
  const st = ent && hass && hass.states && hass.states[ent];
  return !st || st.state === "off";
}

function climateCard(r, hass) {
  if (r.climate_card) return r.climate_card;        // hand-written wins
  const card = {
    type: "tile",
    entity: r.climate_entity,
    state_content: ["hvac_action", "current_temperature"],
  };
  if (r.climate_name) card.name = r.climate_name;

  const st = hass && hass.states && hass.states[r.climate_entity];
  const idle = climateIdle(r, hass);
  const pinned = r.climate_modes && r.climate_modes.length ? r.climate_modes : null;
  const modes = pinned
    || (idle && st && st.attributes && st.attributes.hvac_modes) || null;
  // one mode is not a choice, it's a label
  const showModes = !!(modes && modes.length > 1);

  const features = [];
  if (!idle) features.push({ type: "target-temperature" });
  if (showModes) features.push({ type: "climate-hvac-modes", style: "icons",
                                 hvac_modes: modes });

  /* A tile with an empty features array still reserves the row, so the key
   * is left off entirely when there is nothing to put in it — an off
   * thermostat whose entity offers no modes to choose between. */
  if (features.length) {
    card.features = features;
    // the lone setpoint still reads best on the title's own line
    card.features_position = showModes ? "bottom" : "inline";
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

/* The garages are a subset of alert_sensors, not a list of their own — which
 * is why the room tile used to show an open garage twice: once as its own
 * chip in the row, and again in the corner icon, which reads the whole of
 * alert_sensors and draws a garage glyph for any open cover. The chip is
 * gone from room-card.json for that reason, and because the subset relation
 * holds by construction, the corner cannot miss anything the chip showed.
 * The pop-up header keeps its garage chip: there is no corner icon there,
 * so it is the only thing saying a door is open. */
/* Which of a room's alert sensors are open right now, honouring the room's
 * confirm sensor. It lives on `window` because three separate places in
 * room-card.json need the same answer — the corner icon, the grid column it
 * takes up, and the width the name is then allowed to assume — and a
 * button-card template can only reach a shared implementation through a
 * global. Passing it in as a card variable instead would freeze it:
 * variables are computed once when the card is built, and this has to stay
 * live. Three copies of the filter would be three chances to drift. */
function charroOpenAlerts(v, states) {
  const open = (st) => st === "Violated" || st === "on" || st === "open";
  const cs = v && v.confirm_sensor;
  if (cs && !open(states[cs] && states[cs].state)) return [];
  return ((v && v.alert_sensors) || []).filter((e) => {
    const st = states[e] && states[e].state;
    if (!st) return false;
    return e.startsWith("cover.") ? st !== "closed" : open(st);
  });
}
if (typeof window !== "undefined") window.charroOpenAlerts = charroOpenAlerts;

/* The tile's corner badge took its glyph from the FIRST open sensor and its
 * number from ALL of them. A garage with one door up and the entry door ajar
 * therefore drew a garage icon with a 2 beside it, which reads as two garage
 * doors open. The count was right and the icon was lying.
 *
 * Group by glyph instead, so every number belongs to the icon next to it:
 * one badge per kind, each counting only its own. The pop-up header has
 * worked this way since 5.6.0 - this is the tile catching up, and the two
 * finally describing the same room in the same language.
 *
 * On `window` for the same reason charroOpenAlerts is: the template needs
 * the same answer in three places and a button-card template can only reach
 * a shared implementation through a global. */
function charroAlertIcon(id) {
  if (String(id).startsWith("cover.")) return "mdi:garage-open";
  if (String(id).includes("window")) return "mdi:window-open-variant";
  if (String(id).includes("motion")) return "mdi:motion-sensor";
  return "mdi:door-open";
}

function charroAlertGroups(v, states) {
  const out = [];
  for (const id of charroOpenAlerts(v, states)) {
    const icon = charroAlertIcon(id);
    const hit = out.find((g) => g[0] === icon);
    if (hit) hit[1]++;
    else out.push([icon, 1]);
  }
  return out;
}
if (typeof window !== "undefined") {
  window.charroAlertIcon = charroAlertIcon;
  window.charroAlertGroups = charroAlertGroups;
}

/* The TV a room's chip should follow.
 *
 * There are two places a room can name its television and they were not
 * talking to each other. `tv_entity` is the Media section's field, and it
 * is what every chip reads. But most rooms never fill it: they add a screen
 * under Media & remotes instead, and the television is that screen's power
 * entity. The result was a room with a properly configured TV and no TV
 * chip, because the chip was watching the field nobody filled in.
 *
 * So tv_entity still wins when it is set, and otherwise the screens answer
 * the question. What is excluded is the projector: Theatre's display is
 * powered by switch.theatre_projector, which already has its own chip, and
 * promoting it to "the TV" would show one device twice under two icons.
 *
 * 4.89: a screen's power doesn't have to be a media_player. A television fed
 * by the RTI matrix is switched over HDMI-CEC, so its power entity is the
 * matrix's switch - reliable, because CEC is the one control path a modern
 * Samsung still honours. But a switch can only switch: it has no volume, no
 * buttons, nothing playing. So a screen can name its own `media_player` as
 * well, and then the two do different jobs - the switch says whether the
 * screen is on and turns it on, the player carries the remote. That player
 * is what the chip follows when it is set, since it is the one that knows
 * what is on screen. */
/* A screen is two questions that are usually one answer: what is it, and
 * what turns it on. For a television wired straight to the wall they are the
 * same entity and only `screen` is filled in. For a set fed by the RTI
 * matrix they come apart - `screen` is the TV, carrying the remote, the
 * volume and what is playing, and `power` is the matrix switch, which is
 * what actually turns it on over HDMI-CEC and what reports whether it is on.
 *
 * Either field answers for the other when it is blank, so a room that fills
 * in only one still works, and `media_player` is read as `screen` for rooms
 * saved by 4.89 and 4.90, when that was its name. */
function screenTv(d) {
  return (d && (d.screen || d.media_player || d.power)) || "";
}

function screenPower(d) {
  return (d && (d.power || d.screen || d.media_player)) || "";
}

/* Fold an older screen into the two fields. The editor does this on load, so
 * the boxes show what the room is really doing and a save writes it back in
 * the current shape. */
/* Stamped on a video block the moment the editor has folded it forward, so
 * the fold below can never run twice. Without it a screen that deliberately
 * names only `power` - a television there is no integration for, switched
 * by the matrix - would have that power absorbed into `screen` every time
 * the room was opened, quietly undoing the configuration. */
const VIDEO_SCHEMA = 2;

function migrateVideoSchema(v) {
  if (!v || v.schema >= VIDEO_SCHEMA) return false;
  for (const d of v.displays || []) migrateScreen(d);
  v.schema = VIDEO_SCHEMA;
  return true;
}

function migrateScreen(d) {
  if (!d || typeof d !== "object" || d.screen) return false;
  if (d.media_player) { d.screen = d.media_player; delete d.media_player; return true; }
  if (d.power) { d.screen = d.power; delete d.power; return true; }
  return false;
}

function roomTv(r) {
  if (!r) return "";
  if (r.tv_entity) return r.tv_entity;
  const screens = ((r.video && r.video.displays) || [])
    .filter((d) => d && screenPower(d) !== r.projector_entity)
    .map(screenTv)
    .filter((p) => p && p !== r.projector_entity);
  return screens.find((p) => p.startsWith("media_player.")) || screens[0] || "";
}

/* The sensor that says a car is in the bay.
 *
 * `vehicle_entity` on the door still wins, but almost nobody fills it in,
 * and for a ratgdo it is derivable: the vehicle sensor is a sibling of the
 * cover on the same HA device. So the three Disco openers on the west side
 * light up green with nothing configured, and the three plain openers on
 * the east - which have no such sensor to find - simply never do.
 *
 * Two routes to the same sibling: the shared object id, which is a string
 * swap and needs nothing from the registry, and failing that the device it
 * is attached to. Scanning the registry is O(entities), so that second one
 * is done once per device and remembered. The cache is keyed on the registry object itself rather than
 * on time: Home Assistant replaces `hass.entities` wholesale when the
 * registry changes, so adding the sensor later busts this by itself, and a
 * hit costs one identity comparison. */
let _vehReg = null;
let _vehCache = new Map();

function vehicleFor(entry, hass) {
  const o = typeof entry === "object" && entry ? entry : {};
  if (o.vehicle_entity) return o.vehicle_entity;
  const id = o.entity || (typeof entry === "string" ? entry : "");
  if (!id) return "";
  const ents = (hass && hass.entities) || null;
  const states = (hass && hass.states) || {};

  /* The ratgdo names its entities off one object id, so the sibling is
   * usually just the suffix swapped. Try that before walking the registry:
   * it is two string operations, it needs no `device_id` - which not every
   * Home Assistant build puts in this map - and it is checked against
   * `states` so a guess that doesn't exist is no answer at all. */
  const stem = id.slice(id.indexOf(".") + 1).replace(/_door$/, "");
  const guess = `binary_sensor.${stem}_vehicle_detected`;
  if (states[guess]) return guess;

  const reg = ents && ents[id];
  const dev = reg && reg.device_id;
  if (!dev) return "";
  if (_vehReg !== ents) { _vehReg = ents; _vehCache = new Map(); }
  if (_vehCache.has(dev)) return _vehCache.get(dev);
  let found = "";
  for (const k in ents) {
    const e = ents[k];
    if (!e || e.device_id !== dev) continue;
    const eid = e.entity_id || k;
    if (eid.startsWith("binary_sensor.") && eid.endsWith("_vehicle_detected")) {
      found = eid; break;
    }
  }
  _vehCache.set(dev, found);
  return found;
}

/* The four states a garage door can be in, decided once so the chip and the
 * security card can't come to different conclusions about the same door.
 * The order is the card's order: moving beats open beats a parked car. */
function garageState(entry, hass, guarded) {
  const o = typeof entry === "object" && entry ? entry : {};
  const id = o.entity || (typeof entry === "string" ? entry : "");
  const st = id && hass && hass.states && hass.states[id];
  if (!st) return null;
  const raw = String(st.state);
  const s = raw.toLowerCase();
  const veh = vehicleFor(entry, hass);
  const car = !!(veh && hass.states[veh] && hass.states[veh].state === "on");
  const mode = o.alert_mode || (id.startsWith("cover.") ? "open" : "violated");
  const bad = mode === "open" ? s !== "closed" : raw === "Violated";
  let kind = "shut";
  // the room's guard is what stops a ratgdo's phantom Opening reaching here
  if (!guarded && (s === "opening" || s === "closing")) kind = "move";
  else if (!guarded && bad) kind = "open";
  else if (car) kind = "car";
  return { entity: id, kind, car, name: entLabel(entry, hass, "label") };
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
  // `video` merged into `media` in 4.84. A layout that still names it draws
  // the merged block rather than nothing at all.
  if (name === "video") name = "media";

  if (name === "climate" && r.climate_entity) push(climateCard(r, hass));

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

  /* 4.84: screens, remotes and the plain AV tiles are one block. There was
   * never a reason for two: a room has one television, and splitting it
   * across "Media" and "Video / remotes" meant every room with a TV had to
   * be told twice about it — and showed it twice when it was.
   *
   * Order inside the block: the screens first, because that is what you
   * walked into the room to use; then the tiles for anything with no remote;
   * then the loose remotes. */
  if (name === "media") {
    const screens = new Set();              // what the video half already draws
    if (r.video) {
      for (const d of r.video.displays || []) {
        if (screenPower(d)) screens.add(screenPower(d));
        if (screenTv(d)) screens.add(screenTv(d));
      }
      if (videoIsBasic(r.video)) for (const c of videoSimpleCards(r, hass)) push(c);
      else push({ type: "custom:charro-video-card", video: r.video,
                  templates: r._remotes || {} });
    }

    // A device a remote already watches doesn't want a plain tile too: the
    // remote pair covers both states, so the tile would only ever be a
    // duplicate of whichever half is showing.
    const covered = new Set(screens);
    for (const spec of r.remotes || []) {
      const w = remoteWatch(spec);
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
    /* A loose remote for a screen the video half is already drawing is the
     * duplicate this merge exists to remove — both faces of it would be on
     * screen twice, once from the switcher and once from here. The screen
     * wins, because it knows which source is live. */
    const loose = (r.remotes || []).filter((s) => !screens.has(remoteWatch(s)));
    for (const c of remoteCards({ ...r, remotes: loose }, r._remotes || {})) push(c);
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
      // what it was built from, so a card whose shape depends on state can
      // be found again and rebuilt without re-rendering the whole body
      el.__charroCfg = cfg;
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

/* 4.84 merged `video` into `media`. A saved layout may name one, the other,
 * or both, and "both" is the case that matters: drawing the merged block
 * twice would put the switcher on screen twice. So collapse them into a
 * single `media` item at the position of whichever came first, and if the
 * layout places one while `hidden` parks the other, drop the parked half —
 * they are one thing now, and the one you can see wins.
 *
 * Runs after migrateMusic, so a room that named only `video` doesn't get a
 * music block it never had. */
function migrateVideo(r) {
  const has = (list) => (list || []).some((it) => it &&
    (it.block === "video" || (it.group !== undefined && has(it.items))));
  if (!has(r.layout) && !has(r.hidden)) return r;

  let kept = false;                     // the one media item, already placed
  const walk = (list) => (list || []).flatMap((it) => {
    if (!it) return [];
    if (it.group !== undefined) return [{ ...it, items: walk(it.items) }];
    if (it.block !== "video" && it.block !== "media") return [it];
    if (kept) return [];                // the second half of the pair
    kept = true;
    return [{ ...it, block: "media" }];
  });

  const out = { ...r };
  if (r.layout) out.layout = walk(r.layout);
  if (r.hidden) out.hidden = walk(r.hidden);   // second, so a placed block wins
  return out;
}

function roomBody(r, hass) {
  if (!(r.layout && r.layout.length)) return autoBody(r, hass);
  return layoutBody(migrateVideo(migrateMusic(r)), hass);
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

/* Lovelace resources — the modules that define button-card, mushroom and
 * card-mod — are loaded by the dashboard, not by Home Assistant itself. A
 * sidebar panel is not a dashboard, so on /charro-rooms none of them exist.
 * charro-room-card is defined there (the integration injects it on every
 * page), so it builds happily and then fails the moment it asks for its
 * inner `custom:button-card` — which is why every preview in the editor
 * said "Configuration error" while the same room rendered perfectly on a
 * view, and why the one card that did render was a core `tile`.
 *
 * So the panel fetches the same list the dashboard would and loads it
 * itself. customElements is per-document, so once a module has run its
 * definitions are there for the preview too.
 *
 * Lazily and once: opening the editor to rename a room shouldn't pay for a
 * few hundred KB of card modules, and nothing is re-injected that the page
 * already has — on a dashboard, where the editor can also live as a card,
 * every one of these is already in the document and this does nothing. */
let _resP = null;
const _resSeen = new Set();

function _resHere(url) {
  let abs;
  try { abs = new URL(url, location.href).href; } catch (e) { return false; }
  if (_resSeen.has(abs)) return true;
  for (const n of document.querySelectorAll("script[src], link[href]")) {
    if (n.src === abs || n.href === abs) { _resSeen.add(abs); return true; }
  }
  _resSeen.add(abs);
  return false;
}

function loadResource(res) {
  const url = res && res.url;
  if (!url || _resHere(url)) return Promise.resolve(null);
  return new Promise((done) => {
    let el;
    if (res.type === "css") {
      el = document.createElement("link");
      el.rel = "stylesheet";
      el.href = url;
    } else {
      el = document.createElement("script");
      el.src = url;
      // "module" is what everything current ships as; "js" is the legacy
      // classic script. HA's old html imports stopped working years ago.
      if (res.type !== "js") el.type = "module";
    }
    // one bad URL shouldn't hang every preview behind it
    el.addEventListener("load", () => done(url), { once: true });
    el.addEventListener("error", () => {
      console.warn("Charro Cards: resource failed to load", url);
      done(null);
    }, { once: true });
    document.head.appendChild(el);
  });
}

function loadLovelaceResources(hass) {
  if (_resP) return _resP;
  if (!hass || !hass.callWS) return Promise.resolve([]);
  _resP = hass.callWS({ type: "lovelace/resources" })
    .then((list) => Promise.all((list || []).map(loadResource)))
    .then((done) => done.filter(Boolean))
    .catch((err) => {
      // storage-mode dashboards only; a YAML-mode instance has no such
      // command, and there is nothing to do about it from here
      console.warn("Charro Cards: couldn\u2019t read the resource list", err);
      _resP = null;                      // transient failures can be retried
      return [];
    });
  return _resP;
}

/* ----------------------------------------------------------- scenes ----- */
/* A scene is what the room looked like, recalled later. It is stored in the
 * room file as a plain entity -> state map and applied with HA's own
 * `scene.apply`, which takes that map inline: no scene entity is created,
 * nothing is left behind, and HA's state-reproduction does the work, so
 * brightness, colour temperature, fan percentage, hvac mode, source and
 * volume all land correctly without this file knowing how any of them work.
 *
 * Everything below is deliberately plain data in and out, so the store can
 * become real HA scenes later without the capture or the UI changing. */

const SCENE_GROUPS = [
  ["lights",  "Lights",  "mdi:lightbulb"],
  ["fans",    "Fans",    "mdi:ceiling-fan"],
  ["climate", "Climate", "mdi:thermostat"],
  ["music",   "Music",   "mdi:music"],
  ["screens", "Screens", "mdi:television"],
];

/* Which attributes are worth keeping per domain. State alone would lose the
 * dim level and the input; everything is too much, and a captured
 * `friendly_name` or `supported_features` only invites HA to argue with it. */
const SCENE_ATTRS = {
  light: ["brightness", "color_temp_kelvin", "hs_color", "rgb_color",
          "color_mode", "effect"],
  fan: ["percentage", "preset_mode", "direction", "oscillating"],
  climate: ["temperature", "target_temp_high", "target_temp_low",
            "fan_mode", "humidity", "swing_mode"],
  media_player: ["source", "volume_level"],
  cover: ["current_position", "current_tilt_position"],
};

function sceneGroupIds(r, group) {
  const ids = [];
  const add = (x) => { const id = lightId(x); if (id) ids.push(id); };
  if (group === "lights") {
    for (const k of ["light_entities", "landscape_entities"]) (r[k] || []).forEach(add);
  } else if (group === "fans") {
    for (const k of ["fan_entities", "bath_fan_entities"]) (r[k] || []).forEach(add);
  } else if (group === "climate") {
    if (r.climate_entity) ids.push(r.climate_entity);
  } else if (group === "music") {
    for (const p of r.music_powers || []) {
      const id = typeof p === "string" ? p : (p && (p.entity || p.power));
      if (id) ids.push(id);
    }
    if (r.media_player) ids.push(r.media_player);
  } else if (group === "screens") {
    for (const d of (r.video && r.video.displays) || []) {
      const pw = screenPower(d), tv = screenTv(d);
      if (pw) ids.push(pw);
      if (tv) ids.push(tv);
      const src = d && (d.source_from || d.source);
      if (src) ids.push(src);
    }
    for (const k of ["tv_entity", "projector_entity", "receiver_entity"])
      if (r[k]) ids.push(r[k]);
  }
  return uniq(ids);
}

/* Only offer a tick-box for something the room actually has. */
function sceneGroupsFor(r) {
  return SCENE_GROUPS.filter(([k]) => sceneGroupIds(r, k).length);
}

function captureScene(r, groups, hass) {
  const out = {};
  const states = (hass && hass.states) || {};
  for (const g of groups) {
    for (const id of sceneGroupIds(r, g)) {
      const st = states[id];
      // an entity HA can't see would be recalled as a guess, so skip it
      if (!st || st.state === "unavailable" || st.state === "unknown") continue;
      const e = { state: st.state };
      for (const a of SCENE_ATTRS[id.split(".")[0]] || []) {
        const v = st.attributes ? st.attributes[a] : undefined;
        if (v !== undefined && v !== null) e[a] = v;
      }
      out[id] = e;
    }
  }
  return out;
}

function applyScene(hass, entities) {
  if (!entities || !Object.keys(entities).length) return Promise.resolve();
  return hass.callService("scene", "apply", { entities });
}

/* Read the room back from the server before writing, so a scene saved from
 * a dashboard can't overwrite an edit made in the editor a moment earlier,
 * and so the card's own merged copy - which carries the card's config keys
 * on top of the file - never becomes the file. */
async function writeScenes(hass, key, mutate) {
  const fresh = await loadRoom(key, hass);
  const next = { ...(fresh || {}) };
  delete next._remotes;
  const scenes = { ...(next.scenes || {}) };
  mutate(scenes);
  if (Object.keys(scenes).length) next.scenes = scenes;
  else delete next.scenes;
  await hass.callWS({ type: WS_SAVE, key, config: next });
  invalidateRooms();
  return next;
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

/* The pop-up is a dialog, and a theme that has thought about dialogs has
 * already said what one should look like — so take those answers rather
 * than inventing a surface. Frosted Glass Dark sets a 0.7 surface, an 8px
 * frost and a 0.8 scrim; a theme that sets none of them falls through to
 * the card variables and then to the values this used before, so nothing
 * depends on any particular theme defining them.
 *
 * What is deliberately NOT themed: the open-door red. That belongs to the
 * chip palette, not the dialog chrome, and pulling it from --error-color
 * would leave the header's door a different red from the same door's chip
 * two inches away. */
const POPUP_CSS = `
.charro-pop-backdrop{
  position:fixed; inset:0; z-index:8;
  background:var(--mdc-dialog-scrim-color, rgba(0,0,0,.45));
  backdrop-filter:blur(10px);
  -webkit-backdrop-filter:blur(10px);
  opacity:0; transition:opacity .22s ease;
}
.charro-pop-backdrop.in{ opacity:1; }
.charro-pop{
  position:fixed; left:0; right:0; bottom:0; z-index:9;
  max-height:88vh; overflow:auto; box-sizing:border-box;
  padding:14px 14px calc(18px + env(safe-area-inset-bottom,0px));
  background:var(--ha-dialog-surface-background,
             var(--ha-card-background, var(--card-background-color, #fff)));
  backdrop-filter:var(--ha-dialog-surface-backdrop-filter, none);
  -webkit-backdrop-filter:var(--ha-dialog-surface-backdrop-filter, none);
  border:var(--ha-card-border-width, 1px) solid
         var(--ha-card-border-color, var(--divider-color, transparent));
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
  border:none; color:var(--primary-text-color);
  background:color-mix(in srgb, var(--primary-text-color, #fff) 12%, transparent);
  width:32px; height:32px; border-radius:50%; cursor:pointer;
  display:grid; place-items:center; font:inherit; flex:none;
}
.charro-pop-hd .tail > button:hover{
  background:color-mix(in srgb, var(--primary-text-color, #fff) 20%, transparent);
}
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
/* ----- room scenes --------------------------------------------------------
 * The panel hangs off the header it was opened from, so it can't be left
 * behind by a scroll, and carries its own max-height: a room with a dozen
 * scenes scrolls the list, not the pop-up. */
.charro-pop-hd .tail > button.on{
  background:color-mix(in srgb, var(--primary-color, #03a9f4) 30%, transparent);
  color:var(--primary-color, #03a9f4);
}
.charro-scenes{
  position:absolute; top:calc(100% + 6px); right:0; z-index:3;
  width:min(300px, calc(100vw - 48px));
  max-height:min(60vh, 420px); overflow:auto;
  box-sizing:border-box; padding:8px; text-align:left; font-size:14px;
  background:var(--ha-card-background, var(--card-background-color, #1c1c1c));
  border:1px solid var(--divider-color, rgba(255,255,255,.12));
  border-radius:14px; box-shadow:0 10px 30px rgba(0,0,0,.45);
}
.charro-scenes .sc-hint{
  padding:6px 8px; color:var(--secondary-text-color); font-size:12.5px;
}
.charro-scenes .sc-err{
  padding:6px 8px; color:var(--error-color, #ef5350); font-size:12.5px;
}
.charro-scenes .sc-row{ display:flex; align-items:center; gap:4px; }
.charro-scenes button{
  border:none; background:none; color:var(--primary-text-color);
  font:inherit; cursor:pointer; border-radius:10px;
}
.charro-scenes button[disabled]{ opacity:.5; cursor:default; }
.charro-scenes .sc-go{
  flex:1 1 auto; min-width:0; display:flex; align-items:center; gap:8px;
  padding:8px; text-align:left;
}
.charro-scenes .sc-go span{
  min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
}
.charro-scenes .sc-go:hover,
.charro-scenes .sc-ed:hover,
.charro-scenes .sc-add:hover{
  background:color-mix(in srgb, var(--primary-text-color, #fff) 10%, transparent);
}
.charro-scenes .sc-ed{
  flex:none; width:32px; height:32px; display:grid; place-items:center;
}
.charro-scenes ha-icon{
  --mdc-icon-size:18px; width:18px; height:18px; flex:none;
  display:flex; align-items:center; justify-content:center; line-height:0;
}
.charro-scenes .sc-edit{ display:flex; gap:6px; padding:0 8px 8px 34px; }
.charro-scenes .sc-edit button,
.charro-scenes .sc-save button{
  padding:6px 12px; font-size:13px; font-weight:600;
  background:color-mix(in srgb, var(--primary-text-color, #fff) 12%, transparent);
}
.charro-scenes .sc-edit button.danger{ color:var(--error-color, #ef5350); }
.charro-scenes .sc-sep{
  height:1px; margin:6px 2px;
  background:var(--divider-color, rgba(255,255,255,.12));
}
.charro-scenes .sc-add{
  width:100%; display:flex; align-items:center; gap:8px; padding:8px;
}
.charro-scenes .sc-groups{
  display:flex; flex-direction:column; gap:2px; padding:4px 2px;
}
.charro-scenes .sc-groups label{
  display:flex; align-items:center; gap:8px; padding:5px 6px;
  border-radius:10px; cursor:pointer;
}
.charro-scenes .sc-groups label:hover{
  background:color-mix(in srgb, var(--primary-text-color, #fff) 8%, transparent);
}
.charro-scenes .sc-groups input{ accent-color:var(--primary-color, #03a9f4); margin:0; }
.charro-scenes .sc-save{
  display:flex; gap:6px; align-items:center; padding:4px 2px 2px;
}
.charro-scenes .sc-save input[type=text]{
  flex:1 1 auto; min-width:0; box-sizing:border-box; padding:7px 9px;
  border-radius:10px; font:inherit; color:var(--primary-text-color);
  background:color-mix(in srgb, var(--primary-text-color, #fff) 8%, transparent);
  border:1px solid var(--divider-color, rgba(255,255,255,.12));
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
  /* A garage door's own four states. These are the security page's exact
   * values, lifted out of garage-card.json so the page and the pop-up
   * header read the same door the same way. The page is unchanged to the
   * hex; what moved is the chip, which used to borrow `red` and so sat a
   * shade off the tile it was describing. Door red is deliberately not
   * `red`: an open garage is a different claim from a violated window. */
  door_open: { bg: "rgba(244,67,54,0.20)",   fg: "#f44336" },
  door_car:  { bg: "rgba(76,175,80,0.20)",   fg: "#4CAF50" },
  door_move: { bg: "rgba(255,152,0,0.22)",   fg: "#ff9800" },
  door_shut: { bg: "rgba(255,255,255,0.12)", fg: "white" },
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
const CHIP_DOOR_OPEN = pal("door_open");
const CHIP_DOOR_CAR  = pal("door_car");
const CHIP_DOOR_MOVE = pal("door_move");
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
    const id = key === "tv_entity" ? roomTv(r) : r[key];
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

  /* The one you'd want to know about from across the house, and now it
   * reads like its own tile on the security page: the same four states, the
   * same colours and the same glyphs, out of the palette they share.
   *
   * Grouped by state rather than one chip per door, because the west bay
   * has three and three red chips in a row say nothing the count doesn't.
   * A door closed over an empty bay is the one state with nothing to
   * report, so it draws no chip - which is also why an east door, with no
   * vehicle sensor to find, is silent until it actually opens. */
  const garages = garageSensors(r, hass);
  if (garages.length) {
    const cs = r.confirm_sensor;
    const csSt = cs && hass.states[cs];
    const guarded = !!cs &&
      !OPENISH.includes(String(csSt && csSt.state).toLowerCase());
    const by = { move: [], open: [], car: [] };
    let anyCar = false;
    for (const e of garages) {
      const g = garageState(e, hass, guarded);
      if (!g) continue;
      if (g.car) anyCar = true;
      if (by[g.kind]) by[g.kind].push(g);
    }
    for (const [list, icon, col, tail] of [
      [by.move, "mdi:garage-open", CHIP_DOOR_MOVE, "on the move."],
      [by.open, anyCar ? "mdi:garage-open-variant" : "mdi:garage-open",
       CHIP_DOOR_OPEN, "open."],
      [by.car, "mdi:garage-variant", CHIP_DOOR_CAR, "shut with a car inside."],
    ]) {
      if (!list.length) continue;
      out.push({ key: `garage-${tail.split(" ")[0]}`, icon, col,
                 text: list.length > 1 ? String(list.length) : "",
                 title: `${listNames(list)} ${tail}`,
                 tap: { kind: "more-info", entity: list[0].entity } });
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
    this._scOpen = false; this._scPanel = null; this._scBtn = null;
  }
  set hass(h) {
    this._hass = h;
    for (const c of this._cards || []) c.hass = h;
    this._syncClimate();
    // hass ticks constantly; only redraw the header when something it shows
    // has actually moved, or a busy house would rebuild it hundreds of times
    if (!this._hd) return;
    /* The scenes panel hangs off the header, and the rebuild below replaces
     * the header whole - which under an open panel would wipe a half-typed
     * scene name and a set of tick boxes. The chips go stale for as long as
     * it is open; _scClose() forces the redraw they missed. */
    if (this._scOpen) return;
    const sig = this._headerSig();
    if (sig === this._hdSig) return;
    this._hdSig = sig;
    const next = this._header();
    this._hd.replaceWith(next);
    this._hd = next;
  }

  /* Every other card in the body answers a state change by redrawing
   * itself; the thermostat is the one whose *shape* depends on state —
   * setpoint while it runs, mode buttons while it's off — and a card's
   * config is fixed once it is built. So this watches that one boundary and
   * rebuilds just that card when it is crossed, leaving the rest of the
   * body, its scroll position and its other cards alone.
   *
   * Only the off/on transition counts. hass ticks constantly and a running
   * thermostat changes temperature all day without changing shape, so the
   * comparison is the boolean, not the state string. */
  _syncClimate() {
    const r = this.room, hass = this._hass;
    const ent = r && r.climate_entity;
    // a hand-written climate_card is the room's business, not ours to swap
    if (!ent || !hass || !hass.states || r.climate_card) return;
    const idle = climateIdle(r, hass);
    if (this._climateIdle === undefined) { this._climateIdle = idle; return; }
    if (idle === this._climateIdle || this._climateBusy) return;
    this._climateIdle = idle;
    this._swapClimate();
  }

  async _swapClimate() {
    this._climateBusy = true;
    try {
      const cards = this._cards || [];
      const old = cards.find((c) => {
        const cfg = c && c.__charroCfg;
        return cfg && cfg.type === "tile" && cfg.entity === this.room.climate_entity;
      });
      // the pop-up may have closed, or the room may not show its thermostat
      if (!old || !old.isConnected) return;
      const helpers = await window.loadCardHelpers();
      if (!this.el) return;                     // closed while we awaited
      const cfg = climateCard(this.room, this._hass);
      const next = helpers.createCardElement(cfg);
      next.hass = this._hass;
      next.style.display = "block";
      next.__charroCfg = cfg;
      old.replaceWith(next);
      const i = cards.indexOf(old);
      if (i >= 0) cards[i] = next;              // so later hass ticks reach it
    } catch (err) {
      console.error("charro-room-card: climate swap", err);
    } finally {
      this._climateBusy = false;
    }
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
      [r.media_player, roomTv(r), r.projector_entity, r.receiver_entity, r.climate_entity],
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
    /* Record the shape the body was actually built with, rather than
     * whichever hass tick happened to arrive first — otherwise a thermostat
     * that changed between the two would leave the two out of step and the
     * next real transition would be missed. */
    this._climateIdle = climateIdle(this.room, this._hass);

    const panel = this.el, back = this.backdrop;
    panel.append(hd, body);
    host.append(back, panel);
    requestAnimationFrame(() => {
      // close() may already have run and nulled these
      if (this.el !== panel) return;
      back.classList.add("in");
      panel.classList.add("in");
    });

    this._key = (ev) => {
      if (ev.key !== "Escape") return;
      // one Escape per layer, or a scene half-named would take the room with it
      if (this._scOpen) { this._scClose(); return; }
      this.dismiss();
    };
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

    /* Scenes belong to the room, so the button sits with the room's own
     * buttons. Only on the room's own pop-up - the now-playing panel is a
     * different thing wearing the same frame - and only when there is
     * something behind it: for anyone who can't save, an empty list is a
     * button that does nothing. */
    if (this.room.room && !this.bodyFn
        && (this._scAdmin() || Object.keys(this._scenes()).length)) {
      const sb = document.createElement("button");
      sb.title = "Scenes";
      sb.setAttribute("aria-label", "Scenes");
      sb.innerHTML = `<ha-icon icon="mdi:palette"></ha-icon>`;
      if (this._scOpen) sb.classList.add("on");
      sb.addEventListener("click", () => this._scToggle());
      tail.appendChild(sb);
      this._scBtn = sb;
    }

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
    if (this._scOpen) {
      const p = this._scPanelEl();
      this._scPanel = p;
      hd.appendChild(p);
    }
    return hd;
  }

  /* ----------------------------------------------------------- scenes ---
   * One room, its own scenes, kept in its own file. The palette button
   * opens the panel; a tap on a row applies it with `scene.apply`, so
   * nothing is created in Home Assistant and HA's own state-reproduction
   * does the recall. Admins save, update and delete; everyone applies. */

  _scAdmin() {
    const u = this._hass && this._hass.user;
    return !!(u && u.is_admin);
  }
  _scenes() { return (this.room && this.room.scenes) || {}; }

  _scToggle() {
    if (this._scOpen) { this._scClose(); return; }
    this._scOpen = true;
    this._scEdit = null; this._scMode = null; this._scDel = null;
    this._scErr = ""; this._scName = "";
    this._scGroups = new Set(sceneGroupsFor(this.room).map(([k]) => k));
    this._scRedraw();
  }
  _scClose() {
    this._scOpen = false;
    if (this._scPanel) { try { this._scPanel.remove(); } catch (err) {} }
    this._scPanel = null;
    if (this._scBtn) this._scBtn.classList.remove("on");
    // the chips stood still while the panel held the header; catch them up
    this._hdSig = null;
    if (this._hass) this.hass = this._hass;
  }
  _scRedraw() {
    if (!this._hd || !this._scOpen) return;
    const next = this._scPanelEl();
    if (this._scPanel && this._scPanel.isConnected) this._scPanel.replaceWith(next);
    else this._hd.appendChild(next);
    this._scPanel = next;
    if (this._scBtn) this._scBtn.classList.add("on");
  }

  _scPanelEl() {
    const p = document.createElement("div");
    p.className = "charro-scenes";
    const admin = this._scAdmin();
    const scenes = this._scenes();
    const names = Object.keys(scenes);
    const groups = sceneGroupsFor(this.room);

    if (!names.length) {
      const h = document.createElement("div");
      h.className = "sc-hint";
      h.textContent = admin
        ? "No scenes yet. Set the room how you want it, then save it below."
        : "No scenes saved for this room.";
      p.appendChild(h);
    }

    for (const name of names) {
      const row = document.createElement("div");
      row.className = "sc-row";

      const go = document.createElement("button");
      go.className = "sc-go";
      go.title = `Apply ${name}`;
      const gi = document.createElement("ha-icon");
      gi.icon = scenes[name].icon || "mdi:palette";
      const gt = document.createElement("span");
      gt.textContent = name;
      go.append(gi, gt);
      go.addEventListener("click", () => this._scApply(name));
      row.appendChild(go);

      if (admin) {
        const ed = document.createElement("button");
        ed.className = "sc-ed";
        ed.title = `Edit ${name}`;
        ed.setAttribute("aria-label", `Edit ${name}`);
        ed.innerHTML = `<ha-icon icon="mdi:pencil"></ha-icon>`;
        ed.addEventListener("click", () => {
          const shut = this._scEdit === name && !this._scMode;
          this._scEdit = shut ? null : name;
          this._scMode = null; this._scDel = null; this._scErr = "";
          this._scRedraw();
        });
        row.appendChild(ed);
      }
      p.appendChild(row);

      if (admin && this._scEdit === name && !this._scMode) {
        const e = document.createElement("div");
        e.className = "sc-edit";
        const up = document.createElement("button");
        up.textContent = "Update";
        up.addEventListener("click", () => {
          this._scMode = "update";
          /* Re-open with the groups this scene was saved with, not with
           * everything: a lights-only scene asked to remember the lights,
           * and an update shouldn't quietly widen it. */
          const have = groups.map(([k]) => k);
          const was = scenes[name].groups;
          this._scGroups = new Set(
            (was && was.length ? was : have).filter((k) => have.includes(k)));
          this._scRedraw();
        });
        const del = document.createElement("button");
        del.className = "danger";
        del.textContent = this._scDel === name ? "Tap again to delete" : "Delete";
        del.addEventListener("click", () => {
          // two taps, because there is no undo on the other side of this
          if (this._scDel !== name) { this._scDel = name; this._scRedraw(); return; }
          this._scDelete(name);
        });
        e.append(up, del);
        p.appendChild(e);
      }

      if (admin && this._scEdit === name && this._scMode === "update")
        p.appendChild(this._scForm(groups, name));
    }

    if (admin) {
      const sep = document.createElement("div");
      sep.className = "sc-sep";
      p.appendChild(sep);
      if (!groups.length) {
        const h = document.createElement("div");
        h.className = "sc-hint";
        h.textContent = "This room has no lights, fans, climate, music or screens to remember.";
        p.appendChild(h);
      } else if (this._scMode === "new") {
        p.appendChild(this._scForm(groups, null));
      } else {
        const add = document.createElement("button");
        add.className = "sc-add";
        add.innerHTML =
          `<ha-icon icon="mdi:plus"></ha-icon><span>Save the room as a scene</span>`;
        add.addEventListener("click", () => {
          this._scMode = "new"; this._scEdit = null; this._scDel = null;
          this._scErr = "";
          this._scGroups = new Set(groups.map(([k]) => k));
          this._scRedraw();
        });
        p.appendChild(add);
      }
    }

    if (this._scErr) {
      const e = document.createElement("div");
      e.className = "sc-err";
      e.textContent = this._scErr;
      p.appendChild(e);
    }
    return p;
  }

  /* The tick boxes: what the scene should remember. Only what the room
   * actually has is offered, and an unticked group is left out of the
   * capture entirely, so a lights scene never touches the television.
   * The count beside each one is how many entities it covers. */
  _scForm(groups, name) {
    const wrap = document.createElement("div");

    const gs = document.createElement("div");
    gs.className = "sc-groups";
    for (const [k, label, icon] of groups) {
      const l = document.createElement("label");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = this._scGroups.has(k);
      // no redraw on a tick: the name field would lose what was typed in it
      cb.addEventListener("change", () => {
        if (cb.checked) this._scGroups.add(k); else this._scGroups.delete(k);
      });
      const i = document.createElement("ha-icon");
      i.icon = icon;
      const s = document.createElement("span");
      s.textContent = `${label} (${sceneGroupIds(this.room, k).length})`;
      l.append(cb, i, s);
      gs.appendChild(l);
    }
    wrap.appendChild(gs);

    const row = document.createElement("div");
    row.className = "sc-save";

    const save = document.createElement("button");
    save.textContent = this._scBusy ? "Saving…" : (name ? "Save over it" : "Save");
    save.disabled = !!this._scBusy;
    save.addEventListener("click", () => this._scSave(name));

    const cancel = document.createElement("button");
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => {
      this._scMode = null; this._scEdit = null; this._scErr = "";
      this._scRedraw();
    });

    let field = null;
    if (!name) {
      field = document.createElement("input");
      field.type = "text";
      field.placeholder = "Scene name";
      field.value = this._scName || "";
      field.addEventListener("input", () => { this._scName = field.value; });
      field.addEventListener("keydown", (ev) => {
        if (ev.key !== "Enter") return;
        ev.preventDefault();
        this._scSave(null);
      });
      row.appendChild(field);
    }
    row.append(save, cancel);
    wrap.appendChild(row);
    if (field) requestAnimationFrame(() => { try { field.focus(); } catch (err) {} });
    return wrap;
  }

  async _scApply(name) {
    const sc = this._scenes()[name];
    if (!sc) return;
    this._scClose();
    try {
      await applyScene(this._hass, sc.entities);
    } catch (err) {
      console.error("charro-room-card: apply scene", err);
    }
  }

  async _scSave(name) {
    const key = this.room && this.room.room;
    if (!key) {
      this._scErr = "This room has no file to save into.";
      this._scRedraw(); return;
    }
    const label = String(name || this._scName || "").trim();
    if (!label) { this._scErr = "Give the scene a name."; this._scRedraw(); return; }
    const groups = [...(this._scGroups || [])];
    if (!groups.length) {
      this._scErr = "Tick at least one thing to remember.";
      this._scRedraw(); return;
    }
    const entities = captureScene(this.room, groups, this._hass);
    if (!Object.keys(entities).length) {
      this._scErr = "Nothing in those groups is answering right now.";
      this._scRedraw(); return;
    }
    this._scBusy = true; this._scErr = "";
    this._scRedraw();
    try {
      const was = this._scenes()[label] || {};
      const next = await writeScenes(this._hass, key, (s) => {
        s[label] = { ...(was.icon ? { icon: was.icon } : {}), groups, entities };
      });
      this.room.scenes = next.scenes || {};
      this._scMode = null; this._scEdit = null; this._scName = "";
    } catch (err) {
      console.error("charro-room-card: save scene", err);
      this._scErr = (err && err.message) || "Could not save the scene.";
    } finally {
      this._scBusy = false;
      this._scRedraw();
    }
  }

  async _scDelete(name) {
    const key = this.room && this.room.room;
    if (!key) return;
    this._scBusy = true; this._scErr = ""; this._scDel = null;
    this._scRedraw();
    try {
      const next = await writeScenes(this._hass, key, (s) => { delete s[name]; });
      this.room.scenes = next.scenes || {};
      this._scEdit = null; this._scMode = null;
    } catch (err) {
      console.error("charro-room-card: delete scene", err);
      this._scErr = (err && err.message) || "Could not delete the scene.";
    } finally {
      this._scBusy = false;
      this._scRedraw();
    }
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
    this._scOpen = false; this._scPanel = null; this._scBtn = null;
    this._scEdit = null; this._scMode = null; this._scDel = null;
    this._scBusy = false; this._scErr = ""; this._scName = "";
    this._climateIdle = undefined; this._climateBusy = false;
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
      tv_entity: roomTv(c),
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
    /* ROOM_SINGLES covers tv_entity, but a room that names its television
     * through a screen instead has nothing there — and without the resolved
     * one here the tile never redraws when that TV turns on, so the chip
     * would only appear on a reload. */
    const tv = roomTv(c);
    if (tv) out.push(tv);
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
  tv_entity: "Only needed if the room has no screen under Media & remotes — " +
             "otherwise the chip follows that screen's TV on its own. " +
             "Either way it appears only while the TV is on.",
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
      // blank on almost every door, so the sibling sensor answers for it
      vehicle_entity: c.vehicle_entity || vehicleFor(c, this._hass),
      toggle_button: c.toggle_button || "",
      // the door's four colours, so the template carries none of its own
      pal: CHIP_PAL,
    };
  }

  /* An auto-found sensor has to be in here too, or button-card never hears
   * the car arrive and the tile stays white until something else redraws it. */
  triggers() {
    return uniq([this._config.vehicle_entity || vehicleFor(this._config, this._hass)]);
  }
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
  vehicle_entity: "Green when a car is in the bay, white when closed and empty. Blank finds the ratgdo's own vehicle sensor, if it has one.",
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
  /* The set of entities worth watching changes only when the registries do,
   * so it is found once and kept. Without this the signature walked all
   * ~2000 entities on every hass tick, which in a busy house is several
   * thousand wasted regex tests a second for a panel that is usually shut. */
  _scan() {
    const h = this._hass;
    if (this._scanDevs === h.devices && this._scanEnts === h.entities && this._watch) return;
    this._scanDevs = h.devices;
    this._scanEnts = h.entities;
    this._devs = ubiDevices(h);
    const byDev = entsByDevice(h);
    const ids = [];
    for (const d of this._devs) for (const e of byDev[d.id] || []) ids.push(e);
    for (const id in h.states)
      if (/_bssid$|_ssid$|_wifi_signal$|_connection_type$/.test(id)) ids.push(id);
    this._watch = uniq(ids);
  }

  _sig() {
    const h = this._hass;
    if (!h || !h.states || !h.devices) return "";
    this._scan();
    let s = "";
    for (const d of this._devs) s += `${d.id}:${d.sw_version || ""}|`;
    for (const id of this._watch) s += `${id}=${(h.states[id] || {}).state};`;
    return s;
  }

  /* A room with one screen has nothing to choose between, so it needs no
   * focus select and no chip row — that screen is always the focused one. */
  _single() {
    const d = this._v.displays || [];
    return !this._v.focus && d.length === 1 ? d[0] : null;
  }
  /* Which screen the panel is showing.
   *
   * A room can name an input_select as its screen picker and several do,
   * because the physical keypads set it too. A room that doesn't shouldn't
   * need one invented: before this, two screens and no picker left
   * _focusName() returning "" and the whole block rendering nothing below
   * the chips - the chips didn't even respond, since _pick had nothing to
   * write to. The choice now falls back to the card itself, starting on the
   * first screen, which is the same stateless treatment the view override
   * gets: it lives with the pop-up and nothing is stored. */
  _focusName() {
    const one = this._single();
    if (one) return one.name;
    if (this._v.focus) {
      const st = this._hass.states[this._v.focus];
      return st ? st.state : "";
    }
    const ds = this._v.displays || [];
    if (this._focus && ds.some((d) => d && d.name === this._focus)) return this._focus;
    return (ds[0] && ds[0].name) || "";
  }
  _display(name) {
    return (this._v.displays || []).find((d) => d.name === name) || null;
  }
  /* Where "which source is live" is read from. The receiver's own
   * media_player, usually - it is the thing that actually knows, so the card
   * cannot drift out of step with it the way a helper could. A `select` works
   * too, which is what the RTI matrix publishes per output. */
  /* Where "which source is live" is read from, for this screen.
   *
   * A room with one receiver names it once at the video level. A matrix
   * gives every output its own select, so the screen's own field answers
   * first - and that field is the one the room already filled in as its
   * source select, because for a matrix they are the same entity: the thing
   * that says what is feeding this screen, and the thing you set to change
   * it. Keeping them as two fields only invited filling in one and
   * wondering why the picker never appeared. */
  _sourceFrom(d) {
    return (d && d.source_from) || this._v.source_from || (d && d.source) || "";
  }

  /* What the receiver says is feeding this screen, in its own words.
   * null means the room has no source_from and the old helper is in play. */
  _liveInput(d) {
    const sf = this._sourceFrom(d);
    if (!sf) return null;
    const st = this._hass.states[sf];
    if (!st) return "";
    // nothing on is the Off entry, whatever the room chose to call it
    if (OFFISH.includes(st.state)) return this._v.off_option || "Off";
    return sf.startsWith("media_player.")
      ? ((st.attributes || {}).source || "")
      : st.state;
  }

  /* A view-only source - the television's own apps, say - isn't something
   * the matrix can report, because the matrix is still routed somewhere
   * whatever the TV is actually showing. So picking one sets a view
   * override: which remote you are looking at, held for as long as the
   * matrix hasn't moved. It lives on the card and nowhere else, so it dies
   * with the pop-up and cannot disagree with the hardware for long - the
   * moment the receiver reports a different input, something really did
   * switch and the override gives way. */
  _sourceOf(d) {
    const cur = this._liveInput(d);
    if (cur !== null) {
      const ov = this._view;
      if (ov) {
        if (ov.base === cur) return ov.key;
        this._view = null;            // the matrix moved; it wins
      }
      for (const [key, spec] of Object.entries(this._v.sources || {}))
        if (((spec && spec.input) || key) === cur) return key;
      return cur;             // on an input no source in the room names
    }
    if (!d || !d.source) return "";
    const st = this._hass.states[d.source];
    return st ? st.state : "";
  }

  _sourceSpec(key) {
    const d = this._display(this._focusName());
    return ((d && d.sources) || {})[key] || (this._v.sources || {})[key] || null;
  }

  /* Run the source's own actions, then the one call every room was writing
   * out by hand. */
  /* The screen's own power, as a chip rather than a card: it belongs beside
   * the screen's name, not in the run of source remotes.
   *
   * It appears when power is genuinely a different entity from the screen -
   * a Samsung switched over HDMI-CEC by the matrix, because the Samsung's
   * own turn-on is not dependable. When they are the same entity there is
   * nothing to add: the screen's remote already has a power button, and a
   * second one beside it would only be a way to get the two out of step. */
  _powerChip(d) {
    const p = screenPower(d);
    if (!p) return null;
    const st = this._hass.states[p];
    const on = st && !OFFISH.includes(st.state);
    const b = document.createElement("button");
    b.className = "vchip pwr" + (on ? " live" : "");
    b.innerHTML = `<ha-icon icon="mdi:power"></ha-icon>`;
    const sp = document.createElement("span");
    sp.textContent = d.name || "Screen";
    b.appendChild(sp);
    b.title = `${d.name || "This screen"} is ${on ? "on" : "off"} \u2014 tap to turn it `
            + `${on ? "off" : "on"} (${p})`;
    b.addEventListener("click", () => {
      const domain = p.split(".")[0];
      this._hass.callService(domain, "toggle", {}, { entity_id: p });
    });
    return b;
  }

  /* The power chip. It used to call _pick(), which only changes which
   * screen the panel is showing - so on a room with one screen it was
   * hidden entirely, and on a room with several it blanked the panel and
   * turned nothing off. Theatre therefore had no way to be switched off
   * from the card at all.
   *
   * Now it commands. An `Off` entry in `sources` carrying `do` actions is
   * the real answer: direct service calls, no helper and no automation in
   * between. Without one it falls back to telling each screen's own select
   * that it is off, which is what the rooms built around a dropdown and a
   * matching automation have always relied on, so nothing regresses.
   *
   * It only moves the view when there is a view to move: a room driven by
   * a focus helper gets the option written to it, several screens go blank
   * to show the room is off, and a single-screen room is left where it is.
   * Focusing "Off" there would hide the only screen chip and strand the
   * panel with no way back. */
  /* What "off" would actually do in this room, worked out once so the chip
   * is only drawn when it can do something.
   *
   * Three tiers. An `Off` entry in `sources` with `do` actions wins: direct
   * service calls, no helper and no automation in between. Otherwise each
   * screen is handled on its own - its source select is told "Off" where
   * that is one of the options, and where it isn't the screen is switched
   * off at its power entity instead. That second case is the RTI-fed ones:
   * their matrix select offers DirecTV 1 through Input 8 and no Off at all,
   * so selecting one was never going to turn a television off. The RTI
   * power switch is what does that.
   *
   * A room where none of the three applies gets no chip. A button that
   * cannot act is worse than no button. */
  _offPlan() {
    const v = this._v, hass = this._hass;
    const off = v.off_option || "Off";
    const spec = this._sourceSpec(off) || {};
    if (spec.do && spec.do.length) return { kind: "do", steps: spec.do };
    const jobs = [];
    for (const d of v.displays || []) {
      const sf = this._sourceFrom(d);
      const st = sf && hass && hass.states[sf];
      const opts = st && st.attributes &&
        (st.attributes.options || st.attributes.source_list);
      if (opts && opts.includes(off)) { jobs.push({ pick: sf, option: off }); continue; }
      const p = screenPower(d);
      if (p && hass && hass.states[p]) jobs.push({ power: p });
    }
    return { kind: "jobs", steps: jobs };
  }

  async _allOff() {
    const v = this._v, hass = this._hass;
    const off = v.off_option || "Off";
    const plan = this._offPlan();
    if (plan.kind === "do") {
      await runActions(hass, plan.steps);
    } else {
      for (const job of plan.steps) {
        try {
          if (job.pick) {
            const domain = job.pick.split(".")[0];
            if (domain === "media_player")
              await hass.callService("media_player", "select_source",
                                     { source: job.option }, { entity_id: job.pick });
            else
              await hass.callService(domain, "select_option",
                                     { option: job.option }, { entity_id: job.pick });
          } else if (job.power) {
            await hass.callService(job.power.split(".")[0], "turn_off",
                                   {}, { entity_id: job.power });
          }
        } catch (err) { console.error("charro-video-card: off", err); }
      }
    }
    /* Only move the view when there is a view to move. A focus helper gets
     * the option written to it, several screens go blank to show the room
     * is off, and a single-screen room is left alone - focusing "Off" there
     * would hide its only chip and strand the panel with no way back. */
    if (v.focus) {
      hass.callService("input_select", "select_option",
                       { entity_id: v.focus, option: off });
    } else if (!this._single()) {
      this._focus = off;
    }
    this._render();
  }

  async _pickSource(key) {
    const spec = this._sourceSpec(key) || {};
    const d = this._display(this._focusName());

    if (spec.view_only) {
      // show this remote against whatever the matrix is already doing, and
      // route nothing
      this._view = { key, base: this._liveInput(d) };
      await runActions(this._hass, spec.do);
      this._render();
      return;
    }

    this._view = null;                // a real pick ends any view override
    await runActions(this._hass, spec.do);
    const sf = this._sourceFrom(d);
    /* The option to set: `input` when the source names one, and otherwise
     * the source's own name - which is what the matching side has always
     * used. Requiring one here while matching fell back to the name meant a
     * source could highlight correctly and still do nothing when pressed. */
    const opt = spec.input || key;
    if (!sf || !opt) return;
    const domain = sf.split(".")[0];
    const st = this._hass.states[sf];
    const valid = st && st.attributes &&
      (st.attributes.options || st.attributes.source_list);
    if (valid && valid.length && !valid.includes(opt)) {
      console.warn(`Charro Cards: "${opt}" is not an option on ${sf}. ` +
                   `It offers: ${valid.join(", ")}`);
    }
    try {
      if (domain === "media_player")
        await this._hass.callService("media_player", "select_source",
                                     { source: opt }, { entity_id: sf });
      else
        await this._hass.callService(domain, "select_option",
                                     { option: opt }, { entity_id: sf });
    } catch (err) {
      console.error("Charro Cards: couldn\u2019t select source", opt, err);
    }
  }
  _isLive(d) {
    if (!d) return false;
    const p = screenPower(d);
    if (p) {
      const st = this._hass.states[p];
      if (st) return !OFFISH.includes(st.state);
    }
    const s = this._sourceOf(d);
    return !!s && s !== (this._v.off_option || "Off");
  }

  _pick(value) {
    if (!this._v.focus) {
      this._focus = value;        // no picker entity: the card remembers
      this._render();
      return;
    }
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
    if ((this._v.displays || []).length && this._offPlan().steps.length) {
      const one = this._single();
      const o = document.createElement("button");
      o.className = "vchip off";
      o.innerHTML = `<ha-icon icon="mdi:power"></ha-icon>`;
      const sp = document.createElement("span");
      sp.textContent = one ? "Off" : "All off";
      o.appendChild(sp);
      o.title = one ? "Turn this room's screen off"
                    : "Turn every screen in this room off";
      o.addEventListener("click", () => this._allOff());
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

    /* ---- the screen itself, above whatever is feeding it.
     *
     * The test is simply whether the room filled the power field in. That
     * is the room saying "this screen is switched by something other than
     * its own remote" - the matrix over CEC - and it holds equally for a
     * screen that names no television at all, where the remote on show
     * belongs to the box and can't turn the screen off either. Leave the
     * field blank, as an LG that answers its own remote would, and no
     * second power button appears. */
    const sepPower = !!d.power;
    if (sepPower) {
      const prow = document.createElement("div");
      prow.className = "vrow";
      prow.appendChild(this._powerChip(d));
      this._wrap.appendChild(prow);
    }

    // ---- what's feeding it
    const sf = this._sourceFrom(d);
    /* Hidden sources still match - they supply the remote when the receiver
     * reports them - they just aren't offered as something to press. */
    const keys = Object.keys(this._v.sources || {})
      .filter((k) => !(this._v.sources[k] || {}).hidden);
    if (sf && keys.length) {
      const live = this._sourceOf(d);
      const srow = document.createElement("div");
      srow.className = "vrow";
      for (const key of keys) {
        const spec = this._v.sources[key] || {};
        const b = document.createElement("button");
        b.className = "vchip" + (key === live ? " sel live" : "");
        if (spec.icon) {
          const i = document.createElement("ha-icon");
          i.icon = spec.icon;
          b.appendChild(i);
        }
        const sp = document.createElement("span");
        sp.textContent = spec.title || key;
        b.appendChild(sp);
        b.title = key === live ? `${spec.title || key} \u2014 on now` : `Switch to ${spec.title || key}`;
        b.addEventListener("click", () => this._pickSource(key));
        srow.appendChild(b);
      }
      this._wrap.appendChild(srow);
    } else if (d.source) {
      add({ type: "custom:mushroom-select-card", entity: d.source,
            name: `${d.name} source`, layout: "horizontal",
            fill_container: false, secondary_info: "none" });
    }

    // ---- and the buttons for it
    /* Somewhere to turn the screen off whatever else is going on. The header
     * has it when power is separate; these are the cases where it isn't, and
     * where without this you would be looking at a note and nothing else. */
    const stranded = () => {
      if (sepPower) return;            // already in the header, don't repeat it
      const chip = this._powerChip(d);
      if (!chip) return;
      const r2 = document.createElement("div");
      r2.className = "vrow";
      r2.appendChild(chip);
      this._wrap.appendChild(r2);
    };

    const src = this._sourceOf(d);
    if (!src || src === off) {
      const p = screenPower(d);
      if (p && !sepPower) {
        add({ type: "tile", entity: p, name: d.name,
              icon: d.off_icon || "mdi:television-off", hide_state: true,
              tap_action: { action: "toggle" }, icon_tap_action: { action: "toggle" } });
      } else if (!p) {
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
      stranded();
      return;
    }
    if (spec.card) { add(spec.card); return; }
    const tpl = this._templates[spec.use];
    if (!tpl) {
      const n = document.createElement("div");
      n.className = "vnote";
      n.textContent = `\`_remotes.json\` has no template named "${spec.use}".`;
      this._wrap.appendChild(n);
      stranded();
      return;
    }
    // the display's own volume, so the buttons act on the screen you're at
    add(fillTemplate(clone(tpl), { title: spec.title || src, ...spec,
                                   display: d.name,
                                   display_media: screenTv(d) }));
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
/* A source has nine fields and a room has four or five sources. Open they
 * are a wall; the name is all you need to find the one you want. */
.vsrc{
  border:1px solid var(--divider-color); border-radius:8px; margin-bottom:6px;
}
.vsrc > summary{
  cursor:pointer; list-style:none; user-select:none;
  display:flex; align-items:center; gap:8px; padding:9px 10px; font-size:13px;
}
.vsrc > summary::-webkit-details-marker{ display:none; }
.vsrc > summary::before{ content:"\u25B8"; color:var(--secondary-text-color); }
.vsrc[open] > summary::before{ content:"\u25BE"; }
.vsrc[open] > summary{ border-bottom:1px solid var(--divider-color); }
.vsrc > summary .sub{
  margin-left:auto; font-size:11px; color:var(--secondary-text-color);
  text-align:right; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
}
.vsrc > .vrowbox{ border:0; border-radius:0; margin:0; }
.vchip.pwr.live{ color:#4CAF50; border-color:rgba(76,175,80,.55); }
.vsrc.off > summary{ opacity:.5; }
.vsrc > summary .ctl{ display:flex; gap:3px; flex:0 0 auto; }
.vsrc > summary .sbtn{
  border:1px solid var(--divider-color); background:transparent; cursor:pointer;
  color:var(--secondary-text-color); border-radius:6px; width:24px; height:24px;
  line-height:1; font-size:12px; padding:0;
}
.vsrc > summary .sbtn:hover{ background:rgba(127,127,127,.16); }
.vsrc > summary .sbtn.on{ color:var(--primary-color); border-color:var(--primary-color); }
.vfield{ display:flex; flex-direction:column; gap:2px; }
.vfield > span{ font-size:11.5px; color:var(--secondary-text-color); }
.vdet{ margin-top:2px; }
.vdet > summary{
  cursor:pointer; font-size:11.5px; color:var(--secondary-text-color);
  padding:5px 0; list-style:none; user-select:none;
}
.vdet > summary::-webkit-details-marker{ display:none; }
.vdet > summary::before{ content:"\u25B8 "; }
.vdet[open] > summary::before{ content:"\u25BE "; }
.vdet ha-selector{ display:block; margin:4px 0 6px; }
.vhelp{ font-size:11px; line-height:1.35; color:var(--secondary-text-color); margin:1px 0 2px; }
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
  climate: "Climate", media: "Media & remotes",
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
      const m = migrateVideo(migrateMusic(r));
      if (m !== r) { r.layout = m.layout; r.hidden = m.hidden || []; }
    }
    // 4.84: `video` is no longer a section of its own, so a room that still
    // names it gets the merged list it is already being rendered with.
    if (Array.isArray(r.sections) && r.sections.includes("video"))
      r.sections = sectionOrder(r);
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
      media: () => !!(r.tv_entity || r.projector_entity || r.receiver_entity
                      || (r.remotes || []).length || r.video),
      music: () => !!((r.music_powers || []).length || r.media_player),
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

/* `perform_action: "script.toggle"` reads exactly like an entity id and is
 * not one — it is a service name, and no entity will ever be called
 * `script.toggle` or `button.press`. Those were the checker's own false
 * positives. A script or scene called by its own name
 * (`perform_action: "script.open_gate"`) IS worth checking, so only Home
 * Assistant's own verbs are skipped, not the whole key. */
const ACTION_KEYS = new Set(["perform_action", "service", "action"]);
const SERVICE_VERBS = new Set([
  "toggle", "turn_on", "turn_off", "press", "trigger", "reload",
  "select_option", "select_next", "select_previous", "select_first",
  "select_last", "set_value", "set_level", "set_percentage", "set_datetime",
  "increment", "decrement", "start", "stop", "pause", "cancel", "finish",
  "open", "close", "lock", "unlock", "open_cover", "close_cover",
  "stop_cover", "set_cover_position", "send_command", "send_magic_packet",
  "toggle_cover_tilt", "snapshot", "play_media", "volume_up", "volume_down",
]);

function entityRefs(node, out, path) {
  if (typeof node === "string") {
    if (node.includes("{{") || node.includes("[[[")) return;
    if (ENTITY_RE.test(node)) {
      const key = String(path || "").split(".").pop();
      if (ACTION_KEYS.has(key) && SERVICE_VERBS.has(node.split(".")[1])) return;
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

/* A dotted path is exact and unreadable: `layout[1].items[2].entity` tells
 * you nothing about where to click. Split it into segments, then say it in
 * the editor's own words — which panel, which column, which row. */
function pathParts(p) {
  const out = [];
  for (const seg of String(p || "").split(".")) {
    const m = seg.match(/^([^[]*)((?:\[\d+\])*)$/);
    if (!m) { out.push(seg); continue; }
    if (m[1]) out.push(m[1]);
    for (const n of (m[2] || "").match(/\d+/g) || []) out.push(Number(n));
  }
  return out;
}

/* One layout row, named the way its own chip is named in the builder. */
function itemWhere(it) {
  if (!it || typeof it !== "object") return "row";
  if (it.block) return BLOCK_LABEL[it.block] || it.block;
  if (it.entity) return String(it.entity);
  if (it.sensor) return typeof it.sensor === "string" ? it.sensor
                       : (it.sensor.label || it.sensor.entity || "sensor");
  if (it.zone) return typeof it.zone === "string" ? it.zone
                     : (it.zone.entity || it.zone.power || "zone");
  if (it.gate) return `gate ${it.gate}`;
  if (it.pump) return `${it.pump} pump`;
  if (it.heater) return `${it.heater} heater`;
  if (it.water_action) return it.water_action;
  if (it.heading !== undefined) return `heading "${it.heading}"`;
  if (it.card) return `card ${(it.card.type || "").replace(/^custom:/, "")}`.trim();
  if (it.group !== undefined) return "column";
  if (it.gap) return "gap";
  return "row";
}

/* Which panel a plain field belongs to. ROOM_LABELS already names the ones
 * the form owns, so this only adds the panel in front of it and covers the
 * fields the form has no row for. */
const FIELD_WHERE = {
  climate_entity: "Climate", climate_card: "Climate", climate_modes: "Climate",
  tv_entity: "Media & remotes", projector_entity: "Media & remotes",
  receiver_entity: "Media & remotes",
  media_player: "Music", media_card: "Advanced", music_player: "Music",
  music_powers: "Music", zone_players: "Music",
  light_entities: "Lights", landscape_entities: "Landscape",
  fan_entities: "Fans", bath_fan_entities: "Other fans",
  fountain_entities: "Pool & water", pool_switch: "Pool & water",
  spa_switch: "Pool & water", pool_heater: "Pool & water",
  spa_heater: "Pool & water", water_actions: "Pool & water",
  alert_sensors: "Door / motion alert", confirm_sensor: "Door / motion alert",
  cameras: "Cameras", gates: "Gates",
  remotes: "Media & remotes", video: "Media & remotes",
  sections: "Advanced",
};

function refWhere(room, path) {
  const p = pathParts(path);
  if (!p.length) return "the room file";
  const r = room || {};
  const k = p[0];
  const nth = (i) => (typeof i === "number" ? i + 1 : "?");
  const tail = (i) => (typeof p[i] === "string" ? ` \u2192 ${p[i]}` : "");

  /* a custom layout: the builder's own geography */
  if (k === "layout" || k === "hidden") {
    const base = k === "layout" ? "Layout" : "Hidden";
    const top = (r[k] || [])[p[1]];
    if (top && top.group !== undefined && p[2] === "items") {
      const col = (typeof top.group === "string" && top.group) || top.title
                  || `column ${nth(p[1])}`;
      return `${base} \u2192 ${col} \u2192 row ${nth(p[3])}: ${itemWhere((top.items || [])[p[3]])}`;
    }
    return `${base} \u2192 row ${nth(p[1])}: ${itemWhere(top)}`;
  }

  if (k === "cards") {
    const slot = p[1] === "start" ? "before everything"
               : p[1] === "end" ? "after everything"
               : `after ${BLOCK_LABEL[p[1]] || p[1]}`;
    return `Extra cards (${slot}) \u2192 card ${nth(p[2])}`;
  }

  if (k === "video") {
    const v = r.video || {};
    if (p[1] === "displays") {
      const d = (v.displays || [])[p[2]] || {};
      return `Media & remotes \u2192 screen ${d.name || nth(p[2])}${tail(3)}`;
    }
    if (p[1] === "sources")
      return `Media & remotes \u2192 source "${p[2]}"${tail(3)}`;
    return `Media & remotes \u2192 video${tail(1)}`;
  }

  if (k === "remotes") {
    const spec = (r.remotes || [])[p[1]] || {};
    return `Media & remotes \u2192 remote ${spec.title || spec.use || nth(p[1])}${tail(2)}`;
  }

  if (k === "gates") {
    const g = (r.gates || [])[p[1]];
    const name = g && typeof g === "object" ? g.name : g;
    return `Gates \u2192 ${name || nth(p[1])}${tail(2)}`;
  }

  if (k === "water_actions") {
    const a = (r.water_actions || [])[p[1]] || {};
    return `Pool & water \u2192 ${a.name || a.script || a.perform_action || nth(p[1])}`;
  }

  if (k === "alert_sensors") {
    const x = (r.alert_sensors || [])[p[1]];
    const label = x && typeof x === "object" ? (x.label || x.entity) : x;
    return `Door / motion alert \u2192 ${label || nth(p[1])}${tail(2)}`;
  }

  const panel = FIELD_WHERE[k];
  const field = ROOM_LABELS[k];
  const head = panel && field && panel !== field ? `${panel} \u2192 ${field}`
             : (panel || field || k);
  return typeof p[1] === "number" ? `${head} \u2192 #${nth(p[1])}` : head;
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
    const where = [...new Set([...paths].map((pt) => refWhere(room, pt)))].sort();
    out.push({ id, paths: [...paths].sort(), where });
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

/* The room as it is on disk: without the `_remotes` template library the
 * integration injects at load, or any other underscored scratch the editor
 * hangs off the object. */
function roomJson(r) {
  const out = {};
  for (const [k, v] of Object.entries(r || {}))
    if (!k.startsWith("_")) out[k] = v;
  return JSON.stringify(out, null, 2);
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
/* The four widths are a compromise that can't suit every room: a thirty-row
 * layout wants the middle wide, a room you're only renaming wants the
 * preview wide. So the gutters drag. The tracks stay fr so the whole thing
 * still reflows with the window, and the gutters are real grid tracks
 * rather than a gap, because a gap can't be grabbed. */
.grid2{
  --gut:18px; --c1:170fr; --c2:720fr; --c3:950fr; --c4:500fr;
  display:grid; gap:0; align-items:stretch;
  grid-template-columns:
    minmax(120px,var(--c1)) var(--gut) minmax(200px,var(--c2)) var(--gut)
    minmax(240px,var(--c3)) var(--gut) minmax(260px,var(--c4));
  height:calc(100vh - 210px); min-height:420px;
}
.grid2.pop{ --c2:600fr; --c3:800fr; --c4:1400fr; }
.gut{ cursor:col-resize; position:relative; touch-action:none; }
.gut::after{
  content:""; position:absolute; top:0; bottom:0; left:50%; width:2px;
  transform:translateX(-50%); background:var(--divider-color);
  border-radius:1px; opacity:0; transition:opacity .12s;
}
.gut:hover::after{ opacity:1; }
.gut.on::after{ opacity:1; background:var(--primary-color); }
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
.warnwhere{ font-size:11px; color:var(--secondary-text-color); flex:1; min-width:0; }
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
  .grid2, .grid2.pop{
    grid-template-columns:
      minmax(120px,var(--c1)) var(--gut) minmax(200px,var(--c2))
      var(--gut) minmax(240px,var(--c3));
  }
  .preview, .gut3{ display:none; }
}
@media (max-width:820px){
  .grid2, .grid2.pop{ grid-template-columns:1fr; height:auto; }
  .gut{ display:none; }
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

/* Where you left the gutters, per browser. Storage can be off or throw, and
 * a panel that won't open because localStorage said no would be a silly way
 * to lose an editor, so every touch of it is guarded and the widths simply
 * don't stick when it isn't there. */
const COLS_KEY = "charro-rooms-cols";
const COL_MIN = [120, 200, 240, 260];

function readCols() {
  try {
    const v = JSON.parse(window.localStorage.getItem(COLS_KEY) || "null");
    return Array.isArray(v) && v.length === 4
        && v.every((n) => Number(n) > 0) ? v.map(Number) : null;
  } catch (e) { return null; }
}

function writeCols(v) {
  try {
    if (v) window.localStorage.setItem(COLS_KEY, JSON.stringify(v.map(Math.round)));
    else window.localStorage.removeItem(COLS_KEY);
  } catch (e) { /* nothing to do: the widths just won't be remembered */ }
}

/* Pixels are written back as fr. They are proportional either way, and fr
 * keeps the columns sharing the window instead of overflowing it when the
 * browser is next a different size. */
function applyCols(el, v) {
  for (let i = 0; i < 4; i++) {
    if (v) el.style.setProperty(`--c${i + 1}`, `${Math.round(v[i])}fr`);
    else el.style.removeProperty(`--c${i + 1}`);
  }
}

function mountGutters(cols, kids) {
  const widths = () => kids.map((k) => k.getBoundingClientRect().width);
  for (let i = 0; i < 3; i++) {
    const g = document.createElement("div");
    g.className = `gut gut${i + 1}`;
    g.title = "Drag to resize \u2014 double-click to reset";
    cols.insertBefore(g, kids[i + 1]);

    let startX = 0, a = 0, b = 0, base = null;
    const move = (ev) => {
      const dx = ev.clientX - startX;
      const next = base.slice();
      next[i] = Math.max(COL_MIN[i], a + dx);
      next[i + 1] = Math.max(COL_MIN[i + 1], b - dx);
      applyCols(cols, next);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      g.classList.remove("on");
      document.body.style.userSelect = "";
      writeCols(widths());
    };
    g.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      base = widths();
      a = base[i]; b = base[i + 1];
      startX = ev.clientX;
      g.classList.add("on");
      document.body.style.userSelect = "none";
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
    g.addEventListener("dblclick", () => { applyCols(cols, null); writeCols(null); });
  }
}

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
    mountGutters(cols, [this._rail, this._left, this._mid, right]);
    applyCols(cols, readCols());

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

    const videoHost = this._panel("Media & remotes",
      "The TV, the screens, their sources, and every remote", "mdi:remote-tv",
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
    /* The whole room, as it is on disk. Everything above edits one corner
     * of it; sometimes the fastest thing is to see all of it, to paste a
     * room in from somewhere else, or to reach a key no panel has a field
     * for yet. An escape hatch beside the UI, not instead of it. */
    const h6 = document.createElement("h4"); h6.textContent = "Room JSON";
    const rj = document.createElement("textarea");
    rj.spellcheck = false;
    rj.style.minHeight = "340px";
    rj.value = roomJson(this._room);
    rj.title = "The whole room file. Applies when you click away, if it parses.";
    rj.addEventListener("change", () => {
      const t = rj.value.trim();
      if (!t) { this._say("Room JSON is empty \u2014 nothing applied.", "err"); return; }
      let next;
      try { next = JSON.parse(t); }
      catch (err) { this._say(`Room JSON: ${err.message}`, "err"); return; }
      if (!next || typeof next !== "object" || Array.isArray(next)) {
        this._say("Room JSON must be an object.", "err");
        return;
      }
      // `_remotes` is injected at load and is not part of the file; `room`
      // is the file name, and a room that loses it is one nobody can find
      const keep = this._room._remotes;
      const key = this._room.room;
      this._room = next;
      if (keep) this._room._remotes = keep;
      if (!this._room.room && key) this._room.room = key;
      this._say("");
      this._renderForm();          // every panel rebuilds from the new room
      this._renderPreview();       // and this is what queues the save
    });

    advBody.append(h2, secs, h5, mc, h3, ta, h6, rj);
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
  /* The room's plain AV devices. These were an `ha-form` group called
   * "Media" on the other side of the editor, which put the same subject in
   * two places: you named the television over there and configured the
   * screen it actually is over here. Every other group that had a panel was
   * folded into it long ago; this one was missed, and the 4.84 merge of the
   * two render blocks is what made it obvious. */
  _avFields(box) {
    const r = this._room;
    const { ent } = this._fields(() => {
      this._renderUnknowns();
      this._renderRail();      // a fixed id should clear the badge at once
      this._renderPreview();
    });
    const set = (k) => (s) => { if (s) r[k] = s; else delete r[k]; };
    const help = (el, k) => {
      const t = ROOM_HELPERS[k];
      if (!t) return el;
      const h = document.createElement("div");
      h.className = "vhelp";
      h.textContent = t;
      el.appendChild(h);
      return el;
    };

    const cap = document.createElement("div");
    cap.className = "vcap";
    cap.textContent = "Devices";
    box.appendChild(cap);

    for (const [k, domains] of [
      ["tv_entity", ["media_player"]],
      ["projector_entity", ["switch", "media_player", "light"]],
      ["receiver_entity", ["media_player"]],
    ]) box.appendChild(help(ent(ROOM_LABELS[k], r[k], domains, set(k)), k));
  }

  _renderVideo() {
    const box = this._videoBox;
    if (!box) return;
    box.innerHTML = "";
    const v = this._room.video;
    migrateVideoSchema(v);

    /* Redraw this panel and the preview; the preview redraw is what queues
     * the save. Eleven places called this and nothing declared it, so every
     * button in here - add and remove a screen, add and remove a source,
     * reorder, hide, rename - threw a ReferenceError and did nothing. */
    const changed = () => { this._renderVideo(); this._renderPreview(); };

    this._avFields(box);

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

    const { text: field, ent, icon: iconField } = this._fields(changed);

    const vsw = document.createElement("div");
    vsw.className = "vcap";
    vsw.textContent = "Video switching";
    box.appendChild(vsw);

    const sfField = ent("Current source comes from", v.source_from,
      ["media_player", "select", "input_select"],
      (s) => { if (s) v.source_from = s; else delete v.source_from; },
      "media_player.vsx_lx305");
    sfField.title = "The receiver \u2014 or the matrix\u2019s own select \u2014 that " +
      "actually knows which source is live. Set it and the card reads the " +
      "live source from there and draws its own buttons, so the room needs " +
      "no input_select helper and no automation per source.";
    box.appendChild(sfField);

    /* Somewhere to park the whole switcher without throwing it away: a room
     * whose other sources aren't wired up yet wants a TV button and a
     * remote, not a source picker with one option. */
    const basic = document.createElement("label");
    basic.className = "vfield";
    basic.title = "Ignore the sources and the screen picker for now. Each screen " +
      "shows a button while its TV is off and that TV's own remote once it is on. " +
      "Everything configured below is kept. This happens on its own when there " +
      "are no sources, or no screen has a source select — the box forces it for " +
      "a room that has them but isn't using them yet.";
    const basicTxt = document.createElement("span");
    basicTxt.textContent = "Basic TV only (keeps the config below)";
    const basicBox = document.createElement("input");
    basicBox.type = "checkbox";
    basicBox.checked = !!v.simple;
    basicBox.addEventListener("change", () => {
      if (basicBox.checked) v.simple = true; else delete v.simple;
      this._renderVideo(); this._renderPreview();
    });
    basic.append(basicTxt, basicBox);
    box.appendChild(basic);

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
      /* Same reasoning as the sources: nine fields each, and a room with
       * three screens is a wall of them. Keyed on the index because a
       * screen's name can be blank while you are still typing it. */
      const scrDet = document.createElement("details");
      scrDet.className = "vsrc";
      scrDet.open = !!(this._dispOpen && this._dispOpen[i]);
      scrDet.addEventListener("toggle", () => {
        this._dispOpen = this._dispOpen || {};
        this._dispOpen[i] = scrDet.open;
      });
      const scrSum = document.createElement("summary");
      const scrNm = document.createElement("span");
      scrNm.textContent = d.name || `Screen ${i + 1}`;
      const scrSub = document.createElement("span");
      scrSub.className = "sub";
      const sbits = [];
      const tvId = screenTv(d), pwId = screenPower(d);
      if (tvId) sbits.push(tvId.replace(/^[a-z_]+\./, ""));
      else sbits.push("no screen set");
      if (pwId && pwId !== tvId) sbits.push("power: " + pwId.replace(/^[a-z_]+\./, ""));
      scrSub.textContent = sbits.join(" \u00b7 ");
      scrSum.append(scrNm, scrSub);
      scrDet.appendChild(scrSum);

      const row = document.createElement("div");
      row.className = "vrowbox";
      row.appendChild(field("Name", d.name, (s) => { d.name = s; },
        many ? "must match a picker option" : "TV"));
      row.appendChild(iconField("Icon", d.icon,
        (s) => { if (s) d.icon = s; else delete d.icon; }));
      const scr = ent("Screen", d.screen, ["media_player", "switch", "remote"],
        (s) => { if (s) d.screen = s; else delete d.screen; },
        "media_player.kitchen_samsung_55_2");
      scr.title = "The television itself \u2014 what the remote drives, where the " +
        "volume goes, and what the room\u2019s TV chip follows.";
      row.appendChild(scr);
      const tvf = ent("Screen power, if something else switches it", d.power,
        ["switch", "media_player", "remote"],
        (s) => { if (s) d.power = s; else delete d.power; },
        "switch.rti_vhd_8x_video_kitchen_power");
      tvf.title = "Leave this blank when the screen turns itself on. Fill it in " +
        "when something else does \u2014 the RTI matrix switching it over " +
        "HDMI-CEC, say. Then this is what the on/off button presses and what " +
        "says whether the screen is on, while Screen above keeps the remote.";
      row.appendChild(tvf);
      const srcf = ent("Its source select", d.source, ["input_select", "select"],
        (s) => { if (s) d.source = s; else delete d.source; },
        "select.rti_vhd_8x_video_kitchen_source");
      srcf.title = "The select that says what is feeding this screen, and that " +
        "gets set when you pick a source. For the matrix that is the output\u2019s " +
        "own source select. Leave it blank in a room where one receiver " +
        "answers for every screen and name that receiver under Video " +
        "switching instead.";
      row.appendChild(srcf);
      const mac = field("Wake-on-LAN MAC", d.wake_mac,
        (t) => { if (t) d.wake_mac = t.trim().toLowerCase(); else delete d.wake_mac; },
        "20:15:de:26:33:fa");
      mac.title = "Fill this in when the screen's own turn-on does nothing. " +
        "The off button sends a magic packet instead.";
      row.appendChild(mac);
      const bc = field("… broadcast to", d.wake_broadcast,
        (t) => { if (t) d.wake_broadcast = t.trim(); else delete d.wake_broadcast; },
        "192.168.1.255");
      bc.title = "The TV subnet's broadcast address. Needed when Home Assistant " +
        "has more than one network interface, because the default 255.255.255.255 " +
        "leaves by the default route, which may not be the one that reaches the TV.";
      row.appendChild(bc);
      const x = document.createElement("button");
      x.className = "vdel"; x.textContent = "Remove screen";
      x.addEventListener("click", () => { v.displays.splice(i, 1); changed(); });
      row.appendChild(x);
      scrDet.appendChild(row);
      box.appendChild(scrDet);
    });

    const addD = document.createElement("button");
    addD.textContent = "+ Screen";
    addD.addEventListener("click", () => {
      v.displays = v.displays || [];
      this._dispOpen = this._dispOpen || {};
      this._dispOpen[v.displays.length] = true;   // a new one opens itself
      v.displays.push({ name: "" });
      changed();
    });
    box.appendChild(addD);

    const sh = document.createElement("div");
    sh.className = "vcap";
    sh.textContent = "Sources — what the picker offers, in this order";
    box.appendChild(sh);

    /* The picker's buttons are these, in this order, minus the hidden ones.
     * Order is the key order in the file, which is why reordering rebuilds
     * the object rather than sorting a list. */
    /* Where the list of real inputs comes from. A room with one receiver
     * names it under Video switching; a matrix gives each screen its own
     * select, so the screens are asked too, in the order _sourceFrom
     * resolves. A `select` publishes `options` and a `media_player`
     * publishes `source_list`; looking for only one of them was why rooms
     * on the matrix got a free-text box and ended up with source names that
     * match nothing on the receiver. */
    const optsList = (() => {
      const seen = [v.source_from]
        .concat((v.displays || []).map((d) => d && (d.source_from || d.source)))
        .filter(Boolean);
      for (const e of seen) {
        const st = this._hass.states[e];
        const list = st && st.attributes &&
          (st.attributes.options || st.attributes.source_list);
        if (list && list.length) return list;
      }
      return null;
    })();

    const renameSource = (from, to) => {
      if (!to || to === from || v.sources[to]) return;
      const next = {};
      for (const [k, val] of Object.entries(v.sources)) next[k === from ? to : k] = val;
      v.sources = next;
      if (this._srcOpen) {
        this._srcOpen[to] = this._srcOpen[from];
        delete this._srcOpen[from];
      }
      changed();
    };

    const moveSource = (k, dir) => {
      const keys = Object.keys(v.sources);
      const i = keys.indexOf(k), j = i + dir;
      if (i < 0 || j < 0 || j >= keys.length) return;
      keys.splice(j, 0, keys.splice(i, 1)[0]);
      const next = {};
      for (const kk of keys) next[kk] = v.sources[kk];
      v.sources = next;
      changed();
    };

    const tpls = Object.keys(this._room._remotes || {});
    for (const [key, spec] of Object.entries(v.sources || {})) {
      const srcDet = document.createElement("details");
      srcDet.className = "vsrc";
      // reopen whatever was open before this redraw, so changing one field
      // doesn't collapse the source you are in the middle of editing
      srcDet.open = !!(this._srcOpen && this._srcOpen[key]);
      srcDet.addEventListener("toggle", () => {
        this._srcOpen = this._srcOpen || {};
        this._srcOpen[key] = srcDet.open;
      });
      const srcSum = document.createElement("summary");
      const srcNm = document.createElement("span");
      srcNm.textContent = spec.title || key;
      const srcSub = document.createElement("span");
      srcSub.className = "sub";
      const bits = [];
      if (spec.hidden) bits.push("hidden");
      if (spec.view_only) bits.push("view only");
      if (spec.use) bits.push(spec.use);
      if (spec.input) bits.push("\u2192 " + spec.input);
      const nAct = (spec.do || []).length;
      if (nAct) bits.push(`${nAct} action${nAct > 1 ? "s" : ""}`);
      srcSub.textContent = bits.join(" \u00b7 ");
      if (spec.hidden) srcDet.classList.add("off");

      /* Reorder and hide live in the header so a room can be sorted and
       * pruned without opening anything. A button inside a summary toggles
       * the details unless it says otherwise. */
      const ctl = document.createElement("span");
      ctl.className = "ctl";
      const sbtn = (txt, title, fn, on) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "sbtn" + (on ? " on" : "");
        b.textContent = txt;
        b.title = title;
        b.addEventListener("click", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          fn();
        });
        ctl.appendChild(b);
      };
      sbtn("\u2191", "Move up", () => moveSource(key, -1));
      sbtn("\u2193", "Move down", () => moveSource(key, 1));
      sbtn(spec.hidden ? "\u2715" : "\u25CF",
           spec.hidden ? "Hidden from the picker \u2014 click to show it"
                       : "Shown in the picker \u2014 click to hide it. It still " +
                         "supplies the remote when the receiver reports it.",
           () => { if (spec.hidden) delete spec.hidden; else spec.hidden = true; changed(); },
           !spec.hidden);

      srcSum.append(srcNm, srcSub, ctl);
      srcDet.appendChild(srcSum);

      const row = document.createElement("div");
      row.className = "vrowbox";
      /* The name has to equal what the receiver reports, or the source
       * never matches and you get "no remote configured" for a source that
       * is plainly there - one wrong letter does it. So when the receiver
       * publishes its inputs, this is a list of them rather than a box to
       * mistype one into. Custom is for a source the matrix has never heard
       * of, like the television's own apps. */
      /* A source that only changes which remote you are looking at. Its
       * name matches nothing on the receiver, so the list of inputs would
       * be the wrong thing to offer - it gets a plain box. */
      const vo = document.createElement("label");
      vo.className = "vfield";
      vo.title = "For a remote that isn\u2019t a matrix input at all \u2014 the " +
        "television\u2019s own apps. Picking it shows this remote and routes " +
        "nothing; the matrix stays where it is. Pick any other source and the " +
        "matrix switches as usual.";
      const voTxt = document.createElement("span");
      voTxt.textContent = "Only shows this remote \u2014 doesn\u2019t switch the matrix";
      const voBox = document.createElement("input");
      voBox.type = "checkbox";
      voBox.checked = !!spec.view_only;
      voBox.addEventListener("change", () => {
        if (voBox.checked) spec.view_only = true; else delete spec.view_only;
        changed();
      });
      vo.append(voTxt, voBox);
      row.appendChild(vo);

      if (optsList && optsList.length && !spec.view_only) {
        const used = new Set(Object.keys(v.sources).filter((k) => k !== key));
        const w = document.createElement("label");
        w.className = "vfield";
        const t = document.createElement("span");
        t.textContent = "Option text";
        const dd = document.createElement("select");
        const custom = !optsList.includes(key);
        const mk = (val, lab, seld) => {
          const o = document.createElement("option");
          o.value = val; o.textContent = lab;
          if (seld) o.selected = true;
          dd.appendChild(o);
        };
        for (const o of optsList) if (!used.has(o)) mk(o, o, o === key);
        if (custom) mk(key, key + "  (custom)", true);
        mk("\u0000custom", "Custom\u2026", false);

        const txt = document.createElement("input");
        txt.type = "text";
        txt.value = custom ? key : "";
        txt.placeholder = "a name of your own \u2014 not an input on the receiver";
        txt.style.marginTop = "4px";
        txt.style.display = custom ? "" : "none";
        txt.addEventListener("change", () => {
          const n = txt.value.trim();
          if (n) renameSource(key, n);
        });
        dd.addEventListener("change", () => {
          if (dd.value === "\u0000custom") {
            txt.style.display = "";
            txt.focus();
            return;
          }
          renameSource(key, dd.value);
        });
        w.append(t, dd, txt);
        row.appendChild(w);
      } else {
        row.appendChild(field("Option text", key, (s) => renameSource(key, s),
          spec.view_only ? "Screen"
            : (v.source_from ? "SuperBox"
               : "set \u201cCurrent source comes from\u201d for a list")));
      }

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

      /* Which input this is on whatever reports the live source. A receiver
       * publishes its own source_list, so this is a list of the real names
       * rather than a box to mistype one into. */
      const slist = optsList;
      if (spec.view_only) {
        // it routes nothing, so it has no input on the receiver to name
      } else if (slist && slist.length) {
        const w = document.createElement("label");
        w.className = "vfield";
        const t = document.createElement("span");
        t.textContent = "Its input on the receiver";
        const dd = document.createElement("select");
        const opts = [""].concat(slist);
        if (spec.input && !slist.includes(spec.input)) opts.push(spec.input);
        for (const o of opts) {
          const op = document.createElement("option");
          op.value = o;
          op.textContent = o || "\u2014 none \u2014";
          if ((spec.input || "") === o) op.selected = true;
          dd.appendChild(op);
        }
        dd.addEventListener("change", () => {
          if (dd.value) spec.input = dd.value; else delete spec.input;
          changed();
        });
        w.append(t, dd);
        row.appendChild(w);
      } else {
        row.appendChild(field("Its input on the receiver", spec.input, (s) => {
          if (s) spec.input = s; else delete spec.input; },
          "blank uses the name above"));
      }

      /* Home Assistant's own action editor, which ha-selector lazy-loads the
       * first time one is asked for. Add, remove, reorder, every service and
       * each service's own fields are all HA's - a hand-built version would
       * be a worse copy that drifts out of date, and this is the whole
       * reason a room no longer needs an automation per source. */
      const det = document.createElement("details");
      det.className = "vdet";
      const sum = document.createElement("summary");
      const label = () => {
        const n = (spec.do || []).length;
        sum.textContent = n ? `What picking this does \u2014 ${n} action${n > 1 ? "s" : ""}`
                            : "What picking this does \u2014 nothing yet";
      };
      label();
      det.appendChild(sum);
      if (customElements.get("ha-selector")) {
        const sel = document.createElement("ha-selector");
        sel.hass = this._hass;
        sel.selector = { action: {} };
        sel.value = spec.do || [];
        sel.addEventListener("value-changed", (ev) => {
          ev.stopPropagation();
          const val = ev.detail && ev.detail.value;
          if (val && val.length) spec.do = val; else delete spec.do;
          label();
          /* Deliberately not the panel's redraw: rebuilding this box under
           * the editor would take the focus and the half-finished row with
           * it. The preview redraw is what queues the save - debounced,
           * because the action editor reports every field as you touch it
           * and rebuilding the whole room card that often is wasteful. */
          clearTimeout(this._doT);
          this._doT = setTimeout(() => this._renderPreview(), 400);
        });
        det.appendChild(sel);
      } else {
        const note = document.createElement("div");
        note.className = "vnote";
        note.textContent = "Home Assistant\u2019s action editor isn\u2019t available on this page.";
        det.appendChild(note);
      }
      row.appendChild(det);

      const x = document.createElement("button");
      x.className = "vdel"; x.textContent = "Remove source";
      x.addEventListener("click", () => { delete v.sources[key]; changed(); });
      row.appendChild(x);
      srcDet.appendChild(row);
      box.appendChild(srcDet);
    }

    const addS = document.createElement("button");
    addS.textContent = "+ Source";
    addS.addEventListener("click", () => {
      v.sources = v.sources || {};
      const free = (optsList || []).filter((o) => !v.sources[o]);
      let n = free[0] || "New source", i = 2;
      while (v.sources[n]) n = `New source ${i++}`;
      v.sources[n] = {};
      this._srcOpen = this._srcOpen || {};
      this._srcOpen[n] = true;
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

  /* ROOM_SCHEMA is shared with the dashboard card editor, which has no
   * panels — so the Media group is dropped here, not from the schema. The
   * panel below asks for the same three fields, next to the screens they
   * belong with. */
  _schema() {
    return ROOM_SCHEMA
      .filter((f) => !["room", "mode"].includes(f.name))
      .filter((f) => f.title !== "Media")
      .map((f) => (f.type === "expandable" ? { ...f, expanded: this._expanded } : f));
  }

  _formData() {
    const d = { ...this._room };
    for (const k of RE_LIGHT_LISTS) if (d[k]) d[k] = lightIds(d[k]);
    delete d.cards; delete d.sections;
    // the panel owns these now. Leaving them in the form's data would let a
    // later edit anywhere in the form spread a stale copy back over one the
    // panel had just cleared.
    delete d.tv_entity; delete d.projector_entity; delete d.receiver_entity;
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
      const [helpers] = await Promise.all([
        window.loadCardHelpers(),
        // on the sidebar panel nothing else has loaded button-card yet
        loadLovelaceResources(this._hass),
      ]);
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
      where.textContent = (row.where || row.paths).join(" \u00b7 ");
      // the exact path is still the ground truth, one hover away
      where.title = row.paths.join("\n");
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

/* ========================================================= UNIFI PANEL == */
/*
 * A diagnostics panel for the Ubiquiti gear, at /charro-unifi.
 *
 * Nothing here is hardcoded to this house. Every device, every entity and
 * every button is discovered from the registries at render time, which
 * matters for three reasons: the UniFi integration ships almost all of its
 * entities disabled, so what exists changes as they are enabled; an AP
 * added next year should appear without a code change; and the BSSID map
 * below would otherwise be a list of MAC addresses that silently rots.
 *
 * The one piece of real cleverness is that map. A client's BSSID is not its
 * AP's MAC - the first octet carries the virtual-BSSID bit and the last is
 * a per-SSID offset - but octets two to five are the AP's, so they identify
 * it exactly. Deriving that from each AP's own `connections` means "Kitchen
 * AP" instead of a MAC, with no table to maintain.
 */

/* Order matters, most specific first. UDMB is the Beacon HD - an access
 * point - and would otherwise be caught by the gateway rule's ^UDM; UXG is
 * a gateway and would be caught by a loose ^UX in the AP rule. Both were
 * wrong in the first draft of this list. */
const UNIFI_KINDS = [
  ["ap",  /^(U[67]|UAP|UDMB|UHD|UAL|UWB|E7)/i,  "Access points",       "mdi:access-point"],
  ["gw",  /^(UDM|UXG|USG|UCG|UCKP?|UCK)/i,      "Gateways & consoles", "mdi:router"],
  ["sw",  /^(US|USW|USM|USC|USL|USP)/i,         "Switches",            "mdi:switch"],
  ["wlan", /UniFi WLAN/i,                       "Wireless networks",   "mdi:wifi"],
];

function ubiKind(d) {
  const m = String((d && d.model) || "");
  for (const [k, re] of UNIFI_KINDS) if (re.test(m)) return k;
  return "other";
}

function ubiDevices(hass) {
  const devs = (hass && hass.devices) || {};
  const out = [];
  for (const id in devs) {
    const d = devs[id];
    if (d && /ubiquiti/i.test(d.manufacturer || "")) out.push(d);
  }
  return out;
}

function entsByDevice(hass) {
  const map = {};
  const ents = (hass && hass.entities) || {};
  for (const id in ents) {
    const dev = ents[id].device_id;
    if (dev) (map[dev] = map[dev] || []).push(id);
  }
  return map;
}

const ubiName = (d) => (d && (d.name_by_user || d.name)) || "(unnamed)";

function ubiMac(d) {
  for (const c of (d && d.connections) || []) if (c[0] === "mac") return String(c[1]).toLowerCase();
  return "";
}

/* A device every one of whose entities reads unavailable is not unplugged.
 * It is a registry entry for hardware the integration no longer provides -
 * an access point that was swapped out, a WLAN that was deleted - and it
 * keeps its last known firmware for ever. Calling that "offline" invites a
 * power cycle; worse, leaving it in the firmware comparison below makes the
 * panel invent version warnings about equipment that no longer exists. */
function ubiStale(hass, ids) {
  if (!ids || !ids.length) return false;
  for (const id of ids) {
    const st = hass.states[id];
    if (st && st.state !== "unavailable") return false;
  }
  return true;
}

/* octets two to five of every AP's MAC -> that AP's name */
function apBssidMap(hass) {
  const m = {};
  for (const d of ubiDevices(hass)) {
    if (ubiKind(d) !== "ap") continue;
    const mac = ubiMac(d);
    if (mac.length >= 14) m[mac.slice(3, 14)] = ubiName(d);
  }
  return m;
}

function unifiAgo(iso) {
  if (!iso) return "—";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!isFinite(s) || s < 0) return "—";
  const m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d > 0) return `${d}d`;
  if (h > 0) return `${h}h`;
  if (m > 0) return `${m}m`;
  return `${Math.floor(s)}s`;
}

const UNIFI_DEAD = ["unknown", "unavailable", "none", "", "not connected"];

/* Every client whose phone or tablet reports a BSSID, resolved to an AP.
 * These come from the companion app rather than from UniFi, which is why
 * they work at all while the integration's own entities are disabled. */
function clientRows(hass) {
  const map = apBssidMap(hass);
  const ents = (hass && hass.entities) || {};
  const devs = (hass && hass.devices) || {};
  const rows = [];
  for (const id in hass.states) {
    if (!/^sensor\..+_bssid$/.test(id)) continue;
    const st = hass.states[id];
    const base = id.slice(0, -6);
    const reg = ents[id] || {};
    const dev = reg.device_id && devs[reg.device_id];
    const raw = String(st.state || "").toLowerCase();
    const live = UNIFI_DEAD.indexOf(raw) < 0;
    const ssidSt = hass.states[base + "_ssid"];
    const linkSt = hass.states[base + "_connection_type"];
    rows.push({
      name: (dev && ubiName(dev)) || reg.name || id,
      ssid: live && ssidSt ? String(ssidSt.state).trim() : "—",
      ap: live ? (map[raw.slice(3, 14)] || `Unknown ${st.state}`) : "—",
      known: live && !!map[raw.slice(3, 14)],
      bssid: live ? st.state : "—",
      link: linkSt && UNIFI_DEAD.indexOf(String(linkSt.state).toLowerCase()) < 0
            ? linkSt.state : "—",
      since: live ? unifiAgo(st.last_changed) : "—",
      sinceMs: live ? Date.now() - new Date(st.last_changed).getTime() : -1,
      online: live,
    });
  }
  return rows;
}

/* What's worth shouting about. Firmware is judged against whatever the
 * majority of the same kind of device is running rather than against a
 * version number this file would have to know. */
function unifiHealth(hass) {
  const out = [];
  const devs = ubiDevices(hass);
  const byDev = entsByDevice(hass);
  const stale = devs.filter((d) => ubiStale(hass, byDev[d.id]));
  const liveDevs = devs.filter((d) => stale.indexOf(d) < 0);

  let withEnts = 0;
  for (const d of devs) if ((byDev[d.id] || []).length) withEnts++;
  if (!withEnts && devs.length) {
    out.push(["err", `${devs.length} Ubiquiti devices are registered but none have any ` +
      "entities. Settings › Devices & Services › UniFi Network › Configure, " +
      "then turn on “Track network devices”."]);
  }

  /* Grouped by model, not by kind. A U7 Pro and an AC Pro are both access
   * points and run completely separate firmware lines - 8.7.x against
   * 6.8.x - so comparing them announced that four perfectly current Wi-Fi 7
   * APs were out of date. Only identical models are comparable at all, and
   * three of them are needed before "most of them" means anything. */
  const byModel = {};
  for (const d of liveDevs)
    if (d.sw_version && d.model) (byModel[d.model] = byModel[d.model] || []).push(d);
  for (const model in byModel) {
    const group = byModel[model];
    if (group.length < 3) continue;
    const tally = {};
    for (const d of group) tally[d.sw_version] = (tally[d.sw_version] || 0) + 1;
    let best = "", bn = 0;
    for (const v in tally) if (tally[v] > bn) { bn = tally[v]; best = v; }
    const odd = group.filter((d) => d.sw_version !== best);
    if (odd.length && bn > odd.length) {
      out.push(["warn", `${model}: ${odd.map(ubiName).join(", ")} ` +
        `${odd.length === 1 ? "is" : "are"} not on ${best}.`]);
    }
  }

  if (stale.length) {
    out.push(["warn", `${stale.length} device(s) are registered here but gone from ` +
      `UniFi \u2014 ${stale.map(ubiName).join(", ")}. Every entity on them is ` +
      "unavailable, so they are leftovers from replaced hardware and their firmware " +
      "means nothing. Delete them under Settings \u203A Devices & Services \u203A Devices."]);
  }

  const weak = [];
  for (const id in hass.states) {
    if (!/_wifi_signal$/.test(id)) continue;
    const v = Number(hass.states[id].state);
    if (isFinite(v) && v <= -70) weak.push(`${(hass.entities[id] || {}).name || id} (${v})`);
  }
  if (weak.length) out.push(["warn", `Weak signal: ${weak.join(", ")} dBm.`]);

  const unknownAp = clientRows(hass).filter((r) => r.online && !r.known);
  if (unknownAp.length) {
    out.push(["info", `${unknownAp.length} client(s) are on a BSSID that matches no ` +
      "known AP — a neighbour's network, or an AP that isn't adopted here."]);
  }
  if (!out.length) out.push(["ok", "Nothing looks wrong."]);
  return out;
}

function sortRows(rows, col, dir) {
  const s = rows.slice();
  s.sort((a, b) => {
    const x = a[col], y = b[col];
    const n = typeof x === "number" && typeof y === "number";
    const r = n ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true });
    return dir < 0 ? -r : r;
  });
  return s;
}

const UNIFI_CSS = `
:host{ display:block; height:100%; background:var(--primary-background-color); }
.top{
  display:flex; align-items:center; gap:4px; height:var(--header-height, 56px);
  padding:0 8px 0 8px; box-sizing:border-box;
  background:var(--app-header-background-color, var(--primary-color));
  color:var(--app-header-text-color, var(--text-primary-color, #fff));
  font-size:20px; font-weight:400;
}
.top .t{ margin-left:8px; margin-right:auto; }
.top ha-icon-button{ --mdc-icon-button-size:40px; color:inherit; }
.top input{
  font:inherit; font-size:14px; padding:6px 10px; border-radius:999px;
  border:none; width:200px; max-width:38vw;
  background:rgba(255,255,255,.18); color:inherit;
}
.top input::placeholder{ color:inherit; opacity:.7; }
.tabs{
  display:flex; gap:4px; padding:8px 12px 0; flex-wrap:wrap;
  background:var(--primary-background-color);
}
.tabs button{
  font:inherit; font-size:14px; font-weight:600; cursor:pointer;
  border:none; border-radius:999px; padding:7px 14px;
  color:var(--secondary-text-color);
  background:color-mix(in srgb, var(--primary-text-color, #fff) 8%, transparent);
}
.tabs button.on{
  color:var(--text-primary-color, #fff);
  background:var(--primary-color, #03a9f4);
}
.body{ height:calc(100% - var(--header-height, 56px)); overflow:auto; padding-bottom:40px; }
.wrap{ padding:12px; }
.card{
  background:var(--ha-card-background, var(--card-background-color, #1c1c1c));
  border:1px solid var(--divider-color, rgba(255,255,255,.12));
  border-radius:14px; margin:0 0 12px; overflow:hidden;
}
.card > h3{
  margin:0; padding:12px 14px; font-size:15px; font-weight:700;
  border-bottom:1px solid var(--divider-color, rgba(255,255,255,.12));
}
.msg{ padding:10px 14px; font-size:13.5px; line-height:1.5; }
.msg.err{ color:var(--error-color, #ef5350); }
.msg.warn{ color:#ffb74d; }
.msg.ok{ color:var(--green-color, #4caf50); }
.msg.info{ color:var(--secondary-text-color); }
table{ width:100%; border-collapse:collapse; font-size:13.5px; }
th,td{ padding:8px 12px; text-align:left; white-space:nowrap; }
th{
  font-size:12px; text-transform:uppercase; letter-spacing:.04em;
  color:var(--secondary-text-color); cursor:pointer; user-select:none;
  border-bottom:1px solid var(--divider-color, rgba(255,255,255,.12));
}
th:hover{ color:var(--primary-text-color); }
th .ar{ opacity:.5; font-size:10px; }
tbody tr:nth-child(even){
  background:color-mix(in srgb, var(--primary-text-color, #fff) 4%, transparent);
}
td.dim{ color:var(--secondary-text-color); }
td.bad{ color:var(--error-color, #ef5350); font-weight:600; }
td.good{ color:var(--green-color, #4caf50); }
.pill{
  display:inline-block; padding:2px 8px; border-radius:999px; font-size:12px;
  font-weight:700; background:color-mix(in srgb, var(--primary-text-color, #fff) 12%, transparent);
}
.act{
  font:inherit; font-size:12px; font-weight:600; cursor:pointer; border:none;
  border-radius:8px; padding:4px 9px; margin-right:4px;
  color:var(--primary-text-color);
  background:color-mix(in srgb, var(--primary-text-color, #fff) 13%, transparent);
}
.act:hover{ background:color-mix(in srgb, var(--primary-text-color, #fff) 22%, transparent); }
.act.arm{ color:#fff; background:var(--error-color, #ef5350); }
.stat{ display:flex; flex-wrap:wrap; gap:10px; padding:12px 14px; }
.stat div{
  min-width:92px; padding:10px 12px; border-radius:12px;
  background:color-mix(in srgb, var(--primary-text-color, #fff) 7%, transparent);
}
.stat b{ display:block; font-size:22px; font-weight:700; line-height:1.2; }
.stat span{ font-size:12px; color:var(--secondary-text-color); }
.empty{ padding:14px; color:var(--secondary-text-color); font-size:13.5px; }
`;

const UNIFI_TABS = [
  ["overview", "Overview"],
  ["aps", "Access points"],
  ["sw", "Switches & ports"],
  ["clients", "Clients"],
  ["fw", "Firmware"],
];

class CharroUnifiPanel extends HTMLElement {
  set hass(h) {
    this._hass = h;
    this._render();
    /* hass ticks constantly and these tables are wide. Only redraw when
     * something this panel actually shows has moved. */
    const sig = this._sig();
    if (sig !== this._lastSig) { this._lastSig = sig; this._paint(); }
  }
  set narrow(n) { this._narrow = n; }
  set route(r) { this._route = r; }
  set panel(p) { this._panelCfg = p; }

  _sig() {
    const h = this._hass;
    if (!h || !h.states) return "";
    let s = "";
    for (const d of ubiDevices(h)) s += `${d.id}:${d.sw_version || ""}|`;
    for (const id in h.states) {
      if (/_bssid$|_ssid$|_wifi_signal$|_connection_type$/.test(id))
        s += `${id}=${h.states[id].state};`;
    }
    const byDev = entsByDevice(h);
    for (const d of ubiDevices(h)) for (const e of byDev[d.id] || [])
      s += `${e}=${(h.states[e] || {}).state};`;
    return s;
  }

  _render() {
    if (this._built) return;
    this._built = true;
    this._tab = "overview";
    this._sort = {};
    this._q = "";
    this._armed = "";
    const root = this.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = UNIFI_CSS;

    const top = document.createElement("div");
    top.className = "top";
    const menu = document.createElement("ha-icon-button");
    menu.setAttribute("label", "Menu");
    menu.addEventListener("click", () => {
      this.dispatchEvent(new Event("hass-toggle-menu", { bubbles: true, composed: true }));
    });
    const mi = document.createElement("ha-svg-icon");
    mi.setAttribute("path", "M3,6H21V8H3V6M3,11H21V13H3V11M3,16H21V18H3V16Z");
    menu.appendChild(mi);
    const title = document.createElement("div");
    title.className = "t";
    title.textContent = (this._panelCfg && this._panelCfg.title) || "UniFi";
    const q = document.createElement("input");
    q.type = "search";
    q.placeholder = "Filter…";
    // no redraw of the whole panel on a keystroke, or the box loses focus
    q.addEventListener("input", () => { this._q = q.value.toLowerCase(); this._paintBody(); });
    top.append(menu, title, q);

    const tabs = document.createElement("div");
    tabs.className = "tabs";
    this._tabBtns = {};
    for (const [k, label] of UNIFI_TABS) {
      const b = document.createElement("button");
      b.textContent = label;
      b.addEventListener("click", () => {
        this._tab = k; this._armed = "";
        for (const t in this._tabBtns) this._tabBtns[t].classList.toggle("on", t === k);
        this._paintBody();
      });
      this._tabBtns[k] = b;
      tabs.appendChild(b);
    }
    this._tabBtns.overview.classList.add("on");

    this._body = document.createElement("div");
    this._body.className = "body";
    const wrap = document.createElement("div");
    wrap.className = "wrap";
    this._wrap = wrap;
    this._body.append(tabs, wrap);

    root.append(style, top, this._body);
  }

  _paint() { if (this._wrap) this._paintBody(); }

  _paintBody() {
    const w = this._wrap;
    if (!w || !this._hass) return;
    const keep = this._body.scrollTop;
    w.textContent = "";
    const fn = {
      overview: () => this._overview(),
      aps: () => this._devTable("ap"),
      sw: () => this._switches(),
      clients: () => this._clients(),
      fw: () => this._firmware(),
    }[this._tab];
    for (const node of fn()) w.appendChild(node);
    this._body.scrollTop = keep;
  }

  /* ---------------------------------------------------------- helpers -- */

  _card(titleText) {
    const c = document.createElement("div");
    c.className = "card";
    if (titleText) {
      const h = document.createElement("h3");
      h.textContent = titleText;
      c.appendChild(h);
    }
    return c;
  }

  _hit(text) { return !this._q || String(text).toLowerCase().indexOf(this._q) >= 0; }

  /* One sortable table. `cols` is [key, label, className?]; clicking a
   * header sorts, clicking the same one again reverses it. */
  _table(key, cols, rows) {
    const t = document.createElement("table");
    const st = this._sort[key] || { col: cols[0][0], dir: 1 };
    const thead = document.createElement("thead");
    const htr = document.createElement("tr");
    for (const [ck, label] of cols) {
      const th = document.createElement("th");
      th.textContent = label;
      if (st.col === ck) {
        const ar = document.createElement("span");
        ar.className = "ar";
        ar.textContent = st.dir > 0 ? " ▲" : " ▼";
        th.appendChild(ar);
      }
      th.addEventListener("click", () => {
        this._sort[key] = { col: ck, dir: st.col === ck ? -st.dir : 1 };
        this._paintBody();
      });
      htr.appendChild(th);
    }
    thead.appendChild(htr);
    const tb = document.createElement("tbody");
    for (const r of sortRows(rows, st.col, st.dir)) {
      const tr = document.createElement("tr");
      for (const [ck, , cls] of cols) {
        const td = document.createElement("td");
        const v = r[ck];
        if (v instanceof HTMLElement || v instanceof DocumentFragment) td.appendChild(v);
        else td.textContent = v === undefined || v === null || v === "" ? "—" : String(v);
        const c = typeof cls === "function" ? cls(r) : cls;
        if (c) td.className = c;
        tr.appendChild(td);
      }
      tb.appendChild(tr);
    }
    t.append(thead, tb);
    if (!rows.length) {
      const e = document.createElement("div");
      e.className = "empty";
      e.textContent = this._q ? "Nothing matches that filter." : "Nothing to show yet.";
      const frag = document.createDocumentFragment();
      frag.append(t, e);
      return frag;
    }
    return t;
  }

  /* The buttons a device actually offers, found rather than assumed. A
   * restart drops every client on that AP, so it asks twice. */
  _actions(dev, ids) {
    const box = document.createElement("div");
    const hass = this._hass;
    const add = (label, danger, run) => {
      const b = document.createElement("button");
      const armKey = `${dev.id}:${label}`;
      const armed = this._armed === armKey;
      b.className = danger && armed ? "act arm" : "act";
      b.textContent = armed ? "Sure?" : label;
      b.addEventListener("click", () => {
        if (danger && !armed) { this._armed = armKey; this._paintBody(); return; }
        this._armed = "";
        Promise.resolve(run()).catch((err) => console.error("charro-unifi:", err));
        this._paintBody();
      });
      box.appendChild(b);
    };
    for (const id of ids) {
      const dom = id.split(".")[0];
      const st = hass.states[id];
      if (!st) continue;
      if (dom === "button" && /restart|reboot/.test(id)) {
        add("Restart", true, () => hass.callService("button", "press", { entity_id: id }));
      } else if (dom === "button" && /locate|identify/.test(id)) {
        add("Locate", false, () => hass.callService("button", "press", { entity_id: id }));
      } else if (dom === "switch" && /led|locate/.test(id)) {
        add(st.state === "on" ? "LED off" : "LED on", false,
            () => hass.callService("switch", "toggle", { entity_id: id }));
      } else if (dom === "update" && st.state === "on") {
        add("Install update", true,
            () => hass.callService("update", "install", { entity_id: id }));
      }
    }
    if (!box.childElementCount) {
      const s = document.createElement("span");
      s.className = "pill";
      s.textContent = "none";
      box.appendChild(s);
    }
    return box;
  }

  /* "stale" and "OFFLINE" are different problems with different fixes: one
   * wants deleting in Settings, the other wants looking at. Staleness is
   * checked first because a gone device's tracker also reads unavailable,
   * which the old order reported as merely offline. */
  _devStatus(ids) {
    const hass = this._hass;
    if (!ids.length) return "no entities";
    if (ubiStale(hass, ids)) return "stale";
    for (const id of ids) {
      if (!id.startsWith("device_tracker.")) continue;
      const st = hass.states[id];
      if (st) return st.state === "home" ? "online" : "OFFLINE";
    }
    return "online";
  }

  /* ------------------------------------------------------------ tabs --- */

  _overview() {
    const hass = this._hass;
    const devs = ubiDevices(hass);
    const byDev = entsByDevice(hass);
    const out = [];

    const counts = {};
    for (const d of devs) counts[ubiKind(d)] = (counts[ubiKind(d)] || 0) + 1;
    const stats = this._card("Inventory");
    const sw = document.createElement("div");
    sw.className = "stat";
    const cells = [["Devices", devs.length]];
    for (const [k, , label] of UNIFI_KINDS) if (counts[k]) cells.push([label, counts[k]]);
    cells.push(["Entities", devs.reduce((n, d) => n + ((byDev[d.id] || []).length), 0)]);
    for (const [label, n] of cells) {
      const c = document.createElement("div");
      const b = document.createElement("b");
      b.textContent = String(n);
      const s = document.createElement("span");
      s.textContent = label;
      c.append(b, s);
      sw.appendChild(c);
    }
    stats.appendChild(sw);
    out.push(stats);

    const health = this._card("Health");
    for (const [level, text] of unifiHealth(hass)) {
      const p = document.createElement("div");
      p.className = `msg ${level}`;
      p.textContent = text;
      health.appendChild(p);
    }
    out.push(health);

    const rows = clientRows(hass).filter((r) => r.online);
    const load = {};
    for (const r of rows) load[r.ap] = (load[r.ap] || 0) + 1;
    const lc = this._card("Clients per AP (from reporting devices)");
    lc.appendChild(this._table("load",
      [["ap", "Access point"], ["n", "Clients"]],
      Object.keys(load).map((k) => ({ ap: k, n: load[k] }))));
    out.push(lc);
    return out;
  }

  _devTable(kind) {
    const hass = this._hass;
    const byDev = entsByDevice(hass);
    const label = (UNIFI_KINDS.find((k) => k[0] === kind) || [, , kind])[2];
    const areas = hass.areas || {};
    const clients = clientRows(hass).filter((r) => r.online);
    const load = {};
    for (const r of clients) load[r.ap] = (load[r.ap] || 0) + 1;

    const rows = ubiDevices(hass)
      .filter((d) => ubiKind(d) === kind)
      .filter((d) => this._hit(`${ubiName(d)} ${d.model} ${d.sw_version} ${ubiMac(d)}`))
      .map((d) => {
        const ids = byDev[d.id] || [];
        return {
          name: ubiName(d),
          model: d.model || "",
          area: (areas[d.area_id] || {}).name || "—",
          fw: d.sw_version || "—",
          ip: d.configuration_url ? String(d.configuration_url).replace(/^https?:\/\//, "") : "—",
          mac: ubiMac(d) || "—",
          seen: load[ubiName(d)] || 0,
          status: this._devStatus(ids),
          ents: ids.length,
          act: this._actions(d, ids),
        };
      });

    const dimStale = (r) => (r.status === "stale" ? "dim" : "");
    const cols = [
      ["name", "Name", dimStale], ["model", "Model", "dim"], ["area", "Area", "dim"],
      ["fw", "Firmware", dimStale],
      ["status", "Status", (r) => (r.status === "online" ? "good" : r.status === "OFFLINE" ? "bad" : "dim")],
      ["ents", "Entities", "dim"], ["mac", "MAC", "dim"],
    ];
    if (kind === "ap") cols.splice(5, 0, ["seen", "Clients seen"]);
    cols.push(["act", "Actions"]);

    const c = this._card(`${label} (${rows.length})`);
    c.appendChild(this._table(kind, cols, rows));
    return [c];
  }

  _switches() {
    const out = this._devTable("sw");
    const hass = this._hass;
    const byDev = entsByDevice(hass);
    const ports = [];
    for (const d of ubiDevices(hass)) {
      for (const id of byDev[d.id] || []) {
        if (!/^switch\..*(poe|port)/.test(id)) continue;
        const st = hass.states[id];
        if (!st) continue;
        const nm = (hass.entities[id] || {}).name || id;
        if (!this._hit(`${ubiName(d)} ${nm}`)) continue;
        const tog = document.createElement("button");
        tog.className = "act";
        tog.textContent = st.state === "on" ? "Turn off" : "Turn on";
        tog.addEventListener("click", () => {
          hass.callService("switch", "toggle", { entity_id: id })
            .catch((err) => console.error("charro-unifi:", err));
        });
        ports.push({ dev: ubiName(d), port: nm, state: st.state, act: tog });
      }
    }
    const c = this._card(`PoE / ports (${ports.length})`);
    if (!ports.length) {
      const e = document.createElement("div");
      e.className = "empty";
      e.textContent = "No port switches exist. They are created by the UniFi " +
        "integration once a switch is tracked, and are disabled by default.";
      c.appendChild(e);
    } else {
      c.appendChild(this._table("ports", [
        ["dev", "Switch"], ["port", "Port"],
        ["state", "State", (r) => (r.state === "on" ? "good" : "dim")],
        ["act", ""],
      ], ports));
    }
    out.push(c);
    return out;
  }

  _clients() {
    const rows = clientRows(this._hass)
      .filter((r) => this._hit(`${r.name} ${r.ap} ${r.ssid} ${r.bssid}`));
    const c = this._card(`Wireless clients (${rows.filter((r) => r.online).length} online)`);
    c.appendChild(this._table("clients", [
      ["name", "Device"], ["ssid", "Network"],
      ["ap", "Access point", (r) => (r.online ? (r.known ? "" : "bad") : "dim")],
      ["since", "On this AP"], ["link", "Link", "dim"], ["bssid", "BSSID", "dim"],
    ], rows));
    const note = document.createElement("div");
    note.className = "msg info";
    note.textContent = "These come from the Home Assistant companion app, not from " +
      "UniFi, so only devices running it appear. “On this AP” is how long " +
      "since the BSSID last changed — a number that keeps climbing while signal " +
      "drops is a client refusing to roam.";
    c.appendChild(note);
    return [c];
  }

  _firmware() {
    const hass = this._hass;
    const byDev = entsByDevice(hass);
    const rows = ubiDevices(hass)
      .filter((d) => this._hit(`${ubiName(d)} ${d.model} ${d.sw_version}`))
      .map((d) => {
        const ids = byDev[d.id] || [];
        const up = ids.find((i) => i.startsWith("update."));
        const st = up && hass.states[up];
        return {
          name: ubiName(d),
          model: d.model || "—",
          kind: (UNIFI_KINDS.find((k) => k[0] === ubiKind(d)) || [, , "Other"])[2],
          fw: d.sw_version || "—",
          hw: d.hw_version || "—",
          status: this._devStatus(ids),
          pending: st ? (st.state === "on"
            ? (st.attributes || {}).latest_version || "yes" : "up to date") : "—",
          act: this._actions(d, ids),
        };
      });
    const c = this._card(`Firmware (${rows.length} devices)`);
    c.appendChild(this._table("fw", [
      ["name", "Device", (r) => (r.status === "stale" ? "dim" : "")],
      ["kind", "Kind", "dim"], ["model", "Model", "dim"],
      ["fw", "Running", (r) => (r.status === "stale" ? "dim" : "")],
      ["status", "State", (r) => (r.status === "online" ? "good"
                                  : r.status === "OFFLINE" ? "bad" : "dim")],
      ["hw", "Hardware", "dim"],
      ["pending", "Available", (r) => (/^\d/.test(r.pending) ? "bad" : "dim")],
      ["act", "Actions"],
    ], rows));
    return [c];
  }
}
def("charro-unifi-panel", CharroUnifiPanel);



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

/* The dock, the dots and the extras row are the dashboard's own card
 * surface, described once. room-card.json gives a room tile a 14px radius,
 * no shadow and no background of its own — it just takes the theme's card
 * colour — so these do the same and read as part of the same family rather
 * than a control panel bolted underneath. The blur is a little heavier than
 * a card's because these float over the photo with nothing behind them. */
:host {
  --charro-surface-bg: var(--ha-card-background, var(--card-background-color, #1e1e1e));
  --charro-surface-border: 1px solid var(--ha-card-border-color, var(--divider-color, transparent));
  --charro-surface-blur: blur(24px) saturate(1.3);
  --charro-surface-radius: 14px;
  /* The selected tab used to be a tint of --primary-color, which on this
   * theme is indigo and read as a purple chip stuck to the bar. A darker,
   * more solid version of the bar itself says "you are here" without
   * introducing a colour the dashboard doesn't otherwise use. Mixing toward
   * black rather than hard-coding a dark value keeps it right on a light
   * theme too: 30% toward black still leaves dark label text readable. */
  --charro-active-bg: color-mix(in srgb, var(--card-background-color, #1e1e1e) 70%, #000);
}
@media (max-width: 869px) {
  :host { --charro-dock-x: 50vw; }
}

:host(:not([charro-edit])) ha-tab-group::part(base) { height: auto; }
:host(:not([charro-edit])) ha-tab-group::part(body) { display: none; }   /* the empty tab panel */
:host(:not([charro-edit])) ha-tab-group::part(nav) { border: none; }
:host(:not([charro-edit])) ha-tab-group::part(tabs) {
  gap: 2px;
  padding: 5px;
  border-radius: var(--charro-surface-radius);
  background: var(--charro-surface-bg);
  -webkit-backdrop-filter: var(--charro-surface-blur);
  backdrop-filter: var(--charro-surface-blur);
  border: var(--charro-surface-border);
  box-shadow: none;
  /* a dashboard can outgrow the screen's width; the row scrolls rather than
   * overflowing the dock or squashing the labels */
  max-width: calc(100vw - 24px);
  overflow-x: auto;
  scrollbar-width: none;
}
:host(:not([charro-edit])) ha-tab-group::part(tabs)::-webkit-scrollbar { display: none; }
:host(:not([charro-edit])) ha-tab-group-tab { flex: 0 0 auto; }

:host(:not([charro-edit])) ha-tab-group-tab::part(base) {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  height: 50px;
  min-width: 64px;
  padding: 0 10px;
  border-radius: 10px;
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
  background: var(--charro-active-bg);
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
/* Home Assistant reserves the header's 56px at the top of the view. With
 * the bar gone that is a blank band above the first card while the last one
 * disappears under the dock, so the space moves to the end where the dock
 * actually is. */
:host(:not([charro-edit])) hui-view-container {
  padding-top: env(safe-area-inset-top, 0px);
  padding-bottom: calc(118px + env(safe-area-inset-bottom, 0px));
}


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
:host(:not([charro-edit])) .header {
  background: none !important;
  pointer-events: none;
  /* Home Assistant gives the header a drop shadow once content scrolls
   * under it (:host([scrolled]) .header). The bar itself is invisible, so
   * all that lands on screen is the shadow: a hairline across the top at
   * the header's lower edge — which on a phone is 56px plus the status-bar
   * inset, not 56px. This theme happens to define --bar-box-shadow as
   * transparent, so it costs nothing here, but another theme's wouldn't. */
  box-shadow: none !important;
}
:host(:not([charro-edit])) .header::before { display: none !important; }
:host(:not([charro-edit])) .toolbar > ha-menu-button,
:host(:not([charro-edit])) .toolbar .main-title { display: none !important; }
:host(:not([charro-edit])) .toolbar .action-items { display: none !important; }
:host(:not([charro-edit])) ha-tab-group { pointer-events: auto; }
/* the toolbar's divider — a thin light line straight across the top of a
 * bar that is otherwise no longer drawn */
:host(:not([charro-edit])) .toolbar { border-bottom: none !important; }

/* Tapping the dots floats the real controls — Home Assistant's own add,
 * search, assist and edit buttons, plus its overflow menu — just above the
 * dock. Nothing is reimplemented and nothing is moved in the DOM; the row
 * is simply positioned somewhere else. */
:host(:not([charro-edit])[charro-extras]) .toolbar {
  position: fixed;
  top: auto;
  z-index: 7;
  height: auto;
  width: auto;
  padding: 4px;
  border-radius: var(--charro-surface-radius);
  pointer-events: auto;
  /* Opens upward out of the dots rather than floating over the middle of
   * the dashboard: stacked, right edges aligned with the button, sitting
   * just above it, so it reads as that button's menu.
   * Still no transform — one here would make this the containing block for
   * the fixed dock nested inside it, and the dock would fly up into it. */
  left: auto;
  right: 12px;
  bottom: calc(64px + env(safe-area-inset-bottom, 0px));
  flex-direction: column-reverse;
  align-items: center;
  gap: 2px;
  background: var(--charro-surface-bg);
  border: var(--charro-surface-border);
  box-shadow: none;
}
:host(:not([charro-edit])[charro-extras]) .toolbar::before {
  content: ""; position: absolute; inset: 0; z-index: -1;
  border-radius: var(--charro-surface-radius); pointer-events: none;
  -webkit-backdrop-filter: var(--charro-surface-blur);
  backdrop-filter: var(--charro-surface-blur);
}
/* Home Assistant only fills the menu button in when the sidebar is hidden,
 * so on a phone this is the one way back to it. */
:host(:not([charro-edit])[charro-extras]) .toolbar > ha-menu-button { display: block !important; }
:host(:not([charro-edit])[charro-extras]) .toolbar .action-items {
  display: flex !important;
  flex-direction: column-reverse;
  align-items: center;
  gap: 2px;
}

:host(:not([charro-edit])) #charro-extras-btn {
  position: fixed;
  z-index: 7;
  width: 44px;
  height: 44px;
  border-radius: var(--charro-surface-radius);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  color: var(--secondary-text-color);
  background: var(--charro-surface-bg);
  -webkit-backdrop-filter: var(--charro-surface-blur);
  backdrop-filter: var(--charro-surface-blur);
  border: var(--charro-surface-border);
  box-shadow: none;
  transition: background 200ms ease, color 200ms ease;
  /* parked in the corner of the screen rather than tethered to the dock,
   * so it stays put however many views the dashboard grows */
  right: 12px;
  left: auto;
  bottom: calc(12px + env(safe-area-inset-bottom, 0px));
}
:host(:not([charro-edit])) #charro-extras-btn:hover { color: var(--primary-text-color); }
:host([charro-extras]) #charro-extras-btn {
  background: var(--charro-active-bg);
  color: var(--primary-text-color);
}
/* While editing, the real toolbar is back; the dots would be a duplicate. */
:host([charro-edit]) #charro-extras-btn { display: none; }
/* Nothing behind the dots but the edit controls, so a viewer who can't edit
 * gets a button that opens an empty row. Hidden for them instead. */
:host([charro-noedit]) #charro-extras-btn { display: none; }


/* ---- phones and tablets ------------------------------------------------
 *
 * A floating pill works on a desk, where there is room around it and a
 * cursor to aim with. On a phone it sits in the middle of the screen with
 * cards visible down both sides and sliding behind it, which reads as a
 * card that happens to be on top rather than as the navigation — and it is
 * a long way from the thumb.
 *
 * So below the breakpoint it becomes what a phone expects: a full-width bar
 * on the bottom edge, tabs spread across it, the dots tucked into the right
 * end rather than floating beside it. It takes --card-background-color
 * rather than the near-transparent card surface, so content passing
 * underneath doesn't show through it.
 *
 * These come last in the stylesheet on purpose: they share specificity with
 * the desktop rules above, so order is what decides them.
 */
@media (max-width: 869px) {
  :host(:not([charro-edit])) ha-tab-group {
    left: 0;
    right: 0;
    bottom: 0;
    width: 100%;
    transform: none;
  }
  :host(:not([charro-edit])) ha-tab-group::part(base),
  :host(:not([charro-edit])) ha-tab-group::part(nav) { width: 100%; }
  :host(:not([charro-edit])) ha-tab-group::part(tabs) {
    border-radius: 0;
    border-left: none;
    border-right: none;
    border-bottom: none;
    justify-content: space-around;
    background: var(--card-background-color, #1e1e1e);
    max-width: 100vw;
    /* The home-indicator inset is only partly honoured: taking all 34px of
     * it pushed the labels noticeably up the screen, and the indicator is a
     * thin overlay rather than something that needs full clearance. No room
     * is reserved on the right any more — the dots are gone here, and the
     * gap would just read as the bar being off-centre. */
    padding: 3px calc(3px + env(safe-area-inset-right, 0px)) calc(3px + env(safe-area-inset-bottom, 0px) * 0.55) calc(3px + env(safe-area-inset-left, 0px));
  }
  /* No dots on a phone. The bar is the whole of the navigation here, and
   * the extras behind the dots — add, search, assist, edit — are desk work.
   * Note this also takes away the sidebar button, which Home Assistant only
   * renders on narrow screens and which the extras row was carrying: on a
   * phone this dashboard is now a closed loop, and the sidebar, Settings
   * and the other dashboards are reached from a desktop or by turning this
   * off with window.CHARRO_NO_TAB_STYLE = true. */
  :host(:not([charro-edit])) #charro-extras-btn { display: none; }
  /* the bar is shorter here, and sits on the edge rather than above it */
  :host(:not([charro-edit])) hui-view-container {
    /* the status bar overlays the web view, but the full inset left a band
     * of empty photo above the first card — enough to clear it, no more */
    padding-top: max(calc(env(safe-area-inset-top, 0px) - 14px), 0px);
    padding-bottom: calc(76px + env(safe-area-inset-bottom, 0px) * 0.55);
  }
}
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

/* Home Assistant renders the edit pencil for admins only, and the row the
 * dots reveal is that toolbar — so for anyone else the button would open an
 * empty strip. Same condition, so the two agree. */
function syncCanEdit(host) {
  let admin = false;
  try {
    const hass = host.hass || (document.querySelector("home-assistant") || {}).hass;
    admin = !!(hass && hass.user && hass.user.is_admin);
  } catch (err) { admin = false; }
  host.toggleAttribute("charro-noedit", !admin);
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
    const obs = new MutationObserver(() => stampTabLabels(sr));
    obs.observe(grp, {
      childList: true, subtree: true,
      attributes: true, attributeFilter: ["aria-label"],
    });
    grp.__charroObs = obs;
  }

  watchEditMode(sr, sr.host);
  syncCanEdit(sr.host);
  mountExtras(sr, sr.host);
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
