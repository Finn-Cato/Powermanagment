# Changelog

## v0.8.47 (2026-03-23)
- Removed Easee Test Lab diagnostic panel (served its purpose during charger debugging)

## v0.8.46 (2026-03-23)
- Fix: charger pause/resume ping-pong — 30s resume immunity window + 5s pre-ON delay prevents immediate re-pause from Easee ON-sequence power spike
- Fix: step oscillation (7↔8A) — 15s step-down cooldown prevents rapid back-and-forth when power hovers near limit
- Fix: confirmation timing for Easee — 8s minimum wait + 40s timeout accounts for delayed `measure_current.offered` updates
- Fix: false learned-max disabled when using `target_charger_current` (delayed confirm driver)
- Fix: HAN poll fallback log spam — only logs on enter/exit of fallback mode, not every 10s
- Fix: HAN diagnostics crash (t is not a function) — renamed shadowed variable
- Easee Test Lab: new diagnostic panel on System tab to view and test all charger capabilities with live read/write
- Devices tab: collapsible priority help with example list showing how to prioritise EV charging
- Devices tab: description updated from "Drag ☰" to "Use ↑↓ arrows" to match actual UI
- Translations: Modi→Modus (correct Norwegian), action names cleaned (removed brand names), smart charging logic section translated
- Removed unused Dim action from device dropdown

## v0.8.34 (2026-03-16)
- Fix: Charger Mode in Price tab now shows — when no car is connected or all connected cars are fully charged (was incorrectly showing Fast charge)
- Fix: chargeMode suppression now checks all entries with a linked car device, not just priceControlled entries — covers setups where chargers are managed without priceControlled flag
- Fix: disconnected cars (not plugged into charger) are now treated as "done" and no longer block the — display when other cars are full
- Fix: finalMode declared as let instead of const — previous const declaration silently crashed the price evaluation on every cycle, breaking Charger Mode display and Norgespris toggle
- Fix: Norgespris toggle now saves and reflects correctly after the price evaluation crash was resolved
- Fix: opening the Smart tab now triggers an immediate price re-evaluation so the display is always fresh
- Modes tab: thermostat rows now have explicit On / Off / — buttons plus a separate +/− stepper
- Modes tab: On button restores the last remembered temperature when turning a thermostat back on
- Modes tab: device commands (on/off/setTarget) only fire when editing the currently active mode — switching to another mode tab no longer controls physical devices
- Modes tab: water heater (onoff action) now shows live watt usage in Device Preferences
- Modes tab: active mode tab has orange text; selected (viewed) tab has an orange underline
- Smart tab: Power tab is now hidden when Smart Price Control is on

## v0.8.33 (2026-03-15)
- Fix: voltageSystem fallback corrected from '230v-1phase' to 'auto' — customers who had the old manual value stored were stuck on wrong voltage after migration
- Fix: settings page no longer reloads the old stored voltageSystem value, so saving always writes 'auto' and self-heals misconfigured installs
- EV Charger Preferences: each charger now shows its detected phase count (· 1-phase (230V) / · 3-phase (400V)) under the charger name
- Charger Mode hint for Slow charge changed from "price is moderate" to "no deadline set" — accurately reflects why the charger slow-charges during expensive hours
- Removed redundant EV Charger virtual device driver (was a proxy device users could pair, now unnecessary as the app controls chargers directly)
- Priority list: fixed inconsistent wording — "top of the list" is turned off first (was incorrectly stated as "bottom" in Help tab and README)

## v0.8.32 (2026-03-14)
- Fix: EV charger not pausing when price mode is Off — `_calculateOptimalChargerCurrent` now returns null immediately when price cap is 0, triggering a proper pause instead of setting 0A (which some charger brands ignored)
- EV status: Price Level on EV tab now shows formatted label (🟢 Cheap / ⚪ Normal / 🟠 Expensive / 🔴 Extreme) matching the Price tab

## v0.8.31 (2026-03-14)
- Help tab: added ❓ Help as a sub-tab under Home (after System) — covers getting started, EV setup, modes, supported hardware, and charger mode reference
- Smart charging: all chargers now share one cheapest-hours window (largest hoursNeeded sets the window size); available current is split equally between chargers
- EV status: each charger card now shows its own Charger Mode — hidden (–) when car is not connected
- Charger Mode labels rewritten: short coloured label + plain-language hint on second line (e.g. "⚡ Fast charge / cheap hour", "⏸ Off / waiting for cheap hour")
- api.js: per-charger chargeMode now included in each charger status entry

## v0.8.30 (2026-03-14)
- EV tab: updated smart charging explanation text to reflect cheapest-hours rule
- EV tab: renamed "Hours needed (manual fallback)" to "Hours needed (if no car device linked)" for clarity
- EV tab: updated "Finish charging by" hint to explain the new cheapest-hours behaviour
- README: updated smart charging section to match new logic

## v0.8.29 (2026-03-14)
- Smart charging: replaced smart-skip logic with cheapest-hours rule — when a deadline is set, Power Guard picks the N cheapest hours before the deadline and charges only during those (Off during all other hours)
- Hysteresis now bypassed when deadline rule is active — prevents hysteresis from overriding the Off decision back to Low during normal-price hours
- Result: Charger Mode shows Off outside cheap window, Max during cheap window

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
