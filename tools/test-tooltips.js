/* Hover tips. What they say is built from the same functions the cards
 * draw with, so these run the real ones: roomChips() for a tile chip's
 * sentence, the real room-card.json for its tap and hold, the real
 * screens card for why a source is lit. The engine is driven with fake
 * pointer events, mouse and touch, to prove a phone never sees one. */
const T = require("./harness.js");
const fs = require("fs"), path = require("path");
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log("  FAIL " + m); } else console.log("  ok   " + m); };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), m + "  got " + JSON.stringify(a));
const has = (lines, re, m) => ok((lines || []).some((l) => re.test(l.t)),
  m + "  got " + JSON.stringify((lines || []).map((l) => l.t)));
const TPL = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "dist", "templates", "room-card.json"), "utf8"));

const NOW = new Date("2026-10-20T20:00:00Z");
const ago = (min) => new Date(NOW.getTime() - min * 60000).toISOString();

/* ---------------------------------------------------------- settings -- */
console.log("-- settings --");
eq(T.tipSettings({}), { on: true, delay: 400 }, "no house file: on, after 0.4 s");
eq(T.tipSettings(undefined), { on: true, delay: 400 }, "nor any house at all");
eq(T.tipSettings({ tooltips: false }).on, false, "tooltips:false turns them off");
eq(T.tipSettings({ tooltips: true }).on, true, "true is on");
eq(T.tipSettings({ tooltip_delay: 150 }).delay, 150, "a delay is kept");
eq(T.tipSettings({ tooltip_delay: "800" }).delay, 800, "even as a string");
eq(T.tipSettings({ tooltip_delay: 99999 }).delay, 3000, "capped at 3 s");
eq(T.tipSettings({ tooltip_delay: -5 }).delay, 0, "and never negative");
eq(T.tipSettings({ tooltip_delay: "" }).delay, 400, "blank is the built-in");
eq(T.tipSettings({ tooltip_delay: "soon" }).delay, 400, "nonsense is the built-in");
eq(T.TIP_DELAYS[0][0], "", "the Settings list starts with the built-in");

/* ------------------------------------------------------------- words -- */
console.log("-- time and state --");
eq(T.tipAgo(ago(0.2), NOW), "just now", "seconds read as just now");
eq(T.tipAgo(ago(1.2), NOW), "1 min ago", "a minute");
eq(T.tipAgo(ago(4), NOW), "4 min ago", "minutes");
eq(T.tipAgo(ago(180), NOW), "3 h ago", "hours");
eq(T.tipAgo(ago(60 * 24 * 3), NOW), "3 days ago", "days");
eq(T.tipAgo("not a date", NOW), "", "a bad timestamp says nothing rather than NaN");

const H = { states: {
  "light.den": { state: "on", last_changed: ago(4), attributes: { brightness: 128, friendly_name: "Den" } },
  "switch.dead": { state: "unavailable", last_changed: ago(90), attributes: {} },
} };
eq(T.entStateBits(H.states["light.den"], "light.den"), ["light.den", "on", "50%"],
  "the editor's state words, shared");
eq(T.tipEntLine(H, "light.den", NOW), { t: "light.den · on · 50% · changed 4 min ago", c: "ent" },
  "an entity line says id, state, level and since when");
eq(T.tipEntLine(H, "switch.dead", NOW).c, "warn", "unavailable is a warning");
eq(T.tipEntLine(H, "light.gone", NOW), { t: "light.gone — not in Home Assistant", c: "warn" },
  "a missing entity says so");

console.log("-- actions --");
const on = { state: "on" }, off = { state: "off" };
eq(T.tipAction({ action: "toggle" }, on), "turn it off", "toggle on something on");
eq(T.tipAction({ action: "toggle" }, off), "turn it on", "toggle on something off");
eq(T.tipAction({ action: "toggle" }, null), "turn it on or off", "toggle with no state");
eq(T.tipAction({ action: "more-info" }), "details", "more-info");
eq(T.tipAction({ action: "navigate", navigation_path: "#theatre" }), "open the pop-up", "a hash");
eq(T.tipAction({ action: "navigate", navigation_path: "/d-charro/gym" }), "open /d-charro/gym", "a path");
eq(T.tipAction({ action: "navigate", navigation_path: "[[[ return 1 ]]]" }), "open", "a template is not guessed at");
eq(T.tipAction({ action: "call-service", service: "media_player.volume_up",
  service_data: { entity_id: "media_player.vsx_lx305" } }),
  "volume up · media_player.vsx_lx305", "a service and its target");
eq(T.tipAction({ action: "perform-action", perform_action: "light.turn_off",
  target: { entity_id: ["light.a", "light.b"] } }), "turn off · 2 entities", "several targets are counted");
eq(T.tipAction({ action: "call-service", service: "[[[ return 'x' ]]]" }), "run an action",
  "a templated service is described by kind");
eq(T.tipAction({ action: "none" }), "", "none says nothing");
eq(T.tipAction(null), "", "nor does no action");
eq(T._splitTap("Lights — Den on. Tap to turn them off."),
  { head: "Lights — Den on.", tap: "turn them off" }, "a chip's sentence splits from its tap");
eq(T._splitTap("TV — on"), { head: "TV — on", tap: "" }, "and one with no tap is left whole");

/* ------------------------------------------------------- HA's cards -- */
console.log("-- Lovelace cards in a pop-up --");
const tile = T.el("hui-tile-card"); tile.localName = "hui-tile-card";
let L = T.tipCfg({ entity: "light.den" }, tile, H, NOW);
eq(L.map((l) => l.c), ["head", "ent", "act"], "a tile: name, state, action");
eq(L[0].t, "Den", "named by its friendly name");
eq(L[2].t, "Tap: details", "a tile with no tap_action opens details");
const btn = T.el("button-card"); btn.localName = "button-card";
btn.setAttribute("aria-label", "Vol +");
L = T.tipCfg({ entity: "[[[ return variables.x ]]]", name: "[[[ return 'n' ]]]",
  tap_action: { action: "call-service", service: "media_player.volume_up",
    service_data: { entity_id: "media_player.vsx_lx305" } } }, btn, H, NOW);
eq(L.map((l) => l.t), ["Vol +", "Tap: volume up · media_player.vsx_lx305"],
  "a remote button: its label and what it sends, templates skipped");
eq(T.tipCfg({ type: "vertical-stack" }, T.el("div"), H, NOW), null, "a container has nothing to say");

/* -------------------------------------------------------------- tile -- */
console.log("-- tile chips --");
const ROOM = T.avFill({
  room: "theatre", room_name: "Theatre", room_icon: "mdi:theater",
  light_entities: ["light.a", "light.b"], projector_entity: "switch.theatre_projector",
  alert_sensors: ["sensor.door"], locks: ["lock.front"],
  music_powers: ["switch.zone1"], media_player: "media_player.theatre",
});
const HT = { entities: {}, states: {
  "light.a": { state: "on", last_changed: ago(2), attributes: { friendly_name: "Sconces" } },
  "light.b": { state: "off", last_changed: ago(2), attributes: { friendly_name: "Cans" } },
  "switch.theatre_projector": { state: "off", last_changed: ago(30), attributes: { friendly_name: "Projector" } },
  "sensor.door": { state: "Violated", last_changed: ago(1), attributes: { friendly_name: "Theatre Door" } },
  "lock.front": { state: "unlocked", last_changed: ago(5), attributes: { friendly_name: "Front" } },
  "switch.zone1": { state: "on", last_changed: ago(9), attributes: {} },
  "media_player.theatre": { state: "idle", last_changed: ago(9), attributes: {} },
} };
L = T.tipTileChip("lights", ROOM, HT, TPL, NOW);
has(L, /Sconces on\.$/, "lights: names the one that is on");
has(L, /^Tap: turn them off$/, "and the tap moves to the action line");
ok(!L.some((l) => /Tap to/.test(l.t)), "not said twice");
L = T.tipTileChip("projector", ROOM, HT, TPL, NOW);
has(L, /^Projector — off\.$/, "projector: its state");
has(L, /^switch\.theatre_projector · off · changed 30 min ago$/, "the switch behind it, and since when");
has(L, /^Tap: turn it on · Hold: details$/, "tap from the chip, hold from the template");
L = T.tipTileChip("alert", ROOM, HT, TPL, NOW);
has(L, /^Theatre Door open\.$/, "alert: what is open");
has(L, /^sensor\.door/, "with its sensor");
eq(T.tipTileChip("alert", { ...ROOM, alert_sensors: [] }, HT, TPL, NOW), null, "nothing open, no tip");
L = T.tipTileChip("lock", ROOM, HT, TPL, NOW);
has(L, /unlocked\.$/, "lock: what is unlocked");
has(L, /^Tap: details · Hold: details$/, "and the lock badge's own actions");
L = T.tipTileChip("music", ROOM, HT, TPL, NOW);
has(L, /borrowed from the room’s media player/, "music: a borrowed hold target says where from");
eq(T.tipTileChip("nonsense", ROOM, HT, TPL, NOW), null, "an unknown field says nothing");
eq(T.tipRoom(ROOM).map((l) => l.t), ["Theatre", "Tap: open the pop-up"], "the tile's name");

/* ----------------------------------------------------------- anchors -- */
console.log("-- which element gets the tip --");
const mk = (tag, o) => { const e = T.el(tag); e.localName = tag; e.nodeType = 1; return Object.assign(e, o || {}); };
const room = mk("charro-room-card");
const main = mk("button-card");
room._card = main; room._merged = ROOM; room._tpl = TPL;
const chipCard = mk("button-card");
const chipIcon = mk("ha-state-icon", { id: "icon", getRootNode: () => ({ host: chipCard }) });
const lightsF = mk("div", { id: "lights", getRootNode: () => ({ host: mk("button-card") }) });
const nameF = mk("div", { id: "name", getRootNode: () => ({ host: main }) });
const shadow = { nodeType: 11 };
let at = T.tipAnchor([chipIcon, mk("ha-card"), shadow, chipCard, lightsF, mk("div"), main, room, mk("hui-view")]);
eq(at && [at.el.id, at.kind], ["lights", "chip"], "a chip's own icon gives way to the chip");
has(T.tipLines(at, HT, NOW), /Sconces on/, "and the tip is that chip's");
at = T.tipAnchor([nameF, main, room]);
eq(at && at.kind, "room", "the tile's name is the room");
at = T.tipAnchor([mk("div", { id: "container" }), main, room]);
eq(at, null, "bare tile background: nothing");
const pop = mk("div"); pop.classList.add("charro-pop");
const chip = mk("button"); chip.setAttribute("title", "Projector — off. Tap to turn it on.");
at = T.tipAnchor([mk("ha-icon"), chip, mk("div"), pop]);
eq(at && [at.el, at.kind], [chip, "plain"], "a titled button in a pop-up");
const huiTile = mk("hui-tile-card", { _config: { entity: "light.den" } });
at = T.tipAnchor([mk("ha-tile-info"), shadow, huiTile, mk("div"), pop]);
eq(at && at.kind, "cfg", "a tile card in a pop-up, by its config");
const stack = mk("hui-vertical-stack-card", { _config: { type: "vertical-stack" } });
at = T.tipAnchor([mk("div"), stack, pop]);
eq(at, null, "a stack with no entity is passed over");
const editor = mk("charro-rooms-editor");
const eb = mk("button"); eb.setAttribute("title", "Save");
eq(T.tipAnchor([eb, editor]), null, "the editors keep their own plain titles");
eq(T.tipAnchor([chip, mk("div")]), null, "and nothing outside a room is touched");

/* ------------------------------------------------------------- plain -- */
console.log("-- an element's own words --");
const b2 = mk("button");
b2.dataset.tip = "Xbox — on now\nsecond line";
b2.dataset.tipEnt = "light.den";
b2.dataset.tipWhy = "media_player.vsx_lx305 reports GAME";
b2.dataset.tipBusy = "Sent — waiting";
b2.dataset.tipDo = "Tap: switch";
eq(T.tipPlain(b2, H, NOW).map((l) => l.c), ["head", "", "warn", "ent", "why", "act"],
  "head, more, busy, state, why, action - in that order");
const b3 = mk("button"); b3.dataset.tipEnt = "a.1,a.2,a.3,a.4,a.5";
has(T.tipPlain(b3, H, NOW), /^\+2 more$/, "five entities show three and a count");

/* ----------------------------------------------------------- placing -- */
console.log("-- placing --");
const R = (left, top, w, h) => ({ left, top, width: w, height: h, right: left + w, bottom: top + h });
eq(T.tipPlace(R(500, 100, 40, 20), 200, 60, 1280, 800), { left: 420, top: 128, above: false },
  "centred under the element");
eq(T.tipPlace(R(1250, 100, 20, 20), 200, 60, 1280, 800).left, 1072, "kept 8px inside the right edge");
eq(T.tipPlace(R(2, 100, 20, 20), 200, 60, 1280, 800).left, 8, "and the left");
eq(T.tipPlace(R(500, 760, 40, 20), 200, 60, 1280, 800), { left: 420, top: 692, above: true },
  "above when there is no room below");

/* ------------------------------------------------------------ engine -- */
console.log("-- engine --");
T._tip.on = true; T._tip.delay = 400; T._tip.hass = H;
const tb = mk("button"); tb.setAttribute("title", "Projector — off. Tap to turn it on.");
tb.dataset.tipEnt = "light.den";
const ev = (type, path) => ({ pointerType: type, composedPath: () => path });
T.tipOver(ev("touch", [tb, pop]));
ok(!T._tip.at && tb.getAttribute("title"), "touch: nothing happens, title untouched");
T.tipOver(ev("pen", [tb, pop]));
ok(!T._tip.at, "nor a pen");
T.tipOver(ev("mouse", [tb, pop]));
ok(T._tip.at && T._tip.at.el === tb, "a mouse anchors on it");
ok(!tb.getAttribute("title") && tb.dataset.tip, "the title moves to data-tip so the browser's doesn't double up");
eq(tb.getAttribute("aria-label"), "Projector — off. Tap to turn it on.", "and the accessible name stays");
ok(!!T._tip.timer, "a show is scheduled, not done at once");
T.tipShow();
const node = T._tip.node;
ok(node && node.style.display === "block", "after the delay it shows");
eq(node.children.map((c) => c.className), ["head", "ent", "act"], "one div per line");
eq(node.children[2].textContent, "Tap: turn it on", "words from the button");
ok(!!T._tip.tick, "and rereads itself while showing");
T.tipDown();
ok(node.style.display === "none" && !T._tip.tick && !T._tip.at, "pressing hides it and stops the timer");
T.tipOver(ev("mouse", [mk("span"), tb, pop]));
ok(!T._tip.at, "and it stays away while the pointer is still on that button");
const other = mk("button"); other.setAttribute("title", "Close");
T.tipOver(ev("mouse", [other, pop]));
ok(T._tip.at && T._tip.at.el === other, "moving to another element starts again");
T.tipOver(ev("mouse", [mk("div"), mk("hui-view")]));
ok(!T._tip.at && !T._tip.timer, "leaving the room cancels it");
T._tip.on = false;
const tc = mk("button"); tc.setAttribute("title", "kept");
T.tipOver(ev("mouse", [tc, pop]));
ok(!T._tip.at && tc.getAttribute("title") === "kept", "switched off: native titles are left alone");
T.tipHide();

/* ------------------------------------------------- cards set the data -- */
(async () => {
  console.log("-- pop-up chips --");
  const p = new T.RoomPopup("#theatre", ROOM, HT);
  const strip = p._chipStrip();
  const pj = strip.children.find((b) => /Projector/.test(b.title));
  eq(pj && pj.dataset.tipEnt, "switch.theatre_projector", "a one-entity chip names it for the tip");
  const li = strip.children.find((b) => /Lights/.test(b.title));
  ok(li && !li.dataset.tipEnt, "a chip over several lights names them in its sentence instead");

  console.log("-- screens --");
  const VIDEO = T.avFill({ receiver_entity: "media_player.vsx_lx305", video: {
    displays: [{ name: "Theatre", source: "input_select.theater_media_select",
      screen: "switch.theatre_projector", volume: "media_player.vsx_lx305" }],
    sources: { Dish: { title: "Dish", live_input: "SAT" }, XBOX: { title: "Xbox" } } } }).video;
  window.loadCardHelpers = async () => ({ createCardElement: () => T.el("div") });
  const hv = (proj) => ({ calls: [], callService: async function (...a) { this.calls.push(a); },
    states: {
      "switch.theatre_projector": { state: proj, last_changed: ago(1), attributes: {} },
      "input_select.theater_media_select": { state: "Off",
        attributes: { options: ["Off", "Dish", "XBOX"] } },
      "media_player.vsx_lx305": { state: "on",
        attributes: { source: "SAT", source_list: ["SAT", "GAME", "DVD", "STRM"] } } } });
  const render = async (h) => {
    const c = Object.create(T.CharroVideoCard.prototype);
    c._config = { video: VIDEO }; c._v = VIDEO; c._templates = {}; c._zones = []; c._tabs = false;
    c._wrap = T.el("div"); c._hass = h;
    await c._render();
    return c;
  };
  let h = hv("off");
  let c = await render(h);
  const onB = c._wrap.querySelectorAll("button.vchip").find((b) => b.textContent.trim() === "On");
  eq(onB && onB.dataset.tipEnt, "switch.theatre_projector,media_player.vsx_lx305",
    "On names the switch it turns on, and the receiver that comes on with it");
  onB.click();
  await new Promise((r) => setTimeout(r, 0));
  ok(/waiting for switch\.theatre_projector to report on/.test(onB.dataset.tipBusy || ""),
    "and once pressed, the grey button says what it is waiting for");
  h = hv("on");
  c = await render(h);
  const src = (t) => c._wrap.querySelectorAll("button.vchip").find((b) => b.textContent.trim() === t);
  eq(src("Dish") && src("Dish").dataset.tipWhy,
    "media_player.vsx_lx305 reports SAT (borrowed from the room’s receiver)",
    "the lit source says who reported it, and that the receiver was borrowed");
  ok(/^No live input set/.test((src("Xbox") && src("Xbox").dataset.tipWhy) || ""),
    "a source the receiver can't be matched to says why it never lights");

  console.log("-- irrigation zones --");
  const z = { name: "Front Lawn", num: 3, device: "d3", color: "#4caf50",
    watering: "binary_sensor.z3", auto: "switch.z3_auto", today: "sensor.z3_today" };
  const hi = { states: { "binary_sensor.z3": { state: "off", attributes: {} },
    "switch.z3_auto": { state: "off", attributes: {} },
    "sensor.z3_today": { state: "12", attributes: { unit_of_measurement: "min" } } } };
  const s = T.hwState(z, hi, NOW);
  const grid = T.hwGridDom({ sum: T.hwSummary([z], null, hi, NOW), zones: [{ z, s }], now: NOW,
    lang: "en-US" }, { open() {} });
  const zb = grid.querySelector("button.z");
  ok(/^Front Lawn · zone 3\n/.test(zb.dataset.tip || ""), "a zone's tip leads with its name and number");
  ok(/suspended/.test(zb.dataset.tip), "and says when automatic watering is suspended");
  eq(zb.dataset.tipEnt, "binary_sensor.z3", "with the sensor behind it");
  eq(zb.dataset.tipDo, "Tap: open the zone", "and what a tap does");

  console.log("-- Settings tab --");
  const e = Object.create(T.CharroHouseEditor.prototype);
  e._body = T.el("div"); e._cfg = {}; e._hass = { states: {} }; e._rooms = [];
  e._paint();
  const sw = () => e._body.querySelector("ha-switch");
  ok(sw() && sw().checked === true, "the switch reads on with no setting saved");
  // the delay's own select, told from the Music Assistant one by its options
  const delays = () => e._body.querySelectorAll("select").filter((s) => s.children.some((o) => o.value === "800"));
  ok(delays().length === 1, "and the delay is offered");
  sw().checked = false; sw().fire("change");
  eq(e._cfg.tooltips, false, "off is saved as tooltips:false");
  eq(delays().length, 0, "and the delay is hidden while off");
  sw().checked = true; sw().fire("change");
  ok(!("tooltips" in e._cfg), "back on removes the key - on is the built-in");
  const sel = delays()[0];
  sel.value = "800"; sel.fire("change");
  eq(e._cfg.tooltip_delay, 800, "a delay is saved as a number");
  sel.value = ""; delays()[0].fire("change");

  console.log(fails ? "\n" + fails + " FAILED" : "\nall passed");
  process.exit(fails ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
