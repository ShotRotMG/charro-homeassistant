/* The volume bar above a remote: mute, -, slider, +, aimed at the screen's
 * volume (the Theatre's receiver), live without redrawing, and the remote's
 * own volume buttons dropped so there is one control, not two. */
const T = require("./harness.js");
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log("  FAIL " + m); } else console.log("  ok   " + m); };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), m + "  got " + JSON.stringify(a));

const PJ = "switch.theatre_projector", RX = "media_player.vsx_lx305";
const TPL = { xbox: { type: "custom:remote", rows: [["up"], ["vol_up", "vol_down", "mute"]],
  custom_actions: [
    { name: "up", tap_action: { action: "perform-action", perform_action: "remote.send_command", data: { command: "Up" } } },
    { name: "vol_up", tap_action: { action: "perform-action", perform_action: "media_player.volume_up", target: { entity_id: "{{volume}}" } } },
    { name: "vol_down", tap_action: { action: "perform-action", perform_action: "media_player.volume_down", target: { entity_id: "{{volume}}" } } },
    { name: "mute", tap_action: { action: "perform-action", perform_action: "media_player.volume_mute", target: { entity_id: "{{volume}}" } } }] } };
const VIDEO = { volume_bar: true, source_from: RX, displays: [{ name: "Theatre", screen: PJ, volume: RX }],
  sources: { XBOX: { title: "Xbox", input: "GAME", use: "xbox" } } };
const built = [];
window.loadCardHelpers = async () => ({ createCardElement: (cfg) => { built.push(cfg); return T.el("div"); } });
const hassWith = (level, muted) => { const calls = []; return { calls,
  callService: async (...a) => { calls.push(a); },
  states: { [PJ]: { state: "on", attributes: {} },
            [RX]: { state: "on", attributes: { source: "GAME", source_list: ["GAME"], volume_level: level, is_volume_muted: muted } } } }; };
async function render(h, v = VIDEO) {
  built.length = 0;
  const c = Object.create(T.CharroVideoCard.prototype);
  c._config = { video: v }; c._v = v; c._templates = TPL; c._zones = []; c._tabs = false;
  c._wrap = T.el("div"); c._hass = h;
  await c._render();
  return c;
}

(async () => {
  let h = hassWith(0.42, false);
  let c = await render(h);
  const bar = c._wrap.querySelector(".vvol");
  ok(!!bar, "a volume bar sits above the remote");
  const s = bar.querySelector("input");
  eq([s.min, s.max, s.value], ["0", "100", "42"], "the slider reads the receiver's volume");
  ok(bar.textContent.includes("42"), "and says the number");
  const remote = built.find((x) => x.type === "custom:remote");
  eq(remote.custom_actions.map((a) => a.name), ["up"], "the remote's own volume buttons are gone");
  eq(remote.rows, [["up"], []], "from its rows too");
  const [mute, down, up] = bar.querySelectorAll("button");
  up.click(); down.click(); mute.click();
  s.value = "60"; s.fire("change");
  await new Promise((r) => setTimeout(r, 0));
  eq(h.calls.map((x) => [x[1], x[2], x[3].entity_id]), [
    ["volume_up", {}, RX], ["volume_down", {}, RX],
    ["volume_mute", { is_volume_muted: true }, RX], ["volume_set", { volume_level: 0.6 }, RX]],
    "+, -, mute and the slider all drive the receiver");

  console.log("-- live --");
  const h2 = hassWith(0.7, true);
  c._hass = h2;
  c.hass = h2;
  eq(s.value, "70", "a new volume moves the slider without a redraw");
  ok(mute.classList.contains("on") && mute.title === "Unmute", "and a mute shows as muted");
  s.fire("pointerdown");
  c.hass = hassWith(0.1, false);
  eq(s.value, "70", "but not while a finger is on it");

  await new Promise((r) => setTimeout(r, 20));    // let the live card's own redraw settle
  console.log("-- decibels --");
  eq(T.volLabel(42, {}), "42", "percent by default");
  eq(T.volLabel(50, { volume_display: "db" }), "-32.0 dB", "dB with the default ends (-82 to +18)");
  eq(T.volLabel(82, { volume_display: "db" }), "0.0 dB", "82% is 0 dB at the defaults");
  eq(T.volLabel(90, { volume_display: "db" }), "+8.0 dB", "above 0 gets a plus");
  eq(T.volLabel(0, { volume_display: "db" }), "Min", "the bottom is Min");
  eq(T.volLabel(50, { volume_display: "db", volume_db_min: -80, volume_db_max: 12 }), "-34.0 dB", "the ends are settable");
  eq(T.volLabel(33, { volume_display: "db", volume_db_min: -80, volume_db_max: 12 }), "-49.6 dB", "to a tenth");
  eq(T.volLabel(50.5, { volume_display: "db" }), "-31.5 dB", "a half-percent step shows as a half dB");
  eq(T.volLabel(50.5, {}), "50.5", "and as a half percent");
  c = await render(hassWith(0.5, false), { ...VIDEO, volume_display: "db" });
  ok(c._wrap.querySelector(".vvol").textContent.includes("-32.0 dB"), "the bar shows it");
  c = await render(hassWith(0.505, false), { ...VIDEO, volume_display: "db" });
  ok(c._wrap.querySelector(".vvol").textContent.includes("-31.5 dB"), "a 0.005 step from the receiver is not rounded away");
  eq(c._wrap.querySelector(".vvol").querySelector("input").value, "50.5", "nor on the slider");
  await new Promise((r) => setTimeout(r, 20));
  console.log("-- off --");
  const { volume_bar, ...PLAIN } = VIDEO;
  c = await render(hassWith(0.42, false), PLAIN);
  ok(!c._wrap.querySelector(".vvol"), "not asked for - no bar, so it's opt-in");
  eq(built.find((x) => x.type === "custom:remote").custom_actions.length, 4, "and the remote keeps its buttons");

  console.log(fails ? "\n" + fails + " FAILED" : "\nall passed");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
