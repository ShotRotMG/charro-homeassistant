# Charro Home Assistant

Lovelace cards for the Charro dashboard. One HACS install gives you four cards,
each with a visual editor.

| Card | What it is |
|---|---|
| `charro-room-card` | Room summary — lights, fans, climate, music, door alert |
| `charro-security-card` | Elk zone or garage door tile, coloured client-side |
| `charro-zone-card` | RTI AD-8x single-line zone control |
| `charro-all-off-card` | Turn every RTI zone off on both amps |

All four render `custom:button-card` underneath, with the styling in
`dist/templates/*.json`. Nothing goes in `button_card_templates:` any more.

## Requirements

- [button-card](https://github.com/custom-cards/button-card)
- [card-mod](https://github.com/thomasloven/lovelace-card-mod)

## Install

HACS → three-dot menu → **Custom repositories** → paste this repo's URL,
category **Dashboard** → Add. Then find "Charro Home Assistant" in HACS and
download it. HACS registers the Lovelace resource itself.

---

## `charro-room-card`

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
