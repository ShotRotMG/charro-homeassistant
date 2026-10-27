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

const make = (cfg, house) => {
  T.invalidateRooms();
  const c = Object.create(T.CharroMusicAssistantCard.prototype);
  c.attachShadow = function () { this.shadowRoot = T.el("shadow-root"); return this.shadowRoot; };
  c.setConfig(cfg);
  const h = { callWS: async () => ({ rooms: {}, house }), states: {} };
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

  console.log("-- registered --");
  ok(!!T.CARD_META["charro-music-assistant-card"] && T.CARD_META["charro-music-assistant-card"].inRoom,
    "in the card picker and the room editor's library");

  console.log(fails ? "\n" + fails + " FAILED" : "\nall passed");
  process.exit(fails ? 1 : 0);
})();
