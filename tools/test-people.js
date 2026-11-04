/* Charro Config's People tab: everyone listed, admins and yourself locked,
 * and a pick applied straight away. */
const T = require("./harness.js");
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log("  FAIL " + m); } else console.log("  ok   " + m); };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), m + "  got " + JSON.stringify(a));

const calls = [];
const people = [
  { id: "j", name: "Jordan", admin: false, owner: false, active: true, mode: "" },
  { id: "n", name: "Janell", admin: false, owner: false, active: true, mode: "paused" },
  { id: "d", name: "Dad", admin: true, owner: false, active: true, mode: "" },
  { id: "me", name: "Javon", admin: true, owner: true, active: true, mode: "" },
];
const hass = { states: {}, user: { id: "me" }, callWS: async (m) => {
  calls.push(m);
  if (m.type === "charro/access_list") return { people: JSON.parse(JSON.stringify(people)) };
  if (m.type === "charro/access_set") return { mode: m.mode };
  if (m.type === "charro/get_rooms") return { rooms: {}, house: { tooltips: false }, notify: { people: [
    { key: "jordan", name: "Jordan", ha_user_id: "j", devices: [{ service: "notify.mobile_app_jordans_iphone" }, { service: "notify.mobile_app_ipad" }] },
    { key: "janell", name: "Janell", ha_user: "janell", service: "notify.mobile_app_janell" }] } };
  if (m.type === "charro/save_house") return {};
  throw new Error(m.type);
} };
const ed = Object.create(T.CharroPeopleEditor.prototype);
ed.attachShadow = function () { this.shadowRoot = T.el("shadow-root"); return this.shadowRoot; };
ed.setConfig({});
ed.hass = hass;
setTimeout(async () => {
  const sels = () => ed._body.querySelectorAll("select");
  eq(sels().length, 4, "everyone who can sign in is listed");
  eq(sels().map((s) => s.value), ["", "paused", "", ""], "with their current setting");
  ok(!sels()[0].disabled && sels()[2].disabled && sels()[3].disabled, "admins and you can't be changed");
  const notes = ed._body.querySelectorAll(".vhelp").map((n) => n.textContent);
  ok(notes.includes("Devices: jordans_iphone, ipad"), "each sign-in shows the devices they own, tied by id");
  ok(notes.includes("Devices: janell"), "or by name, for an older one-phone row");
  sels()[0].value = "hidden"; sels()[0].fire("change");
  await new Promise((r) => setTimeout(r, 5));
  eq(calls.filter((c) => c.type === "charro/access_set").pop(), { type: "charro/access_set", user_id: "j", mode: "hidden" },
    "picking Hidden applies it at once, nothing to save");
  ok(/Jordan is hidden/.test(ed._status.textContent), "and says so");
  sels()[1].value = ""; sels()[1].fire("change");
  await new Promise((r) => setTimeout(r, 5));
  eq(calls.filter((c) => c.type === "charro/access_set").pop().mode, "", "Normal gives access back");

  console.log("-- what the paused screen says --");
  const msg = ed._body.querySelectorAll("input").find((i) => /paused for now/.test(i.placeholder || ""));
  ok(!!msg, "a field for it, the built-in sentence as its placeholder");
  msg.value = "Ask Javon"; msg.fire("change");
  await new Promise((r) => setTimeout(r, 5));
  eq(calls.filter((c) => c.type === "charro/save_house").pop().config, { tooltips: false, paused_message: "Ask Javon" },
    "saved with the house's other settings, which are kept");

  console.log("-- on a paused person's dashboard --");
  const body = document.body;
  T.accessApply("paused");
  let scr = body.querySelector(".charro-access");
  ok(!!scr && scr.dataset.mode === "paused", "Paused covers the dashboard");
  ok(/Access paused/.test(JSON.stringify(scr.children.map((c) => c.textContent))), "saying Access paused");
  T.accessApply("hidden");
  scr = body.querySelector(".charro-access");
  ok(!!scr && scr.dataset.mode === "hidden" && !/Access paused/.test(JSON.stringify(scr.children.map((c) => c.textContent))),
    "Hidden covers it with nothing to read");
  ok(body.querySelectorAll(".charro-access").length === 1, "one screen, not two");
  T.accessApply("");
  ok(!body.querySelector(".charro-access"), "Normal takes the screen away, no reload");
  ok(T._acc.timer === null, "and stops checking");

  console.log(fails ? "\n" + fails + " FAILED" : "\nall passed");
  process.exit(fails ? 1 : 0);
}, 10);
