# Changelog

## v0.7.18 (2026-03-08)
- Added Home / Night / Away / Holiday mode engine
- Night schedule with 24-hour time steppers (▲/▼, 10-min steps) and schedule type selector
- Per-device preferences per mode: On/Off for switches, target temperature for thermostats, Allow/Pause for EV chargers, High/Med/Low/Off for Høiax water heaters
- Active mode shown with orange highlight on mode buttons
- EV charger mode control supports both `onoff` and `toggleChargingCapability`
- Høiax water heater uses correct power-level steps (not temperature)
- Mode engine respects Power Guard mitigation — won't restore a device currently being throttled
- UI: compact single-row mode bar, compact Night Schedule card
