# Power Guard — Logic Audit Report
**Date:** 2026-03-16
**Version audited:** 0.8.34
**Files reviewed:** app.js, api.js, settings/index.html

---

## Summary

20 findings across four severity levels. The most impactful issues are:
- **Finding 8:** Charger adjustments permanently block thermostat/heater restoration
- **Finding 3:** Charge mode suppression is incomplete (per-charger map not updated)
- **Finding 1:** Two independent engines fight over charger current in the same cycle

---

## Critical — Wrong behavior with valid configurations

### Finding 1 & 20: Two charger control engines conflict
**Location:** `app.js` lines ~1190, ~1226, ~2629, ~3583

`_mitigateEaseeChargers` and `_adjustEVChargersForPower` both run in the same power reading cycle and both send current commands to the same charger. They use different budget formulas:
- `_adjustEVChargersForPower` uses a shared pool divided across all active chargers (correct for multi-charger setups)
- `_mitigateEaseeChargers` uses a per-charger calculation that subtracts only that one charger's power (wrong for multi-charger)

Since both are called from `_checkLimits` in sequence, the last command wins unpredictably.

---

### Finding 2: Same charger entry added/removed simultaneously
**Location:** `app.js` lines ~2848, ~3632

When a charger is at full current:
- `_adjustEVChargersForPower` keeps the entry in `_mitigatedDevices`
- `_mitigateEaseeChargers` removes the entry from `_mitigatedDevices`

Both run back-to-back in the same cycle, causing the charger entry to oscillate between present and absent on every power reading.

---

### Finding 3: Charge mode suppression doesn't fix per-charger map
**Location:** `app.js` lines ~4717–4733

When all cars are full/disconnected, `finalMode` is correctly set to `null`. However, the per-charger `chargeModes` map (used by `_getPriceCurrentCap`) was already populated with the non-null mode **before** the suppression check runs. Result: `_getPriceCurrentCap` reads the per-charger map first and still applies a current cap to chargers that should be uncapped, even though the global chargeMode correctly shows `—`.

**Fix needed:** Populate `chargeModes` after the suppression check, or re-apply suppression to the map.

---

### Finding 8: Charger adjustments permanently block thermostat restoration
**Location:** `app.js` lines ~3609, ~3612, ~1529

Every time `_mitigateEaseeChargers` adjusts a charger current (routine operation, every 15–50 seconds), it resets `_lastMitigationTime`. This restarts the 240-second restore cooldown for ALL non-charger devices. In any household with an active EV charger, thermostats and water heaters can never be restored by the normal restore path — the cooldown is perpetually reset before it expires.

---

### Finding 15: Mode engine temperature changes corrupt mitigation snapshots
**Location:** `app.js` lines ~5110, ~1810

When the mode engine sets a thermostat to a lower temperature (e.g. 15°C in night mode), the mitigation engine's state snapshot reads 15°C as the device's "original" temperature. When the mitigation engine later restores the device, it restores to 15°C instead of the pre-mitigation home-mode temperature. The mode engine's temperature change is invisible to the mitigation engine's snapshot.

---

## High — Race conditions / edge-case failures

### Finding 7: Proactive EV shed restore also resets restore cooldown
**Location:** `app.js` lines ~2557–2583, ~1516

Related to Finding 8 — charger proactive shed/restore cycles also interact with the 120-second minimum off-time for proactively shed devices. When budget fluctuates near the threshold, a device can be proactively shed, restored, then immediately re-shed in subsequent cycles.

---

### Finding 11: No mutex on `_adjustEVChargersForPower`
**Location:** `app.js` lines ~1190, ~1214, ~2629

`_triggerMitigation` acquires `this._mutex` before modifying `_mitigatedDevices`. `_adjustEVChargersForPower` (called earlier in the same cycle) also modifies `_mitigatedDevices` but does NOT acquire the mutex. Since `_adjustEVChargersForPower` is async (it calls brand-specific charger setters with API calls), the event loop can yield mid-execution, allowing `_triggerMitigation` to read a partially-updated `_mitigatedDevices` array.

---

### Finding 16: Mode engine "ON" clears mitigation, causing immediate re-shed
**Location:** `app.js` lines ~4000–4007, ~5121

`controlFloorHeater(id, 'on')` removes the device from `_mitigatedDevices`. The mode engine calls this when switching modes (e.g. Away → Home). If the system is currently over the power limit when a mode switch happens, the device starts drawing power immediately and gets re-mitigated within the next power reading cycle — pointless on/off cycling.

The guard at line ~5121 (`if (wantOn && isMitigated) continue`) only applies to `onoff` action devices, not thermostats.

---

### Finding 17: Phase detection never shown in UI on initial load
**Location:** `api.js` lines ~95–101, `settings/index.html` lines ~1901, ~2761

`detectedVoltageSystem` is missing from the `getAllData` API response (`{ settings, status, devices }`). The settings page reads `data.detectedVoltageSystem` on initial load, gets `undefined`, and falls back to `'230v-1phase'`. The correct value is only available via the separate `getAppLog` endpoint. Phase detection therefore never displays correctly in the Settings UI on page load.

---

## Medium — Data inconsistency / silent failures

### Finding 4: `priceControlled` flag partially bypassed
**Location:** `app.js` lines ~4717, ~4992

The per-charger `chargeModes` map is only populated for entries with `priceControlled: true`. However, `_getPriceCurrentCap` falls back to the global `chargeMode` for any charger NOT in the map. So a charger without `priceControlled` still gets its current capped by price — the flag only prevents a per-device entry, not the global fallback.

---

### Finding 5: File backup misses 6 settings keys
**Location:** `app.js` lines ~369–387

`_saveSettingsToFile()` saves only 10 keys. These 6 are not backed up:
- `errorMarginPercent`
- `missingPowerTimeoutS`
- `dynamicRestoreGuard`
- `voltageSystem`
- `phaseDistribution`
- `mainCircuitA`

If Homey's settings store is lost and recovery falls back to the file backup, these 6 keys revert silently to code defaults with no warning to the user.

---

### Finding 6: `_applyMode` reads priority list from a different source
**Location:** `app.js` line ~5092

`_applyMode` uses `this.homey.settings.get('priorityList')` directly. All other engine code uses `this._settings.priorityList` (the in-memory copy populated by `_loadSettings()`). If there is a timing window between `homey.settings.set(...)` and `_loadSettings()` completing, the mode engine acts on a different list than the power and EV engines.

---

### Finding 10: Stale `hoiax_power` entries never cleaned up
**Location:** `app.js` line ~493

`_cleanStaleMitigatedEntries` exempts entries with `action === 'hoiax_power'` from cleanup. If a user changes a device's action away from `hoiax_power`, the old stale entry persists indefinitely. The restore logic will attempt to use `hoiax_power` semantics on a device that no longer has that action, causing failed restores that permanently block the device.

---

### Finding 13: `selectedMeterDeviceId` default inconsistency
**Location:** `app.js` lines ~631, ~569, `api.js` line ~27

Three places read this setting with three different defaults:
- `_connectToHAN`: defaults to `null`
- `getHanDiagnostic`: defaults to `'auto'`
- `api.js _readSettings`: defaults to `'auto'`

An empty string or falsy value produces different behavior depending on which code path reads it.

---

### Finding 14: Proactive EV shed restore can oscillate
**Location:** `app.js` lines ~2566–2584

The restore phase restores exactly one device per call, then breaks. If restoring that device drops available budget below the threshold, the next call enters the shed phase and re-sheds the just-restored device. This can create a shed/restore oscillation cycle for the device nearest the budget threshold.

---

## Low — Minor / cosmetic

### Finding 9: Bounce-back re-mitigation doesn't fire Flow trigger
**Location:** `app.js` lines ~1381–1388

When a thermostat that was already at step-2 mitigation turns itself back on, the code re-mitigates it (turns it off) and `continue`s — skipping the `mitigation_applied` flow trigger at line ~1416. Homey automations listening for this trigger are not notified.

---

### Finding 12: `_forceChargerRecheck` minor race on settings save
**Location:** `app.js` lines ~509–535

When settings are saved, `_forceChargerRecheck` sets `_lastEVAdjustTime = 0` and calls `_adjustEVChargersForPower` immediately. If a normal power reading arrived <2 seconds earlier and is still in-flight (async), both the forced and normal adjustments execute concurrently.

---

### Finding 18: Missing-power guard bypasses smoothing buffer
**Location:** `app.js` lines ~814–815

When the missing-power guard triggers (no HAN reading for the configured timeout), it calls `_checkLimits(syntheticPower)` directly. The synthetic value is NOT added to `_powerBuffer`, so the moving average used inside `_checkLimits` is calculated from stale real readings, not the synthetic value. The mitigation decision is made with inconsistent data.

---

### Finding 19: Power consumption uses truthy check (excludes 0W, includes negative W)
**Location:** `app.js` line ~4149

```javascript
if (device.capabilitiesObj?.measure_power?.value) {
```

A device reporting exactly `0W` fails the truthy check and is excluded — probably correct behavior. However, a device reporting `-1W` (e.g. solar export) passes the check and is recorded as negative power, which can skew consumption statistics.

---

## Prioritized Fix Recommendations

| Priority | Finding | Impact |
|----------|---------|--------|
| 1 | Finding 8 | Thermostats/heaters can never be restored in EV households |
| 2 | Finding 3 | Charge mode suppression incomplete — wrong current cap applied |
| 3 | Finding 1 | Two engines fight over charger current |
| 4 | Finding 16 | Mode switch causes immediate re-shed cycling |
| 5 | Finding 5 | 6 settings keys lost on file-backup recovery |
| 6 | Finding 11 | Race condition on `_mitigatedDevices` array |
| 7 | Finding 17 | Phase detection missing from UI |
| 8 | Finding 15 | Mode engine corrupts mitigation temperature snapshot |
| 9 | Finding 6 | Mode engine reads stale priority list |
| 10 | Finding 14 | Proactive shed oscillation near budget threshold |
