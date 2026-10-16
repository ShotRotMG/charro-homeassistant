/* The all-off card's confirmation used to say "on both amps", which was
 * this house's two RTI amplifiers. It says how many zones instead, which
 * means the same thing anywhere. Run against the real card class. */
const T = require("./harness.js");
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log("  FAIL " + m); } else console.log("  ok   " + m); };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), m + "  got " + JSON.stringify(a));

const C = customElements.get("charro-all-off-card");
const tap = (cfg) => { const c = new C(); c._config = cfg; return c.overrides().tap_action; };

eq(tap({ entities: ["switch.a", "switch.b", "switch.c"] }).confirmation.text,
  "Turn **off all 3 zones**?", "the confirmation counts the zones");
eq(tap({ entities: ["switch.a"] }).confirmation.text,
  "Turn **off all zones**?", "one zone is not 'all 1 zones'");
eq(tap({ entities: ["switch.a", "switch.a"] }).confirmation.text,
  "Turn **off all zones**?", "a duplicate is not a second zone");
eq(tap({ entities: [] }).confirmation.text,
  "Turn **off all zones**?", "no zones listed still reads as a sentence");
eq(tap({ entities: ["switch.a", "switch.b"], confirm_text: "Mine" }).confirmation.text,
  "Mine", "your own text wins");
eq(tap({ entities: ["switch.a"], confirm: false }).confirmation, undefined,
  "confirm off asks nothing");
ok(!JSON.stringify(tap({ entities: ["switch.a", "switch.b"] })).includes("amps"),
  "nothing about this house's amplifiers");
eq(tap({}).service, "script.all_zones_off", "the default script is unchanged");
eq(tap({ service: "script.everything_off" }).service, "script.everything_off",
  "and a chosen one is used");

console.log(fails ? "\n" + fails + " FAILED" : "\nall passed");
process.exit(fails ? 1 : 0);
