
# Power Guard – Mini Specification (Homey Pro + frient HAN Port)

## 1. Purpose
A Homey Pro app that limits household power usage by monitoring real‑time consumption from a **frient HAN Port (Zigbee)** and applying prioritized actions to selected devices when limits are exceeded.

## 2. Data Source
**Primary meter:**
- frient HAN Port (Zigbee)
- Must provide real‑time total power (W) and, if available, per‑phase values.

The app uses these values for all load calculations.

## 3. Main Features
### 3.1 Power Limit Control
- User‑defined total power limit (W or kW)
- Optional per‑phase limits (A)
- Moving average smoothing
- Spike detection
- Hysteresis
- Cooldown between mitigation steps

### 3.2 Priority‑Based Mitigation
User defines a list of controllable devices with:
- Priority order
- Action type (turn off, reduce, dim, pause charging, etc.)
- Optional minimum runtime
- Optional minimum off‑time
- Optional schedules

The app applies mitigation in priority order until usage is safe.

### 3.3 Multi‑Charger Support
Works with multiple EV chargers from different brands. Supported chargers:

#### Easee (Direct Capability Control)
- Dynamic current adjustment via device capabilities (`dynamic_charger_current`, `dynamicChargerCurrent`, etc.)
- Pause/resume via `onoff` capability
- Circuit current control via `target_circuit_current`
- Full confirmation tracking via `measure_current.offered`

#### Zaptec (Flow API + Capability Control)
- Dynamic current adjustment via Homey Flow API (`runFlowCardAction`)
  - Uses `installation_current_control` action from `com.zaptec` app (0–40A per phase)
  - Sets all 3 phases equally
- Pause/resume via `charging_button` capability
- Car connected detection via `alarm_generic.car_connected`
- Available installation current monitoring

#### Enua Charge E (Flow API + Capability Control)
- Dynamic current adjustment via Homey Flow API (`runFlowCardAction`)
  - Uses `changeCurrentLimitAction` action from `no.enua` app (6–32A)
- Pause/resume via `toggleChargingCapability` (custom capability)
- Charger status monitoring via `chargerStatusCapability`
- Cable lock status via `toggleCableLockCapability`

#### Common EV Charger Features
- Auto‑detection of charger brand from device capabilities
- Automatic routing: `_setEaseeChargerCurrent()` detects brand and delegates to the correct handler
- Per‑charger smart throttle based on confirmation state (15s confirmed, 45s unconfirmed, 5s emergency)
- Proportional current scaling for smooth adjustments
- Start threshold to prevent rapid on/off cycling
- Main fuse protection caps power allocation

Actions may include:
- Pause charging
- Resume charging
- Dynamic current reduction (Easee: direct capability, Zaptec/Enua: Flow API)

### 3.4 Restoration
When consumption drops below limits, the app restores devices in reverse priority order, respecting timing rules.

## 4. Virtual Device
A virtual device named **Power Guard** showing:
- Current total power
- Phase load (if available)
- Active mitigation state
- Current profile
- Limit alarm flag

## 5. Profiles
- Normal
- Strict
- Solar‑friendly (optional)

## 6. Flow Cards
### Triggers
- Power limit exceeded
- Phase limit exceeded
- Mitigation step applied
- Mitigation cleared
- Profile changed

### Conditions
- Guard enabled
- Over‑limit status
- Specific profile active

### Actions
- Enable / disable Power Guard
- Change profile
- Reset statistics

## 7. Settings UI
Must include:
- Power limit configuration
- Smoothing and spike sensitivity
- Priority list editor with action types:
  - Turn off (`onoff`)
  - Dim (`dim`)
  - Lower thermostat (`target_temperature`)
  - Pause EV charging — Zaptec/Enua (`charge_pause`)
  - Dynamic charging — Easee/Zaptec/Enua (`dynamic_current`)
- Per‑charger circuit limit (A) and phase configuration
- Profile selection
- Diagnostics panel with:
  - Test charger control (auto‑detects Easee/Zaptec/Enua, probes Flow API availability)
  - Charger brand and capability report
  - Connection status and power readings

## 8. Reliability Requirements
- Fully local execution on Homey Pro
- Safe fallback if frient HAN stops reporting
- No rapid switching
- Must not request unsupported device actions

## 9. Deliverables for Claude
Claude should produce:
- A full Homey Pro app (SDK v3)
- Integration with frient HAN Port
- Priority control engine
- Virtual Power Guard device
- Flow cards and settings UI
- Generic multi‑charger/device control logic

## 10. Technical Architecture — Dynamic Current Control

### Flow API Integration
For chargers that only expose current control as Flow action cards (not settable capabilities), the app uses Homey's `runFlowCardAction` API:

```
await this._api.flow.runFlowCardAction({
  uri: 'homey:app:<appId>',
  id: '<actionId>',
  args: { device: { id: deviceId, name: deviceName }, ...params }
});
```

This requires the `homey:manager:api` permission (already included).

### Brand Detection
`_getChargerBrand(deviceId)` identifies chargers from cached capabilities:
- **Enua**: `toggleChargingCapability` present
- **Zaptec**: `charging_button` present
- **Easee**: `dynamic_charger_current` / `dynamicChargerCurrent` / `target_charger_current` present

### Control Method Summary
| Brand | Pause/Resume | Dynamic Current | Car Connected |
|-------|-------------|----------------|---------------|
| Easee | `onoff` capability | Direct capability (`dynamic_charger_current` etc.) | `charger_status` (2/3/4 = connected) |
| Zaptec | `charging_button` capability | Flow API: `installation_current_control` (0–40A × 3 phases) | `alarm_generic.car_connected` boolean |
| Enua | `toggleChargingCapability` | Flow API: `changeCurrentLimitAction` (6–32A) | `chargerStatusCapability` + power > 100W |

### EV Charger Event Listeners
The app connects to all managed EV chargers and listens to real‑time capability updates:
- `measure_power` — charger power draw
- `charger_status` / `chargerStatusCapability` — charging state
- `alarm_generic.car_connected` — Zaptec car presence
- `charging_button` — Zaptec charging state
- `toggleChargingCapability` — Enua charging state
- `onoff` — Easee charging state
- `measure_current.offered` — Easee command confirmation
