/* The tile and the pop-up header are two renderers of one chip row, and
 * every bug in that row has been one of them changing without the other:
 * the lock glyph, the grey lightbulb, and pool and spa, which the tile has
 * always drawn and the header drew not at all.
 *
 * So this does not assert about either one. It evaluates the real
 * expression out of room-card.json and calls the real roomChips() with the
 * same room and the same states, and says whether they agree. A change to
 * one of them fails here until the other one follows.
 */
const fs = require("fs");
const path = require("path");
const T = require("./harness.js");

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log("  FAIL " + m); } else console.log("  ok   " + m); };

const tpl = JSON.parse(fs.readFileSync(
  path.join(__dirname, "..", "dist", "templates", "room-card.json"), "utf8"));
const chips = tpl.custom_fields.chips.card;

/* the expressions the tile actually uses, pulled out by where they live */
const styleOf = (field, group, prop) => {
  const src = group === "field"
    ? chips.styles.custom_fields[field]
    : chips.custom_fields[field].card.styles[group];
  for (const row of src || []) if (prop in row) return row[prop];
  return null;
};
const nameOf = (field) => chips.custom_fields[field].card.name;

/* [[[ ... ]]] with the scope button-card gives a template. `hass` is the
 * complete hass object there, which is why the unit can be read at all. */
const run = (expr, scope) => {
  const body = String(expr).trim().replace(/^\[\[\[/, "").replace(/\]\]\]$/, "");
  // eslint-disable-next-line no-new-func
  return new Function("variables", "states", "hass", "entity", "user",
    `"use strict";${body}`)(scope.variables, scope.hass.states, scope.hass, null, null);
};

const unit = "°F";
const hassWith = (states) => ({ states, config: { unit_system: { temperature: unit } } });

/* Every shape a body of water comes in. `want` is whether a chip should be
 * there at all; `mood` is which of the three colours it should be. */
const CASES = [
  ["no pump configured",            {}, {}, false, null],
  ["pump off",                      { sw: "off" }, {}, false, null],
  ["pump on, no heater",            { sw: "on" }, { noHeater: true }, true, "resting"],
  ["pump on, heater off",           { sw: "on", h: "off" }, {}, true, "resting"],
  ["heater says it is heating",     { sw: "on", h: "heat", act: "heating", cur: 70, set: 90 }, {}, true, "heating"],
  ["heater says it is idle",        { sw: "on", h: "heat", act: "idle", cur: 90, set: 90 }, {}, true, "warm"],
  ["no hvac_action, still climbing", { sw: "on", h: "Gas Heater", cur: 80, set: 90 }, {}, true, "heating"],
  ["no hvac_action, got there",     { sw: "on", h: "Gas Heater", cur: 90, set: 90 }, {}, true, "warm"],
  ["within the half-degree",        { sw: "on", h: "Gas Heater", cur: 89.6, set: 90 }, {}, true, "warm"],
  ["heater unavailable",            { sw: "on", h: "unavailable", cur: 80, set: 90 }, {}, true, "resting"],
  ["pump off but show always",      { sw: "off", h: "off", cur: 75 }, { show: "always" }, true, "off"],
  ["pump off and show never",       { sw: "off" }, { show: "never" }, false, null],
  ["no pump, show always",          {}, { show: "always" }, false, null],
];

for (const kind of ["pool", "spa"]) {
  const SW = `switch.${kind}`, HT = `water_heater.${kind}`;
  console.log(`\n-- ${kind} --`);
  for (const [label, st, opt, want, mood] of CASES) {
    const states = {};
    if (st.sw) states[SW] = { state: st.sw, attributes: {} };
    if (st.h) {
      const attrs = {};
      if (st.cur != null) attrs.current_temperature = st.cur;
      if (st.set != null) attrs.temperature = st.set;
      if (st.act) attrs.hvac_action = st.act;
      states[HT] = { state: st.h, attributes: attrs };
    }
    const hass = hassWith(states);
    const r = {};
    if (st.sw) r[`${kind}_switch`] = SW;
    if (st.h && !opt.noHeater) r[`${kind}_heater`] = HT;
    if (opt.show) r.chips = { [kind]: { show: opt.show } };

    /* ---- the header ---- */
    const got = T.roomChips(r, hass).find((c) => c.key === kind) || null;

    /* ---- the tile, from the template ---- */
    /* what the card hands the template: the chip looks under `chips`, the
     * room's own entity ids alongside them */
    const scope = { variables: { chips: T.tileChips(r) }, hass };
    for (const k of ["pool_switch", "pool_heater", "spa_switch", "spa_heater"])
      scope.variables[k] = r[k];
    const shown = run(styleOf(kind, "field", "display"), scope) !== "none";
    const bg = shown ? run(styleOf(kind, "card", "background"), scope) : null;
    const text = shown ? run(nameOf(kind), scope) : null;

    ok(shown === want, `${label}: tile ${shown ? "draws" : "hides"} it`);
    ok(!!got === want, `${label}: header agrees`);
    /* keep going rather than reading col off a chip that is not there -
     * one disagreement should not hide the next nine */
    if (!want || !got || !shown) continue;

    ok(got.col[0] === bg, `${label}: same background  ${got.col[0]}`);
    ok(got.text === text, `${label}: same text  ${JSON.stringify(got.text)}`);
    if (mood === "off") {
      ok(got.col === T.CHIP_OFF, `${label}: grey, because the pump is off`);
    } else {
      const look = T.chipLook(kind, r, mood);
      ok(got.col[0] === look.col[0], `${label}: the ${mood} colour`);
    }
    if (st.cur != null && (st.h || !opt.noHeater))
      ok(got.text.endsWith(unit),
        `${label}: the instance's unit, not a bare degree  ${got.text}`);
  }
}

/* and the thing that started this: a room with a pool gets a pool chip */
const live = T.roomChips(
  { pool_switch: "switch.p", pool_heater: "water_heater.p",
    spa_switch: "switch.s", spa_heater: "water_heater.s" },
  hassWith({
    "switch.p": { state: "on", attributes: {} },
    "water_heater.p": { state: "Gas Heater", attributes: { current_temperature: 80, temperature: 90 } },
    "switch.s": { state: "on", attributes: {} },
    "water_heater.s": { state: "off", attributes: { current_temperature: 82, temperature: 102 } },
  })).map((c) => c.key);
ok(live.join() === "pool,spa", `the header draws both, in order  [${live}]`);

console.log(fails ? "\n" + fails + " FAILED" : "\nall passed");
process.exit(fails ? 1 : 0);
