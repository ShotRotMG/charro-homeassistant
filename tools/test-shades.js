/* Shades arrived in 5.73 as a room field, a chip, an editor panel and a
 * chip registry entry, and were left out of the two registries that decide
 * what actually renders. The chip worked, so it looked done. These check
 * every consumer of both lists, for shades and for the groups that were
 * already there - the next list to be added will fail here if it is only
 * half added. */
const T = require("./harness.js");
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log("  FAIL " + m); } else console.log("  ok   " + m); };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b),
  m + "  got " + JSON.stringify(a));

/* ------------------------------------------------ the registries agree -- */
const keys = T.LIGHT_GROUPS.map(([, k]) => k);
ok(keys.includes("shade_entities"), "shades are a drawable group");
for (const k of keys)
  ok(T.RE_LIGHT_LISTS.includes(k),
    k + " can carry per-entity overrides, like every drawable group");
for (const k of T.RE_LIGHT_LISTS)
  ok(keys.includes(k), k + " is drawn somewhere, or its overrides go nowhere");
eq(keys.indexOf("shade_entities"), 2, "shades sit where the chip row puts them");

/* ----------------------------------------------- a shades-only room ----- */
const hass = { states: {
  "switch.shade_l": { state: "on", attributes: { friendly_name: "Shade Left" } },
  "switch.shade_r": { state: "off", attributes: { friendly_name: "Shade Right" } },
  "cover.drape": { state: "open", attributes: { current_position: 60 } },
}, config: { unit_system: { temperature: "°F" } } };

const room = { room: "saloon", room_name: "Saloon",
               shade_entities: ["switch.shade_l", "switch.shade_r"] };
const body = T.roomBody(room, hass);
ok(body.length > 0, "a room of nothing but shades is no longer an empty pop-up");
const flat = JSON.stringify(body);
ok(flat.includes("switch.shade_l") && flat.includes("switch.shade_r"),
  "and both shades are in it");
/* one group gets no heading - the room's own title already says where
 * you are, and that rule is not special to shades */
ok(!flat.includes('"heading"'), "one group, no heading, same as a lights-only room");
const mixed = T.roomBody({ room: "x", light_entities: ["light.a"],
  shade_entities: ["switch.shade_l"] }, hass);
const mh = JSON.stringify(mixed);
ok(mh.includes("Shades") && mh.includes("Lights"),
  "two groups, and each says which it is");

/* the chip still works and still counts only the shades that are down */
const chip = T.roomChips(room, hass).find((c) => c.key === "shade_entities");
ok(!!chip, "the chip is still there");
eq(chip.text, "1", "and still counts only what is down");

/* ------------------------------------------- the layout and the tray ---- */
const mat = T.materializeLayout(room);
const ids = mat.map((x) => x.entity).filter(Boolean);
eq(ids, ["switch.shade_l", "switch.shade_r"],
  "taking the layout over places the shades");

/* with lights as well, each group gets its own heading */
const both = { room: "x", light_entities: ["light.a"],
               shade_entities: ["switch.shade_l"] };
const m2 = T.materializeLayout(both);
const heads = m2.map((x) => x.heading).filter(Boolean);
eq(heads, ["Lights", "Shades"], "two groups, two headings");

/* ------------------------------------------------- how a shade draws ---- */
const sw = T.lightCard("switch.shade_l");
eq(sw.type, "custom:mushroom-entity-card", "a switch shade is an entity card");
eq(sw.tap_action, { action: "toggle" }, "and a tap toggles it");

const cv = T.lightCard("cover.drape");
eq(cv.type, "tile", "a cover shade is a core tile, needing no extra resource");
eq(cv.features, [{ type: "cover-open-close" }, { type: "cover-position" }],
  "with open/close and a position slider");
const cvNoDim = T.lightCard({ entity: "cover.drape", dim: false });
eq(cvNoDim.features, [{ type: "cover-open-close" }],
  "no position slider when dimming is off");

/* a light shade is still a light */
eq(T.lightCard("light.shade").type, "custom:mushroom-light-card",
  "a shade wired as a light keeps the light card");

/* ------------------------------------------- overrides survive the form - */
const named = { shade_entities: [{ entity: "switch.shade_l", name: "Left",
                                   icon: "mdi:blinds" }] };
const card = T.lightCard(named.shade_entities[0]);
eq(card.name, "Left", "a named shade keeps its name");
eq(card.icon, "mdi:blinds", "and its icon");

console.log(fails ? "\n" + fails + " FAILED" : "\nall passed");
process.exit(fails ? 1 : 0);
