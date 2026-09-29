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
data. `rooms_dir` moves the folder, `room_url` points at one exact file. They're
fetched `cache: "no-store"`, so an edit is live on a hard refresh, with no
restart.

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
break them into groups. `hidden` is parked, not deleted — it keeps a light's
name, icon and `dim` so putting it back costs nothing.

The rooms editor does all of this by dragging, and **Customise layout** writes
the room's current automatic arrangement out as a `layout` to start from.
**Back to automatic** drops it again.

For the one-offs — a scene picker, an air-purifier card — `cards` drops raw
Lovelace into a slot: `start` renders before everything, any block name
renders after that block, `end` renders last.

### Media players

`media_player` renders a card in the `media` block. If the entity comes from
the Music Assistant integration it gets `custom:mediocre-media-player-card`,
otherwise the built-in `media-control`. Set `media_card` to a full card config
to override. The room tile grows a now-playing chip while that player is
playing; tapping it opens the media card on its own `#<room>-media` hash.

### Remotes

Every Samsung TV wants the same remote with different entity ids, so the
layouts live once in `_remotes.json` beside the rooms, and a room names one
and fills the blanks:

```json
"remotes": [
  { "use": "samsung_tv", "title": "Javon TV",
    "media_player": "media_player.javon_samsung_70",
    "remote": "remote.javon_samsung_70" }
]
```

```json
// _remotes.json
{
  "samsung_tv": {
    "type": "custom:universal-remote-card",
    "platform": "Samsung TV",
    "remote_id": "{{remote}}",
    "media_player_id": "{{media_player}}",
    "title": "{{title}}",
    "rows": [["back", "custom_power", "menu", "home", "source"], ["circlepad"]]
  }
}
```

`{{key}}` anywhere in a template is filled from the room's entry. A string
that is *exactly* `{{key}}` takes the value's own type, so a number or a list
survives instead of being stringified.

A remote is wrapped in a `conditional` card watching `media_player`, then
`remote`, then `entity` — whichever it finds first — so it only appears while
the device is on rather than off, unavailable, unknown or standby. `when`
picks a different entity to watch; `always: true` skips the check. Because it
is a conditional card it follows state live, not just at the moment the panel
opened.

Name a template that doesn't exist and you get a card saying so, rather than
silence.

The pop-up is drawn by the card itself into `document.body`, keyed on the
room's hash, so the browser back button closes it and nothing in the grid can
clip it. It does not need Bubble Card. Only the first card to claim a hash
owns it, so a room appearing on two views still opens one panel.

### The tile

Room name with a centred row of chips — lights, landscape, ceiling fans,
bathroom fans, fountain, thermostat, music — each shown only when that room has
one. Red door/garage indicator top right. Tap opens the Bubble Card pop-up.

```yaml
type: custom:charro-room-card
room_name: Master
room_icon: mdi:chess-king
climate_entity: climate.master_bed
light_entities: [light.master_cans, light.master_rope_light]
fan_entities: [light.master_fan]
bath_fan_entities: [light.master_bath_shower_fans]
music_powers:
  - switch.rti_ad_8x_amp1_master_bath_power
  - switch.rti_ad_8x_amp1_master_patio_power
alert_sensors: [sensor.elkm1_master_bedroom]
```

| Option | Description |
|---|---|
| `room_name` | **Required.** The title |
| `room_icon` | Icon left of the name. Green when any light is on |
| `popup_hash` | Bubble Card hash. Blank derives it (`Garage East` → `#garage-east`) |
| `light_entities` | Lightbulb chip with an on-count |
| `landscape_entities` | Palm-tree chip, kept out of the lights count |
| `fan_entities` | Ceiling-fan chip with an on-count |
| `bath_fan_entities` | Plain fan chip with an on-count |
| `fountain_entity` | Fountain chip, taps to toggle |
| `climate_entity` | Always shown — grey off, red heat, blue cool, purple heat/cool |
| `music_powers` | Music chip showing how many zones are on. Hidden when all off |
| `music_player` | Opened by holding the music chip |
| `alert_sensors` | Sensors/covers that light the red indicator |
| `confirm_sensor` | Only alert when this is also open |

## `charro-security-card`

Red when the zone is Violated (or a cover isn't closed), green when a vehicle is
detected, white otherwise — all evaluated in the browser, so no white-to-red
flash on load. Subtitle shows state and how long it's been that way.

```yaml
type: custom:charro-security-card
entity: cover.ratgdo32disco_2c5a00_door
label: Garage West 3
icon: mdi:garage
toggle_button: button.ratgdo32disco_2c5a00_toggle_door
vehicle_entity: binary_sensor.ratgdo32disco_2c5a00_vehicle_detected
```

| Option | Description |
|---|---|
| `entity` | **Required.** Elk sensor, binary sensor or cover |
| `label` | Blank uses the friendly name |
| `icon` | Defaults to `mdi:garage` for covers, `mdi:shield-check` otherwise |
| `toggle_button` | Set for garage doors — tapping the round icon fires it |
| `vehicle_entity` | Green when a car is in the bay |
| `alert_mode` | `violated` or `open`. Blank picks from the entity domain |

## `charro-zone-card`

One line per RTI zone: power, source toggle, name, volume down / level / up.
Hold the volume buttons to repeat.

```yaml
type: custom:charro-zone-card
entity: switch.rti_ad_8x_amp2_saloon_bar_power
zone_name: Saloon Bar
source_entity: select.rti_ad_8x_amp2_saloon_bar_source
volume_entity: number.rti_ad_8x_amp2_saloon_bar_volume
```

| Option | Description |
|---|---|
| `entity` | **Required.** Zone power switch |
| `zone_name` | **Required.** Label |
| `source_entity` | Source select — tapping flips between 1 and 2 |
| `volume_entity` | Volume number |
| `volume_step` | How far one tap moves it. Default 1 |

## `charro-all-off-card`

Border goes green when any listed zone is on, red when all are off. Subtitle
counts what's on.

```yaml
type: custom:charro-all-off-card
label: All Zones Off — Both Amps
service: script.all_zones_off
entities:
  - switch.rti_ad_8x_amp1_lanai_power
  - switch.rti_ad_8x_amp2_kitchen_power
```

| Option | Description |
|---|---|
| `entities` | **Required.** Zone power switches to count |
| `label` | Title |
| `service` | Default `script.all_zones_off` |
| `confirm` | `false` to fire without asking |
| `confirm_text` | Custom confirmation wording |

## `charro-lights-card`

One room per card. Every row is the same height whether the light is on, off,
dimmable or a relay, because the brightness control is a fill bar inside the
row rather than a slider underneath it. Drag across a lit dimmable row to set
brightness, tap anywhere to toggle, hold for more-info.

```yaml
type: custom:charro-lights-card
title: Kitchen
icon: mdi:chef-hat
filter_entity: input_select.light_filter
entities:
  - light.kitchen_island
  - entity: light.kitchen_area
    name: Cans
    icon: mdi:light-recessed
    dim: false
```

| Option | Description |
|---|---|
| `entities` | **Required.** Entity ids, or objects with `entity` plus any of `name`, `icon`, `dim`, `fountain` |
| `title` | Room name in the header. Blank hides the header |
| `icon` | Icon beside the title |
| `filter_entity` | An `input_select` driving which rows show — see below |
| `row_height` | Row height in px. Default 46 |
| `keep_empty` | `true` to keep the card visible when the filter hides every row |

Per-light keys:

| Key | Description |
|---|---|
| `dim` | `false` for a Lutron relay or wall switch. Home Assistant reports brightness support for those, which is wrong, so it has to be stated |
| `fountain` | Forces in or out of the Fountains filter. Blank guesses from the name |
| `name` / `icon` | Override the entity's own |

The filter entity's state selects the rows:

| Option | Shows |
|---|---|
| `All` | everything |
| `On` | only what's currently on |
| `Lutron` | entities with a `homeworks_address` attribute |
| `Other` | everything else — Hue, Pentair, ratgdo |
| `Fountains` | water features |

Lutron and Other are read live from the entity, so new Lutron loads sort
themselves. A card whose rows are all filtered out hides itself, so the grid
closes up instead of leaving an empty header.

Fountain rows go blue when on; everything else goes amber.

## `charro-rooms-editor`

Drop it on a config view and edit the room files in place — entity pickers,
icon pickers, per-light overrides, and a live preview of the tile beside the
form.

Give it a `type: panel` view of its own — it lays out in three columns
(settings, the per-light table, a live preview) and wants the width.

```yaml
type: panel
title: Config
path: config
cards:
  - type: custom:charro-rooms-editor
    title: Rooms
```

| Option | Description |
|---|---|
| `rooms` | Pin the list to these keys. Leave it out and the card finds them |
| `title` | Shown beside the room picker |
| `rooms_dir` | Where the files live. Default `/local/rooms/` |

### Finding the rooms

A browser cannot list a folder, so the card works it out two ways and merges
the results: it reads every dashboard's config over the websocket and collects
each `room:` already placed on a `charro-room-card`, and it reads
`_index.json` from the rooms folder, which the save script rewrites on every
save. Between them a room shows up whether it has been put on a dashboard yet
or not, and nothing has to be listed by hand.

`_index.json` only exists once you've saved a room through the script. Until
then the card falls back to what's on your dashboards — so a room file that is
on disk but not yet on a card and not yet in the index is invisible. **Open /
new** covers that case: type the key and the card opens the file if it finds
one, and only starts a blank room if it doesn't. Writing `_index.json` by hand
works too — it's a plain array, `["master", "lanai"]`.

Three columns: the room's settings, the per-light table, and a live preview.
**Open / new** takes a room key and opens that file if it exists, otherwise
starts a blank room — so it can't overwrite one by accident. **Expand all**
opens every settings section at once; they start collapsed to keep that column
narrow.

The middle column is the layout builder. While a room is automatic it shows
what that means and offers to take it over; once it has a `layout` every item
becomes a draggable row — reorder them, drag one under a different heading,
drag into **Hidden** to park it. Entity rows carry their name, icon and dims
toggle inline, so the old flat table is only there for automatic rooms.

Adding or removing a light in the form keeps a custom layout in step: new
lights land at the end, removed ones disappear from both lists.

The preview switches between **Tile** — the chip card as it appears on the
rooms view — and **Pop-up**, which renders the full body the room would show
when opened. Choosing Pop-up widens that column and narrows the other two.

### Saving

A browser cannot write to `/config`, so Save takes one of two routes.

Without any setup the button reads **Copy JSON** — it puts the finished file
on your clipboard and names the path to paste it into.

Add the helper below and it becomes a real **Save** that writes the file:

```yaml
# configuration.yaml
shell_command:
  charro_write_room: "sh /config/scripts/charro_write_room.sh {{ name }} {{ payload }}"
```

with `charro_write_room.sh` at `/config/scripts/` — anywhere under `/config`
works, as long as the two paths agree. No execute bit needed, since the
command invokes `sh` directly. The card base64-encodes the body,
so nothing with a shell metacharacter in it ever reaches the command line; the
script sanitises the room name again, writes to a temp file, refuses to
install anything that doesn't parse as JSON, and only then moves it into
place. The card notices the service by itself — no option to set.

Either way the other cards pick the change up on a hard refresh.

---

## Changing how the cards look

`dist/templates/*.json` hold the full button-card templates — padding, grids,
chip sizes, colours. They're fetched with `cache: "no-store"`, so a hard refresh
picks up edits. No restart.

HACS replaces them on update. To keep your own version, copy one to
`/config/www/cards/` and point the card at it:

```yaml
type: custom:charro-room-card
template_url: /local/cards/room-card.json
```

Landmarks in `room-card.json`:

- `styles.card` — padding, radius, `min-height`
- `styles.grid` — the `"i n alert" / "chips chips chips"` layout and row heights
- `styles.name` — font size by name length
- `custom_fields.chips.card.styles.grid` — the flex chip row (`gap`, centring)
- `custom_fields.chips.card.styles.custom_fields.<chip>` — chip visibility
- `custom_fields.chips.card.custom_fields.<chip>` — a chip's icon, count, colours
- `custom_fields.alert` — the red door indicator

Break the JSON and the card shows a red error instead of failing silently.

## Notes

- `triggers_update` is computed from the entities you set, so a card only
  redraws for its own state changes.
- `security-card.json` and `garage-card.json` are the same tile; the garage one
  swaps the icon's tap action for `button.press`.
