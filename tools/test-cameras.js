/* A room's cameras, all laid out or as one switchable view. */
const T = require("./harness.js");
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log("  FAIL " + m); } else console.log("  ok   " + m); };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), m + "  got " + JSON.stringify(a));

const hass = { states: {}, entities: {} };
const cams = [{ entity: "camera.driveway_entry", name: "Driveway-Entry" },
  { entity: "camera.front_entry", name: "Front-Entry" }, { entity: "camera.driveway_exit", name: "Driveway-Exit" }];

console.log("-- all laid out, as before --");
let out = T.blockCards("cameras", { room: "frontyard", cameras: cams }, hass);
eq(out[0].type, "grid", "a grid");
eq(out[0].cards.length, 3, "of all three cameras");

console.log("-- one at a time --");
const r1 = { room: "frontyard", cameras: cams, camera_view: "one" };
out = T.blockCards("cameras", r1, hass);
eq(out.length, 1, "one card");
eq(out[0].type, "custom:charro-camera-switch-card", "the switcher");
eq(out[0].cameras.map((c) => c.title), ["Driveway-Entry", "Front-Entry", "Driveway-Exit"], "holding every camera, by name");
eq(out[0].key, "frontyard", "remembering the pick per room");
eq(T.blockCards("cameras", { room: "x", cameras: [cams[0]], camera_view: "one" }, hass)[0].cards[0].type, "custom:advanced-camera-card",
  "a room with one camera just shows it");

console.log("-- in a room with its own layout --");
const lay = { ...r1, layout: [{ camera: "camera.front_entry" }, { entity: "light.a" }, { camera: "camera.driveway_exit" }] };
const body = T.layoutBody(lay, hass);
const flat = JSON.stringify(body);
eq((flat.match(/charro-camera-switch-card/g) || []).length, 1, "the first camera tile becomes the switcher");
eq(flat.split("advanced-camera-card").length - 1, 3, "and the later camera tiles don't draw a second copy");

console.log("-- the switcher --");
const store = {};
localStorage.getItem = (k) => (k in store ? store[k] : null);
localStorage.setItem = (k, v) => { store[k] = String(v); };
const sw = Object.create(T.CharroCameraSwitchCard.prototype);
sw.attachShadow = function () { this.shadowRoot = T.el("shadow-root"); return this.shadowRoot; };
sw.setConfig(out[0]);
sw.hass = hass;
const tabs = () => sw.shadowRoot.querySelector(".tabs").children;
eq(tabs().map((b) => b.textContent), ["Driveway-Entry", "Front-Entry", "Driveway-Exit"], "a tab per camera");
ok(tabs()[0].className.includes("on"), "the first on to start");
tabs()[2].click();
ok(tabs()[2].className.includes("on"), "tapping a tab shows that camera");
eq(store["charro-cam:frontyard"], "2", "and remembers it");
sw.shadowRoot.querySelectorAll(".nav")[1].click();
ok(tabs()[0].className.includes("on"), "next from the last wraps to the first");
const again = Object.create(T.CharroCameraSwitchCard.prototype);
again.attachShadow = function () { this.shadowRoot = T.el("shadow-root"); return this.shadowRoot; };
store["charro-cam:frontyard"] = "1";
again.setConfig(out[0]); again.hass = hass;
ok(again.shadowRoot.querySelector(".tabs").children[1].className.includes("on"), "coming back opens the one picked last");

console.log(fails ? "\n" + fails + " FAILED" : "\nall passed");
process.exit(fails ? 1 : 0);
