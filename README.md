# Charro Home Assistant

Lovelace cards for the Charro dashboard. One HACS install gives you six cards,
each with a visual editor.

| Card | What it is |
|---|---|
| `charro-room-card` | A room — the chip tile, its pop-up, and its full page |
| `charro-security-card` | Elk zone or garage door tile, coloured client-side |
| `charro-zone-card` | RTI AD-8x single-line zone control |
| `charro-all-off-card` | Turn every RTI zone off on both amps |
| `charro-lights-card` | One room of lights — equal rows, dim by dragging |
| `charro-rooms-editor` | Edit the files behind `room:` without leaving Home Assistant |

The first four render `custom:button-card` underneath, with the styling in
`dist/templates/*.json`. Nothing goes in `button_card_templates:` any more.
`charro-lights-card` is standalone — no button-card, no template file.

## Requirements

- [button-card](https://github.com/custom-cards/button-card)
- [card-mod](https://github.com/thomasloven/lovelace-card-mod)

## Install

HACS → three-dot menu → **Custom repositories** → paste this repo's URL,
category **Dashboard** → Add. Then find "Charro Home Assistant" in HACS and
download it. HACS registers the Lovelace resource itself.

---

## `charro-room-card`

One card renders a room three ways, from one definition.

| `mode` | What you get |
|---|---|
| *(blank)* | The chip tile — **and it owns the room's pop-up** |
| `page` | The same room laid out as a full subview body |
| `popup` | The pop-up only, for a room with no tile on screen |

### Defining a room once

Set the entities on the card and it behaves as it always has. Point it at a
shared file instead and the tile, the pop-up and the page all read the same
definition, so they can't drift apart:

```yaml
type: custom:charro-room-card
room: master
```

```yaml
# the subview page
type: custom:charro-room-card
mode: page
room: master
```

`room: master` reads `/local/rooms/master.json` — on disk that is
`/config/www/rooms/master.json`. One file per room. Keep them there and **not**
in this repo: HACS replaces `dist/` on every update, and your rooms are your
data. `rooms_dir` moves the folder, `room_url` points at one exact file.

### Caching

Home Assistant serves `/local` with a 31-day `max-age`, so room files are
fetched with a revision on the URL — `master.json?v=1790664723` — and read
from cache between edits. `_index.json` is the one file fetched uncached; it
carries that revision alongside the room list:

```json
{ "rev": "1790664723", "rooms": ["master", "javon"] }
```

Saving through the editor bumps the revision, every room URL changes, and the
browser refetches on the next load. No hard refresh, no restart, and twenty
rooms cost one real request instead of twenty.

Editing a room file by hand doesn't bump anything, so either save once through
the editor afterwards or bump `rev` yourself — any different string will do.
A plain-array `_index.json` (no revision) still works: those rooms fall back
to always-fresh fetches, exactly as before.

> Home Assistant serves `/config/www` at `/local/` **without authentication**.
> A room file holds entity ids, names and layout — no tokens, and entity ids
> alone grant no control, since the APIs still require one. But if your
> instance is reachable from the internet, treat these files as public and
> never put a secret or a credentialled URL in one.

Each file is the room object on its own. Keys are the card's own option names,
so anything set on the card wins over the file:

```json
{
  "room_name": "Master",
  "room_icon": "mdi:chess-king",
  "climate_entity": "climate.master_bed",
  "music_powers": ["switch.rti_ad_8x_amp1_master_bath_power"],
  "alert_sensors": ["sensor.elkm1_master_bedroom"],
  "light_entities": [
    "light.master_cans",
    { "entity": "light.master_bath_shower_fans", "name": "Bathroom Fans", "dim": false }
  ],
  "fan_entities": ["light.master_fan"],
  "sections": ["media", "climate", "lights", "security"],
  "cards": { "start": [ { "type": "custom:universal-remote-card" } ] }
}
```

A file that wraps the object in its own key (`{"master": { ... }}`) is read
too, so a room lifted out of a combined file works unchanged.

A light is an id, or an object with `name`, `icon` and `dim`. Set `dim: false`
on a Lutron relay or wall switch — Home Assistant reports brightness support
for those, which is wrong.

### What the pop-up and page contain

By default `sections` picks the blocks and their order; each appears only if
the room defines those entities, so no room needs a hand-built layout.

| Block | Appears when the room has |
|---|---|
| `climate` | `climate_entity` |
| `media` | `music_powers`, `tv_entity`, `projector_entity`, `receiver_entity`, `remotes`, `media_player` |
| `lights` | `light_entities`, `landscape_entities`, `fan_entities`, `bath_fan_entities`, `fountain_entities` |
| `cameras` | `cameras` |
| `security` | `alert_sensors` |

Default order is climate, media, lights, cameras, security.

### Taking over the layout

Set `layout` and the room stops arranging itself — you spell out the order
instead, and `sections` is ignored. Items are headings, single lights, or
whole blocks, in any order:

```json
"layout": [
  { "heading": "Bedside" },
  { "entity": "light.master_reading_left",  "name": "His" },
  { "entity": "light.master_reading_right", "name": "Hers" },
  { "heading": "Everything else" },
  { "block": "climate" },
  { "entity": "light.master_cans" },
  { "card": { "type": "custom:universal-remote-card" } }
],
"hidden": [
  { "entity": "light.outside_xmas_master_outlet" }
]
```

Consecutive lights collapse into one two-column grid, so headings are what
break them into groups — and `"width": "full"` on an item gives it the whole
row instead, breaking the run around it.

### Columns

A `group` is a column. Neighbouring groups share a row on a wide panel and
stack once there isn't room, which is what a wide pop-up wa