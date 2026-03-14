# Changelog

## v0.8.28 (2026-03-14)
- Mode buttons: loading spinner (⏳) shown while API call is in progress — button disabled during request to prevent double-press
- README: full rewrite with complete feature documentation, EV charger setup guide, and charging hours calculation explained
- Docs: added step-by-step EV setup (battery size, target %, car device, circuit limit, deadline) and formula for hours-needed calculation

## v0.8.27 (2026-03-14)
- HAN meter auto-detection: fixed wrong device being selected when multiple meter-like devices exist — now picks the one with highest current power reading (Frient Smart Reader preferred over Futurehome dongle reporting 0 W)
- Active Mode buttons: fixed ❄️ Holiday button appearing taller than others — reduced font/padding, added non-breaking space to prevent emoji/text line-break
- EV charger: added "Car connected" as a recognized connected status in `_isCarConnected()`
- Thermostat mode: handle `target_temperature = 'off'` (some thermostats use string "off" instead of null)
- API: `batteryFull` threshold raised to ≥ 99%, `displayCharging` separated from `effectiveCharging` for grace-period logic

## v0.8.25 (2026-03-11)
- Car device picker: link a car Homey device to each EV charger — Power Guard reads battery % automatically on plug-in and every 30 min, no Flow required
- Zaptec fix: corrected Flow action ID (`set_installation_current`) and fixed 1-phase (TN) chargers — P2 and P3 now correctly sent as 0A
- Fixed "CAR CHARGING NOW" incorrectly showing No when car is charging — now checks charger status capability as well as power draw
- Norgespris flat-rate fix: charger no longer stuck in paused mode when all prices are equal (spread = 0)
- Smart Charging Status: "Next cheap hour" shows "All equal" instead of — when Norgespris flat rate is active
- Last battery reports panel now always visible with placeholder text

## v0.8.14 (2026-03-08)
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
