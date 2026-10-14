const T = require("./harness.js");
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log("  FAIL " + m); } else console.log("  ok   " + m); };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), m + "  got " + JSON.stringify(a));

const hass = {
  areas: { saloon: { name: "Saloon" }, gym: { name: "Gym" }, a_pool: { name: "Pool" } },
  devices: { d1: { area_id: "saloon" }, d2: { area_id: "gym" } },
  entities: {
    "light.saloon_cans":        { area_id: "saloon" },
    "switch.saloon_shade_left": { area_id: "saloon", name: "Saloon Shade Left" },
    "switch.saloon_shade_right":{ area_id: "saloon", name: "Saloon Shade Right" },
    "fan.saloon_ceiling":       { device_id: "d1" },
    "switch.saloon_bath_fan":   { area_id: "saloon", name: "Saloon Bath Fan" },
    "switch.saloon_fountain":   { area_id: "saloon", name: "Saloon Fountain" },
    "switch.saloon_path_lights":{ area_id: "saloon", name: "Saloon Path Lights" },
    "climate.saloon":           { area_id: "saloon" },
    "camera.saloon":            { area_id: "saloon" },
    "lock.saloon_door":         { area_id: "saloon" },
    "media_player.saloon_tv":   { area_id: "saloon" },
    "media_player.saloon_avr":  { area_id: "saloon" },
    "binary_sensor.saloon_door":{ area_id: "saloon" },
    "binary_sensor.saloon_rssi":{ area_id: "saloon" },
    "sensor.saloon_temp":       { area_id: "saloon" },
    "light.saloon_hidden":      { area_id: "saloon", hidden_by: "user" },
    "light.saloon_disabled":    { area_id: "saloon", disabled_by: "user" },
    "light.gym_cans":           { device_id: "d2" },
  },
  states: {
    "media_player.saloon_tv":   { attributes: { device_class: "tv" } },
    "media_player.saloon_avr":  { attributes: { device_class: "receiver" } },
    "binary_sensor.saloon_door":{ attributes: { device_class: "door" } },
    "binary_sensor.saloon_rssi":{ attributes: { device_class: "connectivity" } },
  },
};

/* area resolution */
eq(T.entityArea(hass, "fan.saloon_ceiling"), "saloon", "device area is inherited");
eq(T.entityArea(hass, "light.saloon_cans"), "saloon", "entity area wins");
eq(T.entityArea(hass, "light.nope"), "", "unknown entity has no area");

/* sorting */
const b = T.areaBuckets(hass, "saloon", new Set());
eq(b.light_entities, ["light.saloon_cans"], "plain light -> lights");
eq(b.shade_entities, ["switch.saloon_shade_left", "switch.saloon_shade_right"], "shade switches -> shades");
eq(b.fan_entities, ["fan.saloon_ceiling"], "fan domain -> ceiling fans");
eq(b.bath_fan_entities, ["switch.saloon_bath_fan"], "bath fan beats fan");
eq(b.fountain_entities, ["switch.saloon_fountain"], "fountain switch");
eq(b.landscape_entities, ["switch.saloon_path_lights"], "path lights -> landscape");
eq(b.climate_entity, ["climate.saloon"], "climate");
eq(b.cameras, ["camera.saloon"], "camera");
eq(b.locks, ["lock.saloon_door"], "lock");
eq(b.tv_entity, ["media_player.saloon_tv"], "tv by device_class");
eq(b.receiver_entity, ["media_player.saloon_avr"], "receiver by device_class");
eq(b.alert_sensors, ["binary_sensor.saloon_door"], "door sensor only");
ok(!JSON.stringify(b).includes("saloon_rssi"), "connectivity sensor skipped");
ok(!JSON.stringify(b).includes("sensor.saloon_temp"), "plain sensor skipped");
ok(!JSON.stringify(b).includes("hidden"), "hidden entity skipped");
ok(!JSON.stringify(b).includes("disabled"), "disabled entity skipped");
ok(!JSON.stringify(b).includes("gym"), "another area is not pulled in");
eq(T.areaBuckets(hass, "", new Set()), {}, "no area picked -> nothing");
eq(T.areaBuckets(hass, "a_pool", new Set()), {}, "empty area -> nothing");

/* dedupe against what the room already has, through the real walker */
const room = { room: "saloon", light_entities: ["light.saloon_cans"],
               cameras: [{ entity: "camera.saloon" }] };
const refs = new Map(); T.entityRefs(room, refs, "");
const b2 = T.areaBuckets(hass, "saloon", new Set(refs.keys()));
ok(!b2.light_entities, "a light already in the room is not offered again");
ok(!b2.cameras, "a camera already in the room is not offered again");
ok(b2.shade_entities, "the rest is still offered");

/* applying */
const r = { light_entities: ["light.old"] };
eq(T.areaApply(r, "light_entities", ["light.a", "light.b"]), 2, "two lights added");
eq(r.light_entities, ["light.old", "light.a", "light.b"], "appends, keeps what was there");
const r2 = {};
T.areaApply(r2, "cameras", ["camera.a"]);
eq(r2.cameras, [{ entity: "camera.a" }], "cameras are wrapped as objects");
T.areaApply(r2, "locks", ["lock.a"]);
eq(r2.locks, [{ entity: "lock.a" }], "locks are wrapped as objects");
const r3 = { climate_entity: "climate.keep" };
eq(T.areaApply(r3, "climate_entity", ["climate.new"]), 0, "a filled single field is left alone");
eq(r3.climate_entity, "climate.keep", "and keeps its value");
const r4 = {};
eq(T.areaApply(r4, "climate_entity", ["climate.new"]), 1, "an empty single field takes the first");
eq(r4.climate_entity, "climate.new", "and only the first");
const r5 = { light_entities: "light.one" };
T.areaApply(r5, "light_entities", ["light.two"]);
eq(r5.light_entities, ["light.one", "light.two"], "a string list is promoted, not clobbered");
eq(T.areaApply(r5, "light_entities", []), 0, "nothing to add is a no-op");
eq(T.areaApply(r5, "not_a_field", ["x.y"]), 0, "an unknown key is refused");

/* every target is a field the room editor or a panel actually reads */
for (const k of Object.keys(T.AREA_TARGETS)) ok(T.AREA_TARGETS[k].label, k + " has a label");

console.log(fails ? "\n" + fails + " FAILED" : "\nall passed");
process.exit(fails ? 1 : 0);
