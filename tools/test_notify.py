# -*- coding: utf-8 -*-
"""The payload each phone gets, run against the real functions.

__init__.py imports homeassistant, which is not installed here, so the two
functions under test are lifted out of the file by ast and executed as
themselves. That is the point: a copy pasted into a test is a copy that
keeps passing after the original changes.
"""
import ast
import io
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "custom_components", "charro"))
import const  # noqa: E402  - the real constants, not a copy

WANT = ("_notify_payload", "_notify_platform")
src = io.open(os.path.join(ROOT, "custom_components", "charro", "__init__.py"),
              encoding="utf-8").read()
tree = ast.parse(src)
picked = [n for n in tree.body
          if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name in WANT]
assert len(picked) == len(WANT), "expected %s, found %s" % (
    list(WANT), [n.name for n in picked])
ns = {"Any": object, "NOTIFY_PLATFORMS": const.NOTIFY_PLATFORMS}
exec(compile(ast.Module(body=picked, type_ignores=[]), "<charro>", "exec"), ns)
payload = ns["_notify_payload"]
platform = ns["_notify_platform"]

fails = []


def ok(cond, msg):
    if cond:
        print("  ok   " + msg)
    else:
        fails.append(msg)
        print("  FAIL " + msg)


def eq(got, want, msg):
    ok(got == want, "%s  got %r" % (msg, got))


# ------------------------------------------------------------ platform --
eq(platform({}), "ios", "no platform set is iOS")
eq(platform({"platform": "ios"}), "ios", "iOS stays iOS")
eq(platform({"platform": "android"}), "android", "Android is Android")
eq(platform({"platform": "ANDROID"}), "android", "case does not matter")
eq(platform({"platform": " android "}), "android", "nor does whitespace")
eq(platform({"platform": "windows_phone"}), "ios", "anything unknown falls back to iOS")
eq(platform({"platform": ""}), "ios", "and so does blank")
eq(platform({"platform": None}), "ios", "and None")

CAT = {"key": "doors", "name": "Doors", "icon": "mdi:door-open",
       "color": "#ef5350", "url": "/lovelace/security",
       "camera": "camera.front_door"}

ios = payload(CAT, {}, "charro-doors-x-open", platform="ios")
andr = payload(CAT, {}, "charro-doors-x-open", platform="android")

# ------------------------------------------------------- what is shared --
for k in ("tag", "group", "notification_icon", "color"):
    ok(k in ios and k in andr, "%s is sent to both" % k)
    eq(ios[k], andr[k], "   and is the same on both: %s" % k)
eq(ios["group"], "doors", "group falls back to the category key")
eq(payload({"key": "a", "group": "g"}, {}, "t")["group"], "g",
   "an explicit group wins")

# ----------------------------------------------- what must not be shared --
eq(ios.get("url"), "/lovelace/security", "iOS gets url")
ok("clickAction" not in ios, "and not clickAction")
eq(andr.get("clickAction"), "/lovelace/security", "Android gets clickAction")
ok("url" not in andr, "and not url - it would be ignored")

eq(ios.get("entity_id"), "camera.front_door", "iOS gets the camera entity")
ok("image" not in ios, "and not an image url")
eq(andr.get("image"), "/api/camera_proxy/camera.front_door",
   "Android gets the camera proxy still")
ok("entity_id" not in andr, "and not the entity, which it cannot attach")

# the subtitle / subject split, including the iOS glyph rule
noGlyph = {"key": "doors", "name": "Doors"}
eq(payload(noGlyph, {}, "t", platform="ios").get("subtitle"), "Doors",
   "iOS shows the category as a subtitle when there is no glyph")
ok("subtitle" not in ios, "but not when a glyph has taken that slot")
eq(andr.get("subject"), "Doors", "Android always gets the category as subject")
eq(payload(noGlyph, {}, "t", platform="android").get("subject"), "Doors",
   "   glyph or no glyph")
ok("subject" not in ios and "subtitle" not in andr,
   "neither platform is sent the other's key")

# ------------------------------------------------------------ overrides --
over = {"url": "/lovelace/cams", "camera": "camera.gate", "actions": [{"action": "x"}]}
eq(payload(CAT, over, "t", platform="android")["clickAction"], "/lovelace/cams",
   "the call's url beats the category's")
eq(payload(CAT, over, "t", platform="android")["image"],
   "/api/camera_proxy/camera.gate", "and its camera")
eq(payload(CAT, over, "t", platform="ios")["actions"], [{"action": "x"}],
   "actions are actionable on both")
eq(payload(CAT, over, "t", platform="android")["actions"], [{"action": "x"}],
   "   including Android")

# a direction-specific colour and glyph arrive already settled
shut = payload(CAT, {}, "t", color="#4caf50", icon="mdi:door-closed")
eq(shut["color"], "#4caf50", "the caller's colour wins")
eq(shut["notification_icon"], "mdi:door-closed", "and its glyph")

# a bare category sends nothing it cannot fill in
bare = payload({"key": "x"}, {}, "charro-x")
eq(sorted(bare), ["group", "tag"], "a bare category sends only tag and group")

# --------------------------------------------------- the urgency tables --
eq(sorted(const.NOTIFY_ANDROID_IMPORTANCE), sorted(const.NOTIFY_PUSH_LEVEL),
   "every level that has an iOS urgency has an Android one")
for lvl in const.NOTIFY_LEVELS:
    if lvl == "off":
        continue
    ok(lvl in const.NOTIFY_ANDROID_IMPORTANCE, "%s has an Android importance" % lvl)
    ok(const.NOTIFY_ANDROID_IMPORTANCE[lvl] in
       ("min", "low", "default", "high", "max"),
       "   and it is a value Android knows: %s" % const.NOTIFY_ANDROID_IMPORTANCE[lvl])
eq(const.NOTIFY_ANDROID_IMPORTANCE["critical"], "max", "critical is the loudest")
ok(const.NOTIFY_ANDROID_CRITICAL_CHANNEL
   and const.NOTIFY_ANDROID_CRITICAL_CHANNEL != "General",
   "critical has a channel of its own to allow past Do Not Disturb")
eq(const.NOTIFY_PLATFORMS, ("ios", "android"), "two platforms, iOS first")

print("\n%d FAILED" % len(fails) if fails else "\nall passed")
sys.exit(1 if fails else 0)
