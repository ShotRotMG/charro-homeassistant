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
  sels()[0].value = "hidden"; sels()[0].fire("change");
  await new Promise((r) => setTimeout(r, 5));
  eq(calls.filter((c) => c.type === "charro/access_set").pop(), { type: "charro/access_set", user_id: "j", mode: "hidden" },
    "picking Hidden applies it at once, nothing to save");
  ok(/Jordan is hidden/.test(ed._status.textContent), "and says so");
  sels()[1].value = ""; sels()[1].fire("change");
  await new Promise((r) => setTimeout(r, 5));
  eq(calls.filter((c) => c.type === "charro/access_set").pop().mode, "", "Normal gives access back");
  console.log(fails ? "\n" + fails + " FAILED" : "\nall passed");
  process.exit(fails ? 1 : 0);
}, 10);
