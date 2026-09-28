/*
 * Charro Home Assistant — Lovelace cards
 *
 *   charro-room-card      room summary with chips + door alert
 *   charro-security-card  Elk zone / garage door tile, colours itself client-side
 *   charro-zone-card      RTI AD-8x single-line zone control
 *   charro-all-off-card   all zones off, both amps
 *   charro-lights-card    one room of lights, uniform rows, inline dimming
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

const VERSION = "4.4.0";
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

/* ============================================================ ROOM CARD == */

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

  variables() {
    const c = this._config;
    let hash = c.popup_hash || (c.room_name ? "#" + slugify(c.room_name) : "");
    if (hash && !hash.startsWith("#")) hash = "#" + hash;
    const v = {
      room_name: c.room_name || "",
      room_icon: c.room_icon || "mdi:home",
      popup_hash: hash,
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
    for (const k of ROOM_LISTS) v[k] = c[k] || [];
    // back-compat: the old single fountain_entity folds into the list
    if (c.fountain_entity && !v.fountain_entities.includes(c.fountain_entity)) {
      v.fountain_entities = [c.fountain_entity, ...v.fountain_entities];
    }
    return v;
  }

  triggers() {
    const c = this._config;
    const out = [];
    for (const k of ROOM_LISTS) out.push(...(c[k] || []));
    for (const k of ROOM_SINGLES) if (c[k]) out.push(c[k]);
    if (c.fountain_entity) out.push(c.fountain_entity);
    return uniq(out);
  }

  getGridOptions() { return { columns: 6, rows: "auto", min_columns: 3 }; }
}
customElements.define("charro-room-card", CharroRoomCard);

makeEditor("charro-room-card-editor", [
  { name: "room_name", required: true, selector: { text: {} } },
  { name: "room_icon", selector: { icon: {} } },
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
], {
  room_name: "Room name",
  room_icon: "Room icon",
  popup_hash: "Pop-up hash (blank = from the name)",
  light_entities: "Lights",
  landscape_entities: "Landscape lights (own chip)",
  fan_entities: "Ceiling fans",
  bath_fan_entities: "Bathroom fans",
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
}, {
  popup_hash: 'Must match the Bubble Card pop-up, e.g. "#garage-east".',
  landscape_entities: "Kept out of the lights count, gets a palm-tree chip.",
  music_powers: "The chip shows how many of these are on.",
  confirm_sensor: "Guards the garages against a false ratgdo Opening.",
  pool_switch: "The pool chip appears only while this is on.",
  pool_heater: "Supplies the temperature and the warming/at-temp colour.",
  fountain_entities: "Fountain, spill, water wall. One chip with a count; tapping turns them all off.",
  tv_entity: "Chip appears only while the TV is on.",
  receiver_entity: "Chip shows the current source while the receiver is on.",
});

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
    description: "One room of lights — equal rows, dim by dragging the row.", preview: false }
);
