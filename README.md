# Power Guard for Homey

**Protect your home against exceeding your power limit.**

Power Guard monitors your household power consumption in real-time using a HAN meter and automatically controls devices when you approach your grid limit — preventing costly peak penalties and tripped breakers.

> ⚠️ **Trial version** — use at your own risk. Please report bugs on the [Issues page](https://github.com/Finn-Cato/Powermanagment/issues).

## What's New

| Version | Change |
|---------|--------|
| **0.8.1** | Added: Home / Night / Away / Holiday mode engine with per-device preferences (On/Off, thermostat temp, EV Allow/Pause, Høiax High/Med/Low/Off). Night schedule with 24h time steppers. Compact mode bar UI. |
| **0.7.17** | Fixed: Høiax water heater was turning off immediately instead of stepping down — now correctly steps high → medium → low → off |
| **0.7.16** | Added: Enua charger is now recognised and can be paused/resumed (on/off only — dynamic current stepping not yet supported by Enua's Homey app) |
| **0.7.15** | Fixed: Høiax 2000W model was not being stepped — power stepping now works for both 2kW and 3kW models |
| **0.7.14** | Fixed: EV charger would not restart after pause if less than 7600W of headroom was free — charger now restarts at whatever current the budget allows |

## Supported Hardware

| Type | Supported |
|------|-----------|
| **EV Charger** | Easee Home, Easee Pro, Zaptec Go/Go2/Home/Pro, Enua Charge E |
| **Power Meter** | Any HAN meter with `measure_power` — Frient, Futurehome HAN, Tibber Pulse, Aidon, Kaifa, Easee Equalizer, and more |
| **Thermostats** | Any brand — auto-detects capabilities (Futurehome, Z-Wave, Zigbee, etc.) |
| **Water Heaters** | Hoiax Connected 300/200 — stepped power reduction |

## How It Works

1. **Monitor** — Subscribes to your HAN meter for real-time power readings
2. **Evaluate** — Smooths readings and checks against your power limit
3. **Mitigate** — Turns off devices one-by-one in priority order when over the limit
4. **Restore** — Brings devices back once power drops to a safe level

## Features

- Real-time power data from any HAN electricity meter
- Auto-detects meter brand and installation phase count (1-phase / 3-phase) from HAN sensor
- Live power dashboard per device
- Priority list — drag-and-drop ordering of which devices to turn off first
- Multiple actions — turn off, dim, lower temperature, pause charging, or dynamically adjust charger current
- Automatic restore when power is safe again
- Protection profiles: Normal and Strict (95% of limit)
- Per-phase ampere limits (L1/L2/L3)
- Spike filtering and configurable reaction speed
- Flow cards for Homey automations

### EV Charger Control

- **Dynamic current adjustment** — continuously adjusts charger current based on available power headroom
- **Auto phase detection** — detects 1-phase vs 3-phase from the charger's live power/current ratio; no manual config needed
- **Confirmation tracking** — verifies commands by reading the charger's `measure_current.offered` capability, with per-charger reliability scoring
- **Smart throttle** — adjusts faster when the charger confirms commands (15s), waits longer when unconfirmed (45s), and responds immediately in emergencies (5s)
- **Start threshold** — requires 11A of headroom before restarting a paused charger, preventing rapid on/off cycling
- **Minimum current** — keeps chargers at 7A minimum instead of pausing, so the car stays charging
- **Circuit current control** — manages both `target_charger_current` and `target_circuit_current` on Easee chargers for reliable control
- **Disconnected car detection** — uses a whitelist of charger statuses to detect when no car is connected, skipping unnecessary adjustments
- **Retry with backoff** — retries failed commands up to 2 times with increasing delays
- **Pending command tracking** — prevents sending new commands while a previous command is still being processed
- **Zaptec support** — detects Zaptec chargers (Go, Go2, Home, Pro) via the `charging_button` capability for charge pause/resume
- **Enua support** — detects Enua Charge E chargers and supports pause/resume (on/off). Dynamic current stepping is not yet available as the Enua Homey app does not expose a current-control capability.
- **Multi-brand** — works with Easee (`target_charger_current` / `target_circuit_current`), Zaptec (`charging_button` / Flow API), and Enua (`toggleChargingCapability`) control methods

### Thermostat Control

- Auto-detects thermostat capabilities (on/off, target temperature, or both)
- Lowers by 3°C during mitigation instead of turning off completely
- Cross-fallback: if `target_temperature` isn't available, falls back to `onoff` (and vice versa)
- Automatic restore to previous temperature when power is safe

### Mode Engine (Home / Night / Away / Holiday)

- Four modes: **Home**, **Night**, **Away**, **Holiday** — switch manually or automatically
- **Night schedule** — automatically switches between Home and Night at chosen times (24h time steppers, ▲/▼ in 10-min steps)
- **Per-device preferences per mode:**
  - On/Off devices → On / Off / — (leave as-is)
  - Thermostats → target temperature stepper
  - EV chargers → Allow / Pause / —
  - Høiax water heaters → High / Medium / Low / Off / —
- Active mode shown with orange highlight on the mode bar
- Mode changes fire a Homey flow trigger (`mode_changed`)
- Mode engine always respects Power Guard mitigation — won't restore a device that is currently being throttled

### Effekttariff Tracking (Capacity Tariff)

- Tracks hourly energy consumption using trapezoidal integration
- Records the highest hourly average (kW) per day — the daily peak
- Calculates the monthly capacity metric: average of the 3 highest daily peaks (TOP3 average)
- Maps to Norwegian grid tariff tiers: 0–2, 2–5, 5–10, 10–15, 15–20, 20–25, ≥25 kW
- Displays current hour running average, projected end-of-hour kWh, today's peak, top 3 peaks with medals, and current tier
- Data persists across restarts and auto-cleans at month boundaries

## Getting Started

Before Power Guard can protect your home, complete these steps:

### 1. Set Your Power Limit

Go to the **Settings** tab and enter your grid connection limit in watts (e.g. 10 000 W). This is the maximum power your household is allowed to draw.

### 2. Enable Devices

Go to the **Devices** tab and toggle on the devices you want Power Guard to control. Drag them into priority order — devices at the bottom are turned off first during overload.

### 3. Set Up EV Chargers (if applicable)

For EV chargers, set the action to **Dynamic Current** on the Devices tab. This enables smart current control and makes the charger visible on the System tab.

Then go to the **System** tab to view your chargers under **Managed Chargers**:

- **Phase configuration** — Shows detected phases (1-phase or 3-phase) per charger. The app auto-detects this from the charger's live power/current ratio. You can override manually as a fallback.
- **Per-charger circuit limit** — Set the circuit breaker limit for each charger (6–32 A).
- **Total summary** — See the combined amperage and power capacity of all your chargers at a glance.

No manual electrical system configuration is needed — Power Guard auto-detects the installation phase count from your HAN sensor.

### 4. Activate the Guard

On the **Settings** tab, make sure "Guard active" is turned on. Choose a protection profile (Normal or Strict) and you're ready to go.

## Settings Page

The app has six tabs in the settings page:

| Tab | What it does |
|-----|-------------|
| **⚙️ Settings** | Live status, power limit, protection mode, effekttariff tracking, activity log, mitigation scan |
| **📱 Devices** | Enable/disable devices, set priority order and actions |
| **🏠 Modes** | Home/Night/Away/Holiday mode engine — activate modes, set night schedule, configure per-device preferences |
| **📊 System** | Power meter selection, HAN diagnostics, managed charger details and test buttons |
| **⚡ Power** | Real-time power consumption per device |
| **🌡️ Heaters** | Thermostat control — temperature, on/off, live readings |
| **📋 Log** | Diagnostic log for remote debugging — filterable by category, copy-to-clipboard, auto-refresh |

### Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| Guard active | On | Enable or disable power monitoring |
| Profile | Normal | Normal or Strict (95% of limit) |
| Maximum power (W) | 10 000 | Your grid connection limit in watts |
| Time before acting (s) | 30 | Cooldown between mitigation steps |
| Phase limits (A) | 0 (off) | Per-phase ampere limits, L1/L2/L3 (0 = disabled) |

**Advanced settings** (collapsed by default):

| Setting | Default | Description |
|---------|---------|-------------|
| Reaction speed | 5 | Moving-average window — lower = faster response |
| Spike ignore threshold | 2× | Ignore readings above this multiple of the average |
| Confirm before acting | 3 | Consecutive over-limit readings before acting |
| Safety buffer | 0% | Reduce effective limit by this % as extra headroom |
| Missing data timeout | 120 s | Force mitigation if no HAN reading for this long (0 = off) |
| Dynamic restore guard | On | Wait 1–5 min before restoring — longer when more of the hour remains |

### Priority List (Devices Tab)

Drag and drop devices to set priority order. Devices at the **bottom** are turned off first. Each device can have one of these actions:

| Action | What it does |
|--------|-------------|
| Turn Off | Switches the device off |
| Dim | Reduces to 10% brightness |
| Lower Thermostat | Lowers target temperature by 3°C |
| Charge Pause | Pauses EV charging (Zaptec/Enua) |
| Dynamic Current | Adjusts charger current limit (Easee/Zaptec/Enua, 7–32A) |
| Stepped Power (Hoiax) | Reduces water heater power one level per cycle (3000W → 1750W → 1250W → off) |

### System Tab

- **Power Meter Selection** — Choose which device to use for live power monitoring, or leave on Auto-detect.
- **HAN Meter Diagnostics** — Live connection status, reading source, raw reading log. Copy diagnostic JSON for support.
- **Managed Chargers** — Per-charger status, phase (auto-detected), circuit limit, max power. Buttons: Sync from charger, Test charger control, Diagnostics.

### Power Tab

Shows real-time power consumption for all devices with `measure_power` capability:
- Current, average, and peak power per device
- Devices sorted by power usage (highest first)
- Power share percentage
- Auto-refreshes every 2 seconds

### Heaters Tab

Controls all detected thermostats in your home:
- Auto-detects any thermostat brand
- Inline stepper to adjust target temperature ( − 20.0 + )
- Live current temperature (auto-refreshes)
- On/off toggle per thermostat
- Orange border shows heaters currently drawing power

### Log Tab

Consolidated diagnostic log for remote debugging:
- Filter by category: HAN, Charger, Mitigation, Energy, Cache, System
- Color-coded category badges for quick scanning
- Copy Filtered or Copy All JSON to clipboard for sharing
- Auto-refresh toggle (5-second interval)
- HAN Meter Summary — connection status, reading source, raw readings
- Last Mitigation Scan — device-by-device results table
- System Info — uptime, power limits, settings summary

### Power Meter / HAN Support

- Auto-detects HAN meters by device class, name, or driver ID
- Supported brands: Frient, Futurehome HAN, Tibber Pulse, Aidon, Kaifa, Easee Equalizer
- **Easee Equalizer** — used as a whole-house power meter via `measure_power`, with per-phase current and voltage monitoring (`measure_current.L1–L3`, `measure_voltage.L1–L3`)
- Active polling fallback (10s) for meters that don't fire frequent events
- Any device with `measure_power` and a meter-like name/class is automatically picked up

## Drivers

| Driver | Purpose |
|--------|---------|
| **Power Guard** | Virtual device — shows current power, limit alarm, guard on/off |
| **EV Charger** | Charger power monitoring and on/off state |

## Flow Cards

**Triggers:** Power limit exceeded · Mitigation step applied · Mitigation cleared · Profile changed

**Conditions:** Guard enabled/disabled · Power over/under limit · Active profile is [profile]

**Actions:** Enable/disable guard · Set profile · Reset statistics

## License

GPL-3.0

---

## Changelog

### v0.5.0
- **Auto-detect charger phases** — phases (1-phase / 3-phase) are now detected automatically from the live power/current ratio. No manual electrical system configuration needed.
- **Simplified charger calc** — available power calculated purely from watt headroom (`limit − usage − 200W`), giving consistently correct results regardless of meter reporting.
- **Settings migration** — on first start after update, `voltageSystem` is automatically reset to `auto` so HAN-based phase detection takes over.
- **Strict profile** — 5% safety margin (95% of your configured power limit).
- **Effekttariff display fix** — current-hour kWh and projected end-of-hour kWh now shown correctly; daily peak comparison uses projected value.
- **EV charger robustness** — non-charger usage clamped to 0 to prevent negative values inflating available headroom.

### v0.3.0 – v0.3.23
UI redesign, heater tab improvements, stale mitigation fixes, auto phase detection from HAN sensor, EV loop crash fix.

### v0.2.22 – v0.2.23
New diagnostic **Log** tab. Enua improvements, Zaptec meter device fix, spike filter lockout fix.

### v0.2.21
Høiax Connected 300/200 stepped power control. Thermostat mitigation lowers by 3°C per cycle.

### v0.2.0 – v0.2.2
Dynamic flow action discovery for Zaptec/Enua. Adax heater power estimation. Fallback to hardcoded flow action IDs.

### v0.1.4 – v0.1.9
Initial release through Zaptec/Enua/Equalizer support. Dynamic current control, per-phase monitoring, HAN auto-detect, priority-based mitigation, Norwegian capacity tariff tracking.

### v0.1.6
Added manual power meter selection on the System tab. Fixed auto-detect falsely matching devices like "Hanna Thermostat". Improved Futurehome HAN and Easee Equalizer support.

### v0.1.5
Added support for Easee Equalizer as HAN meter source and Zaptec charger detection. Expanded per-phase monitoring for Easee devices.

### v0.1.4
Initial release. Real-time power monitoring with HAN meter, smart EV charger control with dynamic current adjustment, thermostat management, priority-based mitigation, and Norwegian capacity tariff tracking.
