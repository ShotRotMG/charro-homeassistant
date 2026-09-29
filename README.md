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
| `media` | `tv_entity`, `projector_entity`, `receiver_entity`, `remotes` |
| `music` | `music_powers`, `media_player` |
| `lights` | `light_entities`, `landscape_entities`, `fan_entities`, `bath_fan_entities`, `fountain_entities` |
| `cameras` | `cameras` |
| `security` | `alert_sensors` |

Default order is climate, media, music, lights, cameras, security.

`sections` is optional and most rooms leave it out. It does two things: it
picks which of those blocks appear at all, and it sets their order. Listing
`["lights", "climate"]` means lights first, then climate, and nothing else —
so a camera in that room simply wouldn't be drawn. Leave it unset and every
block the room has entities for appears in the default order.

A saved `layout` supersedes it entirely: once a room has one, the drag builder
owns the arrangement and `sections` is ignored.

Audio and video used to share one `media` block. They split in 4.20 so a
player can be sorted away from a TV remote. A room whose `sections` named
`media` before the split gets `music` put back in right behind it, and a saved
`layout` with a `media` node gets a `music` node inserted after it — unless
`music` is already parked in `hidden`, which is read as a decision rather than
an omission.

### Climate

`climate_entity` renders