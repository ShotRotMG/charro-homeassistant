/* fieldKit() builds most of the room editor, so these press the real
 * buttons on the real elements rather than asserting about a copy. */
const T = require("./harness.js");
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log("  FAIL " + m); } else console.log("  ok   " + m); };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b),
  m + "  got " + JSON.stringify(a));

/* ha-entity-picker has to exist or fieldKit falls back to a text input */
class Picker extends T.El { constructor() { super("ha-entity-picker"); } }
customElements.define("ha-entity-picker", Picker);

const hass = { states: {
  "light.a": { state: "on", attributes: { friendly_name: "A", brightness: 128 } },
  "light.b": { state: "off", attributes: { friendly_name: "B" } },
  "light.c": { state: "unavailable", attributes: {} },
  "cover.d": { state: "open", attributes: { current_position: 40 } },
  "fan.e":   { state: "on", attributes: { percentage: 66 } },
  "climate.f": { state: "heat", attributes: { current_temperature: 68 } },
} };

/* ---------------------------------------------------------- state line -- */
const line = (id) => T.entStateLine(hass, id);
eq(line("").textContent, "", "no entity, no line");
ok(line("light.a").textContent.includes("light.a"), "the id is shown");
ok(line("light.a").textContent.includes("on"), "and its state");
ok(line("light.a").textContent.includes("50%"), "brightness as a percentage");
ok(line("cover.d").textContent.includes("40% open"), "a cover's position");
ok(line("fan.e").textContent.includes("66%"), "a fan's speed");
ok(line("climate.f").textContent.includes("68"), "a thermostat's temperature");
eq(line("light.z").className, "vstate bad", "an unknown id is flagged");
ok(line("light.z").textContent.includes("not in Home Assistant"), "and says why");
eq(line("light.c").className, "vstate bad", "unavailable is flagged too");
eq(line("light.b").className, "vstate", "a healthy entity is not");

/* -------------------------------------------------------------- ent() --- */
let redraws = 0;
const kit = T.fieldKit(hass, () => { redraws++; });
const one = kit.ent("Camera", "light.a", ["light"], () => {});
eq(one.children.length, 3, "label, picker line, state line");
eq(one.firstChild.textContent, "Camera", "the label is first");
ok(one.querySelector(".vent"), "the picker sits on its own line");
ok(one.querySelector("ha-entity-picker"), "and it is a real picker");
ok(one.querySelector(".vstate").textContent.includes("light.a"), "state underneath");
eq(one.querySelector("ha-entity-picker").includeDomains, ["light"], "domains passed through");

let got = null;
const two = kit.ent("X", "", ["light"], (v) => { got = v; });
two.querySelector("ha-entity-picker").fire("value-changed", { value: "light.b" });
eq(got, "light.b", "picking fires onChange");
ok(redraws === 1, "and one redraw");

const ex = kit.ent("X", "", ["light"], () => {}, "", { exclude: ["light.a", "", null] });
eq(ex.querySelector("ha-entity-picker").excludeEntities, ["light.a"],
  "exclusions are passed, blanks dropped");

const tr = T.el("button"); tr.className = "vx";
const three = kit.ent("X", "light.a", ["light"], () => {}, "", { trail: tr });
eq(three.querySelector(".vent").children.length, 2, "a trailing control shares the line");
ok(three.querySelector(".vent").children[1] === tr, "and comes after the picker");

/* ------------------------------------------------------------- many() --- */
let list = ["light.a", "light.b"];
const build = () => T.fieldKit(hass, () => {})
  .many("Lights", list, ["light"], (v) => { list = v; });

let m = build();
eq(m.firstChild.textContent, "Lights (2)", "the label counts the list");
eq(m.querySelectorAll("ha-entity-picker").length, 3, "a row each, plus one to grow into");
eq(m.querySelectorAll("button.vx").length, 2, "an x on the filled rows only");
eq(m.querySelectorAll(".vstate").length, 3, "every row says what it is doing");

/* no duplicates: each row hides what the others hold */
const exs = m.querySelectorAll("ha-entity-picker").map((p) => p.excludeEntities);
eq(exs[0], ["light.b"], "row 1 cannot pick row 2's entity");
eq(exs[1], ["light.a"], "row 2 cannot pick row 1's");
eq(exs[2], ["light.a", "light.b"], "the empty row cannot pick either");

/* the x removes that row and only that row */
m.querySelectorAll("button.vx")[0].click();
eq(list, ["light.b"], "x removed the first");
ok(m.querySelectorAll("button.vx")[0].getAttribute("aria-label") === "Remove light.a",
  "and said which one it would remove");

/* clearing a picker still removes it */
list = ["light.a", "light.b"]; m = build();
m.querySelectorAll("ha-entity-picker")[1].fire("value-changed", { value: "" });
eq(list, ["light.a"], "clearing a picker removes the row");

/* the trailing row appends */
list = ["light.a"]; m = build();
m.querySelectorAll("ha-entity-picker")[1].fire("value-changed", { value: "cover.d" });
eq(list, ["light.a", "cover.d"], "the empty row appends");

/* changing a row in place */
list = ["light.a", "light.b"]; m = build();
m.querySelectorAll("ha-entity-picker")[0].fire("value-changed", { value: "light.c" });
eq(list, ["light.c", "light.b"], "a row can be changed without moving");

/* an empty list is still usable */
list = []; m = build();
eq(m.firstChild.textContent, "Lights", "no count when the list is empty");
eq(m.querySelectorAll("button.vx").length, 0, "nothing to remove");
eq(m.querySelectorAll("ha-entity-picker").length, 1, "just the row to grow into");

/* junk in the stored list does not produce a dead row */
list = ["light.a", "", null, "light.b"]; m = build();
eq(m.firstChild.textContent, "Lights (2)", "blanks are not counted");
eq(m.querySelectorAll("button.vx").length, 2, "and get no row");

console.log(fails ? "\n" + fails + " FAILED" : "\nall passed");
process.exit(fails ? 1 : 0);
