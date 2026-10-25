/* The colour light: brightness, swatches and a picker, warmth, effects and
 * the Zigbee2MQTT scenes on the light's device - each only when the light
 * supports it - updated in place and never under a held slider. */
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
        min_color_temp_kelvin: 2200, max_color_temp_kelvin: 6500, effect_list: ["blink", "colorloop", "candle", "stop_effect"], ...attrs } },
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
const btns = (c, sel) => c.shadowRoot.querySelectorAll(sel);

console.log("-- what it offers --");
let h = mk({ brightness: 158, rgb_color: [255, 40, 30], color_mode: "xy" });
let c = card(h);
const sliders = c.shadowRoot.querySelectorAll("input").filter((i) => i.type === "range");
eq(sliders.length, 2, "brightness and warmth sliders");
eq(sliders[0].value, "62", "brightness reads 62%");
eq(c.shadowRoot.querySelectorAll(".sw")[0].querySelectorAll("button").length, 9, "nine colour swatches");
ok(!!c.shadowRoot.querySelectorAll("input").find((i) => i.type === "color"), "and a free colour picker");
const chipTexts = c.shadowRoot.querySelectorAll(".chips").map((r) => r.children.map((b) => b.textContent));
eq(chipTexts, [["Movie", "Read"], ["colorloop", "candle"]], "its own Zigbee2MQTT scenes, and its looks (not blink or stop)");
ok(c.shadowRoot.querySelectorAll(".sw")[0].querySelectorAll("button")[0].classList.contains("sel"), "the red swatch shows as current");

console.log("-- what it sends --");
c.shadowRoot.querySelectorAll(".sw")[0].querySelectorAll("button")[6].click();
sliders[0].value = "30"; sliders[0].fire("change");
sliders[1].value = "2700"; sliders[1].fire("change");
c.shadowRoot.querySelectorAll(".chips")[0].children[0].click();
c.shadowRoot.querySelectorAll(".chips")[1].children[0].click();
btns(c, ".pw")[0].click();
setTimeout(() => {
  eq(h.calls.map((x) => [x[0], x[1], x[2], x[3].entity_id]), [
    ["light", "turn_on", { rgb_color: [40, 110, 255] }, L],
    ["light", "turn_on", { brightness_pct: 30 }, L],
    ["light", "turn_on", { color_temp_kelvin: 2700 }, L],
    ["scene", "turn_on", {}, "scene.javon_lamps_movie"],
    ["light", "turn_on", { effect: "colorloop" }, L],
    ["light", "toggle", {}, L]], "blue, 30%, 2700K, the Movie scene, colorloop, power");

  console.log("-- live, but not under a finger --");
  const h2 = mk({ brightness: 255, rgb_color: [40, 110, 255] });
  c.hass = h2;
  eq(sliders[0].value, "100", "a new brightness moves the slider");
  sliders[0].fire("pointerdown");
  c.hass = mk({ brightness: 25 });
  eq(sliders[0].value, "100", "not while it is held");

  console.log("-- a plain dimmer --");
  const d = card(mk({}), D);
  eq(d.shadowRoot.querySelectorAll("input").filter((i) => i.type === "range").length, 1, "just the brightness slider");
  eq(d.shadowRoot.querySelectorAll(".sw").length, 0, "no colours");
  eq(d.shadowRoot.querySelectorAll(".chips").length, 0, "no scenes or effects");

  console.log("-- in a room --");
  ok(!!T.RENDER_KINDS.color, "the layout builder offers it as a way to draw a light");
  eq(T.lightCard({ entity: L, render: "color", name: "Lamps" }), { type: "custom:charro-color-light-card", entity: L, name: "Lamps" },
    "and a light set to it draws the colour card");

  console.log(fails ? "\n" + fails + " FAILED" : "\nall passed");
  process.exit(fails ? 1 : 0);
}, 10);
