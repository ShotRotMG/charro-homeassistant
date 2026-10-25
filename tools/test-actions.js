/* The action editor on each source ("What picking this does") is Home
 * Assistant's own ha-selector, which draws from .value alone. A picked
 * action has to be handed back to it, or it vanishes from the editor the
 * moment it is chosen - the 2026-10-23 SuperBox, saved as a bare
 * remote.send_command with no target and no command. */
const T = require("./harness.js");
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log("  FAIL " + m); } else console.log("  ok   " + m); };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), m + "  got " + JSON.stringify(a));

customElements.define("ha-selector", class {});
const RX = "media_player.vsx_lx305";
const hass = { states: {
  [RX]: { state: "off", attributes: { source_list: ["SAT", "GAME", "DVD", "STRM"], friendly_name: "VSX-LX305" } },
  "switch.theatre_projector": { state: "off", attributes: {} },
}, entities: {}, devices: {}, areas: {} };

const ed = Object.create(T.CharroRoomsEditor.prototype);
ed._hass = hass; ed._videoBox = T.el("div"); ed._renderPreview = () => {};
ed._srcOpen = { XBOX: true };
ed._room = { room: "theatre", _remotes: {}, video: { source_from: RX,
  displays: [{ name: "Theatre", screen: "switch.theatre_projector", volume: RX }],
  sources: { XBOX: { title: "Xbox", input: "GAME" } } } };
ed._renderVideo();
const sel = ed._videoBox.querySelectorAll("ha-selector")[0];
ok(!!sel, "the source has an action editor");
eq(sel && sel.value, [], "starting empty");
const picked = [{ action: "remote.send_command", metadata: {} }];
sel.dispatchEvent({ type: "value-changed", detail: { value: picked }, stopPropagation() {} });
eq(sel.value, picked, "a picked action is handed back, so it stays on screen to be filled in");
eq(ed._room.video.sources.XBOX.do, picked, "and is on the source");
const filled = [{ action: "remote.send_command", target: { entity_id: "remote.theatre_harmonyhub" },
  data: { device: "Microsoft Game Console", command: "PowerOn" } }];
sel.dispatchEvent({ type: "value-changed", detail: { value: filled }, stopPropagation() {} });
eq(ed._room.video.sources.XBOX.do, filled, "filling it in updates the source");
sel.dispatchEvent({ type: "value-changed", detail: { value: [] }, stopPropagation() {} });
ok(!("do" in ed._room.video.sources.XBOX), "removing the last action clears it");
eq(sel.value, [], "and the editor shows none");

console.log("-- keep together --");
const kl = ed._videoBox.querySelectorAll("label").find((l) => /Keep the receiver on and off/.test(l.textContent));
ok(!!kl, "Media & remotes offers keeping the receiver with the screen");
const kb = kl && kl.querySelector("input");
ok(kb && !kb.checked, "off by default");
kb.checked = true; kb.fire("change");
eq(ed._room.video.keep_together, true, "ticked, it is saved on the room's video");
kb.checked = false; kb.fire("change");
ok(!("keep_together" in ed._room.video), "unticked, the key goes");

console.log("-- the action editor's words --");
const asked = [];
const h2 = { ...hass, loadFragmentTranslation: async (f) => { asked.push(f); } };
const ed2 = Object.create(T.CharroRoomsEditor.prototype);
ed2._hass = h2; ed2._videoBox = T.el("div"); ed2._renderPreview = () => {};
ed2._room = JSON.parse(JSON.stringify(ed._room));
ed2._room.video.sources.Dish = { title: "Dish", input: "SAT" };
ed2._renderVideo();
eq(asked, ["config"], "the config translations are asked for, once, however many sources");
const sels = ed2._videoBox.querySelectorAll("ha-selector");
const h3 = { ...h2, localize: () => "Add action" };
ed2._built = true;
ed2.hass = h3;
ok(sels.length === 2 && sels.every((s) => s.hass === h3), "and each action editor gets the hass that carries them");

console.log(fails ? "\n" + fails + " FAILED" : "\nall passed");
process.exit(fails ? 1 : 0);
