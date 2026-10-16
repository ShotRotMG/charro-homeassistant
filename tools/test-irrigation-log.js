/* The Watering tab, against history shaped like what this house's recorder
 * actually returned on 2026-10-16: a daily counter whose first row is
 * yesterday's total stamped at midnight, a reset to nought forty minutes
 * later, and a watering sensor that is reachable ten minutes in every
 * thirty. */
const T = require("./harness.js");
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log("  FAIL " + m); } else console.log("  ok   " + m); };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), m + "  got " + JSON.stringify(a));

const now = new Date(2026, 9, 16, 12, 30);              // Friday 12:30
const lu = (d, h, m) => new Date(2026, 9, d, h, m).getTime() / 1000;
const from = T.hwMidnight(now, T.HW_LOG_FETCH_DAYS - 1).getTime();

/* ------------------------------------------------------------ day totals */
console.log("-- day totals --");
const counter = [
  { s: "360.0", lu: from / 1000 },          // the start-of-window row: someone else's day
  { s: "0.0", lu: lu(3, 0, 40) },
  { s: "300", lu: lu(3, 6, 40) },
  { s: "0.0", lu: lu(4, 0, 40) },
  { s: "0.0", lu: lu(16, 0, 40) },
  { s: "21.0", lu: lu(16, 10, 40) },
  { s: "1198.0", lu: lu(16, 11, 40) },
  { s: "unavailable", lu: lu(16, 12, 0) },
];
let d = T.hwDaily(counter, 1, from);
eq(d.get("2026-10-16"), 1198, "a day's total is the most its counter reached");
eq(d.get("2026-10-03"), 300, "and each day keeps its own");
ok(d.get(T.hwDayKey(from)) !== 360,
  "the row that opens the window - 360, the day before's - is not that day's watering");
const quiet = [{ s: "500", lu: from / 1000 }];
eq(T.hwDaily(quiet, 1, from).size, 0,
  "a quiet first day does not inherit the day before's total - the bug this guards");
eq(T.hwDaily([{ s: "2", lu: lu(16, 9, 0) }], 60, from).get("2026-10-16"), 120,
  "a counter in minutes is turned into seconds");

/* ------------------------------------------------------------------ runs */
console.log("-- runs --");
const watering = [
  { s: "off", lu: lu(16, 10, 11) },
  { s: "unavailable", lu: lu(16, 10, 21) },
  { s: "off", lu: lu(16, 10, 41) },
  { s: "unavailable", lu: lu(16, 10, 51) },
  { s: "on", lu: lu(16, 11, 12) },
  { s: "unavailable", lu: lu(16, 11, 22) },
  { s: "on", lu: lu(16, 12, 20) },
];
const runs = T.hwRuns(watering, now);
eq(runs.length, 2, "a run seen, and one still going");
eq(Math.round((runs[0].end - runs[0].start) / 60000), 10,
  "unavailable ends a run - a zone off the cloud is not known to be running");
ok(runs[1].open && runs[1].end === now.getTime(), "a run still on at the end is open, to now");

/* ------------------------------------------------------------------ week */
console.log("-- the week --");
const zones = [
  { device: "z1", num: 1, name: "Front Lawn", color: "#a9d9a8",
    today: "sensor.z1_today", watering: "binary_sensor.z1_watering" },
  { device: "z2", num: 2, name: "Back Beds", color: "#a9cff0",
    today: "sensor.z2_today", watering: "binary_sensor.z2_watering" },
];
const ctrl = { device: "c", today: "sensor.c_today" };
const hass = { states: {
  "sensor.z1_today": { state: "0", attributes: { unit_of_measurement: "s" } },
  "sensor.z2_today": { state: "0", attributes: { unit_of_measurement: "s" } },
  "sensor.c_today": { state: "0", attributes: { unit_of_measurement: "s" } },
} };
const hist = {
  "sensor.z1_today": [{ s: "999", lu: from / 1000 },
    { s: "600", lu: lu(16, 9, 40) }, { s: "300", lu: lu(14, 6, 40) }],
  "sensor.z2_today": [{ s: "240", lu: lu(16, 9, 40) }],
  "sensor.c_today": [{ s: "999", lu: from / 1000 },
    { s: "840", lu: lu(16, 9, 40) }, { s: "300", lu: lu(14, 6, 40) },
    { s: "1200", lu: lu(7, 6, 40) }],
  "binary_sensor.z1_watering": [{ s: "on", lu: lu(16, 5, 0) }, { s: "off", lu: lu(16, 5, 10) }],
};
const wk = T.hwWeek(hist, zones, ctrl, hass, now);
eq(wk.days.length, 7, "seven days");
eq(wk.days[6].key, "2026-10-16", "ending today");
eq(wk.days[6].total, 840, "today's total is the controller's figure");
eq(wk.days[6].zones.map((x) => [x.z.name, x.secs]), [["Front Lawn", 600], ["Back Beds", 240]],
  "and the zones that made it, most first");
eq(wk.days[4].total, 300, "two days ago");
eq(wk.week, 1140, "the week adds up");
const dayRuns = T.hwDayRuns({ "binary_sensor.z1_watering": hist["binary_sensor.z1_watering"] },
  zones, now);
eq(dayRuns.map((r) => r.z.name), ["Front Lawn"], "the runs one day's read holds");
ok(wk.prevComplete, "a recorder that reaches back two weeks allows a comparison");
eq(wk.prev, 1200, "and the week before is counted");
eq(T.hwCompare(wk.week, wk.prev), "5% less than the week before", "and said in words");

const purged = { ...hist };
purged["sensor.c_today"] = hist["sensor.c_today"].filter((r) => r.lu * 1000 > from);
purged["sensor.z1_today"] = hist["sensor.z1_today"].filter((r) => r.lu * 1000 > from);
const wk2 = T.hwWeek(purged, zones, ctrl, hass, now);
ok(!wk2.prevComplete && wk2.prev == null,
  "with the older days purged there is no week before, rather than a wrong one");
eq(T.hwCompare(1000, null), "", "no comparison without one");
eq(T.hwCompare(1000, 0), "", "nor against a week of nothing");
eq(T.hwCompare(1300, 1000), "30% more than the week before", "more");

const noCtrl = T.hwWeek(hist, zones, null, hass, now);
eq(noCtrl.days[6].total, 840, "without a controller total, the zones are added up");

const req = T.hwCountReq(zones, ctrl, now);
eq(req.type, "history/history_during_period", "the counters are one history call");
eq(req.entity_ids.sort(), ["sensor.c_today", "sensor.z1_today", "sensor.z2_today"],
  "for the counters only - the watering sensors were 98% of the rows");
ok(req.minimal_response && req.no_attributes, "asking for as little as it can");
eq(new Date(req.start_time).getTime(), from, "a fortnight of them, so the week before can be compared");
const rq = T.hwRunsReq(zones, "2026-10-14", now);
eq(rq.entity_ids.sort(), ["binary_sensor.z1_watering", "binary_sensor.z2_watering"],
  "runs are read from the watering sensors");
eq([new Date(rq.start_time).getDate(), new Date(rq.end_time).getDate()], [14, 15],
  "for one whole day");
const rt = T.hwRunsReq(zones, "2026-10-16", now);
eq(new Date(rt.end_time).getTime(), now.getTime(), "and today only up to now");

/* ---------------------------------------------------------------- screen */
console.log("-- screen --");
let picked = null, again = 0;
const dom = T.hwLogDom(wk, { sel: null, lang: "en-US", now, runs: { list: dayRuns } }, {
  day: (k) => { picked = k; }, reload: () => { again++; } });
ok(dom.textContent.includes("19m over 7 days"), "the week's total heads it");
ok(dom.textContent.includes("Sat, Oct 10 \u2013 today"), "and names the seven days it adds up");
ok(dom.textContent.includes("5% less than the week before"), "with the comparison");
const days = dom.querySelectorAll("button.day");
eq(days.length, 7, "a button per day");
ok(days[6].className.includes("on"), "today is picked to start with");
days[4].click();
eq(picked, "2026-10-14", "pressing a day picks it");
ok(dom.textContent.includes("Front Lawn") && dom.textContent.includes("10m"),
  "today's zones and their minutes are listed");
ok(dom.textContent.includes("~10m"), "a run is marked approximate");
ok(dom.textContent.includes("exact") && dom.textContent.includes("five minutes"),
  "and the screen says which numbers are exact and which are not");
dom.querySelectorAll("button.back").forEach((b) => b.click());
eq(again, 1, "it can be read again");
const dom2 = T.hwLogDom(wk2, { sel: null, lang: "en-US", now }, { day() {}, reload() {} });
ok(dom2.textContent.includes("needs 14 days"), "without the week before, it says why");
const rl = T.hwLogDom(wk, { lang: "en-US", now, runs: { loading: true } }, { day() {}, reload() {} });
ok(rl.textContent.includes("Reading that day"), "a day's runs say so while they load");
const re = T.hwLogDom(wk, { lang: "en-US", now, runs: { err: "x" } }, { day() {}, reload() {} });
ok(re.textContent.includes("Could not read that day"), "and if they fail");
ok(re.textContent.includes("Front Lawn"), "without losing the totals above them");
const loading = T.hwLogDom(null, { loading: true, lang: "en-US", now }, { day() {}, reload() {} });
ok(loading.textContent.includes("Reading"), "while it loads, it says so");
const bad = T.hwLogDom(null, { err: "boom", lang: "en-US", now }, { day() {}, reload() {} });
ok(bad.textContent.includes("Could not read the history: boom"), "a failed read is shown");

let tabbed = null;
const tabs = T.hwTabsDom("zones", { tab: (k) => { tabbed = k; } });
tabs.querySelectorAll("button.tab")[1].click();
eq(tabbed, "log", "the Watering tab switches to the log");

console.log(fails ? "\n" + fails + " FAILED" : "\nall passed");
process.exit(fails ? 1 : 0);
