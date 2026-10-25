/* Switching rooms in the editor must never write one room into another.
 * 2026-10-25: a Backyard autosave was pending when Theatre was opened, and
 * it fired while _load was awaiting - with the name already "theatre" and
 * the contents still Backyard. */
const T = require("./harness.js");
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log("  FAIL " + m); } else console.log("  ok   " + m); };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), m + "  got " + JSON.stringify(a));

const files = { backyard: { room_name: "Backyard" }, theatre: { room_name: "Theatre" } };
const writes = [];
let gate = null;
const hass = { states: {}, config: { components: ["charro"] },
  callWS: async (m) => {
    if (m.type === "charro/save_room") { writes.push([m.key, m.config.room_name]); files[m.key] = m.config; return {}; }
    if (m.type === "charro/get_rooms") { if (gate) await gate; return { rooms: JSON.parse(JSON.stringify(files)), remotes: {} }; }
    return {};
  } };
const ed = Object.create(T.CharroRoomsEditor.prototype);
Object.assign(ed, { _hass: hass, _autoMem: true, _renderRail() {}, _saveLabel() {}, _say() {},
  _renderForm() {}, _migrateCounts() { return 0; }, _saveMode() { return "ws"; } });

(async () => {
  await ed._load("backyard", true);
  eq(ed._room.room_name, "Backyard", "Backyard open");
  ed._room.room_icon = "mdi:pool";           // an edit
  ed._queueSave();                           // autosave pending
  let open; gate = new Promise((r) => { open = r; });
  const p = ed._load("theatre", true);       // switch before it fires
  await new Promise((r) => setTimeout(r, 1700));   // the old timer's moment passes mid-read
  open(); gate = null;
  await p;
  eq(writes, [["backyard", "Backyard"]], "the pending edit was saved under backyard, and nothing else was written");
  eq(files.theatre.room_name, "Theatre", "theatre.json is untouched");
  eq(ed._room.room_name, "Theatre", "Theatre open");
  eq(files.backyard.room_icon, "mdi:pool", "and the Backyard edit kept");

  console.log("-- two quick switches --");
  writes.length = 0;
  gate = new Promise((r) => { open = r; });
  const a = ed._load("backyard", true);
  const b = ed._load("theatre", true);
  open(); gate = null;
  await Promise.all([a, b]);
  eq(ed._key, "theatre", "the last one opened wins");
  eq(ed._room && ed._room.room_name, "Theatre", "with its own contents");
  eq(writes, [], "and nothing was written");

  console.log(fails ? "\n" + fails + " FAILED" : "\nall passed");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
