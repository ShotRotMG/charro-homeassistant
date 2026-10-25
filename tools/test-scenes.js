/* Scenes choose their lights, and a room can keep lights out of every
 * scene. Run through the real pop-up: open the form, untick a light, save,
 * and apply - with a skipped light that must never be saved or touched. */
const T = require("./harness.js");
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log("  FAIL " + m); } else console.log("  ok   " + m); };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), m + "  got " + JSON.stringify(a));

const A = "light.rope", B = "light.cans", C = "light.sconces", F = "fan.ceiling";
let file = { room_name: "Theatre", light_entities: [A, B, C], fan_entities: [F], scene_skip: [C] };
const calls = [];
const hass = { user: { is_admin: true }, entities: {}, config: { unit_system: { temperature: "°F" } },
  states: { [A]: { state: "on", attributes: { brightness: 255, friendly_name: "Rope" } },
            [B]: { state: "on", attributes: { brightness: 128, friendly_name: "Cans" } },
            [C]: { state: "on", attributes: { brightness: 50, friendly_name: "Sconces" } },
            [F]: { state: "off", attributes: { friendly_name: "Fan" } } },
  callService: async (...a) => { calls.push(a); },
  callWS: async (m) => {
    if (m.type === "charro/get_rooms") return { rooms: { theatre: JSON.parse(JSON.stringify(file)) } };
    if (m.type === "charro/save_room") { file = m.config; return {}; }
    return {};
  } };

console.log("-- the rules --");
const room = { room: "theatre", ...file };
eq(T.sceneChoices(room, "lights"), [A, B], "a skipped light is not a choice");
eq(Object.keys(T.captureScene(room, ["lights"], hass)), [A, B], "and is never captured");
eq(Object.keys(T.captureScene(room, ["lights", "fans"], hass, new Set([A, F]))), [A, F],
  "a scene with a choice remembers only the chosen");
T.applyScene(hass, { [A]: { state: "on" }, [C]: { state: "off" } }, room);
eq(calls.pop(), ["scene", "apply", { entities: { [A]: { state: "on" } } }],
  "applying an older scene that has a skipped light leaves it alone");

(async () => {
  console.log("-- the pop-up's form --");
  T.invalidateRooms();
  const p = new T.RoomPopup("#theatre", { room: "theatre", ...file }, hass);
  p._scGroups = new Set(["lights", "fans"]);
  p._scPick = new Set([A, B, F]);
  p._scMode = "new";
  const form = p._scForm(T.sceneGroupsFor ? T.sceneGroupsFor(p.room) : [["lights", "Lights", "mdi:lightbulb"], ["fans", "Fans", "mdi:fan"]], null);
  const lists = form.querySelectorAll(".sc-ents");
  const lightBoxes = lists[0].querySelectorAll("input");
  eq(lightBoxes.length, 2, "the lights list offers Rope and Cans, not the skipped Sconces");
  lightBoxes[1].checked = false; lightBoxes[1].fire("change");
  ok(!p._scPick.has(B), "unticking Cans takes it out");
  const groupBox = form.querySelectorAll("label")[0].querySelector("input");
  ok(groupBox.indeterminate, "the Lights box shows some, not all");
  ok(form.querySelectorAll("label")[0].textContent.includes("1 of 2"), "and says 1 of 2");
  p._scName = "Movie";
  await p._scSave(null);
  eq(Object.keys(file.scenes.Movie.entities), [A, F], "saved with Rope and the fan only");

  console.log("-- update reopens with what it saved --");
  const p2 = new T.RoomPopup("#theatre", { room: "theatre", ...file }, hass);
  p2._scOpen = true; p2._scEdit = "Movie";
  const panel = p2._scPanelEl();
  const up = panel.querySelectorAll("button").find((b) => b.textContent === "Update");
  up.click();
  eq([...p2._scPick].sort(), [A, F].sort(), "Update starts from the scene's own lights");

  console.log("-- the editor --");
  ok(T.PANEL_USED.scenes({ scene_skip: [C] }) && !T.PANEL_USED.scenes({}), "a Scenes panel for a room that has a skip list or scenes");
  eq(T.PANEL_ADD.scenes, "Scenes", "named Scenes");

  console.log(fails ? "\n" + fails + " FAILED" : "\nall passed");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
