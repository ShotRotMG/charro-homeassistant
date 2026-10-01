"""Shared names for the Charro integration."""

DOMAIN = "charro"

# What the sidebar entry is called, and the URL it lives at.
PANEL_URL = "charro-rooms"
PANEL_TITLE = "Rooms"
PANEL_ICON = "mdi:floor-plan"

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
