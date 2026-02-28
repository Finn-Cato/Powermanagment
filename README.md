# Power Guard for Homey

**Protect your home against exceeding your power limit.**

Power Guard monitors your household power consumption in real-time using a HAN meter and automatically controls devices when you approach your grid limit — preventing costly peak penalties and tripped breakers.

> ⚠️ **Trial version** — use at your own risk. Please report bugs on the [Issues page](https://github.com/Finn-Cato/Powermanagment/issues).

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
- Auto-detects meter brand
- Live power dashboard per device
- Priority list — drag-and-drop ordering of which devices to turn off first
- Multiple actions — turn off, dim, lower temperature, pause charging, or dynamically adjust charger current
- Automatic restore when power is safe again
- Protection profiles: Normal and Strict (90% of limit)
- Per-phase ampere limits (L1/L2/L3)
- Spike filtering and configurable reaction speed
- Flow cards for Homey automations

### EV Charger Control

- **Dynamic current adjustment** — continuously adjusts charger current based on available power headroom
- **Proportional scaling** — uses the charger's actual offered current and power draw for smoother, more accurate adjustments
- **Confirmation tracking** — verifies commands by reading the charger's `measure_current.offered` capability, with per-charger reliability scoring
- **Smart throttle** — adjusts faster when the charger confirms commands (15s), waits longer when unconfirmed (45s), and responds immediately in emergencies (5s)
- **Main fuse protection** — caps charger power allocation at the physical fuse limit to prevent tripping the main breaker
- **Start threshold** — requires 11A of headroom before restarting a paused charger, preventing rapid on/off cycling
- **Minimum current** — keeps chargers at 7A minimum instead of pausing, so the car stays charging
- **Circuit current control** — manages both `target_charger_current` and `target_circuit_current` on Easee chargers for reliable control
- **Disconnected car detection** — uses a whitelist of charger statuses to detect when no car is connected, skipping unnecessary adjustments
- **Retry with backoff** — retries failed commands up to 2 times with increasing delays
- **Pending command tracking** — prevents sending new commands while a previous command is still being processed
- **Zaptec support** — detects Zaptec chargers (Go, Go2, Home, Pro) via the `charging_button` capability for charge pause/resume
- **Enua support** — detects Enua Charge E chargers with dynamic current control (6–32 A) and pause/resume via Flow API
- **Multi-brand** — works with Easee (`target_charger_current` / `target_circuit_current`), Zaptec (`charging_button` / Flow API), and Enua (Flow API) control methods

### Thermostat Control

- Auto-detects thermostat capabilities (on/off, target temperature, or both)
- Lowers by 3°C during mitigation instead of turning off completely
- Cross-fallback: if `target_temperature` isn't available, falls back to `onoff` (and vice versa)
- Automatic restore to previous temperature when power is safe

### Effekttariff Tracking (Capacity Tariff)

- Tracks hourly energy consumption using trapezoidal integration
- Records the highest hourly average (kW) per day — the daily peak
- Calculates the monthly capacity metric: average of the 3 highest daily peaks (TOP3 average)
- Maps to Norwegian grid tariff tiers: 0–2, 2–5, 5–10, 10–15, 15–20, 20–25, ≥25 kW
- Displays current hour running average, today's peak, top 3 peaks with medals, and current tier
- Data persists across restarts and auto-cleans at month boundaries
- Currently display-only (test mode) — does not affect limits or mitigation

## Getting Started

Before Power Guard can protect your home, complete these steps:

### 1. Set Your Power Limit

Go to the **Settings** tab and enter your grid connection limit in watts (e.g. 10 000 W). This is the maximum power your household is allowed to draw.

### 2. Enable Devices

Go to the **Devices** tab and toggle on the devices you want Power Guard to control. Drag them into priority order — devices at the bottom are turned off first during overload.

### 3. Set Up EV Chargers (if applicable)

For EV chargers, set the action to **Dynamic Current** on the Devices tab. This enables smart current control and makes the charger visible on the System tab.

Then go to the **System** tab to configure your chargers under **Managed Chargers**:

- **Main circuit breaker** — Set the max amperage for your charger circuit (e.g. 25 A or 32 A). This caps how much current each charger can draw.
- **Per-charger phase configuration** — Each charger can be set independently to **1-phase** or **3-phase**. For example, if you have two chargers and one is wired for single-phase while the other uses three-phase, you can configure them individually.
- **Per-charger circuit limit** — Set the circuit breaker limit for each charger (6–32 A).
- **Max power calculation** — The app automatically calculates the maximum power each charger can use based on its phase setting and circuit limit. A 3-phase charger at 32 A gives ~22.1 kW, while a 1-phase charger at 16 A gives ~3.7 kW.
- **Total summary** — See the combined amperage and power capacity of all your chargers at a glance.

This setup ensures Power Guard knows exactly how much power your chargers can use, so it can distribute available capacity correctly during dynamic current control.

### 4. Activate the Guard

On the **Settings** tab, make sure "Guard active" is turned on. Choose a protection profile (Normal or Strict) and you're ready to go.

## Settings Page

The app has six tabs in the settings page:

| Tab | What it does |
|-----|-------------|
| **⚙️ Settings** | Live status, power limit, protection mode, EV charger status, effekttariff tracking, activity log, mitigation scan |
| **📱 Devices** | Enable/disable devices, set priority order and actions |
| **📊 System** | Electrical system config, charger details, test buttons |
| **⚡ Power** | Real-time power consumption per device |
| **🌡️ Heaters** | Thermostat control — temperature, on/off, live readings |
| **📋 Log** | Diagnostic log for remote debugging — filterable by category, copy-to-clipboard, auto-refresh |

### Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| Guard active | On | Enable or disable power monitoring |
| Profile | Normal | Normal or Strict (90% of limit) |
| Maximum power (W) | 10 000 | Your grid connection limit in watts |
| Seconds before acting | 30 | Cooldown between mitigation steps |
| Readings before acting | 3 | Consecutive over-limit readings needed |
| Smoothing window | 5 | Moving-average window size |
| Spike threshold | 2× | Ignore readings above this multiple of average |
| Phase limits (A) | 0 (off) | Per-phase ampere limits (0 = disabled) |

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

### v0.3.23
Fix: illegal continue crash in EV charger adjustment loop caused by a premature closing brace during Enua consolidation. Multi-brand dispatch (Easee / Enua / Zaptec) correctly restored inside the loop.

### v0.3.21
Per-phase current control for EV chargers: reads live per-phase amps (A/B/C) from the HAN sensor and uses them directly to calculate available charger current. Falls back to wattage-based calculation when phase data is unavailable. Auto-detects electrical phase count from HAN sensor — no more manual voltageSystem setting required.

### v0.3.0 – v0.3.2
UI redesign, heater tab improvements, stale mitigation fixes, store submission prep.

### v0.2.23
Enua improvements, Zaptec meter device fix, spike filter lockout fix.

### v0.2.22
New diagnostic **Log** tab for remote debugging: consolidated app log with category filters (HAN, Charger, Mitigation, Energy, Cache, System), color-coded badges, copy-to-clipboard, auto-refresh, HAN meter summary, mitigation scan results, and system info.

### v0.2.21
Høiax Connected 300/200 stepped power control: new action reduces water heater power one level per mitigation cycle (3000W → 1750W → 1250W → off). Driver icons updated. Thermostat mitigation now lowers by 3°C per cycle instead of stepping down to 5°C.

### v0.2.2
Adax heater power estimation: detects when Adax reports constant rated wattage and estimates actual power from temperature state. Thermostat mitigation changed from setting to 5°C to lowering by 3°C from current target.

### v0.2.1
Fixed Zaptec and Enua dynamic current control on Homey setups where `getFlowCardActions()` does not enumerate app flow cards. Falls back to hardcoded known action IDs (`installation_current_control` / `changeCurrentLimitAction`).

### v0.2.0
Dynamic flow action discovery: automatically finds the correct Flow action ID for Zaptec and Enua chargers at runtime. Improved test charger diagnostics with detailed Flow API reporting.

### v0.1.9
Added dynamic current control for Zaptec and Enua chargers via Homey Flow API. Auto-detects charger brand and routes to correct handler. Full Enua Charge E support with pause/resume and status monitoring.

### v0.1.8
Fixed charger test diagnostic for Zaptec Go: now correctly detects `charging_button` capability.

### v0.1.7
Fixed Easee Equalizer showing 0W: reads initial power value immediately on connect, faster first poll (2s), robust number handling for cloud-based meters.

### v0.1.6
Added manual power meter selection on the System tab. Fixed auto-detect falsely matching devices like "Hanna Thermostat". Improved Futurehome HAN and Easee Equalizer support.

### v0.1.5
Added support for Easee Equalizer as HAN meter source and Zaptec charger detection. Expanded per-phase monitoring for Easee devices.

### v0.1.4
Initial release. Real-time power monitoring with HAN meter, smart EV charger control with dynamic current adjustment, thermostat management, priority-based mitigation, and Norwegian capacity tariff tracking.
