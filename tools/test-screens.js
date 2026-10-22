/* The screens card, run as the Theatre is actually configured: one screen,
 * the projector's switch as what says whether it is on, a helper select as
 * the source, and the receiver as the volume. Three states, the three that
 * were wrong on 2026-10-19. */
const T = require("./harness.js");
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log("  FAIL " + m); } else console.log("  ok   " + m); };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), m + "  got " + JSON.stringify(a));

const VIDEO = {
  displays: [{ name: "Theatre", icon: "mdi:projector",
    source: "input_select.theater_media_select",
    screen: "switch.theatre_projector", volume: "media_player.vsx_lx305" }],
  sources: { Dish: { input: "Dish", title: "Dish" }, AppleTV: { title: "Theatre AppleTV" },
             SuperBox: { title: "Theatre SuperBox" }, XBOX: { title: "Xbox" } },
};

const built = [];
window.loadCardHelpers = async () => ({ createCardElement: (cfg) => { built.push(cfg); return T.el("div"); } });

function hassWith(projector, select, receiver = "on") {
  const calls = [];
  return { calls, callService: async (...a) => { calls.push(a); },
    states: {
      "switch.theatre_projector": { state: projector, attributes: {} },
      "input_select.theater_media_select": { state: select,
        attributes: { options: ["Off", "Dish", "AppleTV", "SuperBox", "XBOX"] } },
      "media_player.vsx_lx305": { state: receiver,
        attributes: { source: "SAT", source_list: ["SAT", "GAME", "DVD", "STRM"] } },
    } };
}

async function render(h) {
  built.length = 0;
  const c = Object.create(T.CharroVideoCard.prototype);
  c._config = { video: VIDEO }; c._v = VIDEO; c._templates = {}; c._zones = []; c._tabs = false;
  c._wrap = T.el("div"); c._hass = h;
  await c._render();
  return c;
}
const chips = (c) => c._wrap.querySelectorAll("button.vchip");
const named = (c, t) => chips(c).find((b) => b.textContent.trim() === t);

(async () => {
  console.log("-- projector off --");
  let h = hassWith("off", "Off", "off");
  let c = await render(h);
  ok(!!named(c, "On"), "an off projector offers On");
  ok(!c._wrap.querySelector(".vchip.off"), "and not the red Off that was there before");
  eq(chips(c).length, 1, "and nothing else - no source row for a dark screen");
  eq(built.length, 0, "and no tiles under it");
  const onBtn = named(c, "On");
  if (onBtn) onBtn.click();
  await new Promise((r) => setTimeout(r, 0));
  eq(h.calls[0], ["switch", "turn_on", {}, { entity_id: "switch.theatre_projector" }],
    "On turns the projector's switch on");
  ok(!!onBtn && onBtn.disabled, "and waits for the projector rather than flipping at once");
  ok(h.calls.some((x) => x[0] === "media_player" && x[1] === "turn_on"
    && x[3].entity_id === "media_player.vsx_lx305"), "and the receiver comes on with it, for sound");
  eq(h.calls.length, 2, "nothing else");
  h = hassWith("off", "Off", "on");
  c = await render(h);
  named(c, "On").click();
  await new Promise((r) => setTimeout(r, 0));
  eq(h.calls.length, 1, "a receiver already on is left alone");

  console.log("-- projector on, helper still Off (how tonight looked) --");
  h = hassWith("on", "Off");
  c = await render(h);
  eq(["Dish", "Theatre AppleTV", "Theatre SuperBox", "Xbox"].map((t) => !!named(c, t)),
    [true, true, true, true], "the four sources are offered");
  ok(!!c._wrap.querySelector(".vchip.off"), "with Off beside them, the screen being on");
  ok(!named(c, "On"), "and no On, it being on");
  ok(!built.some((cfg) => cfg.type === "tile" && cfg.entity === "switch.theatre_projector"),
    "no television-off tile - the toggle that drew a running projector as off");

  console.log("-- projector on, Dish picked --");
  h = hassWith("on", "Dish");
  c = await render(h);
  ok(named(c, "Dish").className.includes("sel"), "Dish is shown as on now");

  console.log("-- reading what's on from the receiver --");
  const LIVE = { ...VIDEO, live_from: "media_player.vsx_lx305", sources: {
    Dish: { input: "Dish", title: "Dish", live_input: "SAT" },
    AppleTV: { title: "Theatre AppleTV", live_input: "DVD" },
    SuperBox: { title: "Theatre SuperBox", live_input: "STRM" },
    XBOX: { title: "Xbox", live_input: "GAME" } } };
  async function renderLive(h) {
    built.length = 0;
    const c = Object.create(T.CharroVideoCard.prototype);
    c._config = { video: LIVE }; c._v = LIVE; c._templates = {}; c._zones = []; c._tabs = false;
    c._wrap = T.el("div"); c._hass = h;
    await c._render();
    return c;
  }
  const selOf = (c) => chips(c).filter((b) => b.className.includes("sel")).map((b) => b.textContent.trim());

  h = hassWith("on", "Off");                               // receiver on SAT
  c = await renderLive(h);
  eq(selOf(c), ["Dish"], "the helper says Off, the receiver says SAT: Dish shows as on");

  h = hassWith("on", "Dish");
  h.states["media_player.vsx_lx305"].attributes.source = "DVD";
  c = await renderLive(h);
  eq(selOf(c), ["Theatre AppleTV"], "an input changed by remote is followed, whatever the helper remembers");

  h = hassWith("on", "Dish");
  h.states["media_player.vsx_lx305"].attributes.source = "TV";
  c = await renderLive(h);
  eq(selOf(c), ["Dish"], "an input no source claims hands the question back to the helper");

  h = hassWith("on", "Dish", "unavailable");
  c = await renderLive(h);
  eq(selOf(c), ["Dish"], "so does a receiver that isn't reporting");

  h = hassWith("on", "Dish", "off");
  c = await renderLive(h);
  eq(selOf(c), [], "a receiver that is off means nothing is playing");
  ok(!!c._wrap.querySelector(".vchip.off"), "while the projector, still on, keeps its Off");

  h = hassWith("on", "Off");
  c = await renderLive(h);
  named(c, "Xbox").click();
  await new Promise((r) => setTimeout(r, 0));
  eq(h.calls[0], ["input_select", "select_option", { option: "XBOX" },
    { entity_id: "input_select.theater_media_select" }],
    "picking still goes through the helper, so the automations still do the work");
  ok(!h.calls.some((x) => x[0] === "media_player" && x[1] === "select_source"),
    "and the card does not reach past them to the receiver");

  h = hassWith("on", "Off");
  c = await render(h);
  eq(selOf(c), [], "a room without live_from behaves exactly as before");

  const lc = Object.create(T.CharroVideoCard.prototype);
  lc._v = LIVE; lc._hass = hassWith("on", "Off");
  const s1 = lc._sig();
  lc._hass.states["media_player.vsx_lx305"].attributes.source = "GAME";
  ok(lc._sig() !== s1, "the card redraws when the receiver changes input");

  console.log("-- Off when the helper already says Off (2026-10-21) --");
  h = hassWith("on", "Off");                     // switched on by remote: helper never moved
  c = await renderLive(h);
  const offB = c._wrap.querySelector(".vchip.off");
  ok(!!offB, "the lit room offers Off");
  offB.click();
  await new Promise((r) => setTimeout(r, 0));
  ok(!h.calls.some((x) => x[1] === "select_option"),
    "it does not re-select Off on a helper already at Off - that changes nothing");
  ok(h.calls.some((x) => x[0] === "switch" && x[1] === "turn_off"
    && x[3].entity_id === "switch.theatre_projector"), "it switches the projector off itself");
  ok(h.calls.some((x) => x[0] === "media_player" && x[1] === "turn_off"
    && x[3].entity_id === "media_player.vsx_lx305"), "and the receiver");
  eq(h.calls.filter((x) => x[1] === "turn_off").length, 2, "once each");

  h = hassWith("on", "Off", "off");              // receiver already off
  c = await renderLive(h);
  c._wrap.querySelector(".vchip.off").click();
  await new Promise((r) => setTimeout(r, 0));
  eq(h.calls.map((x) => x[3].entity_id), ["switch.theatre_projector"],
    "only what is on is switched off");

  h = hassWith("on", "Dish");                    // the helper can move: let the automation work
  c = await renderLive(h);
  c._wrap.querySelector(".vchip.off").click();
  await new Promise((r) => setTimeout(r, 0));
  eq(h.calls[0], ["input_select", "select_option", { option: "Off" },
    { entity_id: "input_select.theater_media_select" }],
    "with the helper on Dish, Off still goes through the helper as before");
  eq(h.calls.length, 1, "and nothing else");

  console.log("-- picking the source the helper already holds --");
  h = hassWith("on", "XBOX");                    // helper remembers Xbox; receiver was moved to SAT by remote
  c = await renderLive(h);
  named(c, "Xbox").click();
  await new Promise((r) => setTimeout(r, 0));
  eq(h.calls[0], ["input_select", "select_option", { option: "XBOX" },
    { entity_id: "input_select.theater_media_select" }], "the helper is still told, as always");
  ok(h.calls.some((x) => x[1] === "select_source" && x[2].source === "GAME"
    && x[3].entity_id === "media_player.vsx_lx305"),
    "and since it cannot move, the receiver is switched to GAME directly");
  ok(!h.calls.some((x) => x[1] === "turn_on"), "nothing already on is turned on");

  h = hassWith("on", "XBOX");
  h.states["media_player.vsx_lx305"].attributes.source = "GAME";
  c = await renderLive(h);
  named(c, "Xbox").click();
  await new Promise((r) => setTimeout(r, 0));
  eq(h.calls.length, 1, "already showing Xbox: nothing beyond the helper");

  h = hassWith("on", "XBOX", "off");             // receiver off
  c = await renderLive(h);
  await c._pickSource("XBOX");
  ok(h.calls.some((x) => x[0] === "media_player" && x[1] === "turn_on"), "a receiver that is off is turned on");
  ok(h.calls.some((x) => x[1] === "select_source" && x[2].source === "GAME"), "and put on GAME");

  h = hassWith("on", "Off");
  c = await renderLive(h);
  named(c, "Xbox").click();
  await new Promise((r) => setTimeout(r, 0));
  eq(h.calls.length, 1, "a helper that can move is left to its automation");

  console.log("-- the media block --");
  const room = { room: "theatre", projector_entity: "switch.theatre_projector",
    receiver_entity: "media_player.vsx_lx305", video: VIDEO };
  const tiles = (r) => T.blockCards("media", r, hassWith("on", "Off"))
    .filter((x) => x.type === "grid").flatMap((g) => g.cards || [])
    .filter((x) => x.type === "tile").map((x) => x.entity);
  eq(tiles(room), [], "the receiver the screens already drive gets no tile of its own");
  const loose = { ...room, video: { ...VIDEO, displays: [{ ...VIDEO.displays[0], volume: null }] } };
  eq(tiles(loose), ["media_player.vsx_lx305"],
    "a receiver nothing drives still gets one, so it is never unreachable");
  const tvRoom = { room: "den", tv_entity: "media_player.den_tv" };
  eq(tiles(tvRoom), ["media_player.den_tv"], "a room with no screens setup keeps its plain tiles");

  console.log(fails ? "\n" + fails + " FAILED" : "\nall passed");
  process.exit(fails ? 1 : 0);
})();
