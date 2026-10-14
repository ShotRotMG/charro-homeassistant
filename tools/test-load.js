/* The payload from charro/get_rooms is the only way anything reaches a
 * card. A key the backend sends and the frontend forgets to unpack is
 * silent - the feature just behaves as if its file were empty - so this
 * checks the whole message survives the trip. */
const T = require("./harness.js");
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log("  FAIL " + m); } else console.log("  ok   " + m); };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b),
  m + "  got " + JSON.stringify(a));

const hassWith = (payload) => ({ callWS: async () => payload, states: {} });

(async () => {
  /* every key the integration puts in the message comes out */
  const full = {
    rooms: { saloon: { room_name: "Saloon" } },
    remotes: { apple: { name: "Apple TV" } },
    notify: { doors: { on: true } },
    chips: { lights: { color: "#ffcc00" } },
    bad: ["broken.json"],
    version: "0.0.0-test",
  };
  T.invalidateRooms();
  const got = await T.fetchAll(hassWith(JSON.parse(JSON.stringify(full))));
  for (const k of Object.keys(full))
    eq(got[k], full[k], k + " survives the trip");

  /* the one that was being dropped, through the function the cards call */
  T.invalidateRooms();
  const chips = await T.loadChips(hassWith(JSON.parse(JSON.stringify(full))));
  eq(chips, full.chips, "loadChips returns the house look, not an empty object");

  /* a key added to the payload later is not dropped either */
  T.invalidateRooms();
  const later = await T.fetchAll(hassWith({ rooms: {}, somethingNew: { a: 1 } }));
  eq(later.somethingNew, { a: 1 }, "an unknown key is passed through");

  /* and the dicts are always dicts, whatever arrives */
  T.invalidateRooms();
  const junk = await T.fetchAll(hassWith({ rooms: null, remotes: "nope",
    notify: 7, chips: undefined, house: [] }));
  for (const k of ["rooms", "remotes", "notify", "chips", "house"])
    eq(junk[k], {}, k + " is an object even when it arrives as junk");

  /* listing the guaranteed keys here as well would just mean editing this
   * test every time one is added, so check the shape instead */
  T.invalidateRooms();
  const none = await T.fetchAll(hassWith(null));
  ok(Object.keys(none).length >= 5, "an empty reply is still every dict");
  ok(Object.values(none).every((v) => v && typeof v === "object"
    && !Array.isArray(v) && !Object.keys(v).length),
    "and each one is an empty object, not a throw");

  /* loadAll is one shared promise - a page of twenty cards asks once */
  T.invalidateRooms();
  let calls = 0;
  const counted = { callWS: async () => { calls++; return { rooms: {} }; }, states: {} };
  await Promise.all([T.loadAll(counted), T.loadAll(counted), T.loadAll(counted)]);
  eq(calls, 1, "three cards, one websocket call");
  T.invalidateRooms();
  await T.loadAll(counted);
  eq(calls, 2, "and a save invalidates it");

  console.log(fails ? "\n" + fails + " FAILED" : "\nall passed");
  process.exit(fails ? 1 : 0);
})();
