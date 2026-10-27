/* Music Assistant's own app in the dashboard. The address comes from the
 * card, else the house's Settings; the iframe is built once and never
 * rebuilt on a state change, which would reload the whole app. */
const T = require("./harness.js");
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log("  FAIL " + m); } else console.log("  ok   " + m); };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), m + "  got " + JSON.stringify(a));

console.log("-- the address --");
eq(T.maUrl({}, { music_url: "https://music.charro.cc" }), "https://music.charro.cc", "the house's address by default");
eq(T.maUrl({ url: "https://ma.local" }, { music_url: "https://music.charro.cc" }), "https://ma.local", "a card's own wins");
eq(T.maUrl({}, { music_url: "music.charro.cc" }), "https://music.charro.cc", "a bare host gets https");
eq(T.maUrl({}, {}), "", "and nothing set is nothing");

const sup = [];
const make = (cfg, house, admin = false, addon = true) => {
  T.invalidateRooms();
  const c = Object.create(T.CharroMusicAssistantCard.prototype);
  c.attachShadow = function () { this.shadowRoot = T.el("shadow-root"); return this.shadowRoot; };
  c.setConfig(cfg);
  const h = { user: { is_admin: admin }, states: {}, callWS: async (m) => {
    if (m.type === "charro/get_rooms") return { rooms: {}, house };
    sup.push([m.endpoint, m.method]);
    if (m.endpoint === "/addons") return { addons: addon ? [{ slug: "d5369777_music_assistant", state: "started" }] : [] };
    if (m.endpoint === "/addons/d5369777_music_assistant/info") return { ingress_url: "/api/hassio_ingress/TOKEN/" };
    if (m.endpoint === "/ingress/session") return { session: "S1" };
    throw new Error("unexpected " + m.endpoint);
  } };
  c.hass = h;
  return { c, h };
};

(async () => {
  console.log("-- the card --");
  const { c, h } = make({}, { music_url: "https://music.charro.cc" });
  await new Promise((r) => setTimeout(r, 10));
  const f = c.shadowRoot.querySelector("iframe");
  ok(!!f && f.src === "https://music.charro.cc", "it shows the house's Music Assistant");
  eq(f.style.height, "640px", "640px tall by default");
  ok(!!c._open && !!c._reload, "with open-in-a-tab and reload buttons");
  c.hass = { ...h, states: { "light.x": { state: "on" } } };
  ok(c.shadowRoot.querySelector("iframe") === f, "a state change leaves the app alone");

  const { c: c2 } = make({ height: "80vh", header: false }, { music_url: "https://music.charro.cc" });
  await new Promise((r) => setTimeout(r, 10));
  eq(c2.shadowRoot.querySelector("iframe").style.height, "80vh", "a height of its own");
  ok(!c2.shadowRoot.querySelector(".hd"), "and the title bar can go");

  const { c: c3 } = make({}, {});
  await new Promise((r) => setTimeout(r, 10));
  ok(!c3.shadowRoot.querySelector("iframe") && !!c3.shadowRoot.querySelector(".none"),
    "no address: it says where to set one");

  console.log("-- the add-on, for an admin --");
  const { c: a } = make({}, { music_url: "https://music.charro.cc" }, true);
  await new Promise((r) => setTimeout(r, 10));
  eq(a.shadowRoot.querySelector("iframe").src, "/api/hassio_ingress/TOKEN/", "an admin gets the add-on through Home Assistant");
  ok(sup.some(([e, m]) => e === "/ingress/session" && m === "post"), "after opening an ingress session, as the sidebar does");
  ok(String(globalThis.document.cookie || "").includes("ingress_session=S1"), "and setting its cookie");
  const { c: a2 } = make({ source: "url" }, { music_url: "https://music.charro.cc" }, true);
  await new Promise((r) => setTimeout(r, 10));
  eq(a2.shadowRoot.querySelector("iframe").src, "https://music.charro.cc", "a card set to the address keeps it");
  const { c: a3 } = make({}, { music_url: "https://music.charro.cc", music_source: "url" }, true);
  await new Promise((r) => setTimeout(r, 10));
  eq(a3.shadowRoot.querySelector("iframe").src, "https://music.charro.cc", "so does the house set to the address");

  console.log("-- registered --");
  ok(!!T.CARD_META["charro-music-assistant-card"] && T.CARD_META["charro-music-assistant-card"].inRoom,
    "in the card picker and the room editor's library");

  console.log(fails ? "\n" + fails + " FAILED" : "\nall passed");
  process.exit(fails ? 1 : 0);
})();
