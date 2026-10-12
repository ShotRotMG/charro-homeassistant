"""Shared names for the Charro integration."""

DOMAIN = "charro"

# What the sidebar entry is called, and the URL it lives at. One entry for
# everything Charro: the rooms, the remote templates and the UniFi
# diagnostics are tabs inside it rather than pages of their own.
PANEL_URL = "charro-config"
PANEL_TITLE = "Charro Config"
# mdi:home-cog, which 5.42.0 used, is not an icon that exists - the
# sidebar drew the entry with a blank where the glyph should be.
PANEL_ICON = "mdi:home-edit"

# The two URLs this used to be two panels at. Still registered, but off the
# sidebar, so a dashboard link or a bookmark to either one still lands - on
# the tab that page became. /<url>/<tab> picks the tab directly.
LEGACY_PANEL_URLS = ("charro-rooms", "charro-unifi")

# Where the bundle is served from, and the element the panel mounts.
STATIC_URL = "/charro_static"
BUNDLE = "charro-cards.js"
PANEL_ELEMENT = "charro-config-panel"

# Room files live in /config, NOT under /config/www: anything under www is
# served at /local with no authentication at all, so a room file there - the
# entity ids and layout of every room in the house - was readable by anyone
# who could reach the instance. The cards fetch them over the websocket now,
# which is already authenticated.
ROOMS_DIR = "charro_rooms"

# Nudging a number-backed volume needs its current value, which a card's
# static config cannot read. The remotes call this instead.
SERVICE_VOLUME_STEP = "volume_step"
REMOTES_FILE = "_remotes.json"

# One notification service for the whole house. Who gets what, and how
# loudly, lives in a file the Notifications tab writes - not in forty
# automations that each name a phone.
SERVICE_NOTIFY = "notify"
NOTIFY_FILE = "_notify.json"

# iOS has no notification channels, so the urgency is decided here and
# carried in push.interruption-level. These are the five settings a cell in
# the matrix can hold, in order.
NOTIFY_LEVELS = ("off", "quiet", "normal", "urgent", "critical")
# APNs keeps exactly one notification for a phone that is off the network
# and discards the rest, so "don't lose any" cannot be a promise made at
# the push layer. The journal is the record; push is a doorbell on top of
# it, allowed to fail because failing no longer means losing.
JOURNAL_FILE = "_journal.json"
JOURNAL_KEEP_DAYS = 30
JOURNAL_MAX = 2000

# A failed send is retried on this ladder, in seconds. Three attempts: past
# that it is not a blip, and the entry stays in the feed either way.
NOTIFY_RETRIES = (5, 30, 120)

# What the watcher reads out of the room files, and the category each list
# becomes. The rooms already say where every door, lock and gate is, so
# nothing here has to be listed twice - and no automation has to exist.
WATCH_DEFAULTS = {
    "doors":  {"on": True,  "cooldown": 60},
    "locks":  {"on": True,  "cooldown": 30},
    "gates":  {"on": True,  "cooldown": 60},
    "garage": {"on": False, "cooldown": 120},
    # Motion is the chattiest thing in the house and ships off, with a
    # five-minute window: a hallway sensor left on a 60s cooldown would
    # spend a 500-a-day allowance by lunchtime.
    "motion": {"on": False, "cooldown": 300},
}

# A state that means "I don't know", which is not news and is the whole
# class the ratgdo false-Opening lives in.
WATCH_NOISE = ("unavailable", "unknown", "none", "")

# What counts as a candidate, and which category it lands in. Everything
# matching is watched unless it is ticked off in the checklist, so a lock
# added next year is covered without anyone remembering to add it.
# Classified by what the entity says it is, never by its name.
# An ElkM1 zone is not a binary_sensor. The integration publishes it as a
# `sensor` with no device class at all, reading "Normal" or "Violated" and
# carrying `logical_status` and `definition` attributes - which is why a
# device-class sweep found six garage covers, one lock and not one of this
# house's twenty-seven door contacts.
WATCH_ZONE_ATTRS = ("logical_status", "definition")
WATCH_ZONE_PREFIX = "burglar"

# An Elk burglar zone is a door or a motion detector, and the panel says
# which: entry/exit and perimeter zones are ways in, interior zones are
# what watches the space behind them. Six of this house's twenty-five
# "doors" were motion detectors until this told them apart - and it is
# the panel's own word for them, not a guess from "Hall Motion".
WATCH_ZONE_MOTION = "burglar_interior"

# Some things have no state to watch, only a moment. A gate here is a
# script and a DoorBird relay: nothing reports whether it is open, and the
# only signal is that somebody pressed it. These are never auto-detected -
# nothing about a script says "gate" except its name, and names are not
# evidence - so they are added by hand in the checklist and only the
# leading edge counts.
WATCH_PRESS = ("script", "button", "input_button", "scene")

# Every way an entity in this house says "open", whatever its domain -
# and every way it says it has gone back to being shut. An Elk zone
# returns to "Normal" rather than to "off".
WATCH_OPEN = ("on", "open", "opening", "violated")
WATCH_SHUT = ("off", "closed", "normal")
# The verbs that mean the second half of a pair. The cooldown is keyed on
# the direction, and so is the closed colour - a door that shut can read
# calmer than the same door opening.
WATCH_SHUT_VERBS = ("Closed", "Locked", "Clear")

# What a notification is allowed to say, and what it says by default.
# Compiled once when the config is saved, never parsed while a door is
# opening - the whole point of precompiling is that firing is a join
# over a short list and nothing else.
NOTIFY_FIELDS = ("name", "room", "status", "state", "was", "category",
                 "entity", "time", "who", "by")
NOTIFY_TITLE = "{name}"
NOTIFY_MESSAGE = "{status} \u00b7 {room}"

# Characters a dangling separator can be made of, trimmed when the field
# beside them turns out to be empty - a room that has no name should read
# "Opened", not "Opened \u00b7 ".
NOTIFY_TRIM = " \u00b7-\u2013\u2014,:;|"

WATCH_CLASSES = {
    "lock": {None: "locks"},
    "cover": {"garage": "garage", "gate": "gates", "door": "doors"},
    "binary_sensor": {
        "door": "doors", "window": "doors", "opening": "doors",
        "garage_door": "garage",
        "motion": "motion", "occupancy": "motion",
    },
}

# How far back a restart looks for sends that never completed.
NOTIFY_RESUME_SECONDS = 3600

NOTIFY_PUSH_LEVEL = {
    "quiet": "passive",
    "normal": "active",
    "urgent": "time-sensitive",
    "critical": "critical",
}

# Where they used to live, so an existing install can be moved across once.
LEGACY_SUBDIR = ("www", "rooms")

# Every save copies the file it is about to replace into here first, so an
# autosave you didn't mean is recoverable. Thinned on each write so the list
# stays short enough to actually read: roughly 25 per room, never past the
# hard cap. Widen SNAP_KEEP_DAYS or narrow SNAP_FINE_EVERY if you want more.
SNAP_DIR = ".snapshots"
SNAP_FINE_EVERY = 600     # one per 10 min, for the first hour        -> ~6
SNAP_MID_EVERY = 14400    # then one per 4 hours, for the first day   -> ~6
SNAP_DAY = 86400          # then one per day                         -> ~13
SNAP_KEEP_DAYS = 14
SNAP_HOUR = 3600          # boundary between the fine and mid tiers
SNAP_MAX = 30             # belt and braces, whatever the arithmetic does
