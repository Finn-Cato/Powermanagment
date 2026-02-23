# Power Guard for Homey

**Protect your home against exceeding your power limit.**

Power Guard monitors your household power consumption in real-time using a HAN meter and automatically controls devices when you approach your grid limit — preventing costly peak penalties and tripped breakers.

> ⚠️ **Trial version** — use at your own risk. Please report bugs on the [Issues page](https://github.com/Finn-Cato/Powermanagment/issues).

## Supported Hardware

| Type | Supported |
|------|-----------|
| **EV Charger** | Easee Home, Easee Pro |
| **Power Meter** | Any HAN meter with `measure_power` (Frient, Futurehome, Tibber Pulse, Aidon, Kaifa, etc.) |
| **Thermostats** | Any brand — auto-detects capabilities (Futurehome, Z-Wave, Zigbee, etc.) |

*More charger brands will be added in future releases.*

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
- Dynamic EV charger current based on available power
- Thermostat control with inline stepper and live temperature
- Protection profiles: Normal and Strict (90% of limit)
- Per-phase ampere limits (L1/L2/L3)
- Spike filtering and configurable reaction speed
- Flow cards for Homey automations

## Settings Page

The app has five tabs in the settings page:

| Tab | What it does |
|-----|-------------|
| **⚙️ Settings** | Live status, power limit, protection mode, activity log |
| **📱 Devices** | Enable/disable devices, set priority order and actions |
| **📊 System** | Electrical system config, charger details, test buttons |
| **⚡ Power** | Real-time power consumption per device |
| **🌡️ Heaters** | Thermostat control — temperature, on/off, live readings |

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
| Temperature | Lowers target temperature |
| Charge Pause | Pauses EV charging |
| Dynamic Current | Adjusts charger current limit |

> **⚡ EV Charger Setup:** To use EV charger features, go to the **Devices** tab, enable your charger, and set its action to **Dynamic Current**. Only then will it appear on the Settings and System tabs.

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

## Drivers

| Driver | Purpose |
|--------|---------|
| **Power Guard** | Virtual device — shows current power, limit alarm, guard on/off |
| **EV Charger** | Charger power monitoring and on/off state |
| **Thermostat** | Temperature control, on/off, operating mode (heat/cool/auto/off) |

## Flow Cards

**Triggers:** Power limit exceeded · Mitigation step applied · Mitigation cleared · Profile changed

**Conditions:** Guard enabled/disabled · Power over/under limit · Active profile is [profile]

**Actions:** Enable/disable guard · Set profile · Reset statistics

## License

GPL-3.0
