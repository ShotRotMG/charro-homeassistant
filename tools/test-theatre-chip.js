/* The Theatre's one chip. The projector is a screen in the room's video
 * block, so its chip works like a television's: lit while the projector or
 * the receiver is on, saying what is playing, and a tap opens the screens
 * pop-up instead of toggling the projector. The receiver's chip stands
 * down. The tile's real template expressions are run against roomChips()
 * so the two renderers say the same thing. */
const fs = require("fs"), path = require("path");
const T = require("./harness.js");
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log("  FAIL " + m); } else console.log("  ok   " + m); };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), m + "  got " + JSON.stringify(a));

const tpl = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "dist", "templates", "room-card.json"), "utf8"));
const chips = tpl.custom_fields.chips.card;
const row = (rows, prop) => { for (const x of rows || []) if (prop in x) return x[prop]; return null; };
const run = (expr, v, hass) => new Function("variables", "states", "hass", "entity", "user",
  `"use strict";${String(expr).trim().replace(/^\[\[\[/, "").replace(/\]\]\]$/, "")}`)(v, hass.states, hass, null, null);

const PJ = "switch.theatre_projector", RX = "media_player.vsx_lx305";
const THEATRE = {
  room: "theatre", room_name: "Theatre", popup_hash: "#theatre",
  projector_entity: PJ, receiver_entity: RX,
  video: { source_from: RX, displays: [{ name: "Theatre", screen: PJ, volume: RX }],
    sources: { Dish: { title: "Dish", input: "SAT" }, AppleTV: { title: "AppleTV", input: "DVD" },
               SuperBox: { title: "SuperBox", input: "STRM" }, XBOX: { title: "Xbox", input: "GAME" } } },
};
const hassWith = (pj, rx, src) => ({ entities: {}, config: { unit_system: { temperature: "°F" } },
  states: { [PJ]: { state: pj, attributes: { friendly_name: "Projector" } },
            [RX]: { state: rx, attributes: { source: src, friendly_name: "Receiver" } } } });
const vars = (r, hass) => {
  const c = Object.create(T.CharroRoomCard.prototype);
  c._merged = T.avFill(r); c._config = r; c._hass = hass;
  return c.variables();
};
const pc = chips.custom_fields.projector.card;
const tile = (r, hass) => {
  const v = vars(r, hass);
  return {
    show: run(row(chips.styles.custom_fields.projector, "display"), v, hass) === "flex",
    text: run(pc.name, v, hass),
    bg: run(row(pc.styles.card, "background"), v, hass),
    tap: run(pc.tap_action.action, v, hass),
    path: run(pc.tap_action.navigation_path, v, hass),
    rx: run(row(chips.styles.custom_fields.receiver, "display"), v, hass) === "flex",
  };
};
const header = (r, hass) => {
  const all = T.roomChips(T.avFill(r), hass);
  const p = all.find((c) => c.key === "projector_entity");
  return { p, rx: all.some((c) => c.key === "receiver_entity") };
};

console.log("-- the screen's variables --");
const sv = T.screenVars(T.avFill(THEATRE));
eq([sv.projector_screen, sv.projector_audio, sv.receiver_in_screen], [true, RX, true],
  "the projector is the screen, the receiver plays it");
eq(sv.screen_src.map, { SAT: "Dish", Dish: "Dish", DVD: "AppleTV", AppleTV: "AppleTV",
  STRM: "SuperBox", SuperBox: "SuperBox", GAME: "Xbox", XBOX: "Xbox" }, "inputs map to source names");

for (const [label, hs, want] of [
  ["all off", hassWith("off", "off", ""), { lit: false, text: "" }],
  ["on, Dish", hassWith("on", "on", "SAT"), { lit: true, text: "Dish" }],
  ["on, Xbox", hassWith("on", "on", "GAME"), { lit: true, text: "Xbox" }],
  ["receiver on, projector off", hassWith("off", "on", "DVD"), { lit: true, text: "AppleTV" }],
  ["projector on, receiver off", hassWith("on", "off", ""), { lit: true, text: "" }],
  ["an input no source names", hassWith("on", "on", "BD"), { lit: true, text: "BD" }],
]) {
  console.log(`-- ${label} --`);
  const a = tile(THEATRE, hs), b = header(THEATRE, hs);
  ok(a.show && !!b.p, "one chip on both, lit or grey");
  eq(a.text, want.text, "the tile says " + JSON.stringify(want.text));
  eq(b.p.text, want.text, "and so does the header");
  const look = T.chipLook("projector_entity", {});
  eq(a.bg, want.lit ? look.col[0] : T.CHIP_OFF[0], `tile is ${want.lit ? "lit" : "grey"}`);
  eq(b.p.col[0], a.bg, "header agrees");
  eq([a.tap, a.path], ["navigate", "#theatre-tv"], "a tap on the tile opens the screens pop-up");
  eq(b.p.tap, { kind: "navigate", path: "#theatre-tv" }, "and on the header too - never a toggle");
  ok(!a.rx && !b.rx, "the receiver has no chip of its own");
}

console.log("-- a room whose projector is not a screen --");
const PLAIN = { room: "den", room_name: "Den", projector_entity: PJ, receiver_entity: RX };
const hs = hassWith("on", "on", "SAT");
const a = tile(PLAIN, hs), b = header(PLAIN, hs);
eq([a.tap, a.text], ["toggle", ""], "keeps its toggle and says nothing");
eq(b.p.tap, { kind: "toggle", entity: PJ }, "on the header too");

console.log("-- the header's tap --");
const pop = new T.RoomPopup("#theatre", T.avFill(THEATRE), hassWith("on", "on", "SAT"));
const pushed = [];
const was = history.pushState;
history.pushState = (s, t, u) => pushed.push(u);
pop._chipTap({ kind: "navigate", path: "#theatre-tv" });
history.pushState = was;
eq(pushed, ["#theatre-tv"], "pushes the screens pop-up's hash");

console.log(fails ? "\n" + fails + " FAILED" : "\nall passed");
process.exit(fails ? 1 : 0);
