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
import shutil
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
    LEGACY_SUBDIR,
    PANEL_ELEMENT,
    PANEL_ICON,
    PANEL_TITLE,
    PANEL_URL,
    REMOTES_FILE,
    ROOMS_DIR,
    STATIC_URL,
)

_LOGGER = logging.getLogger(__name__)

CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)

# A room key becomes a filename, so it is allowlisted rather than sanitised.
# No dots, no slashes, so "../../configuration" can't be spelled at all.
KEY_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")



# --------------------------------------------------------------- setup --


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """YAML isn't used — everything happens in async_setup_entry."""
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Serve the bundle, register it, add the sidebar panel and the save API."""
    integration = await async_get_integration(hass, DOMAIN)
    root = os.path.dirname(__file__)
    web = os.path.join(root, "frontend")

    # aiohttp's router refuses a second route on the same prefix, and the
    # prefix never changes — only the query does — so this happens once per
    # Home Assistant run rather than once per setup.
    rooms = _rooms_dir(hass)
    legacy = hass.config.path(*LEGACY_SUBDIR)
    moved = await hass.async_add_executor_job(_migrate_rooms, rooms, legacy)
    if moved:
        _LOGGER.warning(
            "Copied %d room file(s) from %s to %s. The originals are still "
            "there and still served publicly at /local/rooms/ - delete that "
            "folder once you are happy: %s",
            len(moved), legacy, rooms, ", ".join(moved),
        )

    store = hass.data.setdefault(DOMAIN, {})
    if not store.get("static"):
        await _register_static(hass, STATIC_URL, web)
        store["static"] = True

    # The bundle is served with HA's long cache headers, so the URL carries a
    # revision: the manifest version plus the file's mtime. A reinstall or a
    # hand-edit of the file changes the URL, and the browser refetches.
    def _rev() -> str:
        # Newest mtime anywhere under frontend/, not just the bundle's: the
        # cards stamp the template URLs with this same revision, so editing a
        # template alone still has to move it or the old one stays cached.
        newest = 0
        for root_dir, _dirs, files in os.walk(web):
            for name in files:
                try:
                    newest = max(newest, int(os.path.getmtime(os.path.join(root_dir, name))))
                except OSError:
                    continue
        return f"{integration.version}.{newest}"

    url = f"{STATIC_URL}/{BUNDLE}?v={await hass.async_add_executor_job(_rev)}"

    # How the cards reach a dashboard. Preferred is a Lovelace resource:
    # Lovelace fetches that list live over the websocket every time a
    # dashboard opens, so it cannot go stale. add_extra_js_url instead bakes
    # the URL into the frontend's app shell, which the service worker
    # precaches - a shell cached before this integration existed carries no
    # reference to the bundle at all, the cards never register, and every one
    # of them renders as "Configuration error" until that cache is cleared.
    # So the resource is the real path, and the extra module is only the
    # fallback for a Lovelace running YAML-mode resources, where a resource
    # can't be added.
    if await _sync_resource(hass, url):
        # upgrading from a version that used the shell: take the old entry
        # back out so a cached shell stops pulling in a stale copy
        _drop_extra_js(hass, store.pop("extra_js", None))
    else:
        frontend.add_extra_js_url(hass, url)
        store["extra_js"] = url

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

    websocket_api.async_register_command(hass, ws_get_rooms)
    websocket_api.async_register_command(hass, ws_list_rooms)
    websocket_api.async_register_command(hass, ws_save_room)
    websocket_api.async_register_command(hass, ws_delete_room)

    store[entry.entry_id] = {"url": url}
    _LOGGER.debug("Charro Cards %s ready at %s", integration.version, url)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Undo setup cleanly enough that Reload picks up new frontend files.

    The revision in the bundle's URL is computed at setup, so the old URL has
    to come back out of the frontend's list or a reload would serve both the
    stale one and the fresh one. With it removed, Reload + a browser refresh
    is enough for any change under frontend/; only edits to this Python need
    a Home Assistant restart, since the module is already imported.

    The static route stays: aiohttp can't unregister one, and it doesn't need
    to — the path is stable and setup skips re-adding it.

    The Lovelace resource stays too, and setup rewrites its URL rather than
    adding another. Removing it here would make a reload a window in which
    every dashboard has no cards; it is cleaned up when the integration is
    deleted instead.
    """
    store = hass.data.get(DOMAIN, {})
    frontend.async_remove_panel(hass, PANEL_URL)
    store.pop(entry.entry_id, None)
    _drop_extra_js(hass, store.pop("extra_js", None))
    return True


async def async_remove_entry(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Integration deleted: take the resource out so it stops 404ing."""
    res = _lovelace_resources(hass)
    if res is None:
        return
    prefix = f"{STATIC_URL}/{BUNDLE}"
    try:
        await res.async_get_info()
        for item in [r for r in (res.async_items() or [])
                     if str(r.get("url", "")).startswith(prefix)]:
            await res.async_delete_item(item["id"])
    except Exception:  # noqa: BLE001 - deletion is best effort
        _LOGGER.exception("couldn't remove the Lovelace resource")


def _lovelace_resources(hass: HomeAssistant):
    """The Lovelace resource collection, if one can be written to."""
    data = hass.data.get("lovelace")
    res = getattr(data, "resources", None)
    if res is None and isinstance(data, dict):
        res = data.get("resources")          # cores before the dataclass
    # ResourceYAMLCollection has no create/update: YAML mode owns the list
    return res if hasattr(res, "async_create_item") else None


async def _sync_resource(hass: HomeAssistant, url: str) -> bool:
    """Point Lovelace's resource list at this bundle. True if it took."""
    res = _lovelace_resources(hass)
    if res is None:
        return False
    prefix = f"{STATIC_URL}/{BUNDLE}"
    try:
        await res.async_get_info()                 # loads the collection
        mine = [r for r in (res.async_items() or [])
                if str(r.get("url", "")).startswith(prefix)]
        if not mine:
            await res.async_create_item({"res_type": "module", "url": url})
        else:
            if mine[0].get("url") != url:
                await res.async_update_item(mine[0]["id"], {"url": url})
            for dupe in mine[1:]:                  # only ever one of ours
                await res.async_delete_item(dupe["id"])
    except Exception:  # noqa: BLE001 - a nicety; never fail setup over it
        _LOGGER.exception("couldn't register the Lovelace resource for %s", url)
        return False
    return True


def _drop_extra_js(hass: HomeAssistant, url: str | None) -> None:
    if not url:
        return
    try:
        frontend.remove_extra_js_url(hass, url)
    except (KeyError, ValueError, AttributeError):
        pass


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


def _rooms_dir(hass: HomeAssistant) -> str:
    """Where room files live: /config/charro_rooms, never under www."""
    return hass.config.path(ROOMS_DIR)


def _migrate_rooms(private: str, legacy: str) -> list[str]:
    """Copy rooms out of /config/www/rooms the first time, and only then.

    The originals are left where they are. They are the user's files and
    deleting them automatically is not this integration's call - but they are
    also still world-readable at /local, so setup logs a line saying so.
    """
    if not os.path.isdir(legacy):
        return []
    os.makedirs(private, exist_ok=True)
    if any(f.endswith(".json") for f in os.listdir(private)):
        return []                                  # already moved, or in use
    moved = []
    for name in sorted(os.listdir(legacy)):
        # _index.json only ever existed to bust an HTTP cache; nothing reads
        # it now, so it is not worth carrying across
        if not name.endswith(".json") or name == "_index.json":
            continue
        src_path = os.path.join(legacy, name)
        if os.path.isfile(src_path):
            shutil.copy2(src_path, os.path.join(private, name))
            moved.append(name)
    return moved


def _write_room(path: str, key: str, config: dict[str, Any]) -> None:
    """Write one room file, then rebuild the index the cards read."""
    os.makedirs(path, exist_ok=True)
    target = os.path.join(path, f"{key}.json")
    tmp = f"{target}.tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(config, fh, indent=2, ensure_ascii=False)
        fh.write("\n")
    os.replace(tmp, target)  # so a reader never sees a half-written file


def _read_all(path: str) -> dict[str, Any]:
    """Every room file, plus the shared remote templates, in one go.

    One websocket message replaces one uncached index fetch plus one fetch per
    room. A file that doesn't parse is skipped rather than failing the lot, so
    one bad edit costs you that room and not the dashboard.
    """
    rooms: dict[str, Any] = {}
    remotes: dict[str, Any] = {}
    bad: list[str] = []
    if not os.path.isdir(path):
        return {"rooms": rooms, "remotes": remotes, "bad": bad}
    for name in sorted(os.listdir(path)):
        if not name.endswith(".json") or name.endswith(".tmp.json"):
            continue
        try:
            with open(os.path.join(path, name), encoding="utf-8") as fh:
                data = json.load(fh)
        except (OSError, ValueError):
            bad.append(name)
            continue
        if name == REMOTES_FILE:
            remotes = data if isinstance(data, dict) else {}
        elif not name.startswith("_") and isinstance(data, dict):
            key = name[:-5]
            # tolerate a file that wraps the room in its own key
            if "room_name" not in data and isinstance(data.get(key), dict):
                data = data[key]
            rooms[key] = data
    return {"rooms": rooms, "remotes": remotes, "bad": bad}


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


# ------------------------------------------------------------ websocket --


@websocket_api.websocket_command({vol.Required("type"): "charro/get_rooms"})
@websocket_api.async_response
async def ws_get_rooms(hass, connection, msg):
    """Every room in one authenticated message.

    Deliberately NOT admin-only: any signed-in user who can open a dashboard
    needs this, exactly as they needed to fetch the files before. Writing
    still is admin-only.
    """
    path = _rooms_dir(hass)
    data = await hass.async_add_executor_job(_read_all, path)
    if data["bad"]:
        _LOGGER.warning("skipped unreadable room files: %s", ", ".join(data["bad"]))
    connection.send_result(msg["id"], data)


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        vol.Required("type"): "charro/list_rooms",
    }
)
@websocket_api.async_response
async def ws_list_rooms(hass, connection, msg):
    """List the room keys on disk, so the editor doesn't have to guess."""
    path = _rooms_dir(hass)
    rooms = await hass.async_add_executor_job(_list_rooms, path)
    connection.send_result(msg["id"], {"rooms": rooms, "path": path})


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        vol.Required("type"): "charro/save_room",
        vol.Required("key"): cv.string,
        vol.Required("config"): dict,
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
    path = _rooms_dir(hass)
    try:
        await hass.async_add_executor_job(_write_room, path, key, msg["config"])
    except OSError as err:
        connection.send_error(msg["id"], "write_failed", str(err))
        return
    connection.send_result(msg["id"], {"path": os.path.join(path, f"{key}.json")})


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        vol.Required("type"): "charro/delete_room",
        vol.Required("key"): cv.string,
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
    path = _rooms_dir(hass)
    try:
        await hass.async_add_executor_job(_delete_room, path, key)
    except HomeAssistantError as err:
        connection.send_error(msg["id"], "not_found", str(err))
        return
    except OSError as err:
        connection.send_error(msg["id"], "delete_failed", str(err))
        return
    connection.send_result(msg["id"], {"deleted": key})
