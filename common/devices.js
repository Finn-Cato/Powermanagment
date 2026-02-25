'use strict';

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
 * Apply a mitigation action to a HomeyAPI device.
 * Uses { capabilityId, value } as required by homey-api v3.
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
        const current = obj.target_temperature ? obj.target_temperature.value : 20;
        const newTemp = Math.max(5, current - 3);
        if (current <= 5) return false;  // Already at minimum
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

    case ACTIONS.TARGET_TEMP:
      if (caps.includes('target_temperature')) {
        const current = obj.target_temperature ? obj.target_temperature.value : 20;
        // Lower by 3°C to reduce heating, with a floor of 5°C
        const newTemp = Math.max(5, current - 3);
        if (current <= 5) return false;  // Already at minimum
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

    case ACTIONS.DYNAMIC_CURRENT: {
      // Try Easee-compatible dynamic current capabilities in order of preference
      const dynCap = ['target_current', 'dynamicCircuitCurrentP1', 'dynamic_current']
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

    case ACTIONS.HOIAX_POWER: {
      // Determine which max_power capability the device has (300 vs 200 model)
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

    case ACTIONS.TARGET_TEMP:
      if (caps.includes('target_temperature')) {
        const prevTemp = previousState && previousState.target_temperature !== undefined
          ? previousState.target_temperature : 21;
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

    case ACTIONS.DYNAMIC_CURRENT: {
      const dynCap = ['target_current', 'dynamicCircuitCurrentP1', 'dynamic_current']
        .find(function (c) { return caps.includes(c); });
      if (dynCap) {
        const prevVal = (previousState && previousState.target_current !== undefined)
          ? previousState.target_current : 16;
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
