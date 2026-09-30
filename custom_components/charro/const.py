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

# Room files live under /config/www so the cards can fetch them from /local.
ROOMS_SUBDIR = "rooms"
