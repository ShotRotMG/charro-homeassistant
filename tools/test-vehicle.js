/* The vehicle card: a car's entities found from its device by name, the
 * compact card drawn from them, and only redrawn when the car changes. */
const T = require("./harness.js");
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log("  FAIL " + m); } else console.log("  ok   " + m); };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), m + "  got " + JSON.stringify(a));

const V = "fordpass_3fmtk";
const st = (state, attrs) => ({ state, attributes: attrs || {}, last_updated: "t0" });
const mk = (over) => {
  const states = {
    [`sensor.${V}_soc`]: st("40.0", { unit_of_measurement: "%" }),
    [`sensor.${V}_elveh`]: st("118.2", { unit_of_measurement: "mi" }),
    [`sensor.${V}_elvehplug`]: st("CONNECTED"),
    [`sensor.${V}_elvehcharging`]: st("CHARGING", { estimatedEndTime: "2026-10-30T09:00:00Z" }),
    [`sensor.${V}_elvehchargingpower`]: st("6.412", { unit_of_measurement: "kW" }),
    [`sensor.${V}_odometer`]: st("43996.18", { unit_of_measurement: "mi" }),
    [`lock.${V}_doorlock`]: st("locked"),
    [`device_tracker.${V}_tracker`]: st("home"),
    [`select.${V}_elvehtargetcharge`]: st("95", { options: ["80", "90", "95", "100"] }),
    [`sensor.${V}_battery`]: st("96", { unit_of_measurement: "%" }),
    "sensor.other_soc": st("10"),
    ...(over || {}),
  };
  const entities = {};
  for (const id of Object.keys(states))
    entities[id] = { device_id: id.startsWith("sensor.other") ? "x" : "car1", platform: "fordpass" };
  return { states, entities, devices: { car1: { name: "Mustang Mach-E" } }, callService: async () => {} };
};

console.log("-- found from the device --");
let h = mk();
const e = T.vehEntities({ device: "car1" }, h);
eq(e.soc, `sensor.${V}_soc`, "charge");
eq(e.range, `sensor.${V}_elveh`, "range");
eq(e.lock, `lock.${V}_doorlock`, "the door lock");
eq(e.battery12, `sensor.${V}_battery`, "the 12V battery");
eq(e.target, `select.${V}_elvehtargetcharge`, "the target charge");
ok(!Object.values(e).includes("sensor.other_soc"), "nothing from another device");
eq(T.vehEntities({ device: "car1", soc: "sensor.other_soc" }, h).soc, "sensor.other_soc", "an entity picked in the editor wins");
eq(T.vehEntities({ lock: `lock.${V}_doorlock` }, h).soc, `sensor.${V}_soc`, "one entity is enough to find the device");

eq(e._make, "ford", "a FordPass device reads as a Ford");

console.log("-- a Tesla --");
{
  const ts = {
    "sensor.setareh_battery_level": st("92"), "sensor.setareh_battery_range": st("267", { unit_of_measurement: "mi" }),
    "binary_sensor.setareh_charge_cable": st("on"), "sensor.setareh_charging": st("charging"),
    "sensor.setareh_charger_power": st("7.2", { unit_of_measurement: "kW" }), "lock.setareh_lock": st("locked"),
    "number.setareh_charge_limit": st("90"), "cover.setareh_trunk": st("closed"),
    "sensor.renamed_by_hand": st("36853", { unit_of_measurement: "mi" }),
  };
  const te = {};
  for (const id of Object.keys(ts)) te[id] = { device_id: "tes", platform: "teslemetry" };
  te["sensor.renamed_by_hand"].translation_key = "vehicle_state_odometer";
  const th = { states: ts, entities: te, devices: { tes: { name: "Setareh" } } };
  const t = T.vehEntities({ device: "tes" }, th);
  eq(t._make, "tesla", "a Teslemetry device reads as a Tesla");
  eq([t.soc, t.plug, t.target, t.trunk], ["sensor.setareh_battery_level", "binary_sensor.setareh_charge_cable",
    "number.setareh_charge_limit", "cover.setareh_trunk"], "its charge, cable, limit and trunk");
  eq(t.odometer, "sensor.renamed_by_hand", "found by its translation key even when renamed");
  ok(T.vehCharge(th, t).plugged && T.vehCharge(th, t).charging, "cable on and charging");
  eq(T.vehEntities({ device: "car1", make: "tesla" }, mk()).soc, undefined, "Make set by hand is obeyed");
}

console.log("-- charging --");
let c0 = T.vehCharge(h, e);
ok(c0.plugged && c0.charging, "plugged in and charging");
eq(c0.w, 6412, "at 6.4 kW");
c0 = T.vehCharge(mk({ [`sensor.${V}_elvehplug`]: st("DISCONNECTED"), [`sensor.${V}_elvehcharging`]: st("NOT_READY"),
  [`sensor.${V}_elvehchargingpower`]: st("0", { unit_of_measurement: "kW" }) }), e);
ok(!c0.plugged && !c0.charging, "DISCONNECTED is unplugged, not plugged in");

console.log("-- the compact card --");
const card = (hh, cfg) => {
  const c = Object.create(T.CharroVehicleCard.prototype);
  c.attachShadow = function () { this.shadowRoot = T.el("shadow-root"); return this.shadowRoot; };
  c.setConfig(cfg || { device: "car1" }); c.hass = hh; return c;
};
const c = card(h);
const sr = c.shadowRoot;
eq(sr.querySelector(".nm").textContent, "Mustang Mach-E", "named after the device");
ok(!sr.querySelector(".chips"), "no Connected / Charging words: the bar says it");
eq(sr.querySelector(".fill").style.width, "40%", "the bar at 40%");
const ld = sr.querySelector(".load");
ok(!!ld && ld.style.left === "40%" && ld.style.width === "55%", "the stretch up to 95% loads while it charges");
eq(sr.querySelector(".badge").querySelector("ha-icon").getAttribute("icon"), "mdi:lightning-bolt", "with a bolt on the bar");
eq(sr.querySelector(".tgt").style.left, "calc(95% - 1px)", "the target marked at 95%");
const foot = sr.querySelector(".foot").children;
ok(/^40% · 6\.4 kW/.test(foot[0].textContent), "40%, then how fast  got " + foot[0].textContent);
eq(foot[1].textContent, "Range: 118 mi", "range on the right");
{
  const hp = mk({ [`sensor.${V}_elvehcharging`]: st("COMPLETED"), [`sensor.${V}_elvehchargingpower`]: st("0", { unit_of_measurement: "kW" }) });
  const pc = card(hp).shadowRoot;
  ok(!pc.querySelector(".load"), "plugged in but done: nothing loading");
  eq(pc.querySelector(".badge").querySelector("ha-icon").getAttribute("icon"), "mdi:power-plug", "a plug on the bar");
  ok(/Plugged in/.test(pc.querySelector(".foot").children[0].textContent), "and it says plugged in");
  const hu = mk({ [`sensor.${V}_elvehplug`]: st("DISCONNECTED"), [`sensor.${V}_elvehcharging`]: st("NOT_READY"),
    [`sensor.${V}_elvehchargingpower`]: st("0", { unit_of_measurement: "kW" }) });
  const uc = card(hu).shadowRoot;
  ok(!uc.querySelector(".badge") && !uc.querySelector(".load"), "unplugged: just the bar");
}
ok(!!sr.querySelector("svg") || /svg/.test(sr.querySelector(".car").innerHTML), "a drawn car until a picture is given");
const before = sr.querySelector("ha-card");
c.hass = { ...h, states: { ...h.states, "light.kitchen": st("on") } };
ok(c.shadowRoot.querySelector("ha-card") === before, "a light elsewhere doesn't redraw it");
c.hass = { ...h, states: { ...h.states, [`sensor.${V}_soc`]: { ...st("41"), last_updated: "t1" } } };
eq(c.shadowRoot.querySelector(".fill").style.width, "41%", "its own charge does");
const pic = card(h, { device: "car1", image: "/local/mache.png", name: "Mach-E" });
eq(pic.shadowRoot.querySelector("img").src, "/local/mache.png", "a picture when one is given");
eq(pic.shadowRoot.querySelector(".nm").textContent, "Mach-E", "and its own name");

console.log("-- chips --");
{
  const keys = (over) => T.vehChips(mk(over), T.vehEntities({ device: "car1" }, mk(over))).map((c) => c.key);
  eq(keys({ [`sensor.${V}_elvehplug`]: st("DISCONNECTED"), [`sensor.${V}_elvehcharging`]: st("NOT_READY"),
    [`sensor.${V}_elvehchargingpower`]: st("0", { unit_of_measurement: "kW" }) }), [], "unplugged and locked: no chips");
  eq(keys({ [`lock.${V}_doorlock`]: st("unlocked"), [`sensor.${V}_windowposition`]: st("Open", { driver: "OPEN", passenger: "CLOSED" }),
    [`sensor.${V}_alarm`]: st("ARMED"), [`sensor.${V}_remotestartstatus`]: st("Active") }),
    ["charge", "lock", "windows", "alarm", "remote"], "charging, unlocked, a window, the alarm and remote start");
  eq(keys({ [`sensor.${V}_alarm`]: st("DISARMED") }), ["charge"], "a disarmed alarm is no chip");
  const d = T.vehDoors(mk({ [`lock.${V}_doorlock`]: st("unlocked") }), T.vehEntities({ device: "car1" }, mk()));
  eq(d.v, "Unlocked", "shut but unlocked reads Unlocked");
  eq(T.vehWindows(mk({ [`sensor.${V}_windowposition`]: st("Closed", { driver: "FULLY_CLOSED" }) }),
    T.vehEntities({ device: "car1" }, mk({ [`sensor.${V}_windowposition`]: st("Closed") }))).v, "Closed", "windows: closed");
  ok(!!card(mk()).shadowRoot.querySelector(".vchips"), "the chips are on the small card too");
}

console.log("-- where it is --");
{
  const e1 = T.vehEntities({ device: "car1" }, mk());
  eq(T.vehWhere(mk(), e1, {}), "Home", "at home: Home");
  const zs = mk({ [`device_tracker.${V}_tracker`]: st("Office"), "zone.office": { entity_id: "zone.office", state: "0", attributes: { friendly_name: "Office" } } });
  eq(T.vehWhere(zs, e1, {}), "Office", "in a zone: the zone");
  const away = mk({ [`device_tracker.${V}_tracker`]: st("not_home", { latitude: 32.9, longitude: -117.2 }) });
  eq(T.vehWhere(away, e1, { hide_address: true }), "Away", "addresses off: Away");
  const kept = {};
  localStorage.getItem = (k) => (k in kept ? kept[k] : null);
  localStorage.setItem = (k, v) => { kept[k] = String(v); };
  localStorage.setItem("charro-addr:32.9000,-117.2000", "123 Via Example, Solana Beach");
  eq(T.vehWhere(away, e1, {}), "123 Via Example, Solana Beach", "otherwise the address, asked once and kept");
  eq(T.vehAddrFormat({ address: { house_number: "1", road: "Main St", city: "Del Mar" } }), "1 Main St, Del Mar",
    "number, street and town");
}

console.log("-- the details pop-up --");
{
  const hp = mk({
    [`sensor.${V}_tirepressure`]: st("LOW_TIRE_PRESSURE", { frontLeft: "38 psi", frontRight: "39 psi",
      rearLeft: "29 psi", rearRight: "38 psi", rearLeft_state: "LOW", frontLeft_state: "NORMAL" }),
    [`sensor.${V}_doorstatus`]: st("Closed", { driverFront: "CLOSED", tailgate: "OPEN" }),
    [`sensor.${V}_cabintemperature`]: st("74.3", { unit_of_measurement: "°F" }),
    [`sensor.${V}_alarm`]: st("ARMED"),
  });
  const p = card(hp);
  p.shadowRoot.querySelector("ha-card").click();
  ok(!!p._pop, "tapping the card opens the details");
  ok(!p._pop.classList.contains("charro-pop") && p._pop.classList.contains("charro-veh-pop"),
    "without the room pop-up's class, whose sheet hides it below the screen");
  ok(!!T.tipAnchor([p._pop.querySelector(".grid").children[0], p._pop]), "and hover tips still work in it");
  const labels = p._pop.querySelector(".grid").children.map((d) => d.querySelector(".k").textContent);
  for (const k of ["Doors", "Alarm", "Cabin", "12V battery", "Odometer"])
    ok(labels.includes(k), `it shows ${k}`);
  const doorRow = p._pop.querySelector(".grid").children.filter((d) => d.querySelector(".k").textContent === "Doors")
    .map((d) => d.querySelector(".v").textContent);
  eq(doorRow, ["Open"], "one Doors reading, and the open tailgate beats Locked");
  const chipTips = p._pop.querySelector(".vchips").children.map((c) => c.dataset.tip);
  ok(chipTips[0] === "Charging" && chipTips.some((t) => /^1 open: Tailgate/.test(t)) && chipTips.includes("Alarm armed"),
    "chips for charging, the open door and the armed alarm  got " + JSON.stringify(chipTips));
  eq(T.vehTyres(hp, T.vehEntities({ device: "car1" }, hp)).map((r) => [r[0], r[1], r[2]]),
    [["Front left", "38 psi", false], ["Front right", "39 psi", false], ["Rear left", "29 psi", true], ["Rear right", "38 psi", false]],
    "the four tyres, the low one flagged");
  eq(T.vehLeft("2026-10-30T09:00:00Z", Date.parse("2026-10-30T07:40:00Z")), "1 h 20 min left", "time left on the charge");
  p.hass = { ...hp, states: { ...hp.states, [`sensor.${V}_soc`]: { ...st("55"), last_updated: "t2" } } };
  eq(p._pop.querySelector(".socrow").children[0].textContent, "55%", "it stays live while open");
  p._close();
  ok(!p._pop, "and closes");
}

console.log("-- controls --");
{
  const calls = [];
  const hc = mk({ [`button.${V}_hafshort`]: st("unknown"), [`switch.${V}_ignition`]: st("off") });
  hc.callService = async (...a) => { calls.push([a[0], a[1], a[2], a[3].entity_id]); };
  const p = card(hc);
  p._open();
  const tiles = () => p._pop.querySelector(".ctl").children;
  const byK = (k) => tiles().find((b) => b.querySelector(".k").textContent === k);
  eq(tiles().map((b) => b.querySelector(".k").textContent), ["Locked", "Remote start", "Honk & flash"],
    "lock, remote start and honk, from what the car has");
  byK("Locked").click();
  eq(calls.length, 0, "one tap on a locked car only arms the unlock");
  ok(byK("Locked").className.includes("arm") && /Tap again/.test(byK("Locked").querySelector(".v").textContent),
    "and says to tap again");
  byK("Locked").click();
  eq(calls.pop(), ["lock", "unlock", {}, `lock.${V}_doorlock`], "the second tap unlocks");
  byK("Honk & flash").click(); eq(calls.length, 0, "honking asks first too");
  byK("Honk & flash").click(); eq(calls.pop(), ["button", "press", {}, `button.${V}_hafshort`], "then honks");
  const chips = p._pop.querySelectorAll(".opts")[0].children;
  eq(chips.map((b) => b.textContent), ["80%", "90%", "95%", "100%"], "the target charge choices");
  ok(chips[2].className === "sel", "95% picked");
  chips[1].click();
  eq(calls.pop(), ["select", "select_option", { option: "90" }, `select.${V}_elvehtargetcharge`], "picking 90% sets it");
  p._close();

  const tcalls = [];
  const ts = { "number.t_charge_limit": st("80"), "lock.t_lock": st("unlocked") };
  const th = { states: ts, entities: { "number.t_charge_limit": { device_id: "t", platform: "teslemetry" },
    "lock.t_lock": { device_id: "t", platform: "teslemetry" } }, devices: {},
    callService: async (...a) => { tcalls.push([a[0], a[1], a[2]]); } };
  const tp = card(th, { device: "t" });
  tp._open();
  tp._pop.querySelector(".ctl").children[0].click();
  eq(tcalls.pop(), ["lock", "lock", {}], "locking takes one tap");
  tp._pop.querySelectorAll(".opts")[0].children[3].click();
  eq(tcalls.pop(), ["number", "set_value", { value: 80 }], "a Tesla's limit is a number");
  tp._close();
}

console.log("-- a room's Vehicles section --");
{
  const r = { room: "garage_west", vehicles: [{ device: "car1", name: "Mach-E" }, { device: "tes", make: "tesla", image: "" }] };
  const cards = T.blockCards("vehicles", r, mk());
  eq(cards.length, 1, "one grid");
  eq(cards[0].cards, [{ type: "custom:charro-vehicle-card", device: "car1", name: "Mach-E" },
    { type: "custom:charro-vehicle-card", device: "tes", make: "tesla" }], "a vehicle card per car, blanks left out");
  eq(T.blockCards("vehicles", { vehicles: [{ device: "car1" }] }, mk())[0].type, "custom:charro-vehicle-card",
    "one car is a card on its own");
  ok(T.sectionOrder({ sections: ["lights"], vehicles: [{ device: "car1" }] }).includes("vehicles"),
    "a room with its own section order still gets its cars");
  ok(!T.sectionOrder({ sections: ["lights"] }).includes("vehicles"), "and a room without cars doesn't");
  eq(T.roomVehicles({ vehicles: [{}, { device: "car1" }] }).length, 1, "a car not picked yet draws nothing");

  const ed = Object.create(T.CharroRoomsEditor.prototype);
  ed._room = { room: "garage_west" }; ed._hass = mk(); ed._vehBox = T.el("div");
  ed._renderPreview = () => {};
  ed._renderVehicles();
  const addBtn = ed._vehBox.querySelectorAll("button").find((b) => /\+ Car/.test(b.textContent));
  ok(!!addBtn, "the editor offers + Car");
  addBtn.click();
  eq(ed._room.vehicles, [{}], "which adds a car to fill in");
  const sel = ed._vehBox.querySelector("select");
  ok(sel.children.some((o) => o.value === "car1" && o.textContent === "Mustang Mach-E"), "listing the FordPass car by name");
  sel.value = "car1"; sel.fire("change");
  eq(ed._room.vehicles[0].device, "car1", "and picking it sets the device");
}

console.log("-- fits a phone --");
{
  const src = require("fs").readFileSync(require("path").join(__dirname, "../dist/charro-cards.js"), "utf8");
  const css = src.slice(src.indexOf("const VEH_POP_CSS"), src.indexOf("`;", src.indexOf("const VEH_POP_CSS")));
  ok(/max-height:calc\(100dvh/.test(css), "sized to what the phone actually shows (dvh), not 100vh");
  ok(/\.charro-veh-pop \.hd\{[^}]*position:sticky/.test(css), "the header, with close, stays at the top while it scrolls");
}

console.log(fails ? "\n" + fails + " FAILED" : "\nall passed");
process.exit(fails ? 1 : 0);
