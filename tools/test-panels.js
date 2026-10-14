/* The Simple view hides a panel this room has nothing in, so a predicate
 * that is wrong about one key silently hides something you did configure.
 * One case per key the panel reads. */
const T = require("./harness.js");
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log("  FAIL " + m); } else console.log("  ok   " + m); };

const U = T.PANEL_USED;
const empty = { room: "x", room_name: "X" };
for (const k of Object.keys(U)) ok(!U[k](empty), k + ": an empty room uses nothing");

const cases = [
  ["video", { video: { displays: [] } }],
  ["video", { remotes: [{ name: "r" }] }],
  ["video", { tv_entity: "media_player.tv" }],
  ["video", { projector_entity: "switch.p" }],
  ["video", { receiver_entity: "media_player.avr" }],
  ["video", { media_player: "media_player.x" }],
  ["music", { music_player: "media_player.ma" }],
  ["music", { music_powers: ["switch.z"] }],
  ["music", { music_sources: { a: 1 } }],
  ["music", { zone_players: { a: 1 } }],
  ["water", { fountain_entities: ["switch.f"] }],
  ["water", { fountain_entities: [{ entity: "switch.f", name: "F" }] }],
  ["water", { water_actions: [{ script: "script.s" }] }],
  ["water", { pool_switch: "switch.pool" }],
  ["water", { pool_heater: "water_heater.pool" }],
  ["water", { spa_switch: "switch.spa" }],
  ["water", { spa_heater: "water_heater.spa" }],
  ["doors", { alert_sensors: ["binary_sensor.d"] }],
  ["doors", { locks: [{ entity: "lock.a" }] }],
  ["doors", { confirm_sensor: "binary_sensor.g" }],
  ["gates", { gates: [{ name: "West" }] }],
  ["cams",  { cameras: [{ entity: "camera.a" }] }],
  ["chips", { chips: { lights: { color: "#fff" } } }],
  ["adv",   { sections: ["lights"] }],
  ["adv",   { cards: { start: [] } }],
  ["adv",   { media_card: { type: "x" } }],
  ["adv",   { camera_card: { type: "x" } }],
];
for (const [k, extra] of cases) {
  const r = { ...empty, ...extra };
  ok(U[k](r), k + ": " + Object.keys(extra)[0] + " counts");
  /* and it must not light up a panel it has nothing to do with */
  const others = Object.keys(U).filter((x) => x !== k && U[x](r));
  ok(!others.length, "   and nothing else: " + (others.join(",") || "none"));
}

/* empty containers are not use - a room that once had a camera and lost it
 * should fold the panel away again */
for (const [k, extra] of [["gates", { gates: [] }], ["cams", { cameras: [] }],
  ["chips", { chips: {} }], ["music", { music_powers: [] }],
  ["doors", { alert_sensors: [], locks: [] }], ["video", { remotes: [] }],
  ["water", { fountain_entities: [], water_actions: [] }]])
  ok(!U[k]({ ...empty, ...extra }), k + ": an empty list is not use");

/* every panel has a button label and an open flag, or the reveal button
 * shows blank text and opens nothing */
for (const k of Object.keys(U)) {
  ok(T.PANEL_ADD[k], k + ": has a button label");
  ok(/^_[A-Za-z]+Open$/.test(T.PANEL_OPEN[k] || ""), k + ": has an open flag");
}

/* the preview switch */
ok(T.PREV_MODES.length === 3, "three preview modes");
ok(T.PREV_MODES.every(([k, l, c]) => k && l && c), "each has a key, a label and a caption");
ok(T.PREV_MODES.map(([k]) => k).join() === "tile,popup,page", "tile, pop-up, page");

console.log(fails ? "\n" + fails + " FAILED" : "\nall passed");
process.exit(fails ? 1 : 0);
