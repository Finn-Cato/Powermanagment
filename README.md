# Power Guard for Homey

**Protect your home against exceeding your power limit.**

Power Guard monitors your household power consumption in real-time via a HAN meter (e.g. Frient Electricity Meter) and automatically turns off or dims devices when you approach your grid connection limit — preventing costly peak penalties and tripped breakers.

## Features

- **Real-time HAN meter monitoring** — Reads live power data from your HAN-connected meter
- **Priority-based device control** — Define which devices to turn off first via a drag-and-drop priority list
- **Multiple protection profiles** — Normal, Strict (90% of limit), and Solar-friendly modes
- **EV charger support** — Dedicated driver for EV chargers with dynamic current control
- **Per-phase current limits** — Optional ampere limits for individual phases (L1/L2/L3)
- **Spike filtering** — Moving-average smoothing and spike detection to avoid false triggers
- **Automatic restore** — Devices are restored once power drops back under the limit
- **Flow card support** — Triggers, conditions, and actions for Homey's Flow automation engine
- **Settings page** — Full in-app configuration with live status, device management, and mitigation log

## How It Works

1. **Monitor** — Power Guard subscribes to your HAN meter's `measure_power` capability for real-time readings.
2. **Evaluate** — Readings are smoothed (moving average) and checked against your configured power limit, adjusted by the active profile factor.
3. **Mitigate** — If power exceeds the limit for a configurable number of consecutive readings, devices are turned off one-by-one in priority order (lowest priority first).
4. **Restore** — Once power drops safely below the limit, mitigated devices are restored in reverse order.

## Installation

### From Homey App Store
*(Coming soon)*

### Manual Install (Developer)

Requires [Homey CLI](https://developer.athom.com/tools/cli):

```bash
npm install -g homey
homey login
cd Powermanagment
npm install
homey app install
```

## Configuration

Open the Power Guard settings page in the Homey app to configure:

| Setting | Default | Description |
|---------|---------|-------------|
| **Guard active** | ✅ On | Enable/disable power monitoring |
| **Profile** | Normal | Protection mode: Normal, Strict (90%), Solar-friendly |
| **Maximum power (W)** | 10,000 | Your grid connection limit in watts |
| **Seconds before acting** | 30 | Cooldown between mitigation steps |
| **Readings before acting** | 3 | Consecutive over-limit readings before mitigation |
| **Smoothing window** | 5 | Moving-average window size |
| **Spike threshold** | 2× | Readings above this multiple of average are ignored |
| **Phase limits (A)** | 0 (off) | Per-phase ampere limits (0 = disabled) |

### Priority List

In the **Devices** tab, drag and drop your controllable devices into a priority order. Devices at the **bottom** of the list are turned off first. Each device can be assigned a mitigation action:

- **Turn Off** (`onoff`) — Switches the device off completely
- **Dim** (`dim`) — Reduces to 10% brightness
- **Temperature** (`target_temperature`) — Lowers target temperature
- **Charge Pause** (`charge_pause`) — Pauses EV charging
- **Dynamic Current** (`dynamic_current`) — Adjusts charger current limit

## Drivers

### Power Guard (Virtual Device)
A virtual device that exposes:
- `measure_power` — Current household power consumption
- `alarm_generic` — Power limit exceeded alarm
- `onoff` — Enable/disable the guard

### EV Charger
Dedicated driver for EV chargers with:
- `measure_power` — Charger power consumption
- `onoff` — Charging state

## Flow Cards

### Triggers
- **Power limit exceeded** — Fires when power goes over the configured limit
- **Mitigation step applied** — Fires each time a device is turned off/dimmed
- **Mitigation cleared** — Fires when all mitigated devices are restored
- **Profile changed** — Fires when the active profile changes

### Conditions
- **Power Guard is enabled/disabled**
- **Power is over/under limit**
- **Active profile is/is not [profile]**

### Actions
- **Enable Power Guard**
- **Disable Power Guard**
- **Set profile to [profile]**
- **Reset statistics**

## Project Structure

```
Powermanagment/
├── app.js                  # Main app — HAN monitoring, mitigation engine
├── app.json                # App manifest, API routes, drivers, flow cards
├── api.js                  # REST API endpoints for settings page
├── package.json
├── assets/
│   └── icon.svg
├── common/
│   ├── constants.js        # Profiles, defaults, action types
│   ├── devices.js          # Device control helpers (apply/restore actions)
│   └── tools.js            # Utility functions (moving average, spike detection)
├── drivers/
│   ├── power-guard/        # Virtual Power Guard device driver
│   │   ├── device.js
│   │   └── driver.js
│   └── ev-charger/         # EV Charger device driver
│       ├── device.js
│       └── driver.js
├── locales/
│   ├── en.json
│   └── no.json
└── settings/
    └── index.html          # Custom settings page (app configuration UI)
```

## Tech Stack

- **Homey SDK v3** (compatibility ≥ 8.0.0)
- **Node.js** ≥ 16
- **homey-api** — Homey Web API client
- **async-mutex** — Mutex for thread-safe mitigation

## License

GPL-3.0
