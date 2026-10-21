/* A room's own thermometer. Javon, Janell and Jordan share one thermostat,
 * so the climate chip in all three said the hallway's temperature. A room
 * can now name its own sensor, and both renderers - the tile's template
 * and the pop-up header's roomChips() - must agree on when the chip shows,
 * what number it carries and what colour it is. The real template
 * expressions are run, the same way test-chip-agree runs pool and spa. */
const fs = require("fs"), path = require("path");
const T = require("./harness.js");
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log("  FAIL " + m); } else console.log("  ok   " + m); };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), m + "  got " + JSON.stringify(a));

const tpl = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "dist", "templates", "room-card.json"), "utf8"));
const chips = tpl.custom_fields.chips.card;
const card = chips.custom_fields.climate.card;
const styleOf = (rows, prop) => { for (const row of rows || []) if (prop in row) return row[prop]; return null; };
const run = (expr, v, hass) => {
  const body = String(expr).trim().replace(/^\[\[\[/, "").replace(/\]\]\]$/, "");
  return new Function("variables", "states", "hass", "entity", "user", `"use strict";${body}`)(
    v, hass.states, hass, null, null);
};
const TH = "climate.gym_and_bedrooms", TS = "sensor.javon_temp_monitor_temperature";

function tile(r, hass) {
  const v = { climate_entity: r.climate_entity || "", temp_sensor: r.temp_sensor || "", chips: T.tileChips(r) };
  return {
    show: run(styleOf(chips.styles.custom_fields.climate, "display"), v, hass) === "flex",
    text: run(card.name, v, hass),
    bg: run(styleOf(card.styles.card, "background"), v, hass),
    entity: run(card.entity, v, hass),
  };
}
function header(r, hass) {
  const c = T.roomChips(r, hass).find((x) => x.key === "climate");
  return c ? { show: true, text: c.text, bg: c.col[0], entity: c.tap.entity, title: c.title } : { show: false };
}
const H = (th, ts) => {
  const states = {};
  if (th) states[TH] = { state: th.state, attributes: { friendly_name: "Gym and Bedrooms",
    hvac_action: th.act, current_temperature: th.cur, temperature: th.set } };
  if (ts !== undefined) states[TS] = { state: String(ts), attributes: { friendly_name: "Javon Temp Monitor",
    unit_of_measurement: "°F", device_class: "temperature" } };
  return { states, entities: {}, config: { unit_system: { temperature: "°F" } } };
};

const CASES = [
  ["cooling, room thermometer 76.3", { climate_entity: TH, temp_sensor: TS },
    H({ state: "cool", act: "cooling", cur: 74, set: 72 }, 76.3), { show: true, text: "76°F", mood: "cooling" }],
  ["heating, room thermometer 66.6", { climate_entity: TH, temp_sensor: TS },
    H({ state: "heat", act: "heating", cur: 70, set: 72 }, 66.6), { show: true, text: "67°F", mood: "heating" }],
  ["thermostat off, room thermometer", { climate_entity: TH, temp_sensor: TS },
    H({ state: "off", cur: 70, set: 72 }, 76.3), { show: true, text: "76°F", mood: "off" }],
  ["no thermostat at all, room thermometer", { temp_sensor: TS },
    H(null, 76.3), { show: true, text: "76°F", mood: "off" }],
  ["thermostat off, no thermometer", { climate_entity: TH },
    H({ state: "off", cur: 70, set: 72 }), { show: false }],
  ["thermostat off, thermometer unavailable", { climate_entity: TH, temp_sensor: TS },
    H({ state: "off", cur: 70, set: 72 }, "unavailable"), { show: false }],
  ["thermometer named but gone from HA", { climate_entity: TH, temp_sensor: TS },
    H({ state: "off", cur: 70, set: 72 }), { show: false }],
  ["show never beats a thermometer", { climate_entity: TH, temp_sensor: TS, chips: { climate: { show: "never" } } },
    H({ state: "off" }, 76.3), { show: false }],
];

for (const [label, r, hass, want] of CASES) {
  console.log(`\n-- ${label} --`);
  const a = tile(r, hass), b = header(r, hass);
  eq(a.show, want.show, "tile shows the chip as expected");
  eq(b.show, want.show, "pop-up header agrees");
  if (!want.show) continue;
  eq(a.text, want.text, "tile number");
  eq(b.text, want.text, "header number is the same");
  const offBg = T.CHIP_OFF[0];
  if (want.mood === "off") {
    eq(a.bg, offBg, "tile is the off grey");
    eq(b.bg, offBg, "and so is the header");
  } else {
    const col = T.chipLook("climate", r, want.mood).col[0];
    eq(a.bg, col, `tile is the ${want.mood} colour - the thermostat decides`);
    eq(b.bg, col, "and the header agrees");
  }
  eq(a.entity, r.climate_entity || r.temp_sensor, "tile opens the thermostat, else the thermometer");
  eq(b.entity, r.climate_entity || r.temp_sensor, "and the header opens the same");
}

console.log("\n-- the header's words --");
let h = header(CASES[0][1], CASES[0][2]);
ok(/Javon Temp Monitor reads 76\.3°F/.test(h.title), "says whose number it is  " + h.title);
h = header(CASES[2][1], CASES[2][2]);
ok(/Gym and Bedrooms is off/.test(h.title), "and that the thermostat is off  " + h.title);

console.log("\n-- registered everywhere a field has to be --");
ok(T.ROOM_SINGLES.includes("temp_sensor"), "a room single, so the tile redraws when it changes");
ok(!!T.ROOM_LABELS.temp_sensor, "labelled in the form");
eq(T.FIELD_WHERE.temp_sensor, "Climate", "a bad id says it lives under Climate");
const cl = T.ROOM_SCHEMA.find((g) => g.title === "Climate");
ok(cl && cl.schema.some((f) => f.name === "temp_sensor"), "the Climate group has the picker");
const b2 = T.areaBuckets({ entities: { [TS]: { area_id: "javon" } },
  states: { [TS]: { state: "76", attributes: { device_class: "temperature" } } } }, "javon", new Set());
eq(b2.temp_sensor, [TS], "Fill from area finds a thermometer");

console.log(fails ? "\n" + fails + " FAILED" : "\nall passed");
process.exit(fails ? 1 : 0);
