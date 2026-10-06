# Charro Home Assistant

[![checks](https://github.com/ShotRotMG/charro-homeassistant/actions/workflows/checks.yml/badge.svg)](https://github.com/ShotRotMG/charro-homeassistant/actions/workflows/checks.yml)

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
category **Integration** → Add. Find "Charro Home Assistant" in HACS,
download it, restart Home Assistant, then **Settings → Devices & services →
Add integration → Charro Cards**.

That is the whole setup. Adding the integration does three things:

- serves `charro-cards.js` at `/charro_static/` and registers it with the
  frontend, so the six cards exist with no Lovelace resource entry
- puts **Rooms** on the sidebar — the editor as a full page, admin only
- exposes `charro/save_room`, so the editor writes room files without the
  `shell_command` that used to go in `configuration.yaml`

Room files live at `/config/charro_rooms/*.json` and are read over the
websocket. An existing install is copied across from `/config/www/rooms/` the
first time the integration starts; the originals are left alone, and the log
says so, because **`/config/www` is served at `/local/` with no
authentication** — a room file there is readable by anyone who can reach the
instance. Delete that folder once you're happy the move took.

### Coming from the Dashboard version

HACS lets a repository be an integration or a dashboard plugin, not both, so
the switch is a remove and a re-add:

1. HACS → Charro Home Assistant → **Remove**
2. **Settings → Dashboards → Resources** → delete the
   `/hacsfiles/charro-homeassistant/charro-cards.js` line
3. add the repo again with category **Integration**, download, restart, then
   add the integration
4. optional — delete the `shell_command: charro_write_room` block and
   `/config/scripts/charro_write_room.sh`; the integration replaces both

Your rooms, dashboards and views are untouched by all of that.

### Updating

HACS → Redownload, then:

- **changes under `frontend/`** (the cards, the templates) — **Settings →
  Devices & services → Charro Cards → Reload**, then hard-refresh the
  browser. Reload drops the old bundle URL and emits the new revision, so no
  restart is needed.
- **changes to the integration's Python** — restart Home Assistant. The
  module is already imported by then, so a reload can't replace it. This is
  true of every custom integration, not just this one.

If you're unsure which changed, restart; it always works.

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

`room: master` reads `/config/charro_rooms/master.json`. One file per room.
Keep them there and **not** in this repo: HACS replaces `dist/` on every
update, and your rooms are your data.

Every room arrives in a single authenticated websocket message
(`charro/get_rooms`) the first time any card asks, and every other card on the
page shares it. Saving in the editor drops that copy so the next read is
fresh; other open tabs pick the change up on a refresh.

> They are deliberately not under `/config/www`. Home Assistant serves that
> at `/local/` **without authentication** — no token, no cookie, nothing. The
> room files are entity ids and layout rather than secrets, but they are also
> a room-by-room map of the house, and they used to be public.

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

Screens went the other way. `video` was its own block from 4.29 and merged
back into `media` in 4.84: a room has one television, and having to name it
under two separate sections meant every room with a TV was configured twice
and — when the TV was on — showed it twice. One block now draws the screens
first, then a tile for anything with no remote, then the loose remotes. A room
that still names `video` in `sections`, or places it in a saved `layout`, gets
a single `media` at whichever position came first; if both are named, the
second is dropped rather than drawn twice, and a `media` parked in `hidden`
while `video` is placed is dropped too, since the two are now the same thing
and the one you can see wins. The same merge removes a loose `remotes` entry
for a screen the `video` block already draws — the switcher knows which source
is live, so it wins.

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

### Zone players

A music zone is an amplifier channel, not a player — what you're hearing
depends on which input it's switched to. `zone_players` maps a source value to
the player feeding it, and each zone card is followed by the controls for
whatever is on it:

```json
"music_powers": ["switch.rti_ad_8x_amp2_saloon_bar_power",
                 "switch.rti_ad_8x_amp2_stage_power"],
"zone_players": { "1": "media_player.sonos_1", "2": "media_player.sonos_2" }
```

The map applies to every zone in the room, since they usually share an amp and
its input numbering. A `music_powers` entry written as an object can carry its
own `players` map instead, for a zone wired differently.

The `music` block draws every zone together, which is right for a room with
one. A combined room usually wants them apart — the Living zone beside the
Living lights, not stacked with Dining's at the top — so a zone is also a
layout row of its own:

```json
{ "zone": "switch.rti_ad_8x_amp2_living_room_power" }
```

Switching a room to a custom layout splits them automatically: `music`
materializes into one row per zone plus a `player` block for the room's
`media_player`, and each can be dragged wherever it belongs. Unplaced zones
show in the tray under **Music zones**.

Each pairing becomes a `conditional` card watching that zone's power and
source, rather than a state read — the pop-up body is built once when it
opens, so these have to follow state on their own. A Music Assistant player
gets the Mediocre card, anything else the built-in `media-control`, same rule
as `media_player`.

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
| `focus` | the input_select naming which screen you're controlling — omit it in a one-screen room and that screen is always the focus, with no chip row and no **All off** |
| `off_option` | the option that means "all off" (default `Off`) |
| `displays[].source` | that screen's own source list — the projector's differs |
| `displays[].power` | the screen itself, for the off tile and the lit chip |
| `sources` | keyed by the option text in a source select |
| `displays[].sources` | the same, for one screen only — two screens can both offer "Samsung" and mean different televisions, and a display's own map wins over the room's |
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

### What picking a source does

A source can carry its own actions, written in Home Assistant's own shape —
the same thing you'd write in an automation, pasted straight across:

```json
"video": {
  "source_from": "media_player.vsx_lx305",
  "sources": {
    "AppleTV": {
      "input": "AppleTV", "use": "apple_tv",
      "media_player": "media_player.theatre_appletv",
      "do": [
        { "action": "media_player.turn_on",
          "target": { "entity_id": ["media_player.vsx_lx305",
                                    "media_player.theatre_appletv",
                                    "media_player.theatre_projector"] } }
      ]
    },
    "Off": {
      "do": [
        { "action": "media_player.turn_off",
          "target": { "entity_id": ["media_player.xbox", "media_player.theatre_appletv",
                                    "media_player.vsx_lx305", "media_player.theatre_projector"] } },
        { "delay": 0.5 },
        { "action": "remote.send_command",
          "target": { "entity_id": "remote.harmony_hub" },
          "data": { "device": "83001072", "command": "PowerOff",
                    "num_repeats": 1, "delay_secs": 0.4 } }
      ]
    }
  }
}
```

All of it is editable in the rooms editor, and none of it is JSON. Each
source gets **Home Assistant's own action editor** — `ha-selector` with an
`action` selector, which is the component the automation page uses, so add,
remove, drag-to-reorder, every service and each service's own fields are all
HA's. Nothing is written to `automations.yaml` and no automation entity is
created: the list lives in the room file and the card calls the services
itself. The trade is that these have no automation traces, so a misbehaving
step shows up in the browser console and the logbook rather than a trace view
— fine for "turn on three things and pick an input", and anything genuinely
conditional should be a real automation the source calls.

`Its input` is a dropdown of the receiver's own `source_list` once
`Current source comes from` is set, so the input names come from the receiver
rather than being typed.

This is what an `input_select` helper and one automation per source used to
be. There is no little language in the middle, so anything an automation can
do a source can do — a Harmony `send_command` with its repeats and hold, a
script, a scene. A step is an action, or `{ "delay": 1.5 }` to wait between
two. One failing step is logged and the rest still run, because a receiver
that is already on shouldn't stop the projector coming up.

`input` is the only sugar: with `source_from` set, the `select_source` call is
appended for you, since every room was writing the same one. `source_from` can
be the receiver's `media_player` — then the live source is read from its
`source` attribute — or a `select`, which is what the RTI matrix publishes per
output; then it's read from the state.

**`Off` is an ordinary entry with its own actions**, deliberately not derived
from the others. A room that has to send a PowerOff to a Harmony can't be
guessed at, and a wrong guess turns the wrong things off. It's the entry that
shows as live whenever `source_from` reports off.

With `source_from` set the card draws its own source buttons in place of the
dropdown, highlighting whichever one the receiver says is live. Nothing is
stored anywhere for it to drift out of step with.

All of it is editable in the rooms editor under **Media & remotes**: screens
and sources are lists of objects, which `ha-form` has no good shape for, so
they get their own rows — add, fill in, remove. The remote template is a
dropdown of whatever `_remotes.json` holds. The screen picker only appears
once a room has more than one screen.

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

Most rooms never fill `tv_entity` in, though — they add a screen under Media &
remotes instead — so when it is blank the screens answer the question.

A screen is two questions that usually have one answer: **what is it**, and
**what turns it on**. For a television wired straight to the wall they're the
same entity, so a room fills in `screen` and leaves `power` blank. For a set
fed by the RTI matrix they come apart:

```json
"displays": [
  { "name": "TV",
    "screen": "media_player.kitchen_samsung_55_2",
    "power":  "switch.rti_vhd_8x_video_kitchen_power" }
]
```

`screen` is the television — the remote, the volume, what's playing, and what
the room's TV chip follows. `power` is what actually turns it on and reports
whether it's on, which for these sets is the matrix switching them over
HDMI-CEC: the one control path a recent Samsung still honours, and far better
than asking the TV's own network stack to wake up. A switch can only switch —
no volume, no buttons, nothing playing — which is exactly why it isn't asked to
be the screen.

Either field answers for the other when it's blank, so a room that fills in
only one still works. `screen` takes a `media_player`, a `remote` or a `switch`;
`power` takes any of those too, since what powers a screen varies. The remote
appears and disappears on `power`, so the pair follows what the matrix reports
rather than what the television claims about itself.

Rooms saved before this called the TV `power`, and 4.89–4.90 briefly called it
`media_player`; both are still read, and the editor folds them into `screen`
when you open the room so a save writes the current shape.

That second field takes a `remote` as well as a `media_player`. A player is
better when the television has one, since it is what reports what's on screen
and what a volume template reads its level from — but a set with only a remote
entity still gets its buttons. Whichever half is named, the other is looked for
under the same object id in the other domain and used only if it really exists,
which is how both Samsung integrations name their pairs.

Note that the matrix output stays a `switch`, deliberately. MQTT discovery has
no `media_player` platform, and a CEC output has no transport, no volume state
and no media title to report — so dressing it as a player would mean a custom
component producing a shell. Two honest entities beat one that pretends.

The room's TV chip then follows the screen's `media_player` when it has one,
and its `power` otherwise, preferring a real player across screens since that
is the one that knows what's on. The single exclusion is `projector_entity`:
Theatre's screen is powered by `switch.theatre_projector`, which already has
its own chip, and promoting it to "the TV" would show one device twice under
two icons.

A chip is drawn only when its entity actually exists. A `media_player` that
has been deleted from Home Assistant leaves the room file naming an id that
resolves to nothing, and an absent state used to read as "not off" and light
the chip up — a removed television claiming to be on. The editor lists that id
as unknown, with where in the room it is.

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

### The editor

Four columns in a fixed-height workspace, each scrolling on its own: the room
list, the form and its panels, the layout, and the preview. Reaching row 30 of
a layout no longer scrolls the form and the preview off the top — which is
also what used to make the card editor look broken, since its panel opened
below the fold.

The room list replaces the dropdown: all 21 rooms visible, current one
highlighted, one click to switch. The action bar sticks to the top.

**Autosave is on** and writes 1.5 seconds after you stop changing things. Turn
it off with the switch in the bar and the choice is remembered in that
browser. A save in flight blocks another from starting, and nothing is written
unless the room actually differs from the file.

**Revert goes back to the file as it was when you opened the room**, not to the
last autosave — so autosave can't strand you. Below 1280px the preview is
hidden and below 820px the columns stack.

### Editing a room

Everything in a room file is reachable from the rooms editor. The form covers
the scalars and the entity lists; six collapsible panels cover the rest:

| panel | what it edits |
| --- | --- |
| Media & remotes | `tv_entity`, `projector_entity`, `receiver_entity`, the `video` block, and `remotes` for a room with no screen picker |
| Music | `music_powers`, `music_player`, `zone_players` |
| Pool & water | the pumps, their names and heaters, `fountain_entities`, `water_actions` |
| Door / motion alert | `alert_sensors` and `confirm_sensor` — which sensors, and for each one its label, icon, opener, garage flag and guard |
| Gates | `gates` |
| Advanced | `sections`, `media_card`, and the raw `cards` slots |

Each panel is one subject. Picking the entities and configuring them used to
be split — the simple fields in an `ha-form` group, the lists of objects in a
panel below — which put the same subject in two places. The `ha-form` groups
that had a partner were folded into it, so Music, Pool & water, Media &
remotes and Door / motion alert are each a single place. Lights, Fans and
Climate stay in the form, having nothing to merge with.

Media was the one that got missed: you named the television in an `ha-form`
group on one side of the editor and configured the screen it actually is on
the other. Merging the two render blocks in 4.84 made that hard to ignore, so
the three plain devices moved into the panel beside the screens. The schema
itself is unchanged — the dashboard card editor has no panels, so it still
shows the Media group; the rooms editor filters it out and asks for the same
three fields itself.

In Door / motion alert each sensor is a collapsed row you open for its
details.

The preview loads the dashboard's Lovelace resources before it renders.
Those modules — button-card, mushroom, card-mod — are loaded by a dashboard,
not by Home Assistant, and the rooms editor on the sidebar is a panel, not a
dashboard. So `charro-room-card` was defined there (the integration injects
it on every page), built, and then failed on its inner `custom:button-card`,
which is why every preview said "Configuration error" while the same room
rendered correctly on a view — and why the only card that did draw was a core
`tile`. The panel now asks for the same resource list and loads it itself,
once, the first time a preview is about to render; a resource the page
already has is not injected again, so the editor placed as a card on a
dashboard does nothing extra.

An entity the room names and Home Assistant doesn't have — renamed, removed,
or a typo — is listed above the form, with the badge on the room's rail entry
so you can see which of twenty-one rooms is broken without opening each one.
Each line says where in the room it is in the editor's own words: the panel
and field for a plain one, the panel plus the screen, source, remote, gate or
sensor it belongs to for a list, and for a room with a saved layout the
column and row it sits in. The exact dotted path is on hover.

A `perform_action` is a service name, not an entity, so `script.toggle` and
`button.press` are no longer reported as missing entities — they never were
entities. A script called by its own name is still checked, since that one
can genuinely disappear.

The four columns resize. Drag the gutter between any two; double-click one to
put all four back. Widths are remembered per browser, and the tracks stay `fr`
so the workspace still reflows when the window changes size rather than
overflowing it. A column stops at its minimum rather than disappearing, and
whichever one you were squeezing simply stops giving ground.

The layout builder owns arrangement, and the per-light table covers name,
icon, render, dimming and counting for rooms that never take their layout over.

A hand-written card's `visibility` is translated into a `conditional` card when
it renders. Home Assistant applies `visibility` in its own card wrapper, which
a card instantiated directly never passes through — so a card with
`visibility` used to show regardless of its conditions.

### Pool, spa and their scripts

The `water` block draws the pumps you've already named in `pool_switch` and
`spa_switch` as a pair of tiles, then each heater — but only while its pump is
on, since a heater panel for a pump that's off is a dead control.

A Pentair has modes the switches can't express: "turn the spa on" is a script,
and "turn the whole thing off" is another. `water_actions` lists them, each
shown only while it's the one worth pressing:

```json
"water_actions": [
  { "name": "Turn Spa On", "icon": "mdi:hot-tub", "color": "light-green",
    "script": "script.pentair_spa_on",
    "when_off": "switch.charro_spa" },
  { "name": "Turn Pentair Off", "icon": "mdi:power-plug-off", "color": "red",
    "script": "script.pentair_all_off",
    "when_on": ["switch.charro_spa", "switch.charro_pool",
                "switch.charro_water_feature"] }
]
```

| key | what it does |
| --- | --- |
| `script` / `perform_action` | what a tap runs; `target` if it needs one |
| `when_off` | show while this entity is off |
| `when_on` | show while **any** of these is on |
| `name`, `icon`, `color` | as on any tile |

Both are `conditional` cards, so they appear and disappear live. An action with
neither `when_off` nor `when_on` is always shown. `pool_name` and `spa_name`
rename the pump tiles.

Each piece is also a layout row, so none of it is stuck inside the block:

```json
{ "pump": "pool" }, { "pump": "spa" },
{ "heater": "pool" },
{ "water_action": "Turn Spa On" }
```

A pump shares the two-up run, so Pool and Spa pair; `"width": "full"` takes the
row. A heater and an action take the row to themselves. Switching a room to a
custom layout expands the `water` block into these, and unplaced ones show in
the tray under **Pool & water**. An action row is keyed by the action's `name`,
so renaming one in `water_actions` means renaming it in the layout too.

Fountains stay where they are — `fountain_entities` is a light group, so they
render with the lights and keep their own chip.

### Gates

A gate is a button, not a door — pressing it pulses a relay and there's nothing
to read back, so the tile's state line is the last time it was opened.

```json
"gates": [
  { "name": "East Gate", "icon": "mdi:gate-arrow-left",
    "press": "button.doorstation_1ccae3723d19_relay_1",
    "hold":  "script.open_gate_east" }
]
```

| key | what it does |
| --- | --- |
| `press` | what a tap runs. The service follows the domain — `button.press`, `script.turn_on`, `cover.open_cover` |
| `hold` | something else for a long press, when a script does more than pulse the relay |
| `state` | an open/closed sensor, if one exists — it becomes the tile's entity instead of the button |
| `confirm` | `true` asks "Open East Gate?" first; a string asks that instead |
| `name`, `icon` | as on any tile |

`confirm` is worth setting on anything facing the street — a gate has no undo,
and the tile is a tap away on a phone in a pocket.

Each gate is a layout row too, sharing the two-up run so a pair sits side by
side; `"width": "full"` takes the row. The rows appear in the tray under
**Gates**, and the **Gates** panel in the editor covers all of it.

### Alert sensors

An `alert_sensors` entry is an id, or an object carrying what the door needs:

```json
"alert_sensors": [
  { "entity": "cover.ratgdo32_2b68b8_door",
    "label": "Door 3",
    "toggle_button": "button.ratgdo32_2b68b8_toggle_door" }
]
```

`label`, `icon`, `toggle_button`, `vehicle_entity` and `alert_mode` all pass
through to the card, and the room's `confirm_sensor` is inherited unless the
entry sets its own. A `toggle_button` is what makes the icon operate the door
rather than just report on it.

Each sensor is also a layout row of its own:

```json
{ "sensor": "cover.ratgdo32_2b68b8_door" },
{ "entity": "light.ratgdo32_2b68b8_light", "name": "Overhead 3" }
```

It shares the two-up run like a light, so a door pairs with the opener light on
the same ratgdo; `"width": "full"` takes the row. Switching a room to a custom
layout expands the `security` block into these automatically, and unplaced ones
show in the tray under **Door / motion**. The row carries a label field and a
picker for the button that opens it, so none of this needs a hand-written
`custom:charro-security-card`.

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

A card takes the whole row by default; `"width": "half"` puts it into the
two-up run with the lights instead. The arrows button on a card row toggles it.

For a door you don't need a card at all — see **Alert sensors** below.

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

With the integration installed this is already on the sidebar as **Rooms** —
admin only, full width, nothing to place. The card below is the same editor,
for putting it on a dashboard instead.

Edit the room files in place — entity pickers, icon pickers, per-light
overrides, and a live preview of the tile beside the form.

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

### Finding the rooms

The integration lists the folder over the websocket, so every room file shows
up — including one that is on disk but not on any dashboard yet. The editor
also scans your dashboards for `room:` keys already in use and merges the two,
which costs nothing and catches a room whose file has gone missing.

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

A browser cannot write to `/config`, so Save takes the best route it can find
and tells you which one in the footer under the form.

**The integration.** Nothing to set up — `charro/save_room` writes
`/config/charro_rooms/<key>.json`. The command is admin-only; the room key has
to match `^[a-z0-9][a-z0-9_-]*$`, so it can't name a file outside that folder;
and the file is written to a temp name and moved into place, so a reader never
sees half of one. Saving also drops the copy the cards on this page are
holding, so the next one to ask gets the new version.

**Copy JSON.** No way to write from here: the button puts the finished file on
your clipboard and names the path to paste it into.

Whichever route ran, the other cards pick the change up on a hard refresh.

Autosave is on unless you turn it off, and the checkbox is remembered per
browser. It waits 1.5s after the last keystroke, so typing a name is one write
rather than one per character.

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
