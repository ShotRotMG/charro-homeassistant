"""Shared names for the Charro integration."""

DOMAIN = "charro"

# What the sidebar entry is called, and the URL it lives at.
PANEL_URL = "charro-rooms"
PANEL_TITLE = "Rooms"
PANEL_ICON = "mdi:floor-plan"

# The UniFi diagnostics panel is a second sidebar entry off the same bundle:
# one module fetch serves both, so adding it costs nothing at load time.
UNIFI_PANEL_URL = "charro-unifi"
UNIFI_PANEL_TITLE = "UniFi"
UNIFI_PANEL_ICON = "mdi:router-network"
UNIFI_PANEL_ELEMENT = "charro-unifi-panel"

# Where the bundle is served from, and the element the panel mounts.
STATIC_URL = "/charro_static"
BUNDLE = "charro-cards.js"
PANEL_ELEMENT = "charro-rooms-panel"

# Room files live in /config, NOT under /config/www: anything under www is
# served at /local with no authentication at all, so a room file there - the
# entity ids and layout of every room in the house - was readable by anyone
# who could reach the instance. The cards fetch them over the websocket now,
# which is already authenticated.
ROOMS_DIR = "charro_rooms"
REMOTES_FILE = "_remotes.json"

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
