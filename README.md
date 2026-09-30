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

`climate_entity` renders as a single tile row: what the thermostat is doing and
what the room actually reads on the left, the setpoint inline on the right.

| key | what it does |
| --- | --- |
| `climate_name` | overrides the name on the tile |
| `climate_modes` | list of hvac modes (`["heat_cool","heat","cool","off"]`) — adds a row of mode buttons and moves the setpoint below the name |
| `climate_card` | a full card config, used verbatim instead |

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
stack once there isn't room, which is what a wide pop-up wants — a remote
beside the lights beside the player, rather than all three down the page.

```json
"layout": [
  { "group": "Remote", "span": 4,
    "items": [ { "card": { "type": "custom:universal-remote-card" } } ] },
  { "group": "Lights", "span": 5,
    "items": [ { "entity": "light.javon_cans" }, { "entity": "light.javon_lamp_left" } ] },
  { "group": "Playing", "span": 3,
    "items": [ { "block": "media" } ] },
  { "heading": "Everything else" },
  { "entity": "light.javon_br_shower" }
]
```

`span` weights the widths against each other — 4/5/3 above. Each column has a
260px floor, so on a phone they wrap into a single stack. `group` doubles as
the column's label; use `"group": ""` for an unlabelled one, and `items` holds
anything a layout holds, groups aside.

**+ Column** in the builder adds one. A column is a container you drag items
into and out of; its header carries the label and the span, and removing a
column keeps what was inside by dropping those items back into the layout
where it sat. Columns can't nest, so dragging one onto another is refused. `hidden` is parked, not deleted — it keeps a light's
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

### Video switching

A room with a matrix asks three questions in order — which screen, what's
feeding it, what are the buttons for — and answering them with conditional
cards means one remote card per screen × source pair, all instantiated so all
but one can be hidden. The Saloon's three screens and four sources would be
twelve. A `video` block asks the questions in order and builds only the remote
the answers land on.

```json
"video": {
  "focus": "input_select.saloon_device_select",
  "off_option": "Off",
  "displays": [
    { "name": "Bar", "icon": "mdi:glass-cocktail",
      "source": "input_select.saloon_bar_media_select",
      "power": "media_player.saloon_bar_samsung_q60_55" }
  ],
  "sources": {
    "SuperBox": { "use": "superbox", "title": "Charro SuperBox",
                  "remote": "remote.charro_superbox",
                  "volume": "media_player.saloon_bar_samsung_q60_55" }
  }
}
```

What renders: a row of screen chips, the source dropdown for whichever is
focused, and one remote.

| key | what it does |
| --- | --- |
| `focus` | the input_select naming which screen you're controlling |
| `off_option` | the option that means "all off" (default `Off`) |
| `displays[].source` | that screen's own source list — the projector's differs |
| `displays[].power` | the screen itself, for the off tile and the lit chip |
| `sources` | keyed by the option text in a source select |
| `sources[].use` | a template in `_remotes.json`; the rest of the entry fills its `{{…}}` |
| `sources[].card` | a whole card instead, when a box doesn't fit a template |

A chip is lit when that screen is on, so the row reads as status as well as
choice, and its tooltip names what it's showing. **All off** is pushed to the
right end rather than sitting in the focus list — it's a different kind of
action and shouldn't be in the path of changing screens. With the focus on
`Off` the panel collapses to just the chips.

A screen whose source is `Off` shows its power tile where the remote goes, so
the panel never has a hole. A source with no entry, or a `use` naming no
template, says so rather than rendering nothing.

Volume belongs to the screen, not the box — a matrix sits between them — so
templates take a `{{volume}}` that the source entry points at the display's
own media_player.

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

Rather than leaving a hole while the TV is off, a remote can name what sits in
its place:

```json
"remotes": [
  { "use": "samsung_tv", "title": "Javon TV",
    "media_player": "media_player.javon_samsung_70",
    "remote": "remote.javon_samsung_70",
    "wake": "script.javontv_wake",
    "off_name": "Javon TV" }
]
```

| key | what it does |
| --- | --- |
| `wake` | service the off tile calls to turn the TV on — `script.x`, `scene.y`, anything `perform-action` takes. Without it the tile just toggles the watched entity. |
| `off_name` | label on the off tile. Falls back to `title`. |
| `off_icon` | icon on the off tile. Defaults to `mdi:television-off`. |
| `off_card` | a full card config, used verbatim instead of the generated tile. |

Set any one of those four and the room gets a matched pair in the same slot:
the remote while the device is on, the off tile while it isn't. Set none and
the slot is simply empty while the TV is off, as before. Both halves are
`conditional` cards, so the swap happens live — no reload, no reopening the
pop-up.

A device a remote watches is dropped from the `tv_entity` / `projector_entity`
/ `receiver_entity` tile grid above it — the pair already covers both states,
so the plain tile would only ever duplicate whichever half is showing. Those
keys still draw their own tile in rooms with no remote configured, and
`tv_entity` still drives the now-playing chip on the room tile either way.

Name a template that doesn't exist and you get a card saying so, rather than
silence.

### The pop-up header

The header reads like the room's own tile rather than a plain dialog bar:

- far left, on its own: a door icon for any room with `alert_sensors` — closed
  and grey while everything is shut, open and red when something isn't
- centred: the room icon, the name at 24px, and the chips, travelling together
  as one cluster with a gap either side of the name
- far right: the full-page and close buttons

The room icon is amber whenever anything in `light_entities` or
`landscape_entities` is on — the same rule the tile uses.

The centre cluster is taken out of the flow and positioned off the panel's own
centre, so neither the door nor the buttons can push it off or squeeze the
chips. Under 900px it rejoins the flow and left-aligns, where overlapping would
be the worse problem.

Chips are clickable. A count chip (lights, landscape, fans, water, music
zones) turns that group off, which is what the tile's chips do. A single-entity
chip (TV, projector, receiver, now playing, thermostat) opens more-info. Each
carries a tooltip saying what it is and what a tap will do.

Hovering the door names the sensors in a sentence — "Jordan Bedroom violated.",
"Saloon Lanai Door and Kitchen Lanai Door closed." — listing the violated ones
when any are, and all of them when none are. Clicking a red door opens the
first violated one.

These aren't all binary sensors: the Elk zones are plain `sensor` entities
reading `Normal` or `Violated`. The check treats `violated`, `on`, `open` and
`opening` as violated, whatever the domain, so a zone and a cover and a
binary_sensor can sit in the same `alert_sensors` list.

The header redraws when the states behind it change, guarded by a signature of
just those entities, so an active house doesn't rebuild it on every tick.

Chip colours live in one place in the code, shared by this header, so the tile
and the pop-up can't drift apart.

### Gaps

Tiles fill a two-column grid in order, so a room with an odd number of them
leaves whichever tile happens to land last sitting alone. **+ Gap** drops an
empty cell into the run: the tile after it moves to the other column, or down
to the next row, and nothing is drawn where the gap is.

A gap is `{ "gap": true }` in the layout, and behaves like any other row — drag
it where you want the space, hide it, delete it. It's half-width by definition;
two in a row skip a whole line.

### Adding a card

**+ Card** in the layout builder opens a panel with two ways in: a dropdown of
every card this install actually has — the core Home Assistant ones, then your
installed cards grouped by vendor, read from `window.customCards` so it can't
go stale — and an editor underneath. Pick a type to seed a starting config, or
paste one you already have.

The editor is HA's own `ha-yaml-editor`, so it takes YAML or JSON and tells you
when the syntax is wrong rather than failing on save. If a future frontend stops
registering it, the panel falls back to a JSON textarea.

What lands is an ordinary `{ "card": … }` layout row: draggable, hideable, and
droppable into a column like anything else. The pencil on an existing card row
reopens the same panel.

This replaces `cards.<slot>` as the place to put one-offs. The old slots still
work and still render — switching a room to a custom layout materializes them
into rows — but there's no longer a reason to hand-edit that blob.

### Pop-up width

Width follows the content rather than the monitor. The panel measures the
widest run of side-by-side groups in the body and sizes to that:

| columns | width |
|---|---|
| 1 (no groups) | 680px |
| 2 | 1040px |
| 3 or more | 1320px |

A group's `span` counts toward the total, so one `span: 2` next to a plain
group is three columns' worth. Each width is capped against the viewport
(92 / 88 / 82vw as the screen grows) so the widest never reaches the edges,
and below 870px it's a full-width bottom sheet as before.

The point is that a single column of tiles stretched across 1300px reads worse
than the same column at 680px — extra width is only worth taking when there are
columns to put in it. So to get a wider panel, give the room groups.

`popup_width` overrides all of it — a number is pixels, a string is used as
given (`"64rem"`, `"min(1500px, 80vw)"`). The viewport cap still applies.

The pop-up is drawn by the card itself into the `home-assistant` shadow root —
inside HA's own gesture layer, so lights and sliders in it respond to taps —
keyed on the
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
| `tile_size` | `half` (default) or `full` — how wide the tile sits on the rooms view. A `grid_options` on the card in the view overrides it |
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
| `render` | `mushroom` (default), `tile`, or `hue` — which card draws this light |

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
drag into **Hidden** to park it. Entity rows carry their name, icon, how they're drawn, the dims toggle and
half/full width inline, so the old flat table is only there for automatic
rooms.

Adding or removing a light in the form keeps a custom layout in step: a new
light appears in **Available** rather than landing silently at the end, and a
removed one disappears from everywhere.

**Available** is everything the room owns but hasn't placed — loose lights
grouped by which list they came from, plus any block not in use. It's derived
rather than stored, so dragging one out (or clicking +) creates the item; the
tray just stops showing it. Place everything and the tray says so.

Headings, blocks and raw cards carry an × to remove them outright; a removed
block is offered again by **+ Block**. Lights only hide, since the entity
lists decide which exist — the eye parks one in **Hidden**, and the
arrows button gives an item the full row instead of sharing it.

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
