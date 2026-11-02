/* Tapping anywhere on a room tile opens its pop-up - the chip row too -
 * and the chips sit centred.
 *
 * button-card stops a tap inside a nested card from reaching the tile, and
 * the chip row is a nested card. 5.142 stretched that card across the tile
 * so the whole row opened the pop-up, which knocked the chips off centre.
 * Now the row's slot lets taps fall through to the tile (pointer-events:
 * none) and only the chips themselves, at their own width and centred,
 * take them. */
const fs = require("fs");
const path = require("path");
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log("  FAIL " + m); } else console.log("  ok   " + m); };
const t = JSON.parse(fs.readFileSync(path.join(__dirname, "../dist/templates/room-card.json"), "utf8"));
const flat = (list) => Object.assign({}, ...(list || []));

console.log("-- the chips are centred --");
const field = flat(t.styles.custom_fields.chips);
ok(field.display === "flex" && field["justify-content"] === "center", "the slot centres the row");
const ch = t.custom_fields.chips.card;
const card = flat(ch.styles.card);
ok(card.width === "max-content", "the row is only as wide as its chips");
ok(/ha-card, ha-card:hover \{[^}]*width: max-content/.test(ch.card_mod.style), "card-mod agrees");

console.log("-- and the rest of the row opens the pop-up --");
ok(field["pointer-events"] === "none", "the empty part of the slot lets taps through to the tile");
ok(card["pointer-events"] === "auto" && /pointer-events: auto/.test(ch.card_mod.style), "the chips still take their own taps");
ok(JSON.stringify(ch.tap_action) === JSON.stringify(t.tap_action), "and a tap between chips is the tile's tap");

console.log(fails ? "\n" + fails + " FAILED" : "\nall passed");
process.exit(fails ? 1 : 0);
