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
