/* The pool code was written against this house's Pentair, which publishes
 * its bodies as water_heater. The picker has always accepted a climate
 * heater too, and then asked the thermostat card for a feature that domain
 * does not have. */
const T = require("./harness.js");
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log("  FAIL " + m); } else console.log("  ok   " + m); };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b),
  m + "  got " + JSON.stringify(a));

const F = T.heaterFeatures;
eq(F("water_heater.charro_pool"), [{ type: "water-heater-operation-modes" }],
  "a water_heater gets its operation modes");
eq(F("climate.pool_heater"), [{ type: "climate-hvac-modes" }],
  "a climate heater gets hvac modes, not water-heater ones");
eq(F("switch.pool_heat"), [], "anything else gets no features rather than a broken one");
eq(F(""), [], "and no heater gets none");
eq(F(undefined), [], "undefined too");

/* the card itself */
const card = (r, k) => T.heaterCard(r, k);
const pentair = { pool_switch: "switch.charro_pool",
                  pool_heater: "water_heater.charro_pool" };
const c1 = card(pentair, "pool");
eq(c1.type, "conditional", "the heater follows its pump");
eq(c1.conditions, [{ condition: "state", entity: "switch.charro_pool", state: "on" }],
  "shown only while the pump is on");
eq(c1.card.features, [{ type: "water-heater-operation-modes" }], "Pentair features");
eq(c1.card.name, "Pool heater", "named from the body");

const generic = { pool_switch: "switch.pump", pool_heater: "climate.pool" };
eq(card(generic, "pool").card.features, [{ type: "climate-hvac-modes" }],
  "a climate heater is wired for climate");

const noPump = { pool_heater: "water_heater.x" };
eq(card(noPump, "pool").type, "thermostat",
  "no pump, no condition - the heater is just shown");
ok(card({}, "pool") === null, "no heater, no card");

/* an odd-domain heater still gets a usable card, just without features */
const odd = card({ pool_heater: "sensor.pool_temp" }, "pool");
eq(odd.features, undefined, "no features key at all rather than an empty one");
eq(odd.type, "thermostat", "still a thermostat card");

/* names and icons are the room's to set */
const named = { pool_switch: "switch.p", pool_name: "Lap Pool", pool_icon: "mdi:waves" };
eq(T.pumpCard(named, "pool").name, "Lap Pool", "the tile name is used");
eq(T.pumpCard(named, "pool").icon, "mdi:waves", "and the tile icon");
eq(T.pumpCard({ pool_switch: "switch.p" }, "pool").icon, "mdi:pool", "default pool icon");
eq(T.pumpCard({ spa_switch: "switch.s" }, "spa").icon, "mdi:hot-tub", "default spa icon");
eq(T.pumpCard({ spa_switch: "switch.s" }, "spa").name, "Spa", "default spa name");
ok(T.pumpCard({}, "pool") === null, "no pump, no pump card");

console.log(fails ? "\n" + fails + " FAILED" : "\nall passed");
process.exit(fails ? 1 : 0);
