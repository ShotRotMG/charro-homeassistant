"""Charro Cards.

Two jobs, both of which used to need hand-editing:

  1. Serve `charro-cards.js` and register it with the frontend, so the cards
     exist without a Lovelace resource entry.
  2. Put the Charro Config panel on the sidebar (admin only) and give it a websocket
     command that writes room files, replacing the `shell_command` that
     otherwise had to go in configuration.yaml.

Room files stay where they were: /config/www/rooms/*.json, served at
/local/rooms/. The cards fetch them over plain HTTP, so nothing about how a
dashboard loads a room changes when this integration is installed.
"""

from __future__ import annotations

import asyncio
import functools
import json
import logging
import os
import re
import shutil
import time
from datetime import timedelta
from typing import Any

import voluptuous as vol

from homeassistant.components import frontend, panel_custom, websocket_api
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EVENT_HOMEASSISTANT_STARTED, EVENT_HOMEASSISTANT_STOP
from homeassistant.core import CoreState, HomeAssistant, callback
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import event
from homeassistant.helpers.typing import ConfigType
import homeassistant.helpers.config_validation as cv
from homeassistant.loader import async_get_integration
import homeassistant.util.dt as dt_util

from .const import (
    BUNDLE,
    DOMAIN,
    LEGACY_PANEL_URLS,
    JOURNAL_FILE,
    JOURNAL_KEEP_DAYS,
    JOURNAL_MAX,
    LEGACY_SUBDIR,
    NOTIFY_FIELDS,
    CHIPS_FILE,
    NOTIFY_FILE,
    NOTIFY_LEVELS,
    NOTIFY_MESSAGE,
    NOTIFY_PUSH_LEVEL,
    NOTIFY_RESUME_SECONDS,
    NOTIFY_RETRIES,
    NOTIFY_TITLE,
    NOTIFY_TRIM,
    PANEL_ELEMENT,
    PANEL_ICON,
    PANEL_TITLE,
    PANEL_URL,
    REMOTES_FILE,
    ROOMS_DIR,
    SERVICE_NOTIFY,
    SERVICE_VOLUME_STEP,
    SNAP_DAY,
    SNAP_DIR,
    SNAP_FINE_EVERY,
    SNAP_HOUR,
    SNAP_KEEP_DAYS,
    SNAP_MAX,
    SNAP_MID_EVERY,
    STATIC_URL,
    WATCH_CLASSES,
    WATCH_DEFAULTS,
    WATCH_NOISE,
    WATCH_OPEN,
    WATCH_PRESS,
    WATCH_SHUT,
    WATCH_SHUT_VERBS,
    WATCH_ZONE_ATTRS,
    WATCH_ZONE_MOTION,
    WATCH_ZONE_PREFIX,
)

_LOGGER = logging.getLogger(__name__)

VOLUME_STEP_SCHEMA = vol.Schema(
    {
        vol.Required("entity_id"): cv.entity_ids,
        vol.Optional("steps", default=1): vol.Coerce(float),
    }
)

NOTIFY_SCHEMA = vol.Schema(
    {
        vol.Required("category"): cv.string,
        vol.Required("title"): cv.string,
        vol.Required("message"): cv.string,
        vol.Optional("entity_id"): cv.string,
        vol.Optional("camera"): cv.string,
        vol.Optional("url"): cv.string,
        vol.Optional("people"): vol.All(cv.ensure_list, [cv.string]),
        vol.Optional("level"): vol.In(NOTIFY_LEVELS),
        vol.Optional("shut"): cv.boolean,
        vol.Optional("who"): cv.string,
        vol.Optional("actions"): vol.All(cv.ensure_list, [dict]),
    }
)

# Where a level can live, and what writes one back. A media_player is not
# here on purpose: it steps itself, and the cards leave those alone.
_LEVEL_DOMAINS = {"number", "input_number"}


def _as_float(value: Any, fallback: float | None) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return fallback


async def _async_volume_step(hass: HomeAssistant, call) -> None:
    """Move a number-backed volume by whole steps of its own step size.

    The RTI amplifier publishes a zone's level as a `number`, which has no
    volume_up of its own, and a remote button cannot do the arithmetic
    because it cannot read the current value. So it asks for a direction and
    this reads the level, honours the entity's own min, max and step, and
    writes the result back.
    """
    steps = float(call.data["steps"])
    for entity_id in call.data["entity_id"]:
        domain = entity_id.split(".")[0]
        state = hass.states.get(entity_id)
        if domain not in _LEVEL_DOMAINS or state is None:
            _LOGGER.warning("volume_step: %s has no level to set", entity_id)
            continue
        current = _as_float(state.state, None)
        if current is None:
            _LOGGER.warning("volume_step: %s reads %r, which is not a number",
                            entity_id, state.state)
            continue
        size = _as_float(state.attributes.get("step"), 1.0) or 1.0
        low = _as_float(state.attributes.get("min"), None)
        high = _as_float(state.attributes.get("max"), None)
        # round off the float dust a step of 0.5 leaves behind
        value = round(current + steps * size, 3)
        if low is not None:
            value = max(low, value)
        if high is not None:
            value = min(high, value)
        if value == current:
            continue
        await hass.services.async_call(
            domain, "set_value", {"entity_id": entity_id, "value": value},
            blocking=False,
        )


# ------------------------------------------------------------- notify --

# Where each level sits relative to the others, for the quiet-hours cap.
_NOTIFY_ORDER = {name: i for i, name in enumerate(NOTIFY_LEVELS)}


def _in_window(now: str, start: str | None, end: str | None) -> bool:
    """Is HH:MM `now` inside the HH:MM window, which may wrap midnight?"""
    if not start or not end or start == end:
        return False
    if start < end:
        return start <= now < end
    return now >= start or now < end          # 22:30 -> 07:00


def _notify_payload(cat: dict, call_data: dict, tag: str,
                    color: str = "", icon: str = "") -> dict:
    """The part of the iOS payload that is the same for everybody.

    iOS has no notification channels, so everything that tells one of these
    apart at a glance has to be in the payload: `notification_icon` with
    `color` draws the category's glyph on a coloured disc, `subtitle`
    names the category under the title, `group` threads them together and
    `tag` means the next event for the same door replaces the last one
    rather than making a pile. The title is the sender name on a
    communication notification, so it is the thing, not the house.
    """
    data: dict[str, Any] = {"tag": tag, "group": cat.get("group") or cat.get("key")}
    # Both of these depend on which way the thing went, and only the
    # caller knows that, so they arrive already settled.
    glyph = icon or cat.get("icon")
    if glyph:
        data["notification_icon"] = glyph
    shade = color or cat.get("color")
    if shade:
        data["color"] = shade
    # iOS drops the subtitle on a communication notification - which is
    # what notification_icon makes this - so the category name only earns
    # its place when there is no glyph to carry it.
    if cat.get("name") and not glyph:
        data["subtitle"] = cat["name"]
    url = call_data.get("url") or cat.get("url")
    if url:
        data["url"] = url
    # On iOS a camera entity id IS the attachment - the phone lazy-loads a
    # frame. Worth more than the text it sits above.
    camera = call_data.get("camera") or cat.get("camera")
    if camera:
        data["entity_id"] = camera
    actions = call_data.get("actions")
    if actions:
        data["actions"] = actions
    return data


async def _async_notify(hass: HomeAssistant, call) -> None:
    """The service is now a thin door onto the notifier."""
    notifier = hass.data.get(DOMAIN, {}).get("notifier")
    if notifier is None:
        _LOGGER.error("charro.notify: the integration is not loaded")
        return
    await notifier.async_send(dict(call.data))



# ---------------------------------------------------------- templates --

_FIELD_RE = re.compile(r"\{([a-z_]+)\}")


def compile_template(text: str) -> tuple[tuple, bool]:
    """Turn "{status} \u00b7 {room}" into parts, once.

    Firing a notification should be a join over a short list, not a regex
    pass per phone per door. So the scanning happens here - when the
    config is saved - and what comes back is a tuple of (is_field, value)
    plus whether any field is in it at all, which is the flag that says
    whether the tidy-up below is ever needed.
    """
    parts: list[tuple[bool, str]] = []
    at = 0
    for m in _FIELD_RE.finditer(text or ""):
        if m.start() > at:
            parts.append((False, text[at:m.start()]))
        key = m.group(1)
        # an unknown {thing} is left as written rather than silently eaten,
        # so a typo looks like a typo
        parts.append((True, key) if key in NOTIFY_FIELDS else (False, m.group(0)))
        at = m.end()
    if at < len(text or ""):
        parts.append((False, text[at:]))
    return tuple(parts), any(p[0] for p in parts)


def render_template(parts: tuple, values: dict) -> str:
    """Join the parts. A field that comes back empty takes its separator."""
    out: list[str] = []
    for is_field, value in parts:
        if not is_field:
            out.append(value)
            continue
        got = str(values.get(value) or "")
        if got:
            out.append(got)
        elif out:
            # drop the separator this field was hanging off
            out[-1] = out[-1].rstrip(NOTIFY_TRIM)
    return "".join(out).strip(NOTIFY_TRIM)


# ------------------------------------------------------------ journal --


def _read_journal(path: str) -> list[dict]:
    try:
        with open(os.path.join(path, JOURNAL_FILE), encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return []
    return data if isinstance(data, list) else []


def _write_journal(path: str, entries: list[dict]) -> None:
    os.makedirs(path, exist_ok=True)
    target = os.path.join(path, JOURNAL_FILE)
    tmp = f"{target}.tmp.json"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(entries, fh, indent=1)
    os.replace(tmp, target)


def _trim_journal(entries: list[dict]) -> list[dict]:
    """Newest last, nothing older than a month, never more than the cap."""
    cutoff = dt_util.utcnow() - timedelta(days=JOURNAL_KEEP_DAYS)
    out = []
    for e in entries:
        when = dt_util.parse_datetime(e.get("ts") or "")
        if when is None or when >= cutoff:
            out.append(e)
    return out[-JOURNAL_MAX:]


class CharroNotifier:
    """Routing, delivery and the journal for every notification the house sends.

    The shape of this is set by one fact: push delivery cannot be made
    reliable. A phone that is off the network gets the single most recent
    notification APNs held for it and none of the ones before, and on top
    of that sit Low Power Mode, Focus deferral and a 500-a-day cap. So the
    record is kept here, every delivery attempt is recorded against it, and
    the feed card lets a phone catch up on whatever its push missed.

    The configuration lives in memory. It used to be read off the disk on
    every single call, which is not a thing to do on the path between a
    door opening and a phone ringing.
    """

    def __init__(self, hass: HomeAssistant, path: str) -> None:
        self.hass = hass
        self.path = path
        self.cfg: dict = {}
        self.entries: list[dict] = []
        self._flush_at = None
        self._seq = 0
        self.watching: dict = {}
        self._room_index: dict = {}
        self._unsub_watch = None
        self._last_fired: dict = {}
        self._tpl: dict = {}
        self._user_names: dict[str, str] = {}

    # ----------------------------------------------------------- state --

    async def async_load(self) -> None:
        self.cfg = await self.hass.async_add_executor_job(_read_notify, self.path)
        self._compile_templates()
        self.entries = _trim_journal(
            await self.hass.async_add_executor_job(_read_journal, self.path)
        )
        await self._async_resume()

    async def async_users(self) -> None:
        """Who the Home Assistant logins are, keyed by id.

        The hot path needs to turn the user id stamped on a state change
        into a name, and the hot path cannot await, so the list is cached
        here and refreshed with the rest of the rescan. A system login is
        kept with an empty name rather than left out, so that looking one
        up is a hit and does not look like a cache that needs refilling.

        Logins change about once a year. One added since the last rescan
        costs its first event the attribution and is right from then on.
        """
        try:
            users = await self.hass.auth.async_get_users()
        except Exception:                        # noqa: BLE001 - never fatal
            _LOGGER.debug("charro: could not read the login list", exc_info=True)
            return
        self._user_names = {
            u.id: ("" if u.system_generated else (u.name or "").strip())
            for u in users
        }

    def set_config(self, cfg: dict) -> None:
        """The tab just saved. Nothing reads the file again until a restart."""
        self.cfg = cfg if isinstance(cfg, dict) else {}
        self._compile_templates()

    def _compile_templates(self) -> None:
        """Every category's title and message, parsed once, here."""
        self._tpl = {}
        for cat in self.cfg.get("categories") or []:
            key = cat.get("key")
            if not key:
                continue
            self._tpl[key] = {
                "title": compile_template(cat.get("title") or NOTIFY_TITLE),
                "message": compile_template(cat.get("message") or NOTIFY_MESSAGE),
            }

    def category(self, key: str) -> dict | None:
        for c in self.cfg.get("categories") or []:
            if c.get("key") == key:
                return c
        return None

    # --------------------------------------------------------- journal --

    @callback
    def _schedule_flush(self) -> None:
        """Debounced, because a burst of doors is one write, not six.

        The entry is in memory the moment it exists, so nothing waits on a
        disk write to be delivered - blocking a 3am alarm on an fsync is
        the wrong trade. The window a crash could cost is the couple of
        seconds below, and a stop flushes it.
        """
        if self._flush_at is not None:
            return
        self._flush_at = event.async_call_later(self.hass, 2, self._flush_cb)

    @callback
    def _flush_cb(self, _now) -> None:
        self._flush_at = None
        self.hass.async_create_task(self.async_flush())

    async def async_flush(self, *_args) -> None:
        if self._flush_at is not None:
            self._flush_at()
            self._flush_at = None
        self.entries = _trim_journal(self.entries)
        snapshot = list(self.entries)
        try:
            await self.hass.async_add_executor_job(_write_journal, self.path, snapshot)
        except OSError as err:
            _LOGGER.error("charro: could not write the notification journal: %s", err)

    def _new_id(self) -> str:
        self._seq += 1
        return f"{int(dt_util.utcnow().timestamp())}-{self._seq:04d}"

    # ---------------------------------------------------------- sending --

    async def async_send(self, data: dict) -> str | None:
        """One event: journalled, then fanned out to everyone who wants it."""
        cfg = self.cfg
        key = data["category"]
        cat = self.category(key)
        if cat is None:
            _LOGGER.warning("charro.notify: no category %r in %s", key, NOTIFY_FILE)
            return None

        if cat.get("armed_only"):
            alarm = cfg.get("alarm_entity")
            if not alarm:
                _LOGGER.warning(
                    "charro.notify: category %r is set to \"only while armed\" and "
                    "no alarm entity is configured, so it can never send anything",
                    key,
                )
                return None
            state = self.hass.states.get(alarm)
            if state is None:
                _LOGGER.warning("charro.notify: %s is not an entity this instance has", alarm)
                return None
            if state.state in ("disarmed", "unknown", "unavailable"):
                _LOGGER.debug("charro.notify: %r held back, %s is %s", key, alarm, state.state)
                return None

        # One category, two colours: amber for the door that opened, something
        # calmer for the same door shutting again. Settled here rather than in
        # the card, so the journal carries the colour it was actually sent with
        # and the feed needs to know nothing about direction.
        shade = (cat.get("color_shut") if data.get("shut") else "") \
            or cat.get("color") or ""
        glyph = (cat.get("icon_shut") if data.get("shut") else "") \
            or cat.get("icon") or ""

        entry = {
            "id": self._new_id(),
            "ts": dt_util.utcnow().isoformat(),
            "category": key,
            "entity": data.get("entity_id") or "",
            "title": data["title"],
            "message": data["message"],
            "icon": glyph,
            "color": shade,
            "url": data.get("url") or cat.get("url") or "",
            # Kept as its own field as well as inside the message, so the
            # feed and anything later can show it without reading prose.
            "who": data.get("who") or "",
            "to": {},
            "read": [],
        }
        # Only when it is true, because it goes on every entry in a file
        # with two thousand of them and False is the common case.
        if data.get("shut"):
            entry["shut"] = True
        self.entries.append(entry)
        self._schedule_flush()

        targets = self._targets(key, data)
        if not targets:
            _LOGGER.info(
                "charro.notify: %r reached nobody. Check the grid in Charro Config > "
                "Notifications - a cell set to Off sends nothing. It is in the feed "
                "either way.",
                key,
            )
            return entry["id"]

        # Concurrently: the fourth phone should not wait behind the first.
        await asyncio.gather(*(
            self._async_deliver(entry, person, level, cat, data)
            for person, level in targets
        ))
        self._schedule_flush()
        return entry["id"]

    def _targets(self, key: str, data: dict) -> list[tuple[dict, str]]:
        forced = data.get("level")
        only = set(data.get("people") or [])
        now = dt_util.now().strftime("%H:%M")
        out = []
        for person in self.cfg.get("people") or []:
            who = person.get("name") or person.get("key") or "a phone row"
            if not (person.get("service") or "").strip():
                _LOGGER.warning("charro.notify: %s has no phone set, so it gets nothing", who)
                continue
            if only and person.get("key") not in only:
                continue
            level = forced or (person.get("levels") or {}).get(key, "off")
            if level != "critical" and _in_window(
                now, person.get("quiet_from"), person.get("quiet_to")
            ):
                cap = person.get("quiet_level") or "quiet"
                if _NOTIFY_ORDER.get(level, 0) > _NOTIFY_ORDER.get(cap, 1):
                    _LOGGER.debug("charro.notify: %s is in quiet hours, %r down to %r",
                                  who, level, cap)
                    level = cap
            if level not in NOTIFY_PUSH_LEVEL:
                _LOGGER.debug("charro.notify: %s has %r set to %r", who, key, level)
                continue
            out.append((person, level))
        return out

    async def _async_deliver(self, entry, person, level, cat, data, attempt=0) -> None:
        pk = person.get("key") or person.get("service") or "?"
        rec = entry["to"].setdefault(pk, {"name": person.get("name") or pk, "level": level})
        rec["level"] = level
        rec["tries"] = attempt + 1

        # The colour was settled when the event was journalled, and the
        # entry is the one thing a retry an hour later still has.
        # A tag is an identity on iOS: the next notification carrying it
        # replaces the last one rather than stacking under it. That is what
        # keeps a door that cannot make up its mind to one line - but the
        # direction has to be part of it, or a gate shutting overwrites the
        # news that it opened and the lock screen says only "Closed".
        if cat.get("replace") is False:
            tag = f"charro-{entry['id']}"
        else:
            tag = (f"charro-{entry['category']}-{entry['entity'] or 'all'}"
                   f"-{'shut' if entry.get('shut') else 'open'}")
        payload = _notify_payload(
            cat, data, tag,
            entry.get("color") or "", entry.get("icon") or "")
        payload["push"] = {"interruption-level": NOTIFY_PUSH_LEVEL[level]}
        if level == "critical":
            volume = person.get("critical_volume")
            payload["push"]["sound"] = {
                "name": "default", "critical": 1,
                "volume": float(volume) if volume is not None else 1.0,
            }
        service = (person.get("service") or "").split(".")[-1]
        try:
            # blocking, so a failure is something we know about rather than
            # something that vanishes - the whole point of recording state.
            await self.hass.services.async_call(
                "notify", service,
                {"title": entry["title"], "message": entry["message"], "data": payload},
                blocking=True,
            )
        except Exception as err:            # noqa: BLE001 - any transport failure
            rec["state"] = "failed"
            rec["error"] = str(err)[:200]
            if attempt < len(NOTIFY_RETRIES):
                rec["state"] = "retrying"
                delay = NOTIFY_RETRIES[attempt]
                _LOGGER.warning("charro.notify: %s failed for %s, retrying in %ss: %s",
                                entry["category"], pk, delay, err)
                self._later(delay, entry, person, level, cat, data, attempt + 1)
            else:
                _LOGGER.error("charro.notify: %s gave up for %s after %s tries: %s",
                              entry["category"], pk, rec["tries"], err)
            self._schedule_flush()
            return
        rec["state"] = "sent"
        rec["at"] = dt_util.utcnow().isoformat()
        rec.pop("error", None)
        self._schedule_flush()

    @callback
    def _later(self, delay, entry, person, level, cat, data, attempt) -> None:
        @callback
        def _go(_now):
            self.hass.async_create_task(
                self._async_deliver(entry, person, level, cat, data, attempt)
            )
        event.async_call_later(self.hass, delay, _go)

    async def _async_resume(self) -> None:
        """Anything still unsent when Home Assistant went down.

        Without this a restart mid-retry is a notification that silently
        never happens, which is exactly the failure the journal exists to
        make impossible.
        """
        cutoff = dt_util.utcnow() - timedelta(seconds=NOTIFY_RESUME_SECONDS)
        resumed = 0
        for entry in self.entries:
            when = dt_util.parse_datetime(entry.get("ts") or "")
            if when is None or when < cutoff:
                continue
            cat = self.category(entry.get("category"))
            if cat is None:
                continue
            for pk, rec in (entry.get("to") or {}).items():
                if rec.get("state") == "sent":
                    continue
                person = next((p for p in self.cfg.get("people") or []
                               if p.get("key") == pk), None)
                if not person:
                    continue
                resumed += 1
                self._later(2, entry, person, rec.get("level") or "normal", cat,
                            {"category": entry.get("category")}, 0)
        if resumed:
            _LOGGER.info("charro: resuming %s notification(s) that were in flight "
                         "when Home Assistant stopped", resumed)


    # ---------------------------------------------------------- watcher --

    def watch_cfg(self, key: str) -> dict:
        got = ((self.cfg.get("watch") or {}).get(key)) or {}
        base = dict(WATCH_DEFAULTS.get(key) or {})
        base.update(got)
        return base

    @staticmethod
    def classify(entity_id: str, state) -> str | None:
        """Which category an entity belongs to, by what it says it is.

        Device class, never the name: "Front Door Light" is not a door and
        a sensor called "sensor_12" might be. An entity whose domain is
        here but whose device class is not stays out, which keeps every
        battery and signal-strength sensor off the list.
        """
        domain = entity_id.split(".")[0]
        attrs = state.attributes if state else {}

        # An Elk zone: a `sensor` with no device class that reads Normal or
        # Violated. Twenty-seven of this house's doors are these, so a
        # device-class sweep alone finds none of them.
        if all(k in attrs for k in WATCH_ZONE_ATTRS):
            definition = str(attrs.get("definition") or "")
            if not definition.startswith(WATCH_ZONE_PREFIX):
                # fire, heat and water zones are a different kind of news
                # and have no category here yet
                return None
            return "motion" if definition.startswith(WATCH_ZONE_MOTION) else "doors"

        table = WATCH_CLASSES.get(domain)
        if not table:
            return None
        if None in table:
            return table[None]
        dc = attrs.get("device_class") or ""
        return table.get(dc)

    def candidates(self) -> dict[str, str]:
        """Everything that could be watched, as entity -> category.

        One pass over the state machine, and only when something asks:
        at a rescan, or when the tab draws the checklist. Never on the
        path between a door opening and a phone ringing.
        """
        out = {}
        for state in self.hass.states.async_all():
            cat = self.classify(state.entity_id, state)
            if cat:
                out[state.entity_id] = cat
        return out

    def _rooms_index(self, rooms: dict) -> dict[str, dict]:
        """Entity -> which room mentions it, for the label only.

        Membership is the checklist's business, not a room's. This is here
        so a notification can still say "Opened - Frontyard" when the room
        files happen to know, and say nothing extra when they don't.
        """
        index: dict[str, dict] = {}
        for key, r in (rooms or {}).items():
            if not isinstance(r, dict):
                continue
            base = {"name": r.get("room_name") or key, "url": r.get("page_path") or ""}
            for field, cat in (("alert_sensors", "doors"), ("locks", "locks")):
                for raw in r.get(field) or []:
                    eid = raw if isinstance(raw, str) else (raw or {}).get("entity")
                    if eid:
                        index.setdefault(eid, {**base, "cat": cat})
            for raw in r.get("gates") or []:
                g = raw if isinstance(raw, dict) else {}
                eid = g.get("state") or g.get("entity")
                if eid:
                    index.setdefault(eid, {**base, "cat": "gates"})
        return index

    def all_candidates(self) -> dict[str, str]:
        """Discovery, plus anything a room already calls a door or a lock.

        A room naming an entity under alert_sensors is you saying it is a
        door, which beats anything the entity says about itself. It also
        catches whatever the sweep gets wrong next time.
        """
        out = self.candidates()
        for eid, where in (self._room_index or {}).items():
            cat = where.get("cat")
            if cat and eid not in out and self.hass.states.get(eid) is not None:
                out[eid] = cat
        # Anything you added by hand, which is the only way a gate gets in.
        for eid, cat in ((self.cfg.get("watch") or {}).get("extra") or {}).items():
            if cat and self.hass.states.get(eid) is not None:
                out[eid] = cat
        return out

    async def async_rescan(self) -> None:
        """Resolve the checklist into a flat entity -> what-it-is map.

        Everything the hot path needs is decided here, once: which
        entities are watched, what category each is, and what room name to
        put in the message. The state callback then does a dict lookup and
        nothing else - no registry walk, no room file, no classification,
        no string matching per event.
        """
        await self.async_users()
        watch_cfg = self.cfg.get("watch") or {}
        off = set(watch_cfg.get("off") or [])
        override = watch_cfg.get("cat") or {}
        data = await self.hass.async_add_executor_job(_read_all, self.path)
        self._room_index = self._rooms_index(data.get("rooms") or {})
        index = self._room_index

        watching: dict[str, dict] = {}
        for eid, cat in self.all_candidates().items():
            if eid in off:
                continue
            watching[eid] = {
                "category": override.get(eid) or cat,
                "room": index.get(eid) or {},
            }

        self.watching = watching
        if self._unsub_watch:
            self._unsub_watch()
            self._unsub_watch = None
        ids = sorted(watching)
        if ids:
            # One subscription for the lot. Home Assistant dispatches a
            # state change through a dict keyed on entity id, so watching
            # four hundred entities costs the same per event as watching
            # four: anything not in it never reaches this integration.
            self._unsub_watch = event.async_track_state_change_event(
                self.hass, ids, self._on_state
            )
        _LOGGER.debug("charro: watching %s of %s candidate entities",
                      len(ids), len(ids) + len(off))

    @callback
    def _on_state(self, ev) -> None:
        old = ev.data.get("old_state")
        new = ev.data.get("new_state")
        if new is None or old is None:
            return
        was = (old.state or "").lower()
        now = (new.state or "").lower()
        if now == was:
            return

        eid = ev.data["entity_id"]
        spec = (self.watching or {}).get(eid)
        if not spec:
            return
        cat = spec["category"]
        rules = self.watch_cfg(cat)
        if not rules.get("on"):
            return

        if eid.split(".")[0] in WATCH_PRESS:
            # A press has no second half. A script reports `on` while it
            # runs and `off` when it finishes, and the finish is not news;
            # a button reports the time it was last pushed, so any move is
            # a push.
            if eid.startswith("script.") and now != "on":
                return
            if was in WATCH_NOISE:
                return                       # the first reading after a restart
            verb = "Unlocked" if cat == "locks" else "Opened"
        else:
            # Neither end of a transition may be "I don't know". A ratgdo
            # that drops offline and comes back is not a door that opened.
            if was in WATCH_NOISE or now in WATCH_NOISE:
                return
            verb = self._verb(cat, now, was, rules.get("closed") is True)
        if not verb:
            return

        # One door that can't make up its mind shouldn't ring four phones
        # four times - but the cooldown is per direction, not per entity.
        #
        # Keyed on the entity alone it swallowed the opposite event: unlock
        # a door and lock it ten seconds later and you were told it was
        # open and never told it was shut again, which is worse than
        # telling you nothing. A repeat is noise; a reversal is the news.
        gap = float(rules.get("cooldown") or 0)
        way = "shut" if verb in WATCH_SHUT_VERBS else "open"
        slot = (eid, way)
        last = self._last_fired.get(slot)
        stamp = time.monotonic()
        if gap and last is not None and stamp - last < gap:
            _LOGGER.debug("charro: %s %s within its %ss cooldown, skipped",
                          eid, verb, gap)
            return
        self._last_fired[slot] = stamp

        # Who did it, where Home Assistant actually knows. A tap in the app
        # or on a dashboard stamps the signed-in user on the context, and it
        # survives into the state being read here - measured on six days of
        # gate presses, which came back as two different people. A car remote
        # at the gate, a wall button in the garage or a key in a door stamps
        # nobody, and an empty answer is the honest one; guessing from who
        # happens to be home would be worse than saying nothing.
        uid = getattr(new.context, "user_id", None) or ""
        who = self._user_names.get(uid, "")
        if uid and uid not in self._user_names:
            self.hass.async_create_task(self.async_users())   # a new login

        room = spec.get("room") or {}
        values = {
            "name": (new.attributes.get("friendly_name") or eid).strip(),
            "room": room.get("name") or "",
            "status": verb,
            # The same word in the middle of a sentence. "West Gate opened
            # by Javon." rather than "West Gate Opened by Javon."
            "action": verb.lower(),
            "state": new.state,
            "was": old.state,
            "category": (self.category(cat) or {}).get("name") or cat,
            "entity": eid,
            "time": dt_util.now().strftime("%H:%M"),
            "who": who,
            # The preposition travels with the word so that it leaves with
            # it: "Opened - by Jordan" when there is a name, "Opened" when
            # there is not, rather than a stranded "by". A literal "by" or
            # "in" typed into the template is text, and the trimmer leaves
            # text alone, which is how "Closed in" with nothing after it
            # reached a phone.
            "by": f"by {who}" if who else "",
            "in": f"in {room.get('name')}" if room.get("name") else "",
        }
        # Already parsed, back when the config was saved. This is a join
        # over a short list and nothing else.
        forms = self._tpl.get(cat) or {}
        title_parts = (forms.get("title") or compile_template(NOTIFY_TITLE))[0]
        msg_parts = (forms.get("message") or compile_template(NOTIFY_MESSAGE))[0]
        title = render_template(title_parts, values) or values["name"]
        message = render_template(msg_parts, values) or verb
        payload = {"category": cat, "title": title, "message": message,
                   "entity_id": eid}
        if way == "shut":
            payload["shut"] = True
        if who:
            payload["who"] = who
        if room.get("url"):
            payload["url"] = room["url"]
        self.hass.async_create_task(self.async_send(payload))

    @staticmethod
    def _verb(category: str, now: str, was: str, closed_too: bool = False) -> str | None:
        """What to call what just happened, or None if it isn't news.

        Closing is off by default and deliberately so: it is the other
        half of every pair, which doubles the count for no information and
        is what eats a 500-a-day allowance. Switch it on per category when
        you would rather have both halves.
        """
        if category == "locks":
            if now in ("unlocked", "open"):
                return "Unlocked"
            if now == "jammed":
                return "Jammed"
            if closed_too and now == "locked":
                return "Locked"
            return None
        if category == "motion":
            # A detector does not open, and "Opened" is what this said
            # before there was a branch for it. Clear is the other half,
            # and counts as the shut direction for the cooldown and the
            # closed colour, same as Closed and Locked.
            if now in WATCH_OPEN:
                return "Motion"
            return "Clear" if closed_too and now in WATCH_SHUT else None
        if now in WATCH_OPEN:
            return "Opening" if now == "opening" else "Opened"
        if closed_too and now in WATCH_SHUT:
            return "Closed"
        return None

    # ------------------------------------------------------------ read --

    def person_for_user(self, user) -> str | None:
        """Which phone row the signed-in user is, if any."""
        name = (getattr(user, "name", "") or "").strip().lower()
        for p in self.cfg.get("people") or []:
            tag = (p.get("ha_user") or "").strip().lower()
            if tag and tag == name:
                return p.get("key")
        for p in self.cfg.get("people") or []:
            if name and (p.get("name") or "").strip().lower() == name:
                return p.get("key")
        return None

    def mark_read(self, person: str, ids=None) -> int:
        n = 0
        for entry in self.entries:
            if ids is not None and entry.get("id") not in ids:
                continue
            seen = entry.setdefault("read", [])
            if person not in seen:
                seen.append(person)
                n += 1
        if n:
            self._schedule_flush()
        return n


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

    # The URLs this used to be two separate panels at. Registered with no
    # sidebar title, so they stay off the sidebar but still resolve: the
    # panel reads the path it was reached by and opens the matching tab.
    # One sidebar entry, and nothing anybody bookmarked breaks.
    for legacy in LEGACY_PANEL_URLS:
        await panel_custom.async_register_panel(
            hass,
            webcomponent_name=PANEL_ELEMENT,
            frontend_url_path=legacy,
            module_url=url,
            embed_iframe=False,
            require_admin=True,
        )

    hass.services.async_register(
        DOMAIN,
        SERVICE_VOLUME_STEP,
        functools.partial(_async_volume_step, hass),
        schema=VOLUME_STEP_SCHEMA,
    )

    hass.services.async_register(
        DOMAIN,
        SERVICE_NOTIFY,
        functools.partial(_async_notify, hass),
        schema=NOTIFY_SCHEMA,
    )

    # The routing table and the journal, both in memory from here on. A
    # door opening no longer reads a file to find out who wants telling.
    notifier = CharroNotifier(hass, _rooms_dir(hass))
    await notifier.async_load()
    await notifier.async_rescan()
    store["notifier"] = notifier
    store["notifier_stop"] = hass.bus.async_listen_once(
        EVENT_HOMEASSISTANT_STOP, notifier.async_flush
    )

    # And again once everything else has finished starting.
    #
    # The scan above runs during setup, which is a race this integration
    # loses: the Elk zones are twenty-seven `sensor` entities that do not
    # exist yet while elkm1 is still connecting, so the first scan sees
    # six garage covers and the locks and subscribes to those alone.
    # Nothing complains - the checklist looks right, because the panel
    # rebuilds it live - but no door would ever have fired until the next
    # time anything saved. Which is the worst shape a bug can have.
    async def _rescan_when_up(_event) -> None:
        await notifier.async_rescan()

    if hass.state is CoreState.running:
        await notifier.async_rescan()
    else:
        store["notifier_started"] = hass.bus.async_listen_once(
            EVENT_HOMEASSISTANT_STARTED, _rescan_when_up
        )

    websocket_api.async_register_command(hass, ws_get_rooms)
    websocket_api.async_register_command(hass, ws_list_rooms)
    websocket_api.async_register_command(hass, ws_save_room)
    websocket_api.async_register_command(hass, ws_save_remotes)
    websocket_api.async_register_command(hass, ws_save_notify)
    websocket_api.async_register_command(hass, ws_save_chips)
    websocket_api.async_register_command(hass, ws_watching)
    websocket_api.async_register_command(hass, ws_journal)
    websocket_api.async_register_command(hass, ws_journal_read)
    websocket_api.async_register_command(hass, ws_delete_room)
    websocket_api.async_register_command(hass, ws_list_snapshots)
    websocket_api.async_register_command(hass, ws_get_snapshot)

    # the version a browser should be running; get_rooms hands it over so a
    # page serving a cached older bundle can notice and say so
    store["version"] = str(integration.version)
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
    for legacy in LEGACY_PANEL_URLS:
        frontend.async_remove_panel(hass, legacy)
    hass.services.async_remove(DOMAIN, SERVICE_VOLUME_STEP)
    hass.services.async_remove(DOMAIN, SERVICE_NOTIFY)
    for key in ("notifier_stop", "notifier_started"):
        unsub = store.pop(key, None)
        if unsub:
            unsub()
    notifier = store.pop("notifier", None)
    if notifier is not None:
        if notifier._unsub_watch:
            notifier._unsub_watch()
            notifier._unsub_watch = None
        # whatever is in memory and not yet on disk, before the door shuts
        await notifier.async_flush()
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


def _snap_dir(path: str, key: str) -> str:
    return os.path.join(path, SNAP_DIR, key)


def _snapshot(path: str, key: str) -> None:
    """Keep the version we are about to overwrite, then thin the history."""
    target = os.path.join(path, f"{key}.json")
    if not os.path.isfile(target):
        return                                   # nothing to preserve yet
    into = _snap_dir(path, key)
    os.makedirs(into, exist_ok=True)
    stamp = int(time.time())
    dest = os.path.join(into, f"{stamp}.json")
    if os.path.exists(dest):
        return               # already snapshotted this second; one is enough
    shutil.copy2(target, dest)
    _prune_snaps(into, stamp)


def _bucket(ts: int, now: int) -> tuple[str, int] | None:
    """Which slot a snapshot competes for. None means it has aged out."""
    age = now - ts
    if age < SNAP_HOUR:
        return ("f", ts // SNAP_FINE_EVERY)
    if age < SNAP_DAY:
        return ("h", ts // SNAP_MID_EVERY)
    if age < SNAP_KEEP_DAYS * SNAP_DAY:
        return ("d", ts // SNAP_DAY)
    return None


def _prune_snaps(into: str, now: int) -> None:
    """One snapshot per slot - the OLDEST, which is the important one.

    Within a slot the oldest copy is the state furthest from whatever just
    went wrong. Keeping the newest instead would mean a bad edit, autosaved
    twice inside five minutes, quietly overwrites the good version with the
    broken one. The most recent snapshot overall is always kept as well, so
    undoing the last save never depends on bucket boundaries.
    """
    stamps = sorted(_snap_stamps(into))
    if not stamps:
        return
    keep = {stamps[-1]}
    seen: dict[tuple[str, int], int] = {}
    for ts in stamps:                                   # ascending: oldest wins
        slot = _bucket(ts, now)
        if slot is None:
            continue
        if slot not in seen:
            seen[slot] = ts
            keep.add(ts)
    # whatever the arithmetic produced, never leave more than the cap; the
    # newest are the ones worth keeping when something has to go
    if len(keep) > SNAP_MAX:
        keep = set(sorted(keep, reverse=True)[:SNAP_MAX])

    for ts in stamps:
        if ts not in keep:
            try:
                os.remove(os.path.join(into, f"{ts}.json"))
            except OSError:
                pass


def _snap_stamps(into: str) -> list[int]:
    if not os.path.isdir(into):
        return []
    out = []
    for name in os.listdir(into):
        if name.endswith(".json"):
            try:
                out.append(int(name[:-5]))
            except ValueError:
                continue
    return out


def _list_snaps(path: str, key: str) -> list[dict[str, Any]]:
    into = _snap_dir(path, key)
    rows = []
    for ts in sorted(_snap_stamps(into), reverse=True):
        try:
            rows.append({"ts": ts, "bytes": os.path.getsize(os.path.join(into, f"{ts}.json"))})
        except OSError:
            continue
    return rows


def _read_snap(path: str, key: str, ts: int) -> dict[str, Any]:
    f = os.path.join(_snap_dir(path, key), f"{ts}.json")
    if not os.path.isfile(f):
        raise HomeAssistantError(f"no snapshot {ts} for {key}")
    with open(f, encoding="utf-8") as fh:
        return json.load(fh)


def _write_room(path: str, key: str, config: dict[str, Any]) -> None:
    """Snapshot what is there, then write the new version over it."""
    os.makedirs(path, exist_ok=True)
    _snapshot(path, key)
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
    notify: dict[str, Any] = {}
    chips: dict[str, Any] = {}
    bad: list[str] = []
    if not os.path.isdir(path):
        return {"rooms": rooms, "remotes": remotes, "notify": notify,
                "chips": chips, "bad": bad}
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
        elif name == NOTIFY_FILE:
            notify = data if isinstance(data, dict) else {}
        elif name == CHIPS_FILE:
            chips = data if isinstance(data, dict) else {}
        elif not name.startswith("_") and isinstance(data, dict):
            key = name[:-5]
            # tolerate a file that wraps the room in its own key
            if "room_name" not in data and isinstance(data.get(key), dict):
                data = data[key]
            rooms[key] = data
    return {"rooms": rooms, "remotes": remotes, "notify": notify,
            "chips": chips, "bad": bad}


def _read_notify(path: str) -> dict:
    """Just the notification matrix, for the service call.

    Its own read rather than _read_all: a door opening should not pull
    twenty-one room files off the disk to find out who wants telling.
    """
    try:
        with open(os.path.join(path, NOTIFY_FILE), encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


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
    data["version"] = hass.data.get(DOMAIN, {}).get("version")
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
    notifier = hass.data.get(DOMAIN, {}).get("notifier")
    if notifier is not None:
        # a sensor added to a room in the editor is watched from the save,
        # not from the next restart
        hass.async_create_task(notifier.async_rescan())
    connection.send_result(msg["id"], {"path": os.path.join(path, f"{key}.json")})


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        vol.Required("type"): "charro/save_remotes",
        vol.Required("config"): dict,
    }
)
@websocket_api.async_response
async def ws_save_remotes(hass, connection, msg):
    """Write the shared remote templates. Admin only.

    save_room refuses a key that starts with an underscore, which is what
    stops a room called "_remotes" from quietly becoming the template
    library. The library still has to be editable from the panel, so it
    gets a command of its own rather than a hole in that rule. The write
    goes through the same helper as a room, so it is snapshotted first and
    replaced atomically.
    """
    path = _rooms_dir(hass)
    key = REMOTES_FILE[:-5] if REMOTES_FILE.endswith(".json") else REMOTES_FILE
    try:
        await hass.async_add_executor_job(_write_room, path, key, msg["config"])
    except OSError as err:
        connection.send_error(msg["id"], "write_failed", str(err))
        return
    connection.send_result(msg["id"], {"path": os.path.join(path, REMOTES_FILE)})


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        vol.Required("type"): "charro/save_chips",
        vol.Required("config"): dict,
    }
)
@websocket_api.async_response
async def ws_save_chips(hass, connection, msg):
    """Write the house-wide chip look. Admin only.

    Same shape as the remote library and for the same reason: save_room
    refuses a key starting with an underscore, which is what stops a room
    called "_chips" from quietly becoming the palette. It goes through the
    same writer, so it is snapshotted first and replaced atomically.
    """
    path = _rooms_dir(hass)
    key = CHIPS_FILE[:-5] if CHIPS_FILE.endswith(".json") else CHIPS_FILE
    try:
        await hass.async_add_executor_job(_write_room, path, key, msg["config"])
    except OSError as err:
        connection.send_error(msg["id"], "write_failed", str(err))
        return
    connection.send_result(msg["id"], {"path": os.path.join(path, CHIPS_FILE)})


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        vol.Required("type"): "charro/save_notify",
        vol.Required("config"): dict,
    }
)
@websocket_api.async_response
async def ws_save_notify(hass, connection, msg):
    """Write the notification matrix. Admin only.

    Same reason save_remotes exists: save_room refuses an underscore, and
    this file has to start with one so it is never mistaken for a room.
    It goes through the same writer, so it is snapshotted first and
    replaced atomically.
    """
    path = _rooms_dir(hass)
    key = NOTIFY_FILE[:-5] if NOTIFY_FILE.endswith(".json") else NOTIFY_FILE
    try:
        await hass.async_add_executor_job(_write_room, path, key, msg["config"])
    except OSError as err:
        connection.send_error(msg["id"], "write_failed", str(err))
        return
    notifier = hass.data.get(DOMAIN, {}).get("notifier")
    if notifier is not None:
        notifier.set_config(msg["config"])
        # the checklist lives in this file, so a save is what re-subscribes
        hass.async_create_task(notifier.async_rescan())
    connection.send_result(msg["id"], {"path": os.path.join(path, NOTIFY_FILE)})


@websocket_api.websocket_command({vol.Required("type"): "charro/watching"})
@callback
def ws_watching(hass, connection, msg):
    """The checklist: every candidate in the house, ticked or not.

    Built on demand rather than kept - the tab asks for it when you open
    it, and nothing walks the state machine at any other time.
    """
    notifier = hass.data.get(DOMAIN, {}).get("notifier")
    if notifier is None:
        connection.send_result(msg["id"], {"items": [], "rules": {}})
        return
    watch_cfg = notifier.cfg.get("watch") or {}
    off = set(watch_cfg.get("off") or [])
    override = watch_cfg.get("cat") or {}
    extra = watch_cfg.get("extra") or {}
    live = notifier.watching or {}
    items = []
    for eid, cat in sorted(notifier.all_candidates().items()):
        state = hass.states.get(eid)
        items.append({
            "entity": eid,
            "name": (state.attributes.get("friendly_name") if state else "") or eid,
            "state": state.state if state else "missing",
            "category": override.get(eid) or cat,
            "guess": cat,
            "on": eid not in off,
            "room": ((live.get(eid) or {}).get("room") or {}).get("name") or "",
            # added by hand rather than found, so the panel can offer to
            # take it back out again
            "added": eid in extra,
            "press": eid.split(".")[0] in WATCH_PRESS,
        })
    connection.send_result(msg["id"], {
        "items": items,
        "rules": {k: notifier.watch_cfg(k) for k in WATCH_DEFAULTS},
    })


@websocket_api.websocket_command(
    {
        vol.Required("type"): "charro/journal",
        vol.Optional("limit", default=50): vol.All(int, vol.Range(min=1, max=500)),
    }
)
@callback
def ws_journal(hass, connection, msg):
    """The feed: what happened, and whether each phone actually got it.

    Not admin-only, deliberately. The whole point is that somebody whose
    push was dropped - which APNs does routinely to a phone that was off
    the network - can open the dashboard and see what they missed.
    """
    notifier = hass.data.get(DOMAIN, {}).get("notifier")
    if notifier is None:
        connection.send_result(msg["id"], {"entries": [], "you": None, "unread": 0})
        return
    you = notifier.person_for_user(connection.user)
    recent = notifier.entries[-msg["limit"]:]
    unread = 0
    if you:
        unread = sum(1 for e in notifier.entries if you not in (e.get("read") or []))
    connection.send_result(msg["id"], {
        "entries": list(reversed(recent)),        # newest first, as it reads
        "you": you,
        "unread": unread,
        "total": len(notifier.entries),
    })


@websocket_api.websocket_command(
    {
        vol.Required("type"): "charro/journal_read",
        vol.Optional("ids"): [cv.string],
        vol.Optional("person"): cv.string,
    }
)
@callback
def ws_journal_read(hass, connection, msg):
    """Mark entries read for whoever is signed in. No ids means all of them."""
    notifier = hass.data.get(DOMAIN, {}).get("notifier")
    if notifier is None:
        connection.send_result(msg["id"], {"marked": 0})
        return
    person = msg.get("person") or notifier.person_for_user(connection.user)
    if not person:
        connection.send_error(
            msg["id"], "no_person",
            "no phone row matches this Home Assistant user - set its \"HA user\" "
            "field in Charro Config > Notifications",
        )
        return
    marked = notifier.mark_read(person, msg.get("ids"))
    connection.send_result(msg["id"], {"marked": marked, "person": person})


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        vol.Required("type"): "charro/list_snapshots",
        vol.Required("key"): cv.string,
    }
)
@websocket_api.async_response
async def ws_list_snapshots(hass, connection, msg):
    """Earlier versions of one room, newest first."""
    key = msg["key"]
    if not KEY_RE.match(key):
        connection.send_error(msg["id"], "invalid_key", "bad room key")
        return
    path = _rooms_dir(hass)
    rows = await hass.async_add_executor_job(_list_snaps, path, key)
    connection.send_result(msg["id"], {"snapshots": rows})


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        vol.Required("type"): "charro/get_snapshot",
        vol.Required("key"): cv.string,
        vol.Required("ts"): int,
    }
)
@websocket_api.async_response
async def ws_get_snapshot(hass, connection, msg):
    """One earlier version, for the editor to load as unsaved changes."""
    key = msg["key"]
    if not KEY_RE.match(key):
        connection.send_error(msg["id"], "invalid_key", "bad room key")
        return
    path = _rooms_dir(hass)
    try:
        cfg = await hass.async_add_executor_job(_read_snap, path, key, int(msg["ts"]))
    except HomeAssistantError as err:
        connection.send_error(msg["id"], "not_found", str(err))
        return
    except (OSError, ValueError) as err:
        connection.send_error(msg["id"], "unreadable", str(err))
        return
    connection.send_result(msg["id"], {"config": cfg})


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
