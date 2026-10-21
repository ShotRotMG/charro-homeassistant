/* Readings: extra sensors as chips - the server closet's temperature on
 * Charro. One function builds them for both renderers, so this checks the
 * words and colours once, then that the tile's half and the header's half
 * come out identical for the same room and states. */
const fs = require("fs"), path = require("path");
const T = require("./harness.js");
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log("  FAIL " + m); } else console.log("  ok   " + m); };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), m + "  got " + JSON.stringify(a));

const SRV = "sensor.server_temp_monitor_temperature";
const HUM = "sensor.server_temp_monitor_humidity";
const MAX = "number.server_temp_monitor_comfort_temperature_max";
const MIN = "number.server_temp_monitor_comfort_temperature_min";
const HMAX = "number.server_temp_monitor_comfort_humidity_max";
const HMIN = "number.server_temp_monitor_comfort_humidity_min";
const hassWith = (temp, hum = "34.8") => ({
  config: { unit_system: { temperature: "°F" } },
  entities: {
    [SRV]: { device_id: "dev1", name: null, original_name: "Temperature" },
    [HUM]: { device_id: "dev1" }, [MAX]: { device_id: "dev1" }, [MIN]: { device_id: "dev1" },
    [HMAX]: { device_id: "dev1" }, [HMIN]: { device_id: "dev1" },
  },
  states: {
    [SRV]: { state: String(temp), attributes: { friendly_name: "Server Temp Monitor Temperature",
      device_class: "temperature", unit_of_measurement: "°F" } },
    [HUM]: { state: String(hum), attributes: { device_class: "humidity", unit_of_measurement: "%" } },
    [MAX]: { state: "81.0", attributes: {} }, [MIN]: { state: "66.0", attributes: {} },
    [HMAX]: { state: "60", attributes: {} }, [HMIN]: { state: "40", attributes: {} },
  },
});

console.log("-- numbers --");
eq(T.readingText(92.48, "°F", "temperature"), "92°", "a temperature is whole degrees");
eq(T.readingText(43.5, "%", "humidity"), "44%", "a percentage is whole");
eq(T.readingText(1234.5, "W", "power"), "1235 W", "big numbers are whole");
eq(T.readingText(3.14159, "kWh", "energy"), "3.1 kWh", "small ones keep a decimal");
eq(T.readingText(7, "", ""), "7", "no unit, just the number");

console.log("-- limits --");
let h = hassWith(92.48);
eq(T.readingLimits({ entity: SRV }, h), { high: 81, low: 66, highFrom: MAX, lowFrom: MIN },
  "blank limits borrow the device's comfort range");
eq(T.readingLimits({ entity: HUM }, h), { high: 60, low: 40, highFrom: HMAX, lowFrom: HMIN },
  "humidity borrows humidity's, not temperature's");
eq(T.readingLimits({ entity: SRV, above: 85 }, h), { high: 85, low: 66, highFrom: "", lowFrom: MIN },
  "a limit you set wins, the other still borrows");
eq(T.readingLimits({ entity: SRV, above: 85, below: 50 }, h).highFrom, "", "both set: nothing borrowed");
eq(T.readingLimits(SRV, { states: h.states }), { high: null, low: null, highFrom: "", lowFrom: "" },
  "no registry, no borrowing - and no crash");

console.log("-- chips --");
const room = (readings, extra) => ({ room: "charro", room_name: "Charro", readings, ...(extra || {}) });
const hdr = (r, hass) => T.roomChips(r, hass).filter((c) => c.key === "readings");
let c = hdr(room([{ entity: SRV, name: "Server" }]), h);
eq(c.length, 1, "one chip");
eq([c[0].text, c[0].icon, c[0].mood], ["92°", "mdi:thermometer", "high"], "92°, a thermometer, too hot");
eq(c[0].col, T.chipLook("readings", {}, "high").col, "in the too-high red");
eq(c[0].title, "Server — 92.5°F, above 81°F (the sensor’s own comfort limit).",
  "and says why, and whose limit");
eq(c[0].tap, { kind: "more-info", entity: SRV }, "a tap opens the sensor");
c = hdr(room([{ entity: SRV, name: "Server" }]), hassWith(72));
eq([c[0].mood, c[0].title], ["normal", "Server — 72°F. Comfortable 66–81°F."], "in range: neutral, and the range");
eq(c[0].col, T.pal("neutral"), "neutral grey");
c = hdr(room([{ entity: SRV }]), hassWith(60));
eq(c[0].mood, "low", "below the min is low");
eq(c[0].col, T.chipLook("readings", {}, "low").col, "in blue");
c = hdr(room([{ entity: SRV, icon: "mdi:server" }, HUM]), h);
eq(c.map((x) => x.icon), ["mdi:server", "mdi:water-percent"], "own icon wins; a bare id gets its kind's");
eq(c.map((x) => x.text), ["92°", "35%"], "two readings, two chips, in order");
c = hdr(room([SRV], { chips: { readings: { icon: "mdi:gauge-full" } } }), h);
eq(c[0].icon, "mdi:gauge-full", "a Chips-panel icon covers every reading in the room");
c = hdr(room([{ entity: SRV }], { chips: { readings: { show: "active" } } }), hassWith(72));
eq(c.length, 0, "show 'only when on': an in-range reading hides");
c = hdr(room([{ entity: SRV }], { chips: { readings: { show: "active" } } }), h);
eq(c.length, 1, "and an out-of-range one shows");
c = hdr(room([{ entity: SRV }], { chips: { readings: { show: "never" } } }), h);
eq(c.length, 0, "never is never");
c = hdr(room([{ entity: SRV }]), hassWith("unavailable"));
eq([c.length, c[0] && c[0].text], [1, "–"], "unavailable shows a dash, so a dead sensor is noticed");
c = hdr(room([{ entity: "sensor.gone" }]), h);
ok(/not in Home Assistant/.test(c[0] && c[0].title), "a missing sensor says so");
c = hdr(room([{ entity: "" }, null, { name: "x" }]), h);
eq(c.length, 0, "rows with no sensor are skipped");

console.log("-- the tile draws the same chips --");
const tpl = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "dist", "templates", "room-card.json"), "utf8"));
const chipsTpl = tpl.custom_fields.chips.card;
const run = (expr, v, hass) => new Function("variables", "states", "hass", "entity", "user",
  `"use strict";${String(expr).trim().replace(/^\[\[\[/, "").replace(/\]\]\]$/, "")}`)(v, hass.states, hass, null, null);
const vars = (r) => {
  const card = Object.create(T.CharroRoomCard.prototype);
  card._merged = r; card._config = r; card._hass = h;
  return card.variables();
};
for (const [label, r, hs] of [
  ["hot", room([{ entity: SRV, name: "Server" }, HUM]), hassWith(92.48)],
  ["fine", room([{ entity: SRV, name: "Server" }]), hassWith(72)],
  ["cold, own limits", room([{ entity: SRV, above: 90, below: 75 }]), hassWith(70)],
  ["recoloured", room([SRV], { chips: { readings: { colors: { high: "#ff00ff" }, icon: "mdi:server" } } }), hassWith(95)],
  ["only out of range", room([SRV, HUM], { chips: { readings: { show: "active" } } }), hassWith(72, 70)],
  ["unavailable", room([SRV]), hassWith("unavailable")],
]) {
  const v = vars(r);
  const a = T.charroReadingChips(v, hs).map((x) => [x.text, x.icon, x.col, x.title]);
  const b = hdr(r, hs).map((x) => [x.text, x.icon, x.col, x.title]);
  eq(a, b, `${label}: tile and header agree`);
  const disp = run(chipsTpl.styles.custom_fields.readings[0].display, v, hs);
  eq(disp, b.length ? "flex" : "none", `${label}: the tile's display rule agrees`);
}
const html = run(chipsTpl.custom_fields.readings, vars(room([{ entity: SRV, name: 'Se"rver <x>' }])), h);
ok(html.includes('title="Se&quot;rver &lt;x&gt; — 92.5'), "the tile's html escapes a name");
ok(html.includes(`data-tip-ent="${SRV}"`) && html.includes(">92°</span>"), "and carries the hover tip's entity and the value");

console.log("-- the room card wires it --");
const card = Object.create(T.CharroRoomCard.prototype);
card._merged = room([SRV, { entity: HUM }]); card._config = card._merged; card._hass = h;
ok(card.triggers().includes(SRV) && card.triggers().includes(HUM), "a new reading redraws the tile");
eq(card.variables().readings.length, 2, "the list reaches the template");

console.log("-- the editor --");
const ed = Object.create(T.CharroRoomsEditor.prototype);
ed._readBox = T.el("div"); ed._hass = h; ed._renderPreview = () => {};
ed._room = { readings: [SRV] };
ed._renderReadings();
eq(ed._room.readings[0], { entity: SRV }, "a bare id becomes a row object");
const inputs = ed._readBox.querySelectorAll("input");
const hi = inputs.find((i) => i.placeholder === "81");
ok(!!hi, "Red above shows the borrowed 81 as its placeholder");
ok(ed._readBox.querySelectorAll(".vborrow").length === 2, "and both limits say where they came from");
hi.value = "85"; hi.fire("change");
eq(ed._room.readings[0].above, 85, "typing a limit stores a number");
const hi2 = ed._readBox.querySelectorAll("input").find((i) => i.value === "85");
hi2.value = "abc"; hi2.fire("change");
ok(!("above" in ed._room.readings[0]), "nonsense clears it back to borrowing");
const add = ed._readBox.querySelectorAll("button").find((b) => /\+ Reading/.test(b.textContent));
add.click();
eq(ed._room.readings.length, 2, "+ Reading adds a row");
ed._readBox.querySelectorAll("button.vdel")[1].click();
eq(ed._room.readings.length, 1, "Remove takes it away");
ok(T.PANEL_USED.readings({ readings: [SRV] }) && !T.PANEL_USED.readings({}),
  "the Simple view shows the panel only for a room that has readings");

console.log(fails ? "\n" + fails + " FAILED" : "\nall passed");
process.exit(fails ? 1 : 0);
