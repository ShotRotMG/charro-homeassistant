"""Taking a person's access away without logging them out.

Two ways, set per person from Charro Config's People tab:

  paused  - their dashboards show an "Access paused" screen
  hidden  - their dashboards show nothing at all

Either way they also lose control, and that part is enforced by Home
Assistant rather than by the dashboard: the person is moved into its
built-in read-only group, so a service call that would change an entity
is refused whether it comes from a card, an entity pop-up, Settings, the
companion app or a voice assistant. Changing a user's groups doesn't touch
their sessions, so nobody is signed out, and their own groups are kept
here so turning the pause off puts them back exactly as they were.

Admins and the owner can't be paused: an admin who pauses another admin,
or themselves, could lock the house out of its own configuration.
"""
from __future__ import annotations

import logging
from typing import Any, Callable

_LOGGER = logging.getLogger(__name__)

MODES = ("paused", "hidden")
GROUP_READ_ONLY = "system-read-only"
GROUP_USER = "system-users"


class AccessError(Exception):
    """A pause that can't be made, with a short reason code."""


class CharroAccess:
    """Who is paused, and the groups to give back when they aren't."""

    def __init__(self, hass, store) -> None:
        self.hass = hass
        self._store = store
        self._data: dict[str, Any] = {"users": {}}
        self._listeners: set[Callable[[str, str], None]] = set()

    async def async_load(self) -> None:
        data = await self._store.async_load()
        if isinstance(data, dict) and isinstance(data.get("users"), dict):
            self._data = data
        await self.async_reconcile()

    async def async_reconcile(self) -> None:
        """Drop pauses Home Assistant no longer agrees with.

        If someone deleted the person, or put them back in a group by hand
        in Settings > People, that wins: the pause is forgotten rather than
        forced back on them at the next restart.
        """
        users = self._data["users"]
        gone = []
        for uid in list(users):
            user = await self.hass.auth.async_get_user(uid)
            if user is None or [g.id for g in user.groups] != [GROUP_READ_ONLY]:
                gone.append(uid)
        for uid in gone:
            users.pop(uid, None)
        if gone:
            await self._store.async_save(self._data)

    def mode(self, user_id: str) -> str:
        return (self._data["users"].get(user_id) or {}).get("mode", "")

    def modes(self) -> dict[str, str]:
        return {uid: e.get("mode", "") for uid, e in self._data["users"].items()}

    def listen(self, cb: Callable[[str, str], None]) -> Callable[[], None]:
        self._listeners.add(cb)
        return lambda: self._listeners.discard(cb)

    async def async_set(self, user_id: str, mode: str) -> None:
        if mode and mode not in MODES:
            raise AccessError("bad_mode")
        user = await self.hass.auth.async_get_user(user_id)
        if user is None:
            raise AccessError("no_user")
        users = self._data["users"]
        cur = users.get(user_id)
        if mode:
            if user.is_owner or user.is_admin or user.system_generated:
                raise AccessError("admin")
            if cur is None:
                users[user_id] = {"mode": mode, "groups": [g.id for g in user.groups],
                                  "name": user.name}
                await self.hass.auth.async_update_user(user, group_ids=[GROUP_READ_ONLY])
            else:
                cur["mode"] = mode
        else:
            if cur is None:
                return
            before = cur.get("groups") or [GROUP_USER]
            await self.hass.auth.async_update_user(user, group_ids=before)
            users.pop(user_id, None)
        await self._store.async_save(self._data)
        _LOGGER.info("charro: %s is now %s", user.name, mode or "back to normal")
        for cb in list(self._listeners):
            try:
                cb(user_id, mode)
            except Exception:  # noqa: BLE001 - one broken listener mustn't stop the rest
                _LOGGER.exception("charro: access listener failed")
