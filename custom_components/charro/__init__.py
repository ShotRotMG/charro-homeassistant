"""Charro Cards.

Two jobs, both of which used to need hand-editing:

  1. Serve `charro-cards.js` and register it with the frontend, so the cards
     exist without a Lovelace resource entry.
  2. Put the rooms editor on the sidebar (admin only) and give it a websocket
     command that writes room files, replacing the `shell_command` that
     otherwise had to go in configuration.yaml.

Room files stay where they were: /config/www/rooms/*.json, served at
/local/rooms/. The cards fetch them over plain HTTP, so nothing about how a
dashboard loads a room changes when this integration is installed.
"""

from __future__ import annotations

import json
import logging
import os
import re
import time
from typing import Any

import voluptuous as vol

from homeassistant.components import frontend, panel_custom, websocket_api
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.typing import ConfigType
import homeassistant.helpers.config_validation as cv
from homeassistant.loader import async_get_integration

from .const import (
    BUNDLE,
    DOMAIN,
    PANEL_ELEMENT,
    PANEL_ICON,
    PANEL_TITLE,
    PANEL_URL,
    ROOMS_SUBDIR,
    STATIC_URL,
)

_LOGGER = logging.getLogger(__name__)

CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)

# A room key becomes a filename, so it is allowlisted rather than sanitised.
# No dots, no slashes, so "../../configuration" can't be spelled at all.
KEY_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")

# The editor may carry a non-default rooms_dir from its card config. Only
# /local/... is accepted, and only with plain path segments.
DIR_RE = re.compile(r"^/local/(?:[a-z0-9][a-z0-9_-]*/)*$")


# --------------------------------------------------------------- setup --


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """YAML isn't used — everything happens in async_setup_entry."""
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Serve the bundle, register it, add the sidebar panel and the save API."""
    integration = await async_get_integration(hass, DOMAIN)
    root = os.path.dirname(__file__)
    web = os.path.join(root, "frontend")

    await _register_static(hass, STATIC_URL, web)

    # The bundle is served with HA's long cache headers, so the URL carries a
    # revision: the manifest version plus the file's mtime. A reinstall or a
    # hand-edit of the file changes the URL, and the browser refetches.
    def _rev() -> str:
        try:
            mtime = int(os.path.getmtime(os.path.join(web, BUNDLE)))
        except OSError:
            mtime = 0
        return f"{integration.version}.{mtime}"

    url = f"{STATIC_URL}/{BUNDLE}?v={await hass.async_add_executor_job(_rev)}"

    # This is what replaces the Lovelace resource entry: every frontend load
    # pulls the bundle in, so the cards are defined before a dashboard renders.
    frontend.add_extra_js_url(hass, url)

    await panel_custom.async_register_panel(
        hass,
        webcomponent_name=PANEL_ELEMENT,
        frontend_url_path=PANEL_URL,
        sidebar_title=PANEL_TITLE,
        sidebar_icon=PANEL_ICON,
        # Same URL as above: the browser's module map keys on it, so the
        # bundle is fetched and evaluated exactly once per page.
        module_url=url,
        embed_iframe=False,
        require_admin=True,
    )

    websocket_api.async_register_command(hass, ws_list_rooms)
    websocket_api.async_register_command(hass, ws_save_room)
    websocket_api.async_register_command(hass, ws_delete_room)

    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = {"url": url}
    _LOGGER.debug("Charro Cards %s ready at %s", integration.version, url)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Drop the sidebar panel. The static route and the JS stay until restart."""
    frontend.async_remove_panel(hass, PANEL_URL)
    hass.data.get(DOMAIN, {}).pop(entry.entry_id, None)
    return True


async def _register_static(hass: HomeAssistant, url: str, path: str) -> None:
    """Serve `path` at `url`, using whichever http API this core has."""
    try:
        from homeassistant.components.http import StaticPathConfig

        await hass.http.async_register_static_paths(
            [StaticPathConfig(url, path, cache_headers=True)]
        )
        return
    except (ImportError, AttributeError):
        pass
    # Cores older than 2024.7
    hass.http.register_static_path(url, path, cache_headers=True)


# ----------------------------------------------------------- room files --


def _rooms_dir(hass: HomeAssistant, local_dir: str | None) -> str:
    """Map a /local/... directory to its path under /config/www."""
    if not local_dir:
        return hass.config.path("www", ROOMS_SUBDIR)
    if not DIR_RE.match(local_dir):
        raise HomeAssistantError(f"rooms_dir must look like /local/rooms/, got {local_dir!r}")
    rel = local_dir[len("/local/") :].strip("/")
    return hass.config.path("www", *rel.split("/")) if rel else hass.config.path("www")


def _write_room(path: str, key: str, config: dict[str, Any]) -> None:
    """Write one room file, then rebuild the index the cards read."""
    os.makedirs(path, exist_ok=True)
    target = os.path.join(path, f"{key}.json")
    tmp = f"{target}.tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(config, fh, indent=2, ensure_ascii=False)
        fh.write("\n")
    os.replace(tmp, target)  # so a reader never sees a half-written file
    _write_index(path)


def _write_index(path: str) -> list[str]:
    """Rebuild _index.json: the room list, plus the revision that busts cache.

    Room files are served from /local with a 31-day max-age. Every other fetch
    is stamped with this revision, so bumping it here is what makes an edit
    visible on the next page load.
    """
    keys = sorted(
        f[:-5]
        for f in os.listdir(path)
        if f.endswith(".json") and not f.startswith("_") and not f.endswith(".tmp.json")
    )
    index = os.path.join(path, "_index.json")
    tmp = f"{index}.tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump({"rooms": keys, "rev": str(int(time.time()))}, fh, indent=2)
        fh.write("\n")
    os.replace(tmp, index)
    return keys


def _list_rooms(path: str) -> list[str]:
    if not os.path.isdir(path):
        return []
    return sorted(
        f[:-5]
        for f in os.listdir(path)
        if f.endswith(".json") and not f.startswith("_") and not f.endswith(".tmp.json")
    )


def _delete_room(path: str, key: str) -> None:
    target = os.path.join(path, f"{key}.json")
    if not os.path.isfile(target):
        raise HomeAssistantError(f"{key}.json doesn't exist")
    os.remove(target)
    _write_index(path)


# ------------------------------------------------------------ websocket --


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        vol.Required("type"): "charro/list_rooms",
        vol.Optional("dir"): cv.string,
    }
)
@websocket_api.async_response
async def ws_list_rooms(hass, connection, msg):
    """List the room keys on disk, so the editor doesn't have to guess."""
    try:
        path = _rooms_dir(hass, msg.get("dir"))
        rooms = await hass.async_add_executor_job(_list_rooms, path)
    except HomeAssistantError as err:
        connection.send_error(msg["id"], "invalid_dir", str(err))
        return
    connection.send_result(msg["id"], {"rooms": rooms, "path": path})


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        vol.Required("type"): "charro/save_room",
        vol.Required("key"): cv.string,
        vol.Required("config"): dict,
        vol.Optional("dir"): cv.string,
    }
)
@websocket_api.async_response
async def ws_save_room(hass, connection, msg):
    """Write /config/www/<rooms>/<key>.json. Admin only."""
    key = msg["key"]
    if not KEY_RE.match(key):
        connection.send_error(
            msg["id"], "invalid_key", "a room key is lowercase letters, digits, - and _"
        )
        return
    try:
        path = _rooms_dir(hass, msg.get("dir"))
        await hass.async_add_executor_job(_write_room, path, key, msg["config"])
    except HomeAssistantError as err:
        connection.send_error(msg["id"], "invalid_dir", str(err))
        return
    except OSError as err:
        connection.send_error(msg["id"], "write_failed", str(err))
        return
    connection.send_result(msg["id"], {"path": os.path.join(path, f"{key}.json")})


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        vol.Required("type"): "charro/delete_room",
        vol.Required("key"): cv.string,
        vol.Optional("dir"): cv.string,
    }
)
@websocket_api.async_response
async def ws_delete_room(hass, connection, msg):
    """Remove a room file. Nothing else references it, so this is the whole job."""
    key = msg["key"]
    if not KEY_RE.match(key):
        connection.send_error(
            msg["id"], "invalid_key", "a room key is lowercase letters, digits, - and _"
        )
        return
    try:
        path = _rooms_dir(hass, msg.get("dir"))
        await hass.async_add_executor_job(_delete_room, path, key)
    except HomeAssistantError as err:
        connection.send_error(msg["id"], "not_found", str(err))
        return
    except OSError as err:
        connection.send_error(msg["id"], "delete_failed", str(err))
        return
    connection.send_result(msg["id"], {"deleted": key})
