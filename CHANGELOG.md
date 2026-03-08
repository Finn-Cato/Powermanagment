# Changelog

## v0.8.13 (2026-03-08)
- UI: Settings and System moved into Overview tab as sub-tabs (🏠 Overview / ⚙️ Settings / 📊 System) — reduces main tab bar clutter
- Smart tab and Heaters tab are now mutually exclusive: Smart tab visible only when Smart Price Control is ON, Heaters tab visible only when OFF
- Active Mode card hidden on Overview when Smart Price Control is OFF
- Thermostat temperature control fixed: dual-format `setCapabilityValue` (object-style with string-style fallback) handles homey-api version differences
- `_applyMode` now accepts optional `filterDeviceId` — changing a single device pref only re-applies that device, preventing EV chargers from being triggered on every thermostat click
- All `controlFloorHeater` errors now surfaced in Log tab (Charger filter) instead of silent `this.log()` calls
- EV charger "Charger is disconnected" errors no longer spam the log on every mode pref change

## v0.7.18 (2026-03-08)
- Added Home / Night / Away / Holiday mode engine
- Night schedule with 24-hour time steppers (▲/▼, 10-min steps) and schedule type selector
- Per-device preferences per mode: On/Off for switches, target temperature for thermostats, Allow/Pause for EV chargers, High/Med/Low/Off for Høiax water heaters
- Active mode shown with orange highlight on mode buttons
- EV charger mode control supports both `onoff` and `toggleChargingCapability`
- Høiax water heater uses correct power-level steps (not temperature)
- Mode engine respects Power Guard mitigation — won't restore a device currently being throttled
- UI: compact single-row mode bar, compact Night Schedule card
