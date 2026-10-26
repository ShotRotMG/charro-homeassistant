/* The colour light: one line - bulb, name, and a button each for
 * brightness, white and colour that swaps the name for that slider - and a
 * details pop-up with all of it, swatches and the picker, and the light's
 * Zigbee2MQTT scenes and effects as dropdowns. */
const T = require("./harness.js");
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log("  FAIL " + m); } else console.log("  ok   " + m); };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), m + "  got " + JSON.stringify(a));

const L = "light.javon_lamps_2", D = "light.javon_ceiling_dimmer";
const mk = (attrs, state = "on") => {
  const calls = [];
  return { calls, callService: async (...a) => { calls.push(a); },
    entities: { [L]: { device_id: "grp1" }, "scene.javon_lamps_movie": { device_id: "grp1" },
      "scene.javon_lamps_read": { device_id: "grp1" }, "scene.kitchen_dinner": { device_id: "other" },
      [D]: { device_id: "dim1" } },
    states: { [L]: { state, attributes: { friendly_name: "Javon Lamps", supported_color_modes: ["color_temp", "xy"],
        min_color_temp_kelvin: 2200, max_color_temp_kelvin: 6500,
        effect_list: ["blink", "colorloop", "candle", "stop_effect"], ...attrs } },
      [D]: { state: "on", attributes: { friendly_name: "Ceiling", supported_color_modes: ["brightness"], brightness: 128 } },
      "scene.javon_lamps_movie": { state: "x", attributes: { friendly_name: "Movie" } },
      "scene.javon_lamps_read": { state: "x", attributes: { friendly_name: "Read" } } } };
};
const card = (h, entity = L) => {
  const c = Object.create(T.CharroColorLightCard.prototype);
  c.attachShadow = function () { this.shadowRoot = T.el("shadow-root"); return this.shadowRoot; };
  c.dispatchEvent = () => true;
  c.setConfig({ entity }); c.hass = h; return c;
};
const sr = (c) => c.shadowRoot;

console.log("-- one line --");
let h = mk({ brightness: 158, hs_color: [210, 80], rgb_color: [40, 110, 255], color_mode: "xy", effect: "colorloop" });
let c = card(h);
{
  const kinds = [c._card, c._ic, c._tx, ...sr(c).querySelector(".md").children, c._sliders.bri]
    .map((n) => T.tipKind(n, {}));
  ok(kinds.every((k) => k === "plain"), "every part has a hover tip, the card's own edges included  got " + kinds);
  eq(T.tipPlain(c._ic, h, Date.now())[0].t, "Javon Lamps", "the bulb's tip names the light");
  ok(c._ic.dataset.tipDo === "Tap: turn it off", "and says what a tap does");
}
eq(c._st.textContent, "62%", "the last effect sent isn't shown: Zigbee2MQTT never says it ended");
const md = sr(c).querySelector(".md").children;
eq(md.map((b) => b.title), ["Brightness", "White", "Colour"], "a button each for brightness, white and colour");
ok(sr(c).querySelector(".sl").hidden && !sr(c).querySelector(".tx").hidden, "the name shows until one is pressed");
md[0].click();
let s = sr(c).querySelector(".sl").querySelector("input");
ok(!sr(c).querySelector(".sl").hidden && sr(c).querySelector(".tx").hidden, "brightness swaps the name for its slider");
eq(s.value, "62", "reading 62%");
s.value = "30"; s.fire("change");
md[2].click();
s = sr(c).querySelector(".sl").querySelector("input");
ok(s.className === "hue" && s.value === "210", "colour shows the hue slider, at the light's hue");
s.value = "120"; s.fire("change");
md[1].click();
s = sr(c).querySelector(".sl").querySelector("input");
s.value = "2700"; s.fire("change");
md[1].click();
ok(sr(c).querySelector(".sl").hidden, "pressing the same one again brings the name back");
sr(c).querySelector(".ic").click();

setTimeout(() => {
  eq(h.calls.map((x) => [x[1], x[2]]), [["turn_on", { brightness_pct: 30 }], ["turn_on", { hs_color: [120, 100] }],
    ["turn_on", { color_temp_kelvin: 2700 }], ["toggle", {}]], "30%, green, 2700K, and the bulb toggles");

  console.log("-- the details pop-up --");
  h.calls.length = 0;
  sr(c).querySelector(".tx").click();
  const pop = c._pop;
  ok(!!pop, "tapping the name opens everything");
  eq(pop.querySelectorAll("input").filter((i) => i.type === "range").length, 3, "brightness, white and colour sliders");
  eq(pop.querySelector(".sw").querySelectorAll("button").length, 9, "the swatches");
  const dds = c._drops;
  eq(dds.map((d) => [d.btn.querySelector("span").textContent].concat(d.list.children.map((o) => o.firstChild.textContent))),
    [["Scenes", "Movie", "Read"], ["Effects", "Stop effect", "colorloop", "candle"]],
    "scenes and effects as dropdowns, its own Zigbee2MQTT scenes only");
  ok(dds.every((d) => d.list.style.display === "none"), "both start closed");
  dds[0].btn.click();
  ok(dds[0].list.style.display !== "none", "tapping Scenes opens its list");
  dds[1].btn.click();
  ok(dds[0].list.style.display === "none" && dds[1].list.style.display !== "none", "only one list is open at a time");
  dds[1].btn.click();
  ok(dds[1].list.style.display === "none", "tapping it again closes it");
  dds[0].btn.click(); dds[0].list.children[1].click();
  ok(dds[0].list.style.display === "none", "a pick closes the list");
  dds[1].btn.click(); dds[1].list.children[2].click();
  setTimeout(() => {
    eq(h.calls.map((x) => [x[0], x[1], x[2], x[3].entity_id]), [
      ["scene", "turn_on", {}, "scene.javon_lamps_read"], ["light", "turn_on", { effect: "candle" }, L]],
      "the scene and the effect are applied");
    c._closeDetails();
    ok(!c._pop, "and it closes");

    console.log("-- a plain dimmer --");
    const d = card(mk({}), D);
    eq(sr(d).querySelector(".md").children.map((b) => b.title), ["Brightness"], "a dimmer gets only brightness");

    console.log("-- in a room --");
    ok(!!T.RENDER_KINDS.color, "the layout builder offers it as a way to draw a light");
    eq(T.lightCard({ entity: L, render: "color", name: "Lamps" }),
      { type: "custom:charro-color-light-card", entity: L, name: "Lamps" }, "a light set to it draws the card");

    console.log(fails ? "\n" + fails + " FAILED" : "\nall passed");
    process.exit(fails ? 1 : 0);
  }, 5);
}, 5);
