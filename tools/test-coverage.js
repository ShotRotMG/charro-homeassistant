/* Every addition reaches every list. The repo's bugs of this kind were all
 * one shape: a thing added and working, and missing from a list that offers
 * it - shades from the layout builder's Available, the feed card from Home
 * Assistant's Add card. These are the rules between the "what exists" and
 * the "what you can add" lists, so the next one fails here instead. */
const fs = require("fs"), path = require("path");
const T = require("./harness.js");
const SINK = require("./sink.js");
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log("  FAIL " + m); } else console.log("  ok   " + m); };
const src = fs.readFileSync(path.join(__dirname, "..", "dist", "charro-cards.js"), "utf8");

console.log("-- every element is a card to add, or says why not --");
const tags = [...customElements._m.keys()].filter((t) => t.startsWith("charro-"));
ok(tags.length > 15, `found ${tags.length} charro elements`);
for (const t of tags) {
  const editorOf = t.endsWith("-editor") && T.CARD_META[t.slice(0, -"-editor".length)];
  ok(!!(T.CARD_META[t] || T.INTERNAL_TAGS[t] || editorOf),
    `${t} is a card, a card's editor, or listed as internal`);
}
for (const t of Object.keys(T.INTERNAL_TAGS))
  ok(tags.includes(t), `${t}, listed as internal, still exists`);

console.log("-- every card is offered --");
const reg = window.customCards || [];
for (const [t, m] of Object.entries(T.CARD_META)) {
  ok(!!(m.name && m.description), `${t} has a name and a description`);
  ok(reg.filter((c) => c.type === t).length === 1, `${t} is in Home Assistant's Add card list, once`);
}
const lib = T.cardLibrary().flatMap((c) => c.items).map((i) => i.type.replace(/^custom:/, ""));
for (const [t, m] of Object.entries(T.CARD_META))
  ok(lib.includes(t) === !!m.inRoom,
    `${t} ${m.inRoom ? "is" : "is not"} in the room editor's card library`);

console.log("-- every pop-up section exists everywhere a section is offered --");
const hass = SINK.hass();
hass.entities = {};
for (const s of T.ROOM_SECTIONS) {
  ok(!!T.BLOCK_LABEL[s], `section ${s} has a name in the layout builder`);
  ok(T.blockCards(s, SINK.room, hass).length > 0, `section ${s} draws something for a room that has one`);
}
const BLOCK_ONLY = new Set(["player"]);             // a part of music, placed on its own
for (const b of Object.keys(T.BLOCK_LABEL))
  ok(T.ROOM_SECTIONS.includes(b) || BLOCK_ONLY.has(b), `block ${b} is a section, or declared block-only`);
const ed = Object.create(T.CharroRoomsEditor.prototype);
ed._room = JSON.parse(JSON.stringify(SINK.room)); ed._hass = hass;
const offered = ed._lbAvail().flatMap((c) => c.items).map((i) => i.block).filter(Boolean);
for (const b of Object.keys(T.BLOCK_LABEL))
  ok(offered.includes(b), `the layout builder offers ${b} to a room that has it and hasn't placed it`);

console.log("-- every editor panel can be reached --");
const keys = (o) => Object.keys(o).sort().join(",");
ok(keys(T.PANEL_USED) === keys(T.PANEL_ADD) && keys(T.PANEL_ADD) === keys(T.PANEL_OPEN),
  "PANEL_USED, PANEL_ADD and PANEL_OPEN name the same panels");
const hosts = (/const hosts = \[([\s\S]*?)\];/.exec(src) || [])[1] || "";
for (const k of Object.keys(T.PANEL_USED)) {
  ok(new RegExp(`\\["${k}",`).test(hosts), `panel ${k} is in the editor's list of panels`);
  ok(src.includes(`"${T.PANEL_OPEN[k]}"`), `panel ${k}'s open flag is used by a panel`);
  ok(T.PANEL_USED[k](SINK.room), `the room with everything uses panel ${k}, so tests see it`);
}

console.log("-- every chip --");
for (const k of Object.keys(T.CHIP_SPECS)) {
  const f = T.fieldKit({ states: {} }, () => {});
  ok(!!T.chipRow(f, k, T.CHIP_SPECS[k], {}, T.chipInherit(k, {})), `${k} has a row in the Chips panels`);
}

console.log(fails ? "\n" + fails + " FAILED" : "\nall passed");
process.exit(fails ? 1 : 0);
