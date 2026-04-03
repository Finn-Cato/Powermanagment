# Power Guard for Homey

**Protect your home against exceeding your power limit.**

Power Guard monitors your household power consumption in real-time using a HAN electricity meter and automatically controls devices when you approach your grid limit — preventing costly peak penalties and tripped breakers.

> ⚠️ **Trial version** — use at your own risk. Please report bugs on the [Issues page](https://github.com/Finn-Cato/power-guard/issues).

---

## What the App Can Do

### Power Guard (Core)
- Real-time power monitoring via any HAN electricity meter
- Automatically turns off / reduces devices when you approach your grid limit
- Brings devices back once consumption drops to a safe level
- Priority list — drag-and-drop to choose which devices are turned off first
- Protection profiles: **Normal**, **Strict** (95% of limit), and **Solar-friendly**
- Per-phase ampere limits (L1 / L2 / L3)
- Spike filtering and configurable reaction speed
- Flow cards for Homey automations

### Smart EV Charger Control
- **Dynamic current adjustment** — continuously adjusts charger current based on available headroom
- **Auto phase detection** — detects 1-phase vs 3-phase from live power/current ratio, no manual config needed; requires 3 consistent readings before confirming (avoids false detection during ramp-up); confirmed phase is persisted so it displays immediately after a restart
- **Car device picker** — link a Homey car device to each charger; battery % is read automatically on plug-in and every 30 min
- **Smart Charging Status panel** — shows car connected, charging now, charge mode, next cheap hour
- **Minimum current** — keeps charger at 6A minimum to avoid stopping the session unnecessarily
- **Resume threshold** — resumes from pause at 11A (not 6A) to ensure a reliable charger restart
- **Smooth current stepping** — ramps charger current in 1A steps so each change is small enough for the HAN meter to confirm before the next step; ramp always completes before other devices are restored
- **Anti-oscillation** — a shared 30-second settling window blocks all chargers from ramping after any one ramps, giving the HAN meter time to confirm the change; decreases apply to all chargers immediately in emergencies
- **Proactive load coordination** — when EV budget is tight, heating devices are shed before the charger needs to pause; **priority shed now only fires when the budget is actually insufficient** — if household load is low and the charger has headroom, thermostats stay on; the shed threshold is phase-aware (1-phase = 1380W minimum, 3-phase = 4140W); shedding is skipped when the charger is paused by the price engine; when the session ends, shed devices are **restored one at a time with a 60-second stagger** so the system can observe the grid impact before the next restore; restores are also blocked if power would exceed the limit after restoring
- **Grace window** — 2-minute grace period after confirmed charging before flagging a mismatch
- **Confirmation tracking** — verifies commands by reading `measure_current.offered`, with per-charger reliability scoring
- **Retry with backoff** — retries failed commands up to 2 times with increasing delays
- Supports **Easee** natively (direct API control). Other chargers (**Zaptec**, **Enua**, **Futurehome**, etc.) are supported via Flow cards — see the Help tab in the app settings

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
- **Visual hourly budget bar** — shows kWh used vs the hour's budget, a time cursor for where you are in the hour, remaining kWh, and minutes left; warns when the current hour would set a new daily peak
- **Dynamic hourly budget** (opt-in toggle) — if you've used little power early in the hour, Power Guard temporarily allows higher power using the remaining quota. `dynamicLimit = remainingWh ÷ fractionOfHourLeft`. Capped at min 50% of base limit, 2× base limit, and physical circuit max. Only activates after the first complete hour rollover on startup (startup protection via `hourStartKnown` flag).

### HAN Meter / Power Meter
- Auto-detects HAN meters by device class, name, or driver ID
- When multiple meter-like devices exist, picks the one with the highest current power reading (avoids selecting unconfigured dongles)
- Active polling fallback every 10 seconds for meters that don't send frequent events
- Manual override: choose a specific meter on the System tab
- Supported brands: **Frient**, **Futurehome HAN**, **Tibber Pulse**, **Aidon**, **Kaifa**, **Easee Equalizer**, and any device with `measure_power`

---

## EV Charger Setup & How Charging Hours Are Calculated

### Step 1 — Add the Charger to the Priority List (Devices Tab)
Find your EV charger in the Devices tab and enable it. Set the action to **Dynamic Current** (Easee / Zaptec / Enua) or **Pause EV Charging** (Zaptec / Enua without dynamic control).

### Step 2 — Configure the Battery Schedule (Devices Tab)
Once the charger is enabled, a blue **🔋 Battery schedule** row appears beneath it with three fields:

| Field | What to enter | Example |
|-------|---------------|---------|
| **Size (kWh)** | Your car's usable battery capacity | `77` for a 77 kWh battery |
| **Charge to (%)** | Target charge level | `80` (recommended for daily use) |
| **Car** | Link a Homey car device | Select your car from the dropdown |

If you link a car device, Power Guard reads the battery % automatically when you plug in and every 30 minutes — no Flow required. If no car device is available, you can trigger the **Report EV Battery** Flow action manually.

### Step 3 — Set the Circuit Limit (System Tab)
On the **System** tab under **Managed Chargers**, set the **circuit breaker limit (A)** for each charger. This is the physical maximum your charger's circuit can handle (e.g. `16A` or `32A`).

### Step 4 — Set the Charging Deadline and Hours Needed (Smart Tab)
On the **Smart** tab, set:

| Field | What it does |
|-------|--------------|
| **Ready by (time)** | When the car must be fully charged, e.g. `07:00` |
| **Hours needed (manual)** | Fallback if no car device is linked — enter how many hours you expect charging to take |

---

### How Power Guard Calculates Hours Needed

When a battery report comes in (from a linked car device or a Flow action), Power Guard calculates:

```
kWh to charge = (target% - current%) / 100 × battery capacity (kWh)
charger power  = circuit limit (A) × 230V × phases
hours needed   = kWh to charge ÷ charger power (kW)
```

**Example:**
- Battery: 40 kWh currently, target 80%, capacity 77 kWh
- Charger: 16A circuit, 1-phase → 3.7 kW
- kWh needed: (80 − 40) / 100 × 77 = 30.8 kWh
- **Hours needed: 30.8 ÷ 3.7 = 8.3 hours**

This result is used by the Smart Price engine to decide which hours to charge on.

---

### How the Smart Charging Engine Uses This

Once it knows how many hours are needed and when the deadline is, Power Guard:

1. **Picks the N cheapest hours** before the deadline (where N = hours needed, rounded up)
2. **During those hours** — charges at **Max** (full circuit current)
3. **All other hours** — charger is **Off**, regardless of price level
4. **Deadline imminent** (less than `hoursNeeded + 1h` remaining) — forces **Max** charging regardless of price to guarantee the car is ready in time

**Charge modes used:**

| Mode | What it means |
|------|---------------|
| **Max** | Full charger current (circuit limit) — used during cheapest hours and deadline forcing |
| **Off** | Charger paused — used during all non-cheapest hours |

---

### What Happens Without a Deadline

If no **Ready by** time is set, Power Guard falls back to standard price logic:
- Charges at max during the cheapest hours of the day
- Charges at normal during cheap/normal price periods
- Slows down or pauses during expensive hours
- Pre-charges if the next hour is predicted to be significantly more expensive

---

## Supported Hardware

| Type | Supported devices |
|------|-------------------|
| **EV Charger** | Easee Home, Easee Pro, Zaptec Go / Go2 / Home / Pro, Enua Charge E, Futurehome |
| **HAN Meter** | Frient Smart Reader, Futurehome HAN, Tibber Pulse, Aidon, Kaifa, Easee Equalizer — or any device with `measure_power` |
| **Thermostats** | Any brand — auto-detects capabilities |
| **Water Heaters** | Høiax Connected 300 / 200 |

---

## Getting Started

### 1. Set Your Power Limit
Go to **Overview → Settings** and enter your grid connection limit in watts (e.g. `10 000 W`).

### 2. Enable Devices
Go to the **Devices** tab, toggle on the devices you want Power Guard to control, and drag them into priority order. Devices at the **top** are turned off first.

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
| Dynamic hourly budget | Off | Allow higher power mid-hour when the hourly kWh budget allows it; activates only after the first full hour since startup |

---

## Priority List Actions

| Action | What it does |
|--------|-------------|
| Turn Off | Switches the device off |
| Dim | Reduces to 10% brightness |
| Lower Thermostat | Lowers target temperature by 3°C |
| Charge Pause | Pauses EV charging (Zaptec / Enua) |
| Dynamic Current | Adjusts charger current limit (Easee / Zaptec / Enua / Futurehome, 6–32 A) |
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
