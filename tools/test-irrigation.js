/* The irrigation card, against a controller shaped like the real Hydrawise
 * integration's: a controller device with a connectivity sensor and a daily
 * total, and zone devices hanging off it with six entities and a valve
 * each. Names are invented; the shapes are not. */
const T = require("./harness.js");
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log("  FAIL " + m); } else console.log("  ok   " + m); };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), m + "  got " + JSON.stringify(a));
const HW = "Data provided by hydrawise.com";

function fixture(opts = {}) {
  const states = {}, entities = {}, devices = {};
  const put = (id, state, attrs, dev, tk) => {
    states[id] = { entity_id: id, state, attributes: { attribution: HW, ...attrs } };
    entities[id] = { entity_id: id, platform: "hydrawise", device_id: dev };
    if (tk && !opts.noKeys) entities[id].translation_key = tk;
  };
  devices.ctrl = { name: "Garden" };
  put("binary_sensor.garden_connectivity", opts.offline ? "off" : "on",
    { device_class: "connectivity" }, "ctrl");
  put("sensor.garden_daily_active_watering_time", "3600", { unit_of_measurement: "s",
    device_class: "duration" }, "ctrl", "daily_active_water_time");
  const names = ["Front Lawn", "Back Beds", "Side Drip ", "Orchard"];
  names.forEach((n, i) => {
    const k = i + 1, dev = `z${k}`, z = (s) => `zone_${k}_${s}`;
    devices[dev] = { name: n, via_device_id: "ctrl" };
    const o = (opts.zones || {})[k] || {};
    put(`binary_sensor.${z("watering")}`, o.watering || "off", { device_class: "running",
      friendly_name: `${n.trim()} Watering` }, dev, "watering");
    put(`sensor.${z("next_cycle")}`, o.next || "unknown", { device_class: "timestamp" },
      dev, "next_cycle");
    put(`sensor.${z("remaining_watering_time")}`, o.remaining || "unknown",
      { unit_of_measurement: "min" }, dev, "watering_time");
    put(`sensor.${z("daily_active_watering_time")}`, o.today || "0",
      { unit_of_measurement: "s", device_class: "duration" }, dev, "daily_active_water_time");
    put(`switch.${z("automatic_watering")}`, o.auto || "on", { device_class: "switch" },
      dev, "auto_watering");
    put(`switch.${z("manual_watering")}`, "off", { device_class: "switch" }, dev, "manual_watering");
    put(`valve.zone_${k}`, o.valve || (o.watering === "on" ? "open" : "closed"),
      { device_class: "water", friendly_name: n }, dev);
  });
  // something from another integration that must not be picked up
  states["switch.pool_pump"] = { entity_id: "switch.pool_pump", state: "on", attributes: {} };
  entities["switch.pool_pump"] = { platform: "pentair", device_id: "p" };
  const calls = [];
  return { states, entities, devices, locale: { language: "en-US" }, calls,
    callService: async (d, s, data, target) => { calls.push([d, s, data, target]); } };
}

/* ------------------------------------------------------------ discovery -- */
console.log("-- discovery --");
let h = fixture();
let { ctrl, zones } = T.hwPick(h, {});
eq(ctrl.name, "Garden", "the controller is found and named from its device");
eq(ctrl.online, "binary_sensor.garden_connectivity", "with its connectivity sensor");
eq(ctrl.today, "sensor.garden_daily_active_watering_time", "and its daily total");
eq(zones.length, 4, "every zone, and nothing from another integration");
eq(zones.map((z) => z.num), [1, 2, 3, 4], "numbered from the entity ids, in order");
eq(zones[2].name, "Side Drip", "a trailing space in a device name is trimmed");
for (const k of ["watering", "valve", "auto", "manual", "next", "remaining", "today"])
  ok(zones.every((z) => z[k]), `every zone has its ${k} entity`);
ok(!zones.some((z) => z.today === ctrl.today), "the controller total is not taken for a zone's");

h = fixture({ noKeys: true });
({ zones } = T.hwPick(h, {}));
ok(zones.length === 4 && zones.every((z) => z.auto && z.manual && z.next && z.remaining && z.today),
  "without translation keys, device classes and ids still sort every entity");

/* the registry only changes when hass hands over a new object */
h = fixture();
const a1 = T.hwDiscover(h), a2 = T.hwDiscover(h);
ok(a1 === a2, "the same registry is not walked twice");
h.entities = { ...h.entities };
ok(T.hwDiscover(h) !== a1, "a new registry is");

/* two controllers */
h = fixture();
h.devices.ctrl2 = { name: "Paddock" };
h.devices.z9 = { name: "Trough", via_device_id: "ctrl2" };
h.states["binary_sensor.zone_9_watering"] = { state: "off", attributes: { device_class: "running" } };
h.entities["binary_sensor.zone_9_watering"] = { platform: "hydrawise", device_id: "z9", translation_key: "watering" };
let p = T.hwPick(h, {});
eq(p.controllers.map((c) => c.name).sort(), ["Garden", "Paddock"], "both controllers are offered");
p = T.hwPick(h, { controller: "ctrl2" });
eq(p.zones.map((z) => z.name), ["Trough"], "picking one shows only its zones");

/* overrides */
h = fixture();
p = T.hwPick(h, { zones: { z1: { name: "Lawn", color: "#123456" }, z2: { hide: true } } });
eq(p.zones[0].name, "Lawn", "a zone can be renamed");
eq(p.zones[0].color, "#123456", "and recoloured");
ok(!p.zones.some((z) => z.device === "z2"), "a hidden zone is left off the card");
ok(p.allZones.some((z) => z.device === "z2"), "but is still there for the editor");
eq(p.zones[1].color, T.HW_COLORS[2], "an untouched zone keeps its colour by number");

/* ------------------------------------------------------------- readings -- */
console.log("-- readings --");
eq(T.hwSeconds({ state: "90", attributes: { unit_of_measurement: "s" } }), 90, "seconds");
eq(T.hwSeconds({ state: "2", attributes: { unit_of_measurement: "min" } }), 120, "minutes");
eq(T.hwSeconds({ state: "1.5", attributes: { unit_of_measurement: "h" } }), 5400, "hours");
eq(T.hwSeconds({ state: "unknown", attributes: {} }), null, "unknown is nothing, not zero");

const now = new Date(2026, 9, 16, 12, 0, 0);          // a Friday, noon
const at = (d, hh, mm) => new Date(2026, 9, d, hh, mm).toISOString();
h = fixture({ zones: {
  1: { watering: "on", remaining: "3" },
  2: { next: at(17, 5, 0), today: "480" },
  3: { auto: "off", next: at(16, 18, 0) },
  4: { watering: "unavailable", valve: "unavailable", next: at(16, 13, 0) },
} });
({ ctrl, zones } = T.hwPick(h, {}));
const S = zones.map((z) => T.hwState(z, h, now));
ok(S[0].running && S[0].remaining === 3, "a running zone, with its minutes left");
ok(!S[1].running && S[1].next && S[1].next.getDate() === 17, "an idle zone, with its next run");
eq(S[1].today, 480, "and what it has watered today");
ok(S[2].suspended, "automatic watering off is suspended");
ok(S[3].unavailable && !S[3].running, "unavailable is neither running nor idle");

const sum = T.hwSummary(zones, ctrl, h, now);
eq(sum.running.map((x) => x.z.name), ["Front Lawn"], "the summary knows what is running");
eq(sum.next.zone.name, "Back Beds",
  "next is the soonest zone that will actually run - not a suspended or unavailable one");
eq(sum.suspended, 1, "and counts the suspended");
eq(sum.today, 3600, "today's total is the controller's own figure");
ok(sum.online, "online from the connectivity sensor");
ok(!T.hwSummary(zones, ctrl, fixture({ offline: true }), now).online, "and offline from it");
const allGone = fixture({ zones: { 1: { watering: "unavailable", valve: "unavailable" },
  2: { watering: "unavailable", valve: "unavailable" }, 3: { watering: "unavailable", valve: "unavailable" },
  4: { watering: "unavailable", valve: "unavailable" } } });
const noCtrl = T.hwPick(allGone, {});
ok(!T.hwSummary(noCtrl.zones, { device: "x" }, allGone, now).online,
  "with no connectivity sensor, every zone unavailable reads as offline");

/* the signature moves for what is drawn and for nothing else */
const sig1 = T.hwSig(zones, ctrl, h);
h.states["switch.pool_pump"].state = "off";
eq(T.hwSig(zones, ctrl, h), sig1, "an unrelated entity changing redraws nothing");
h.states["sensor.zone_1_remaining_watering_time"].state = "2";
ok(T.hwSig(zones, ctrl, h) !== sig1, "a zone's minutes changing does");

/* ----------------------------------------------------------------- words -- */
console.log("-- words --");
eq(T.hwDur(480), "8m", "minutes");
eq(T.hwDur(3600), "1h", "an even hour");
eq(T.hwDur(11511), "3h 12m", "hours and minutes");
ok(T.hwWhen(new Date(2026, 9, 16, 18, 0), now, "en-US").startsWith("Today "), "today");
ok(T.hwWhen(new Date(2026, 9, 17, 5, 0), now, "en-US").startsWith("Tomorrow "), "tomorrow");
ok(/^Mon /.test(T.hwWhen(new Date(2026, 9, 19, 5, 0), now, "en-US")), "a weekday within the week");
ok(/^Oct 30 /.test(T.hwWhen(new Date(2026, 9, 30, 5, 0), now, "en-US")), "a date beyond it");
eq(T.hwLine(S[0], now, "en-US"), "3 min left", "running says how long");
eq(T.hwLine(S[2], now, "en-US"), "Suspended", "suspended says so");
eq(T.hwLine(S[3], now, "en-US"), "Unavailable", "and unavailable");
eq(T.hwUntil(7, now), "2026-10-23 12:00:00", "suspend for a week, in the format the service takes");
eq(T.hwUntil(0, now, "2026-11-02"), "2026-11-02 00:00:00", "until a picked day means from its start");
eq(T.hwUntil(0, now, "garbage"), "", "and a bad date sends nothing");

/* --------------------------------------------------------------- commands -- */
console.log("-- commands --");
(async () => {
  h = fixture();
  ({ zones } = T.hwPick(h, {}));
  const z1 = zones[0], w1 = "binary_sensor.zone_1_watering";
  await T.hwAct(h, z1, "start", 0, 5);
  eq(h.calls[0], ["hydrawise", "start_watering", {}, { entity_id: w1 }],
    "start at the zone's default time sends no duration");
  ok(T._hwPend.get(w1).kind === "start", "and marks it starting at once");
  eq(T.hwState(z1, h, new Date()).pending, "start", "which the zone reports");
  await new Promise((r) => setTimeout(r, 20));
  eq(h.calls[1].slice(0, 3), ["homeassistant", "update_entity", { entity_id: w1 }],
    "then asks for one refresh rather than waiting five minutes");
  h.states[w1].state = "on";
  eq(T.hwState(z1, h, new Date()).pending, "", "the mark clears when the zone is really running");

  h = fixture();
  ({ zones } = T.hwPick(h, {}));
  await T.hwAct(h, zones[0], "start", 10, 5);
  eq(h.calls[0][2], { duration: 10 }, "start for ten minutes sends ten");
  await T.hwAct(h, zones[0], "start", 5000, 5);
  eq(h.calls[1][2], { duration: 1440 }, "and never more than the service accepts");
  await T.hwAct(h, zones[0], "stop", null, 5);
  eq(h.calls[2], ["valve", "close_valve", {}, { entity_id: "valve.zone_1" }], "stop closes the valve");
  await T.hwAct(h, zones[0], "suspend", "2026-10-23 12:00:00", 5);
  eq(h.calls[3], ["hydrawise", "suspend", { until: "2026-10-23 12:00:00" },
    { entity_id: "binary_sensor.zone_1_watering" }], "suspend sends its date");
  await T.hwAct(h, zones[0], "resume", null, 5);
  eq(h.calls[4].slice(0, 2), ["hydrawise", "resume"], "resume");
  await new Promise((r) => setTimeout(r, 20));
  eq(h.calls.filter((c) => c[1] === "update_entity").length, 1,
    "five presses in a row cost one refresh, not five");

  const noValve = { ...zones[1], valve: null };
  await T.hwAct(h, noValve, "stop", null, 5);
  eq(h.calls.at(-1), ["switch", "turn_off", {}, { entity_id: "switch.zone_2_manual_watering" }],
    "with no valve, stop turns the manual switch off");

  const refused = fixture();
  refused.callService = async () => { throw new Error("nope"); };
  let threw = false;
  try { await T.hwAct(refused, T.hwPick(refused, {}).zones[0], "start", 0, 5); }
  catch (e) { threw = true; }
  ok(threw, "a refused command is reported");
  eq(T.hwState(T.hwPick(refused, {}).zones[0], refused, new Date()).pending, "",
    "and does not leave the zone claiming to start");

  /* an old mark stops claiming anything */
  h = fixture();
  ({ zones } = T.hwPick(h, {}));
  T._hwPend.set("binary_sensor.zone_3_watering", { kind: "start", at: Date.now() - T.HW_PENDING_MS - 1 });
  eq(T.hwState(zones[2], h, new Date()).pending, "", "a mark older than its limit is dropped");

  /* --------------------------------------------------------------- screens */
  console.log("-- screens --");
  h = fixture({ zones: { 1: { watering: "on", remaining: "4" } } });
  ({ ctrl, zones } = T.hwPick(h, {}));
  let s2 = T.hwSummary(zones, ctrl, h, now);
  let tile = T.hwTileDom(s2, {}, now, "en-US");
  ok(tile.textContent.includes("Irrigation"), "the tile is titled");
  ok(tile.textContent.includes("Front Lawn · 4 min left"), "and says what is running");
  ok(tile.textContent.includes("1 running"), "with a running chip");
  ok(tile.textContent.includes("Today 1h"), "and today's total");
  tile = T.hwTileDom(T.hwSummary(zones, ctrl, fixture({ offline: true }), now), { title: "Yard" }, now, "en-US");
  ok(tile.textContent.includes("Yard") && tile.textContent.includes("\u2019t reach Hydrawise"),
    "losing the cloud says so, under the chosen title");
  ok(!tile.textContent.includes("offline"),
    "and does not blame the controller, which the sensor knows nothing about");

  let opened = null;
  const grid = T.hwGridDom({ sum: s2, zones: s2.states, now, lang: "en-US" },
    { open: (z) => { opened = z; } });
  const tiles = grid.querySelectorAll("button.z");
  eq(tiles.length, 4, "one button per zone");
  ok(tiles[0].className.includes("run"), "the running one is marked");
  ok(tiles[0].textContent.includes("Running"), "and badged");
  tiles[1].click();
  eq(opened && opened.name, "Back Beds", "pressing a zone opens it");
  ok(!grid.querySelector(".banner.off"), "no offline banner while online");
  const offGrid = T.hwGridDom({ sum: T.hwSummary(zones, ctrl, fixture({ offline: true }), now),
    zones: s2.states, now, lang: "en-US" }, { open() {} });
  ok(!!offGrid.querySelector(".banner.off"), "and one when offline");

  const acts = [];
  const hz = { back() {}, draft() {}, act: (k, a) => acts.push([k, a]) };
  const idle = s2.states[1];
  let zd = T.hwZoneDom(idle.z, idle.s, { now, lang: "en-US" }, hz);
  const press = (root, label) => {
    const b = root.querySelectorAll("button.b").find((x) => x.textContent === label);
    if (!b) throw new Error("no button " + label);
    b.click();
  };
  press(zd, "Start");
  press(zd, "10 min");
  press(zd, "1 week");
  eq(acts, [["start", 0], ["start", 10], ["suspend", "2026-10-23 12:00:00"]],
    "Start, 10 min and 1 week send what they say");
  const num = zd.querySelector("input.num");
  num.value = "25";
  press(zd, "Run");
  eq(acts.at(-1), ["start", 25], "typed minutes run for that long");
  ok(!zd.querySelectorAll("button.b").some((b) => b.textContent === "Stop"),
    "an idle zone offers no Stop");

  const runningZ = s2.states[0];
  zd = T.hwZoneDom(runningZ.z, runningZ.s, { now, lang: "en-US" }, hz);
  press(zd, "Stop");
  eq(acts.at(-1), ["stop", undefined], "a running zone offers Stop");
  ok(!zd.querySelectorAll("button.b").some((b) => b.textContent === "Start"),
    "and not Start");

  const susp = { ...idle.s, suspended: true };
  zd = T.hwZoneDom(idle.z, susp, { now, lang: "en-US" }, hz);
  press(zd, "Resume");
  eq(acts.at(-1), ["resume", undefined], "a suspended zone offers Resume");

  const gone = { ...idle.s, unavailable: true };
  zd = T.hwZoneDom(idle.z, gone, { now, lang: "en-US" }, hz);
  const n0 = acts.length;
  zd.querySelectorAll("button.b").forEach((b) => b.click());
  eq(acts.length, n0, "an unavailable zone's buttons do nothing");
  zd = T.hwZoneDom(idle.z, idle.s, { now, lang: "en-US", busy: true }, hz);
  zd.querySelectorAll("button.b").forEach((b) => b.click());
  eq(acts.length, n0, "nor do any while a command is in flight");
  zd = T.hwZoneDom(idle.z, idle.s, { now, lang: "en-US", err: "Hydrawise refused that: x" }, hz);
  ok(zd.textContent.includes("Hydrawise refused that"), "a refusal is shown on the zone");

  console.log(fails ? "\n" + fails + " FAILED" : "\nall passed");
  process.exit(fails ? 1 : 0);
})();
