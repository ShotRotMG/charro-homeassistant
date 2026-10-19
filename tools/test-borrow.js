/* A blank field uses what a field above it already says about the same
 * device. Every rule is tested both ways: where it should borrow, and the
 * rooms where borrowing would have been wrong. */
const T = require("./harness.js");
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log("  FAIL " + m); } else console.log("  ok   " + m); };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), m + "  got " + JSON.stringify(a));

const RX = "media_player.vsx_lx305";
const theatre = (extra = {}, disp = {}) => ({
  room: "theatre", projector_entity: "switch.theatre_projector", receiver_entity: RX,
  video: { displays: [{ name: "Theatre", screen: "switch.theatre_projector",
                        source: "input_select.theater_media_select", ...disp }],
           sources: { Dish: { input: "Dish" }, AppleTV: {} }, ...extra } });

console.log("-- where what's on is read from --");
let f = T.avFill(theatre());
eq(f.video.live_from, RX, "a room picking through a helper reads what's on from its receiver");
eq(f._avWhy.live_from, "Receiver", "and says where that came from");
f = T.avFill(theatre({ live_from: "media_player.other" }));
eq(f.video.live_from, "media_player.other", "a value set on purpose is never replaced");
f = T.avFill(theatre({ source_from: RX }));
ok(!f.video.live_from, "a room that already reads and sets the receiver needs nothing borrowed");
f = T.avFill(theatre({}, { source: "select.rti_vhd_8x_video_bar_source" }));
ok(!f.video.live_from, "a matrix select is the truth about its own output - the receiver must not overrule it");
f = T.avFill(theatre({}, { source: undefined }));
ok(!f.video.live_from, "with no select at all there is nothing for it to stand in for");
const noRx = theatre(); delete noRx.receiver_entity;
ok(!T.avFill(noRx).video.live_from, "and no receiver, nothing to borrow");

console.log("-- the screen --");
const blank = (r) => ({ ...r, video: { ...r.video,
  displays: [{ name: "TV", source: "input_select.x" }] } });
f = T.avFill(blank({ room: "den", tv_entity: "media_player.den_tv", video: {} }));
eq(f.video.displays[0].screen, "media_player.den_tv", "one screen and a TV above: that's the screen");
f = T.avFill(blank({ room: "t", projector_entity: "switch.proj", video: {} }));
eq(f.video.displays[0].screen, "switch.proj", "or the projector, with no TV");
const two = { room: "bar", tv_entity: "media_player.a", video: { displays: [{ name: "A" }, { name: "B" }] } };
ok(!T.avFill(two).video.displays.some((d) => d.screen), "two screens and one TV: nothing is guessed");
f = T.avFill(blank({ room: "den", tv_entity: "media_player.den_tv", video: {} }));
const withPower = { room: "k", tv_entity: "media_player.k", video: { displays: [{ name: "K", power: "switch.k" }] } };
ok(!T.avFill(withPower).video.displays[0].screen, "a screen switched by its own power entity is left as configured");

console.log("-- volume --");
f = T.avFill(theatre({}, { volume: undefined }));
const d0 = f.video.displays[0];
eq(T.volumeFor(d0, {}), RX, "a projector has no volume, so the receiver's is used");
eq(T.volumeFor(d0, { volume: "media_player.bar" }), "media_player.bar", "a source's own volume, set lower down, still wins");
const tvRoom = { room: "den", receiver_entity: RX, video: { displays: [{ name: "TV", screen: "media_player.den_tv" }] } };
eq(T.volumeFor(T.avFill(tvRoom).video.displays[0], {}), "media_player.den_tv",
  "a television keeps its own volume - its speakers are not assumed to be the receiver's");
eq(T.volumeFor(T.avFill(theatre({}, { volume: "media_player.amp" })).video.displays[0], {}),
  "media_player.amp", "and a volume set on the screen is used as set");

console.log("-- reading by name --");
eq(T.liveInputFor("Dish", { input: "Dish" }, ["SAT", "Dish", "DVD"]), "Dish", "a source named like an input needs no telling");
eq(T.liveInputFor("AppleTV", { title: "Theatre AppleTV" }, ["SAT", "DVD"]), "", "and one that isn't has no guess made for it");
eq(T.liveInputFor("Dish", { live_input: "SAT" }, ["SAT", "Dish"]), "SAT", "a mapping set on purpose beats a name");
eq(T.liveInputFor("xbox", {}, ["GAME", "XBOX"]), "XBOX", "case doesn't matter");

console.log("-- the card, with what's on borrowed --");
const built = [];
window.loadCardHelpers = async () => ({ createCardElement: (cfg) => { built.push(cfg); return T.el("div"); } });
const hassWith = (rxState, rxSource) => ({ callService: async () => {}, states: {
  "switch.theatre_projector": { state: "on", attributes: {} },
  "input_select.theater_media_select": { state: "Dish", attributes: { options: ["Off", "Dish", "AppleTV"] } },
  [RX]: { state: rxState, attributes: { source: rxSource, source_list: ["SAT", "DVD", "Dish"] } } } });
async function render(room, h) {
  const v = T.avFill(room).video;
  const c = Object.create(T.CharroVideoCard.prototype);
  c._config = { video: v }; c._v = v; c._templates = {}; c._zones = []; c._tabs = false;
  c._wrap = T.el("div"); c._hass = h;
  await c._render();
  return c._wrap.querySelectorAll("button.vchip").filter((b) => b.className.includes("sel"))
    .map((b) => b.textContent.trim());
}
(async () => {
  eq(await render(theatre(), hassWith("off", "")), ["Dish"],
    "a borrowed receiver that is off does not blank a room nobody has mapped");
  eq(await render(theatre(), hassWith("on", "SAT")), ["Dish"],
    "nor does one on an input no source claims - the helper still answers");
  eq(await render(theatre(), hassWith("on", "Dish")), ["Dish"],
    "a receiver reporting a source by its own name is followed");
  const mapped = theatre({ sources: { Dish: { input: "Dish", live_input: "SAT" }, AppleTV: { live_input: "DVD" } } });
  const h2 = hassWith("on", "DVD");
  eq(await render(mapped, h2), ["AppleTV"],
    "with the inputs mapped, the receiver is followed with nothing else set - the Theatre's case");
  eq(await render(mapped, hassWith("off", "")), [],
    "and once mapped, a receiver that is off means nothing is playing");

  console.log("-- it only ever reads --");
  const r0 = theatre({}, { volume: undefined });
  const before = JSON.stringify(r0);
  const f1 = T.avFill(r0);
  eq(JSON.stringify(r0), before, "the room passed in is not changed");
  ok(T.avFill(f1) === f1, "and filling twice is the same as once");
  ok(T.avFill({ room: "x" }).room === "x", "a room with no screens setup comes back as it went in");

  console.log(fails ? "\n" + fails + " FAILED" : "\nall passed");
  process.exit(fails ? 1 : 0);
})();
