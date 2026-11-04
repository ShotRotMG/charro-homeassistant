/* Notification people with several devices: an old one-phone row carries
 * over, a device can be added, and the sign-in is tied by id. */
const T = require("./harness.js");
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log("  FAIL " + m); } else console.log("  ok   " + m); };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), m + "  got " + JSON.stringify(a));

// the harness doesn't build custom elements; the editor embeds a feed card
const realCE = document.createElement;
document.createElement = (t) => { const e = realCE(t); if (t === "charro-feed-card") e.setConfig = () => {}; return e; };
const saved = [];
const notify = { people: [{ key: "javon", name: "Javon", service: "notify.mobile_app_iphone", platform: "ios",
  levels: { doors: "urgent" } }], categories: [{ key: "doors", name: "Doors" }] };
const hass = { states: {}, user: { id: "me", is_admin: true },
  services: { notify: { mobile_app_iphone: {}, mobile_app_pixel_tablet: {} } },
  callWS: async (m) => {
    if (m.type === "charro/get_rooms") return { rooms: {}, house: {}, notify: JSON.parse(JSON.stringify(notify)) };
    if (m.type === "charro/watching") return null;
    if (m.type === "config/auth/list") return [{ id: "u1", name: "Javon", is_active: true, system_generated: false }];
    if (m.type === "charro/save_notify") { saved.push(m.config); return {}; }
    throw new Error(m.type);
  } };
T.invalidateRooms();
const ed = Object.create(T.CharroNotifyEditor.prototype);
ed.attachShadow = function () { this.shadowRoot = T.el("shadow-root"); return this.shadowRoot; };
ed.setConfig({});
ed.hass = hass;
setTimeout(async () => {
  const p = ed._cfg.people[0];
  eq(p.devices, [{ service: "notify.mobile_app_iphone", platform: "ios" }], "the old one-phone row is a person with that device");
  ok(!("service" in p), "in the new shape");
  const addDev = ed._body.querySelectorAll("button").find((b) => b.textContent === "+ Device");
  ok(!!addDev, "a person offers + Device");
  addDev.click();
  eq(ed._cfg.people[0].devices.length, 2, "adding a second device");
  const sel = ed._body.querySelectorAll("select").find((s) => s.children.some((o) => o.value === "notify.mobile_app_pixel_tablet")
    && s.value === "");
  sel.value = "notify.mobile_app_pixel_tablet"; sel.fire("change");
  eq(ed._cfg.people[0].devices[1].service, "notify.mobile_app_pixel_tablet", "set to the tablet");
  const who = ed._body.querySelectorAll("select").find((s) => s.children.some((o) => o.value === "Javon"));
  who.value = "Javon"; who.fire("change");
  eq([ed._cfg.people[0].ha_user, ed._cfg.people[0].ha_user_id], ["Javon", "u1"], "signs in as Javon, tied by id");
  await ed._doSave();
  eq(saved.pop().people[0].devices.map((d) => d.service), ["notify.mobile_app_iphone", "notify.mobile_app_pixel_tablet"],
    "both devices saved");
  console.log(fails ? "\n" + fails + " FAILED" : "\nall passed");
  process.exit(fails ? 1 : 0);
}, 20);
