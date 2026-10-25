/* A room with one of everything, and a set of states with all of it on.
 *
 * Shared by the tests that need "a room that has the lot": the registry
 * rules, which run each Simple-view predicate against it, and the chip
 * parity sweep, which renders it both ways and compares. Keeping it in one
 * place is the point - a field added to the room editor and not to here is
 * a field those tests stop covering, and they say so rather than passing
 * quietly, because every predicate has to fire on this room.
 */
const room = {
  room: "sink", room_name: "Everything", room_icon: "mdi:home",
  light_entities: ["light.a"],
  landscape_entities: ["light.b"],
  shade_entities: ["switch.sh"],
  fan_entities: ["fan.f"],
  bath_fan_entities: ["switch.bf"],
  fountain_entities: ["switch.fo"],
  climate_entity: "climate.c",
  temp_sensor: "sensor.t",
  music_powers: ["switch.z"],
  music_player: "media_player.ma",
  media_player: "media_player.ma",
  tv_entity: "media_player.tv",
  projector_entity: "switch.proj",
  receiver_entity: "media_player.avr",
  pool_switch: "switch.pool", pool_heater: "water_heater.pool",
  spa_switch: "switch.spa", spa_heater: "water_heater.spa",
  water_actions: [{ name: "Spa on", script: "script.spa_on" }],
  locks: [{ entity: "lock.l" }],
  alert_sensors: ["binary_sensor.d"],
  cameras: [{ entity: "camera.c" }],
  readings: [{ entity: "sensor.srv", name: "Server" }],
  gates: [{ name: "West", press: "script.gate_west" }],
  remotes: [{ name: "Apple TV" }],
  /* keyed by CHIP_SPECS key, which is what the Chips panel writes - not
     by the template's field name, which is a different spelling */
  chips: { light_entities: { color: "#ffcc00" } },
  sections: ["lights", "climate"],
};

const on = {
  "light.a": { state: "on", attributes: { friendly_name: "A" } },
  "light.b": { state: "on", attributes: { friendly_name: "B" } },
  "switch.sh": { state: "on", attributes: { friendly_name: "Shade" } },
  "fan.f": { state: "on", attributes: { friendly_name: "Fan" } },
  "switch.bf": { state: "on", attributes: { friendly_name: "Bath fan" } },
  "switch.fo": { state: "on", attributes: { friendly_name: "Fountain" } },
  "climate.c": { state: "heat", attributes: { friendly_name: "Thermostat",
    hvac_action: "heating", current_temperature: 68, temperature: 72 } },
  "switch.z": { state: "on", attributes: { friendly_name: "Zone" } },
  "media_player.ma": { state: "playing", attributes: { friendly_name: "Music",
    media_title: "Song", media_artist: "Band" } },
  "media_player.tv": { state: "on", attributes: { friendly_name: "TV" } },
  "switch.proj": { state: "off", attributes: { friendly_name: "Projector" } },
  "media_player.avr": { state: "on", attributes: { friendly_name: "Receiver" } },
  "switch.pool": { state: "on", attributes: { friendly_name: "Pool" } },
  "water_heater.pool": { state: "Gas Heater", attributes: { friendly_name: "Pool heater",
    current_temperature: 80, temperature: 90 } },
  "switch.spa": { state: "on", attributes: { friendly_name: "Spa" } },
  "water_heater.spa": { state: "Gas Heater", attributes: { friendly_name: "Spa heater",
    current_temperature: 100, temperature: 102 } },
  "lock.l": { state: "unlocked", attributes: { friendly_name: "Front door" } },
  "binary_sensor.d": { state: "on", attributes: { friendly_name: "Door",
    device_class: "door" } },
  "camera.c": { state: "idle", attributes: { friendly_name: "Camera" } },
  "sensor.t": { state: "71.5", attributes: { friendly_name: "Room temp",
    device_class: "temperature", unit_of_measurement: "°F" } },
  "sensor.srv": { state: "92.5", attributes: { friendly_name: "Server temp",
    device_class: "temperature", unit_of_measurement: "°F" } },
};

const hass = () => ({
  states: JSON.parse(JSON.stringify(on)),
  config: { unit_system: { temperature: "°F" } },
});

module.exports = { room, on, hass };
