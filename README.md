# Power Guard for Homey

**Protect your home against exceeding your power limit.**

Power Guard monitors your household power consumption in real-time via a HAN meter (e.g. Frient Electricity Meter) and automatically turns off or dims devices when you approach your grid connection limit — preventing costly peak penalties and tripped breakers.

## ⚠️ Trial Version Notice

This app is currently in **trial version**. Users install and use it **at their own risk**. While we strive to ensure reliability, there may be bugs or unexpected behavior. Your feedback is greatly appreciated to help identify and fix errors. Please report any issues you encounter.

## Supported Hardware

**Current Release:**
- **EV Charger:** Easee charger only (Easee Home & Easee Pro)
- **Power Meter:** Auto-detects any HAN electricity meter:
  - ✅ Frient Electricity Meter
  - ✅ Futurehome HAN
  - ✅ Tibber Pulse
  - ✅ Aidon HAN
  - ✅ Kaifa HAN
  - ✅ Any other meter with `measure_power` capability
- **Thermostats:** Auto-detects any thermostat with temperature capabilities:
  - ✅ Futurehome thermostats
  - ✅ Any thermostat with `target_temperature` / `measure_temperature`
  - ✅ Cross-brand support (auto-detects `set_temperature`, `setpoint_temperature`, `heating_setpoint`, etc.)

*Additional chargers and HAN devices will be added in future releases.*

## Features

- **Real-time power monitoring** — Auto-detects and reads live power data from any HAN electricity meter (Frient, Futurehome, Tibber, Aidon, Kaifa, etc.)
- **Multi-brand HAN support** — Automatically identifies connected meter brand and displays it in the System tab
- **Power consumption dashboard** — Power tab shows real-time power usage by device with current, average, and peak values
- **Device power tracking** — Monitors all devices with power capabilities including floor heaters, EV chargers, and appliances
- **Floor heater control** — Compact single-line thermostat rows with slide toggle, live temperature, and target temperature input
- **Thermostat driver** — Dedicated driver to pair and control thermostats as Homey devices with real-time subscriptions
- **Dark mode support** — Automatic dark mode via CSS `prefers-color-scheme` media query with JS fallback
- **Dynamic EV charging control** — Automatically adjusts charger current based on available household power
- **Priority-based device control** — Define which devices to turn off first via a drag-and-drop priority list
- **Multiple protection profiles** — Normal and Strict (90% of limit) modes
- **Per-phase current limits** — Optional ampere limits for individual phases (L1/L2/L3)
- **Spike filtering** — Moving-average smoothing and spike detection to avoid false triggers
- **Automatic restore** — Devices are restored once power drops back under the limit
- **Flow card support** — Triggers, conditions, and actions for Homey's Flow automation engine
- **Settings page** — Full in-app configuration with live status, device management, and mitigation log
- **Pill-style tab navigation** — Wrapping tab bar with icons (⚙️ Settings, 📱 Devices, 📊 System, ⚡ Power, 🌡️ Heaters) — responsive on mobile
- **Debug logging** — Live log viewer for troubleshooting device detection and power tracking

## How It Works

1. **Monitor** — Power Guard subscribes to your HAN meter's `measure_power` capability for real-time readings.
2. **Evaluate** — Readings are smoothed (moving average) and checked against your configured power limit, adjusted by the active profile factor.
3. **Mitigate** — If power exceeds the limit for a configurable number of consecutive readings, devices are turned off one-by-one in priority order (lowest priority first).
4. **Restore** — Once power drops safely below the limit, mitigated devices are restored in reverse order.

## Installation

### 📦 From Homey App Store
*(Coming soon)*

---

### 🛠️ Installing via Homey CLI

Install Power Guard directly on your Homey Pro using the command line.

#### Prerequisites

| Requirement | Link |
|-------------|------|
| **Homey Pro** | Any generation |
| **Node.js** (v16+) | [nodejs.org](https://nodejs.org) |
| **Homey CLI** | Installed via npm (see below) |

#### Step-by-Step

**1. Install Homey CLI**
```bash
npm install -g homey
```

**2. Download the app from GitHub**
- Go to the [Power Guard repository](https://github.com/Finn-Cato/Powermanagment)
- Make sure you're on the `master` branch
- Click **Code** → **Download ZIP**
- Extract the ZIP to a folder on your computer

**3. Log in to your Homey**
```bash
homey login
```
> This opens a browser window — sign in with your Athom account.

**4. Select your Homey device**
```bash
homey select
```
> Pick the Homey Pro you want to install the app on.

**5. Navigate to the extracted app folder**
```bash
cd path/to/Powermanagment
```

**6. Install dependencies**
```bash
npm install
```

**7. Install the app on Homey** 🚀
```bash
homey app install
```
> The app will be compiled and pushed to your Homey. Once done, you'll find **Power Guard** in the Homey app list.

#### 🧪 Optional: Run in Development Mode

Want live logs and instant reloads during development?

```bash
homey app run
```
> Press `Ctrl+C` to stop. The app will be removed from Homey when you exit dev mode.

---

> **💡 Quick download:** Grab the latest release ZIP from the [Releases page](https://github.com/Finn-Cato/Powermanagment/releases) and follow the steps above.

## Configuration

Open the Power Guard settings page in the Homey app to configure:

| Setting | Default | Description |
|---------|---------|-------------|
| **Guard active** | ✅ On | Enable/disable power monitoring |
| **Profile** | Normal | Protection mode: Normal or Strict (90% of limit) |
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

### Power Consumption Dashboard

The **Power** tab provides real-time visibility into which devices are consuming power:

- **Live power usage table** — Shows current, average, and peak power for each device
- **Device ranking** — Devices sorted by current power consumption (highest first)
- **Power share percentage** — See what percentage of total power each device uses
- **Auto-refresh** — Updates every 2 seconds for real-time monitoring
- **Smart filtering** — Automatically excludes lights, dimmers, Power Guard itself, and meters
- **Debug log** — Live tracking log for troubleshooting device detection

### Floor Heater Control

The **Heaters** tab provides direct control over all detected thermostats in a compact single-line layout:

- **Auto-detection** — Scans all devices for thermostat capabilities using live HomeyAPI (class `thermostat`, `heater`, or name matching)
- **Cross-brand support** — Works with Futurehome, Z-Wave, Zigbee, and any thermostat brand by detecting capability name variants
- **Compact row design** — Each thermostat on one line: name, current temperature, target input, Set button, and slide on/off toggle
- **Live readings** — Shows current temperature from the device in real-time (2s refresh)
- **Slide toggle** — On/off control via a slide switch, same style as other Homey toggles
- **Active power indicator** — Orange border highlights thermostats currently drawing power
- **Temperature control** — Inline number input with Set button to change target temperature
- **Zone/brand display** — Shows zone name or manufacturer/driver name when zone is unavailable
- **Capability-based** — Uses live HomeyAPI (`device.setCapabilityValue()`) for reliable control

All devices with `measure_power` capability are available for tracking. You can choose which devices to include and sort them by priority in the Devices tab.

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

### Thermostat
Dedicated driver for floor heaters and thermostats with:
- `target_temperature` — Target temperature (5–35°C, step 0.5)
- `measure_temperature` — Current measured temperature
- `onoff` — Heater on/off state
- `thermostat_mode` — Operating mode (heat, cool, auto, off)

Auto-discovers thermostats during pairing via HomeyAPI. Supports any thermostat brand by auto-detecting capability name variants (`target_temperature`, `set_temperature`, `setpoint_temperature`, `heating_setpoint`, `desired_temperature`).

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
│   ├── ev-charger/         # EV Charger device driver
│   │   ├── device.js
│   │   └── driver.js
│   └── thermostat/         # Thermostat device driver (floor heaters, etc.)
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
