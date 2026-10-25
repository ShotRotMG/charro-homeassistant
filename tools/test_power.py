# -*- coding: utf-8 -*-
"""Screens and receivers kept on and off together, run against the real code.

The pair finder, the rule, and the keeper class are lifted out of
__init__.py with ast (homeassistant isn't importable here) and driven with
a fake hass: state changes in, service calls out. Covers the Theatre's two
complaints - projector lit with the receiver off, and the other way round -
and the two ways such a thing goes wrong: chasing its own echo, and giving
up on a projector that ignored "on" while it cooled down.
"""
import ast
import io
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "custom_components", "charro"))
import const  # noqa: E402

WANT = ("_screen_power", "_power_pairs", "_power_is_on", "_power_follow", "CharroPowerKeeper")
src = io.open(os.path.join(ROOT, "custom_components", "charro", "__init__.py"), encoding="utf-8").read()
tree = ast.parse(src)
picked = [n for n in tree.body if isinstance(n, (ast.FunctionDef, ast.ClassDef)) and n.name in WANT]
assert len(picked) == len(WANT), [n.name for n in picked]

clock = [1000.0]
timers = []
subs = []


class FakeEvent:
    @staticmethod
    def async_track_state_change_event(hass, ids, cb):
        subs.append((list(ids), cb))
        return lambda: subs.remove((list(ids), cb)) if (list(ids), cb) in subs else None

    @staticmethod
    def async_call_later(hass, delay, cb):
        timers.append((clock[0] + delay, cb))
        return lambda: None


class FakeTime:
    @staticmethod
    def monotonic():
        return clock[0]


class Log:
    def debug(self, *a): pass
    def info(self, *a): pass


ns = {"HomeAssistant": object, "Any": object, "callback": lambda f: f,
      "event": FakeEvent, "time": FakeTime, "_LOGGER": Log(),
      "POWER_OFF_STATES": const.POWER_OFF_STATES, "POWER_DEAD_STATES": const.POWER_DEAD_STATES,
      "KEEP_QUIET_SECONDS": const.KEEP_QUIET_SECONDS, "KEEP_RETRY_SECONDS": const.KEEP_RETRY_SECONDS}
exec(compile(ast.Module(body=picked, type_ignores=[]), "<charro>", "exec"), ns)

fails = []


def ok(c, m):
    print(("  ok   " if c else "  FAIL ") + m)
    if not c:
        fails.append(m)


def eq(got, want, m):
    ok(got == want, "%s  got %r" % (m, got))


PJ, RX = "switch.theatre_projector", "media_player.vsx_lx305"
THEATRE = {"room_name": "Theatre", "receiver_entity": RX, "video": {
    "keep_together": True, "source_from": RX,
    "displays": [{"name": "Theatre", "screen": PJ, "volume": RX}]}}

print("-- which pairs --")
pairs = ns["_power_pairs"]
eq(pairs({"theatre": THEATRE}), [("theatre", PJ, RX)], "the Theatre: projector and receiver")
off = dict(THEATRE, video=dict(THEATRE["video"], keep_together=False))
eq(pairs({"theatre": off}), [], "only a room that asks")
helper = {"video": {"keep_together": True, "live_from": RX,
                    "displays": [{"screen": PJ, "source": "input_select.x"}]}}
eq(pairs({"t": helper}), [("t", PJ, RX)], "a helper room pairs with what live_from reads")
eq(pairs({"t": {"receiver_entity": RX, "video": {"keep_together": True,
       "displays": [{"screen": PJ}]}}}), [("t", PJ, RX)], "falls back to the room's receiver")
eq(pairs({"t": {"video": {"keep_together": True, "displays": [{"screen": PJ}]}}}), [],
   "no receiver, no pair")
eq(pairs({"t": "nonsense", "u": {"video": []}}), [], "bad rooms are skipped")

print("-- the rule --")
f = ns["_power_follow"]
eq(f("on", "off"), "turn_on", "screen on, receiver off: receiver on")
eq(f("off", "on"), "turn_off", "screen off, receiver on: receiver off")
eq(f("playing", "on"), None, "both on: nothing")
eq(f("standby", "off"), None, "both off: nothing")
eq(f("unavailable", "on"), None, "unavailable says nothing")
eq(f("on", "unknown"), None, "nor unknown")


class State:
    def __init__(self, s):
        self.state = s


class States(dict):
    def get(self, k, d=None):
        return dict.get(self, k, d)


calls = []


class Services:
    def async_call(self, domain, svc, data, blocking=False):
        calls.append((domain, svc, data["entity_id"]))
        return None


class Hass:
    def __init__(self):
        self.states = States()
        self.services = Services()

    def async_create_task(self, x):
        return x

    async def async_add_executor_job(self, fn, *a):
        return {"rooms": {"theatre": THEATRE}}


hass = Hass()
ns["_read_all"] = lambda p: None
k = ns["CharroPowerKeeper"](hass, "/x")
import asyncio  # noqa: E402
asyncio.run(k.async_rescan())
eq(sorted(subs[0][0]), [RX, PJ] if RX < PJ else [PJ, RX], "one subscription, both entities")


class Ev:
    def __init__(self, eid, old, new):
        self.data = {"entity_id": eid, "old_state": State(old), "new_state": State(new)}


def change(eid, old, new):
    hass.states[eid] = State(new)
    k._on_state(Ev(eid, old, new))


print("-- the Theatre --")
hass.states[PJ] = State("off")
hass.states[RX] = State("off")
change(PJ, "off", "on")
eq(calls, [("media_player", "turn_on", RX)], "projector on by Harmony: the receiver follows")
clock[0] += 3
change(RX, "off", "on")
eq(len(calls), 1, "the receiver arriving is our echo - nothing sent back")
clock[0] += 60
change(RX, "on", "off")
eq(calls[-1], ("switch", "turn_off", PJ), "receiver off by its own remote: the projector follows")
clock[0] += 5
change(PJ, "on", "off")
eq(len(calls), 2, "and the projector going off is our echo too")
clock[0] += 60
change(RX, "on", "playing")
eq(len(calls), 2, "playing after on is not a power change")
change(PJ, "off", "unavailable")
eq(len(calls), 2, "a trip through unavailable moves nothing")

print("-- a projector cooling down --")
calls.clear(); timers.clear()
hass.states[PJ] = State("off")
hass.states[RX] = State("off")
clock[0] += 100
change(RX, "off", "on")
eq(calls, [("switch", "turn_on", PJ)], "receiver on: projector told on")
when, cb = timers[-1]
eq(when - clock[0], const.KEEP_RETRY_SECONDS, "a check is booked")
clock[0] = when
cb(None)                                        # the projector ignored it
eq(calls[-1], ("switch", "turn_on", PJ), "still off at the check: told once more")
eq(len(calls), 2, "and only once more")
eq(len(timers), 1, "no second retry booked")
timers.clear()
hass.states[PJ] = State("on")
change(RX, "on", "off")
clock[0] += 200
change(RX, "off", "on")
hass.states[PJ] = State("on")                   # this time it came on
when, cb = timers[-1]
n = len(calls)
cb(None)
eq(len(calls), n, "already on at the check: nothing more")

k.stop()
eq(subs, [], "stop() drops the subscription")

print("\n%s" % ("%d FAILED" % len(fails) if fails else "all passed"))
sys.exit(1 if fails else 0)
