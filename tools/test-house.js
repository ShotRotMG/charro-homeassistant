/* page_base replaces a "/d-charro" that was written into the bundle. It is
 * a path people type, so it arrives with every shape of slash, and getting
 * it wrong sends the pop-up's expand button to a 404. */
const T = require("./harness.js");
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log("  FAIL " + m); } else console.log("  ok   " + m); };
const eq = (a, b, m) => ok(a === b, m + "  got " + JSON.stringify(a));

const P = T.pagePath;
eq(T.HOUSE_PAGE_BASE, "/d-charro", "the built-in default is unchanged");

/* blank falls back, so an install with no settings file behaves as before */
eq(P(undefined, "saloon"), "/d-charro/saloon", "undefined base uses the built-in");
eq(P("", "saloon"), "/d-charro/saloon", "an empty base uses the built-in");
eq(P(null, "saloon"), "/d-charro/saloon", "null uses the built-in");
eq(P("   ", "saloon"), "/d-charro/saloon", "whitespace uses the built-in");

/* the shapes people type */
eq(P("/lovelace", "gym"), "/lovelace/gym", "a plain path");
eq(P("/lovelace/", "gym"), "/lovelace/gym", "a trailing slash is not doubled");
eq(P("/lovelace///", "gym"), "/lovelace/gym", "nor several");
eq(P("lovelace", "gym"), "/lovelace/gym", "a missing leading slash is added");
eq(P("  /lovelace  ", "gym"), "/lovelace/gym", "spaces are trimmed");
eq(P("/d-home/rooms", "gym"), "/d-home/rooms/gym", "a nested dashboard path");

/* {room} puts the key where the path wants it */
eq(P("/lovelace/room-{room}", "gym"), "/lovelace/room-gym", "{room} is substituted");
eq(P("/d/{room}/full", "gym"), "/d/gym/full", "even in the middle");
eq(P("{room}", "gym"), "gym", "and on its own, left exactly as asked");
eq(P("/d/{room}-{room}", "gym"), "/d/gym-gym", "twice if it says twice");

/* no room, no path - a card with no `room:` has no page to link to */
eq(P("/lovelace", ""), "", "no room key, no path");
eq(P("/lovelace", undefined), "", "and undefined is the same");

/* the loader survives a house file that is not there */
(async () => {
  T.invalidateRooms();
  const h = await T.loadHouse({ callWS: async () => ({ rooms: {} }), states: {} });
  eq(JSON.stringify(h), "{}", "no house file reads as no settings");
  T.invalidateRooms();
  const h2 = await T.loadHouse({ callWS: async () =>
    ({ rooms: {}, house: { page_base: "/x" } }), states: {} });
  eq(h2.page_base, "/x", "and a saved one comes through");

  console.log(fails ? "\n" + fails + " FAILED" : "\nall passed");
  process.exit(fails ? 1 : 0);
})();
