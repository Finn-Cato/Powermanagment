'use strict';

const { ACTIONS } = require('./constants');

const ACTION_CAPABILITY_MAP = {
  [ACTIONS.TURN_OFF]:    'onoff',
  [ACTIONS.DIM]:         'dim',
  [ACTIONS.TARGET_TEMP]: 'target_temperature',
  [ACTIONS.CHARGE_PAUSE]:'onoff',
  [ACTIONS.DYNAMIC_CURRENT]: 'target_current',
};

function getAvailableActions(capabilities) {
  const available = [];
  for (const [action, cap] of Object.entries(ACTION_CAPABILITY_MAP)) {
    if (capabilities.includes(cap)) available.push(action);
  }
  return available;
}

function isControllable(device) {
  const caps = device.capabilities || [];
  return caps.includes('onoff') || caps.includes('dim') || caps.includes('target_temperature') || caps.includes('target_current');
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
      // Fallback: thermostat without onoff — set temperature to minimum (5°C) to stop heating
      if (caps.includes('target_temperature')) {
        const current = obj.target_temperature ? obj.target_temperature.value : 20;
        if (current <= 5) return false;  // Already at minimum
        await device.setCapabilityValue({ capabilityId: 'target_temperature', value: 5 });
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
        // Set to minimum (5°C) to actually stop heating — lowering by just 3°C often isn't enough
        const newTemp = 5;
        if (current <= newTemp) return false;  // Already at minimum
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
  }

  return false;
}

module.exports = { ACTION_CAPABILITY_MAP, getAvailableActions, isControllable, applyAction, restoreDevice };
