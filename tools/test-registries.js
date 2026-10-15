/* A room field has to be registered in several places to work, and the
 * last three bugs in this repo were all one of those places being missed:
 * the pop-up header drew no pool chip, LIGHT_GROUPS had no shades so a
 * shade had no card anywhere, and RE_LIGHT_LISTS had no shades so a named
 * shade lost its name on the next keystroke. Each one shipped because the
 * feature looked finished - the half that was registered worked.
 *
 * So these are the rules between the registries rather than facts about
 * any one of them. A field added to one list and not its partner fails
 * here, whichever field it is and whoever adds it.
 */
const fs = require("fs");
const path = require("path");
const T = require("./harness.js");

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log("  FAIL " + m); } else console.log("  ok   " + m); };
const same = (a, b, la, lb) => {
  const A = new Set(a), B = new Set(b);
  const onlyA = [...A].filter((x) => !B.has(x));
  const onlyB = [...B].filter((x) => !A.has(x));
  ok(!onlyA.length && !onlyB.length,
    `${la} and ${lb} hold the same keys` +
    (onlyA.length ? `  -- only in ${la}: ${onlyA}` : "") +
    (onlyB.length ? `  -- only in ${lb}: ${onlyB}` : ""));
};

const lightKeys = T.LIGHT_GROUPS.map(([, k]) => k);
const chipGroupKeys = T.CHIP_GROUPS.map((g) => g[0]);

console.log("\n-- the light lists --");
/* Drawable and overridable are the same thing: a group the body draws has
 * entries that may carry a name, an icon or a dim flag, and _applyForm
 * rebuilds exactly RE_LIGHT_LISTS from the ids ha-form returns. */
same(lightKeys, T.RE_LIGHT_LISTS, "LIGHT_GROUPS", "RE_LIGHT_LISTS");
/* Every group the body draws gets its own counting chip, and every
 * counting chip is a group the body draws - a chip you can tap for things
 * that render nowhere is the shades bug, in either direction. */
same(lightKeys, chipGroupKeys, "LIGHT_GROUPS", "CHIP_GROUPS");
for (const k of lightKeys)
  ok(T.ROOM_LISTS.includes(k), `${k} is a room list, so it survives a save`);

console.log("\n-- the chip registry --");
for (const k of chipGroupKeys)
  ok(!!T.CHIP_SPECS[k], `${k} has a chip spec, so it has an order and a show rule`);
for (const v of Object.values(T.TILE_CHIPS))
  ok(!!T.CHIP_SPECS[v], `the tile's ${v} has a chip spec`);

/* The tile's chip fields live in the template and the map from field name
 * to chip key lives in the bundle. They are two halves of one thing. */
const tpl = JSON.parse(fs.readFileSync(
  path.join(__dirname, "..", "dist", "templates", "room-card.json"), "utf8"));
const tplFields = Object.keys(tpl.custom_fields.chips.card.custom_fields);
same(tplFields, Object.keys(T.TILE_CHIPS), "room-card.json chip fields", "TILE_CHIPS");
for (const f of tplFields)
  ok(!!tpl.custom_fields.chips.card.styles.custom_fields[f],
    `${f} has a display rule as well as a card`);

/* The tile is small, so two things it shows as badges rather than chips.
 * Spelled out, because the alternative is a parity test that quietly
 * tolerates any difference at all. */
const HEADER_ONLY = new Set(["locks", "garage-on", "garage-open", "garage-shut"]);
for (const k of Object.keys(T.CHIP_SPECS))
  ok(Object.values(T.TILE_CHIPS).includes(k) || HEADER_ONLY.has(k),
    `${k} is drawn by the tile, or declared header-only`);

console.log("\n-- a bad entity can be named --");
for (const k of [...T.ROOM_LISTS, ...T.ROOM_SINGLES])
  ok(!!(T.FIELD_WHERE[k] || T.ROOM_LABELS[k]),
    `${k} has a label, so the unknown-entity badge can say where it is`);

console.log("\n-- add-by-area --");
const fields = new Set([...T.ROOM_LISTS, ...T.ROOM_SINGLES,
  "cameras", "locks", "alert_sensors", "gates", "water_actions"]);
for (const k of Object.keys(T.AREA_TARGETS))
  ok(fields.has(k), `${k} is a real room field, so Fill from area writes somewhere`);

console.log("\n-- the Simple view --");
/* Each predicate run against a room that has everything: one that returns
 * false is reading a field by a name the room does not use any more. */
const SINK = require("./sink.js");
for (const [k, fn] of Object.entries(T.PANEL_USED))
  ok(fn(SINK.room), `${k} recognises a room that has one`);
for (const [k, fn] of Object.entries(T.PANEL_USED))
  ok(!fn({ room: "x", room_name: "X" }), `${k} does not fire on an empty room`);

console.log("\n-- sections --");
for (const name of T.sectionOrder(SINK.room))
  ok(T.ROOM_SECTIONS.includes(name), `${name} is a known section`);

console.log(fails ? "\n" + fails + " FAILED" : "\nall passed");
process.exit(fails ? 1 : 0);
