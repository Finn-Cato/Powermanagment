'use strict';

// ══════════════════════════════════════════════════════════════════
// common/devices.js  —  DEVICE ACTION HANDLERS
// ══════════════════════════════════════════════════════════════════
//
//  This file contains the per-device mitigation and restore logic.
//  Each device type is handled inside applyAction() / restoreDevice()
//  as a separate case block.
//
//  Device types handled here:
//
//  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━//  [A] HEATERS — Floor / Thermostat              action: target_temperature
//      Brands: Adax Wi-Fi (no.adax), generic Homey thermostats
//      Caps:   target_temperature                 ✅ STABLE
//
//  [B] WATER HEATER — Høiax Connected           action: hoiax_power
//      Brand:  no.hoiax
//      Caps:   max_power_3000 (Høiax 300) or max_power (Høiax 200)
//      Steps:  high_power → medium_power → low_power → onoff=false
//              (defined in HOIAX_POWER_STEPS in constants.js)     ✅ WORKING
//
//  [C] EV CHARGERS — generic pause/resume        action: charge_pause
//      Dynamic current is handled in app.js Sections 7–9
//      Caps:   onoff  or  toggleChargingCapability (Enua)
//              Note: Zaptec and Easee dynamic current is NOT here —
//              those go directly to _setZaptecCurrent / _setEaseeChargerCurrent
//                                                                  ⚠️ ACTIVE
//  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━//
// ══════════════════════════════════════════════════════════════════

const { ACTIONS, HOIAX_POWER_STEPS } = require('./constants');

const ACTION_CAPABILITY_MAP = {
  [ACTIONS.TURN_OFF]:    'onoff',
  [ACTIONS.DIM]:         'dim',
  [ACTIONS.TARGET_TEMP]: 'target_temperature',
  [ACTIONS.CHARGE_PAUSE]:'onoff',
  [ACTIONS.DYNAMIC_CURRENT]: 'target_current',
  [ACTIONS.HOIAX_POWER]: 'max_power_3000',
};

function getAvailableActions(capabilities) {
  const available = [];
  for (const [action, cap] of Object.entries(ACTION_CAPABILITY_MAP)) {
    if (capabilities.includes(cap)) available.push(action);
  }
  // Also detect Høiax 200 via max_power if not already matched via max_power_3000
  if (!available.includes(ACTIONS.HOIAX_POWER) && capabilities.includes('max_power')) {
    available.push(ACTIONS.HOIAX_POWER);
  }
  return available;
}

function isControllable(device) {
  const caps = device.capabilities || [];
  return caps.includes('onoff') || caps.includes('dim') || caps.includes('target_temperature') || caps.includes('target_current') || caps.includes('max_power_3000') || caps.includes('max_power');
}

/**
 * [A] HEATERS & GENERIC DEVICES — applyAction
 * Handles: target_temperature (heaters), onoff/dim (generic), charge_pause (chargers),
 *          dynamic_current (legacy fallback), hoiax_power (water heater)
 */
async function applyAction(device, action) {
  const caps = device.capabilities || [];
  const obj = device.capabilitiesObj || {};

  switch (action) {
    case ACTIONS.TURN_OFF:
    case ACTIONS.CHARGE_PAUSE:
      if (caps.includes('onoff')) {
        // Skip if already off — device contributes 0W, turning it off again won't help
        if (obj.onoff && obj.onoff.value === false) return false;
        await device.setCapabilityValue({ capabilityId: 'onoff', value: false });
        return true;
      }
      // Enua charger: use toggleChargingCapability to stop charging
      if (caps.includes('toggleChargingCapability')) {
        if (obj.toggleChargingCapability && obj.toggleChargingCapability.value === false) return false;
        await device.setCapabilityValue({ capabilityId: 'toggleChargingCapability', value: false });
        return true;
      }
      // Fallback: thermostat without onoff — lower temperature by 3°C to reduce heating
      if (caps.includes('target_temperature')) {
        const current = Number(obj.target_temperature?.value ?? 20);
        if (current <= 5) return false;  // Already at minimum
        const newTemp = Math.max(5, current - 3);
        // Switch to manual mode so schedule doesn't override the change (e.g. FutureHome)
        if (caps.includes('thermostat_mode')) {
          const currentMode = obj.thermostat_mode ? obj.thermostat_mode.value : null;
          if (currentMode !== 'heat') {
            await device.setCapabilityValue({ capabilityId: 'thermostat_mode', value: 'heat' });
          }
        }
        await device.setCapabilityValue({ capabilityId: 'target_temperature', value: newTemp });
        return true;
      }
      break;

    case ACTIONS.DIM:
      if (caps.includes('dim')) {
        // Skip if already at or below the target dim level
        if (obj.dim && obj.dim.value <= 0.1) return false;
        await device.setCapabilityValue({ capabilityId: 'dim', value: 0.1 });
        return true;
      }
      if (caps.includes('onoff')) {
        if (obj.onoff && obj.onoff.value === false) return false;
        await device.setCapabilityValue({ capabilityId: 'onoff', value: false });
        return true;
      }
      break;

    case ACTIONS.TARGET_TEMP: {
      // Adax Wi-Fi heaters use cloud polling — commands have ~20 min delay.
      // Using onoff=false is equally delayed but cuts heating harder than temp-3°C.
      const isAdax = (device.driverUri || device.driverId || '').toLowerCase().includes('adax');
      if (isAdax && caps.includes('onoff')) {
        if (obj.onoff && obj.onoff.value === false) return false;
        await device.setCapabilityValue({ capabilityId: 'onoff', value: false });
        return true; // NOTE: ~20 min cloud delay before heater responds
      }
      if (caps.includes('target_temperature')) {
        const current = Number(obj.target_temperature?.value ?? 20);
        if (current <= 5) return false;  // Already at minimum
        // Lower by 3°C to reduce heating, with a floor of 5°C
        const newTemp = Math.max(5, current - 3);
        // Some thermostats (e.g. FutureHome) follow a schedule — when in auto/schedule mode,
        // any target_temperature change is overridden by the cloud schedule within seconds.
        // Setting thermostat_mode='heat' (manual) before changing temp makes the change stick.
        if (caps.includes('thermostat_mode')) {
          const currentMode = obj.thermostat_mode ? obj.thermostat_mode.value : null;
          if (currentMode !== 'heat') {
            await device.setCapabilityValue({ capabilityId: 'thermostat_mode', value: 'heat' });
          }
        }
        await device.setCapabilityValue({ capabilityId: 'target_temperature', value: newTemp });
        return true;
      }
      // Fallback: use onoff if thermostat has it
      if (caps.includes('onoff')) {
        if (obj.onoff && obj.onoff.value === false) return false;
        await device.setCapabilityValue({ capabilityId: 'onoff', value: false });
        return true;
      }
      break;
    }

    case ACTIONS.DYNAMIC_CURRENT: {
      // Try volatile/dynamic caps first (ID48 = dynamicChargerCurrent, won't wear FLASH).
      // Only fall back to target_charger_current (ID47 = permanent Ladergrense) if
      // the Homey Easee app doesn't expose a volatile capability for this charger model.
      const dynCap = ['dynamic_charger_current', 'dynamicChargerCurrent', 'target_current', 'dynamicCircuitCurrentP1', 'dynamic_current']
        .find(function (c) { return caps.includes(c); });
      if (dynCap) {
        const currentVal = obj[dynCap] ? (obj[dynCap].value != null ? obj[dynCap].value : 16) : 16;
        if (currentVal <= 6) {
          // At minimum — pause charger instead
          if (caps.includes('onoff')) {
            if (obj.onoff && obj.onoff.value === false) return false;
            await device.setCapabilityValue({ capabilityId: 'onoff', value: false });
            return true;
          }
          return false;
        }
        const newVal = Math.max(6, currentVal - 4);
        if (newVal >= currentVal) return false;
        await device.setCapabilityValue({ capabilityId: dynCap, value: newVal });
        return true;
      }
      // Fallback: pause via onoff
      if (caps.includes('onoff')) {
        if (obj.onoff && obj.onoff.value === false) return false;
        await device.setCapabilityValue({ capabilityId: 'onoff', value: false });
        return true;
      }
      break;
    }

    // ─── [B] WATER HEATER (Høiax): step down power level, then turn off ───
    case ACTIONS.HOIAX_POWER: {
      const maxPowerCap = caps.includes('max_power_3000') ? 'max_power_3000'
                        : caps.includes('max_power') ? 'max_power'
                        : null;

      // If device is already off, no further reduction possible
      if (caps.includes('onoff') && obj.onoff && obj.onoff.value === false) return false;

      if (maxPowerCap) {
        const currentLevel = obj[maxPowerCap] ? obj[maxPowerCap].value : null;
        const steps = HOIAX_POWER_STEPS[maxPowerCap];
        const currentIdx = steps.indexOf(currentLevel);

        if (currentIdx >= 0 && currentIdx < steps.length - 1) {
          // Step down one level (e.g. high_power → medium_power)
          const nextLevel = steps[currentIdx + 1];
          await device.setCapabilityValue({ capabilityId: maxPowerCap, value: nextLevel });
          return true;
        }

        // At lowest step or unknown level → turn off entirely
        if (caps.includes('onoff')) {
          await device.setCapabilityValue({ capabilityId: 'onoff', value: false });
          return true;
        }
        return false;
      }

      // No max_power capability → fallback to onoff
      if (caps.includes('onoff')) {
        if (obj.onoff && obj.onoff.value === false) return false;
        await device.setCapabilityValue({ capabilityId: 'onoff', value: false });
        return true;
      }
      return false;
    }
  }

  return false;
}

/**
 * Restore a device after mitigation.
 */
async function restoreDevice(device, action, previousState) {
  const caps = device.capabilities || [];

  switch (action) {
    case ACTIONS.TURN_OFF:
    case ACTIONS.CHARGE_PAUSE:
      if (caps.includes('onoff')) {
        const wasOn = previousState && previousState.onoff !== undefined ? previousState.onoff : true;
        await device.setCapabilityValue({ capabilityId: 'onoff', value: wasOn });
        return true;
      }
      // Enua charger: restore toggleChargingCapability
      if (caps.includes('toggleChargingCapability')) {
        const wasCharging = previousState && previousState.toggleChargingCapability !== undefined
          ? previousState.toggleChargingCapability : true;
        await device.setCapabilityValue({ capabilityId: 'toggleChargingCapability', value: wasCharging });
        return true;
      }
      // Fallback: restore temperature if we used target_temperature as fallback
      if (caps.includes('target_temperature')) {
        const prevTemp = previousState && previousState.target_temperature !== undefined
          ? previousState.target_temperature : 21;
        // Restore original thermostat mode (e.g. back to 'auto'/'schedule' for FutureHome)
        if (caps.includes('thermostat_mode') && previousState && previousState.thermostat_mode !== undefined) {
          await device.setCapabilityValue({ capabilityId: 'thermostat_mode', value: previousState.thermostat_mode });
        }
        await device.setCapabilityValue({ capabilityId: 'target_temperature', value: prevTemp });
        return true;
      }
      break;

    case ACTIONS.DIM:
      if (caps.includes('dim')) {
        const prevDim = previousState && previousState.dim !== undefined ? previousState.dim : 1.0;
        await device.setCapabilityValue({ capabilityId: 'dim', value: prevDim });
        return true;
      }
      break;

    case ACTIONS.TARGET_TEMP: {
      // Adax: if we turned off via onoff, restore via onoff (not temp)
      const isAdaxRestore = (device.driverUri || device.driverId || '').toLowerCase().includes('adax');
      if (isAdaxRestore && caps.includes('onoff')) {
        const wasOn = previousState && previousState.onoff !== undefined ? previousState.onoff : true;
        await device.setCapabilityValue({ capabilityId: 'onoff', value: wasOn });
        return true; // NOTE: ~20 min cloud delay before heater responds
      }
      if (caps.includes('target_temperature')) {
        const prevTemp = previousState && previousState.target_temperature !== undefined
          ? previousState.target_temperature : 21;
        // If we forced thermostat_mode to 'heat' during mitigation, restore the original mode first
        if (caps.includes('thermostat_mode') && previousState && previousState.thermostat_mode !== undefined) {
          await device.setCapabilityValue({ capabilityId: 'thermostat_mode', value: previousState.thermostat_mode });
        }
        await device.setCapabilityValue({ capabilityId: 'target_temperature', value: prevTemp });
        return true;
      }
      // Fallback: restore onoff if we used that instead
      if (caps.includes('onoff')) {
        const wasOn = previousState && previousState.onoff !== undefined ? previousState.onoff : true;
        await device.setCapabilityValue({ capabilityId: 'onoff', value: wasOn });
        return true;
      }
      break;
    }

    case ACTIONS.DYNAMIC_CURRENT: {
      const dynCap = ['target_current', 'target_charger_current', 'dynamicCircuitCurrentP1', 'dynamic_current']
        .find(function (c) { return caps.includes(c); });
      if (dynCap) {
        // Restore to the original pre-throttle current (targetCurrent key) or fallback to 16A
        const prevVal = (previousState && (previousState.targetCurrent ?? previousState.target_current) !== undefined)
          ? (previousState.targetCurrent ?? previousState.target_current) : 16;
        await device.setCapabilityValue({ capabilityId: dynCap, value: prevVal });
        return true;
      }
      if (caps.includes('onoff')) {
        const wasOn = previousState && previousState.onoff !== undefined ? previousState.onoff : true;
        await device.setCapabilityValue({ capabilityId: 'onoff', value: wasOn });
        return true;
      }
      break;
    }

    case ACTIONS.HOIAX_POWER: {
      const maxPowerCap = caps.includes('max_power_3000') ? 'max_power_3000'
                        : caps.includes('max_power') ? 'max_power'
                        : null;

      // Restore the original max_power level
      if (maxPowerCap && previousState && previousState[maxPowerCap] !== undefined) {
        await device.setCapabilityValue({ capabilityId: maxPowerCap, value: previousState[maxPowerCap] });
      }
      // Restore onoff state (turn back on if was on)
      if (caps.includes('onoff')) {
        const wasOn = previousState && previousState.onoff !== undefined ? previousState.onoff : true;
        await device.setCapabilityValue({ capabilityId: 'onoff', value: wasOn });
      }
      return true;
    }
  }

  return false;
}

module.exports = { ACTION_CAPABILITY_MAP, getAvailableActions, isControllable, applyAction, restoreDevice };
