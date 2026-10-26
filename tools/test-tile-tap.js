/* Tapping anywhere on a room tile opens its pop-up - the chip row too.
 * button-card stops a tap inside a nested card from reaching the tile, and
 * the chip row is a nested card that used to be only as wide as its chips,
 * so the empty space around them did nothing at all. It fills its row now,
 * and taps on it navigate to the same pop-up as the tile. */
const fs = require("fs");
const path = require("path");
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log("  FAIL " + m); } else console.log("  ok   " + m); };
const t = JSON.parse(fs.readFileSync(path.join(__dirname, "../dist/templates/room-card.json"), "utf8"));
const flat = (list) => Object.assign({}, ...(list || []));

console.log("-- the chip row fills its part of the tile --");
const field = flat(t.styles.custom_fields.chips);
ok(field.display === "grid" && field["align-self"] === "stretch", "its slot stretches the row card both ways");
const ch = t.custom_fields.chips.card;
const card = flat(ch.styles.card);
ok(card.width === "100%" && card.height === "100%", "the row card is as wide and tall as its slot");
ok(!/max-content/.test(ch.card_mod.style.split("ha-card, ha-card:hover")[1].split("}")[0]),
  "and card-mod no longer shrinks it back to the chips");
console.log("-- and taps on it open the pop-up --");
ok(JSON.stringify(ch.tap_action) === JSON.stringify(t.tap_action), "the row's tap is the tile's tap");

console.log(fails ? "\n" + fails + " FAILED" : "\nall passed");
process.exit(fails ? 1 : 0);
