/*
 * Charro Home Assistant — Lovelace cards
 *
 *   charro-room-card      room summary with chips + door alert
 *   charro-security-card  Elk zone / garage door tile, colours itself client-side
 *   charro-zone-card      RTI AD-8x single-line zone control
 *   charro-all-off-card   all zones off, both amps
 *
 * Installed through HACS, so the Lovelace resource is registered automatically.
 * Each card renders custom:button-card with a template fetched from
 * ./templates/*.json — cache: "no-store", so a hard refresh picks up edits.
 *
 * HACS replaces those files on update. To keep your own copy, put one under
 * /config/www/cards/ and set template_url on the card:
 *
 *   type: custom:charro-room-card
 *   template_url: /local/cards/room-card.json
 */

const VERSION = "3.1.0";
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
  "bath_fan_entities", "music_powers", "alert_sensors",
];
const ROOM_SINGLES = ["fountain_entity", "climate_entity", "confirm_sensor"];

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
      fountain_entity: c.fountain_entity || "",
      climate_entity: c.climate_entity || "",
      music_player: c.music_player || "",
      confirm_sensor: c.confirm_sensor || "",
    };
    for (const k of ROOM_LISTS) v[k] = c[k] || [];
    return v;
  }

  triggers() {
    const c = this._config;
    const out = [];
    for (const k of ROOM_LISTS) out.push(...(c[k] || []));
    for (const k of ROOM_SINGLES) if (c[k]) out.push(c[k]);
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
  { type: "expandable", name: "", title: "Climate & water", icon: "mdi:thermostat", schema: [
    { name: "climate_entity", selector: ent(["climate"]) },
    { name: "fountain_entity", selector: ent(["switch", "light"]) },
  ]},
  { type: "expandable", name: "", title: "Music", icon: "mdi:music", schema: [
    { name: "music_powers", selector: ent(["switch"], true) },
    { name: "music_player", selector: ent(["media_player"]) },
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
  fountain_entity: "Fountain",
  music_powers: "Music zone power switches",
  music_player: "Media player (hold the chip)",
  alert_sensors: "Door / window / motion / garage sensors",
  confirm_sensor: "Only alert when this is also open",
}, {
  popup_hash: 'Must match the Bubble Card pop-up, e.g. "#garage-east".',
  landscape_entities: "Kept out of the lights count, gets a palm-tree chip.",
  music_powers: "The chip shows how many of these are on.",
  confirm_sensor: "Guards the garages against a false ratgdo Opening.",
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
      icon: c.icon || (isCover ? "mdi:garage" : "mdi:shield-check"),
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
    description: "Turn every RTI zone off on both amps.", preview: false }
);
