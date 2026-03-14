# Power Guard for Homey

**Protect your home against exceeding your power limit.**

Power Guard monitors your household power consumption in real-time using a HAN electricity meter and automatically controls devices when you approach your grid limit — preventing costly peak penalties and tripped breakers.

> ⚠️ **Trial version** — use at your own risk. Please report bugs on the [Issues page](https://github.com/Finn-Cato/Powermanagment/issues).

---

## What the App Can Do

### Power Guard (Core)
- Real-time power monitoring via any HAN electricity meter
- Automatically turns off / reduces devices when you approach your grid limit
- Brings devices back once consumption drops to a safe level
- Priority list — drag-and-drop to choose which devices are turned off first
- Protection profiles: **Normal** and **Strict** (95% of limit)
- Per-phase ampere limits (L1 / L2 / L3)
- Spike filtering and configurable reaction speed
- Flow cards for Homey automations

### Smart EV Charger Control
- **Dynamic current adjustment** — continuously adjusts charger current based on available headroom
- **Auto phase detection** — detects 1-phase vs 3-phase from live power/current ratio, no manual config needed
- **Car device picker** — link a Homey car device to each charger; battery % is read automatically on plug-in and every 30 min
- **Smart Charging Status panel** — shows car connected, charging now, charge mode, next cheap hour
- **Minimum current** — keeps charger at 7A minimum to avoid stopping the session unnecessarily
- **Start threshold** — requires headroom before restarting a paused charger, prevents rapid on/off cycling
- **Grace window** — 2-minute grace period after confirmed charging before flagging a mismatch
- **Confirmation tracking** — verifies commands by reading `measure_current.offered`, with per-charger reliability scoring
- **Retry with backoff** — retries failed commands up to 2 times with increasing delays
- Supports **Easee**, **Zaptec** (Go / Go2 / Home / Pro), and **Enua Charge E**

### Mode Engine (Home / Night / Away / Holiday)
- Four modes switchable manually from the settings page — no Flow required
- **Night schedule** — auto-switches between Home ↔ Night at chosen times
- **Per-device preferences per mode:**
  - Switches → On / Off / leave as-is
  - Thermostats → target temperature
  - EV chargers → Allow / Pause
  - Høiax water heaters → High / Medium / Low / Off
- Active mode highlighted orange on the mode bar
- Mode changes fire a Homey flow trigger (`mode_changed`)
- Mode engine always respects Power Guard — never restores a device that is currently being throttled

### Thermostat Control
- Auto-detects any thermostat brand (Futurehome, Z-Wave, Zigbee, etc.)
- Lowers temperature by 3°C during mitigation instead of switching off completely
- Inline temperature stepper (−/+) with live current temperature
- On/Off toggle per thermostat
- Heaters tab shows which heaters are currently drawing power (orange border)

### Høiax Water Heater
- Stepped power reduction: 3000 W → 1750 W → 1250 W → Off
- Correct power-level steps via Høiax Connected 300/200 integration

### Effekttariff / Capacity Tariff Tracking
- Tracks hourly energy consumption using trapezoidal integration
- Records the highest hourly average (kW) per day
- Calculates the monthly capacity metric: **average of the 3 highest daily peaks (TOP3)**
- Maps to Norwegian grid tariff tiers: 0–2, 2–5, 5–10, 10–15, 15–20, 20–25, ≥25 kW
- Displays current-hour running average, projected end-of-hour kWh, today's peak, top-3 daily peaks with medals, and current tier

### HAN Meter / Power Meter
- Auto-detects HAN meters by device class, name, or driver ID
- When multiple meter-like devices exist, picks the one with the highest current power reading (avoids selecting unconfigured dongles)
- Active polling fallback every 10 seconds for meters that don't send frequent events
- Manual override: choose a specific meter on the System tab
- Supported brands: **Frient**, **Futurehome HAN**, **Tibber Pulse**, **Aidon**, **Kaifa**, **Easee Equalizer**, and any device with `measure_power`

---

## Supported Hardware

| Type | Supported devices |
|------|-------------------|
| **EV Charger** | Easee Home, Easee Pro, Zaptec Go / Go2 / Home / Pro, Enua Charge E |
| **HAN Meter** | Frient Smart Reader, Futurehome HAN, Tibber Pulse, Aidon, Kaifa, Easee Equalizer — or any device with `measure_power` |
| **Thermostats** | Any brand — auto-detects capabilities |
| **Water Heaters** | Høiax Connected 300 / 200 |

---

## Getting Started

### 1. Set Your Power Limit
Go to **Overview → Settings** and enter your grid connection limit in watts (e.g. `10 000 W`).

### 2. Enable Devices
Go to the **Devices** tab, toggle on the devices you want Power Guard to control, and drag them into priority order. Devices at the **bottom** are turned off first.

### 3. Configure EV Chargers (optional)
Set the action to **Dynamic Current** on the Devices tab. Then open the **System** tab to set the circuit breaker limit per charger and link a car device for battery tracking.

### 4. Activate the Guard
On the **Overview → Settings** sub-tab, make sure **Guard active** is turned on.

---

## Settings Tabs

| Tab | What it shows |
|-----|---------------|
| **🏠 Overview** | Live power status, Active Mode bar, price control toggle — with Settings and System sub-tabs |
| **⚙️ Settings** (sub-tab) | Power limit, protection profile, effekttariff, activity log, mitigation scan |
| **📊 System** (sub-tab) | HAN meter selection & diagnostics, managed charger details, phase config, test buttons |
| **📱 Devices** | Enable/disable devices, priority order, action per device |
| **⚡ Smart** | Smart Price Control settings, Smart Charging Status, EV schedule — visible when Smart Price Control is ON |
| **🌡️ Heaters** | Thermostat control — temperature steppers, on/off, live readings — visible when Smart Price Control is OFF |
| **🏠 Modes** | Home / Night / Away / Holiday mode engine — activate, configure night schedule, set per-device preferences |
| **📋 Log** | Diagnostic log — filterable by category, copy to clipboard, auto-refresh |

---

## Configuration Reference

| Setting | Default | Description |
|---------|---------|-------------|
| Guard active | On | Enable or disable power monitoring |
| Profile | Normal | Normal = full limit · Strict = 95% of limit |
| Maximum power (W) | 10 000 | Your grid connection limit |
| Time before acting (s) | 30 | Cooldown between mitigation steps |
| Phase limits (A) | 0 (off) | Per-phase ampere limits L1/L2/L3 (0 = disabled) |

**Advanced settings:**

| Setting | Default | Description |
|---------|---------|-------------|
| Reaction speed | 5 | Moving-average window — lower = faster response |
| Spike ignore threshold | 2× | Ignore readings above this multiple of the average |
| Confirm before acting | 3 | Consecutive over-limit readings before acting |
| Safety buffer | 0% | Reduce effective limit by this % for extra headroom |
| Missing data timeout | 120 s | Force mitigation if no HAN reading for this long (0 = off) |
| Dynamic restore guard | On | Wait 1–5 min before restoring — longer when more of the hour remains |

---

## Priority List Actions

| Action | What it does |
|--------|-------------|
| Turn Off | Switches the device off |
| Dim | Reduces to 10% brightness |
| Lower Thermostat | Lowers target temperature by 3°C |
| Charge Pause | Pauses EV charging (Zaptec / Enua) |
| Dynamic Current | Adjusts charger current limit (Easee / Zaptec / Enua, 7–32 A) |
| Stepped Power (Høiax) | Steps water heater down one level per cycle (3000 W → 1750 W → 1250 W → off) |

---

## Flow Cards

| Type | Cards |
|------|-------|
| **Triggers** | Power limit exceeded · Mitigation step applied · Mitigation cleared · Profile changed · Mode changed |
| **Conditions** | Guard enabled · Guard disabled · Power over limit · Power under limit · Active profile is [profile] · Active mode is [mode] |
| **Actions** | Enable guard · Disable guard · Set profile · Set mode · Reset statistics · Report EV battery % |

---

## Virtual Device (Driver)

Power Guard creates a virtual **Power Guard** device in Homey:
- Shows current power draw and your configured limit
- Alarm capability — triggers when the limit is exceeded
- On/Off toggle to enable/disable the guard from the Homey app or Flows

---

## License

GPL-3.0
