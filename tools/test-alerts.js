/* What an alert sensor is, and what the pop-up's far-left marker says
 * about it. The Theatre's only alert sensor is an Elk motion zone, and the
 * header drew a door and called it "Theater Motion closed." */
const T = require("./harness.js");
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log("  FAIL " + m); } else console.log("  ok   " + m); };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), m + "  got " + JSON.stringify(a));

const st = (state, attrs) => ({ state, attributes: attrs || {} });
const S = {
  "sensor.elkm1_theater_motion": st("Normal", { friendly_name: "Theater Motion" }),
  "sensor.elkm1_front_door": st("Normal", { friendly_name: "Front Door" }),
  "sensor.elkm1_zone_14": st("Normal", { friendly_name: "Hall PIR" }),
  "binary_sensor.kitchen_occ": st("off", { device_class: "occupancy", friendly_name: "Kitchen" }),
  "binary_sensor.den_window": st("off", { device_class: "window" }),
  "binary_sensor.motion_named_door": st("off", { device_class: "door", friendly_name: "Motion door" }),
  "cover.garage": st("closed"),
};
console.log("-- kinds --");
eq(T.alertKind("sensor.elkm1_theater_motion", S), "motion", "an Elk motion zone, by its name");
eq(T.alertKind("sensor.elkm1_front_door", S), "door", "an Elk door zone");
eq(T.alertKind("sensor.elkm1_zone_14", S), "motion", "a PIR named by its friendly name only");
eq(T.alertKind("binary_sensor.kitchen_occ", S), "motion", "occupancy is motion");
eq(T.alertKind("binary_sensor.den_window", S), "window", "a window by device class");
eq(T.alertKind("binary_sensor.motion_named_door", S), "door", "a device class beats the name");
eq(T.alertKind("cover.garage", S), "garage", "a cover is a garage");
eq(T.alertKind("sensor.unknown_thing", S), "door", "and anything else is a door, as before");
eq(T.charroAlertIcon("sensor.elkm1_zone_14", S), "mdi:motion-sensor", "the tile's glyph follows");

console.log("-- the pop-up header --");
const head = (sensors, states) => {
  const p = new T.RoomPopup("#t", { room_name: "Theatre", alert_sensors: sensors },
                            { states, entities: {}, config: { unit_system: { temperature: "°F" } } });
  return p._header().children.filter((c) => (c.className || "").split(" ").includes("door"))
    .map((c) => [c.icon, c.className, c.title]);
};
eq(head(["sensor.elkm1_theater_motion"], S), [], "motion only, still: nothing at all");
eq(head(["sensor.elkm1_theater_motion"], { ...S, "sensor.elkm1_theater_motion": st("Violated", { friendly_name: "Theater Motion" }) }),
  [["mdi:motion-sensor", "door open motion", "Theater Motion — movement."]],
  "motion moving: a red motion marker");
eq(head(["sensor.elkm1_front_door", "sensor.elkm1_theater_motion"], S),
  [["mdi:door-closed", "door", "Front Door closed."]], "a door and still motion: just the shut door");
eq(head(["sensor.elkm1_front_door", "sensor.elkm1_theater_motion"],
  { ...S, "sensor.elkm1_front_door": st("Violated", { friendly_name: "Front Door" }),
    "sensor.elkm1_theater_motion": st("Violated", { friendly_name: "Theater Motion" }) }),
  [["mdi:door-open", "door open", "Front Door open."],
   ["mdi:motion-sensor", "door open motion", "Theater Motion — movement."]],
  "door open and movement: both, each red");
eq(head(["binary_sensor.den_window"], { ...S, "binary_sensor.den_window": st("on", { device_class: "window", friendly_name: "Den window" }) }),
  [["mdi:window-open-variant", "door open", "Den window open."]], "an open window draws a window");

console.log("-- the tile's corner badge --");
eq(T.charroAlertGroups({ alert_sensors: ["sensor.elkm1_zone_14", "sensor.elkm1_front_door"] },
  { ...S, "sensor.elkm1_zone_14": st("Violated", { friendly_name: "Hall PIR" }),
    "sensor.elkm1_front_door": st("Violated", { friendly_name: "Front Door" }) }),
  [["mdi:motion-sensor", 1], ["mdi:door-open", 1]], "a PIR and a door: one badge each");

console.log(fails ? "\n" + fails + " FAILED" : "\nall passed");
process.exit(fails ? 1 : 0);
