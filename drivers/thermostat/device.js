'use strict';

const Homey = require('homey');

/**
 * Thermostat device — wraps a real thermostat (Futurehome, Heatit, etc.)
 * and exposes it with unified capabilities: target_temperature,
 * measure_temperature, onoff, and thermostat_mode.
 *
 * Uses live HomeyAPI device for real-time readings and control.
 */
class ThermostatDevice extends Homey.Device {

  async onInit() {
    this.log('Thermostat device init:', this.getName());

    const realDeviceId = this.getData().realDeviceId;
    const app = this.homey.app;

    if (!app || !app._api) {
      this.setUnavailable('App not ready');
      return;
    }

    try {
      // Get the live device from HomeyAPI
      const realDevice = await app._api.devices.getDevice({ id: realDeviceId });
      if (!realDevice) {
        this.setUnavailable('Real device not found');
        return;
      }

      this._realDeviceId = realDeviceId;
      this._realDevice = realDevice;

      const capObj = realDevice.capabilitiesObj || {};
      const caps = realDevice.capabilities || [];

      this.log(`Real device caps: ${caps.join(', ')}`);

      // --- Detect which capability names this device uses ---

      // Target temperature (what we set)
      this._targetTempCap = ['target_temperature', 'set_temperature', 'setpoint_temperature',
                              'heating_setpoint', 'desired_temperature']
        .find(c => caps.includes(c)) || null;

      // Measure temperature (current room temp)
      this._measureTempCap = ['measure_temperature', 'temperature', 'current_temperature']
        .find(c => caps.includes(c)) || null;

      // Thermostat mode
      this._thermostatModeCap = ['thermostat_mode']
        .find(c => caps.includes(c)) || null;

      this.log(`Target cap: ${this._targetTempCap}, Measure cap: ${this._measureTempCap}, Mode cap: ${this._thermostatModeCap}`);

      // --- Set initial values ---

      if (this._targetTempCap && capObj[this._targetTempCap]) {
        const v = capObj[this._targetTempCap].value;
        if (typeof v === 'number') {
          await this.setCapabilityValue('target_temperature', v).catch(() => {});
        }
      }

      if (this._measureTempCap && capObj[this._measureTempCap]) {
        const v = capObj[this._measureTempCap].value;
        if (typeof v === 'number') {
          await this.setCapabilityValue('measure_temperature', v).catch(() => {});
        }
      }

      if (caps.includes('onoff') && capObj.onoff) {
        const v = capObj.onoff.value;
        await this.setCapabilityValue('onoff', v !== false).catch(() => {});
      }

      if (this._thermostatModeCap && capObj[this._thermostatModeCap]) {
        const v = capObj[this._thermostatModeCap].value;
        if (v && this.hasCapability('thermostat_mode')) {
          await this.setCapabilityValue('thermostat_mode', v).catch(() => {});
        }
      }

      // --- Subscribe to real-time changes ---

      if (this._targetTempCap) {
        try {
          this._targetTempInstance = realDevice.makeCapabilityInstance(this._targetTempCap, (value) => {
            if (typeof value === 'number') {
              this.setCapabilityValue('target_temperature', value).catch(() => {});
              this.log(`Target temp updated: ${value}°C`);
            }
          });
        } catch (err) {
          this.error('Target temp subscription error:', err);
        }
      }

      if (this._measureTempCap) {
        try {
          this._measureTempInstance = realDevice.makeCapabilityInstance(this._measureTempCap, (value) => {
            if (typeof value === 'number') {
              this.setCapabilityValue('measure_temperature', value).catch(() => {});
            }
          });
        } catch (err) {
          this.error('Measure temp subscription error:', err);
        }
      }

      if (caps.includes('onoff')) {
        try {
          this._onoffInstance = realDevice.makeCapabilityInstance('onoff', (value) => {
            this.setCapabilityValue('onoff', value !== false).catch(() => {});
          });
        } catch (err) {
          this.error('Onoff subscription error:', err);
        }
      }

      if (this._thermostatModeCap) {
        try {
          this._modeInstance = realDevice.makeCapabilityInstance(this._thermostatModeCap, (value) => {
            if (value && this.hasCapability('thermostat_mode')) {
              this.setCapabilityValue('thermostat_mode', value).catch(() => {});
            }
          });
        } catch (err) {
          this.error('Mode subscription error:', err);
        }
      }

      // --- Register control listeners (user changes from Homey UI/device tile) ---

      this.registerCapabilityListener('target_temperature', async (value) => {
        try {
          if (this._targetTempCap) {
            await this._realDevice.setCapabilityValue({ capabilityId: this._targetTempCap, value });
            this.log(`Target temp set to ${value}°C by user via ${this._targetTempCap}`);
          }
        } catch (err) {
          this.error('Failed to set target temp:', err);
          throw err;
        }
      });

      this.registerCapabilityListener('onoff', async (value) => {
        try {
          if ((this._realDevice.capabilities || []).includes('onoff')) {
            await this._realDevice.setCapabilityValue({ capabilityId: 'onoff', value });
            this.log(`Thermostat ${value ? 'turned on' : 'turned off'} by user`);
          }
        } catch (err) {
          this.error('Failed to set onoff:', err);
          throw err;
        }
      });

      if (this.hasCapability('thermostat_mode')) {
        this.registerCapabilityListener('thermostat_mode', async (value) => {
          try {
            if (this._thermostatModeCap) {
              await this._realDevice.setCapabilityValue({ capabilityId: this._thermostatModeCap, value });
              this.log(`Mode set to ${value} by user`);
            }
          } catch (err) {
            this.error('Failed to set mode:', err);
            throw err;
          }
        });
      }

      this.setAvailable();
      this.log(`Thermostat device ready: ${this.getName()}`);

    } catch (err) {
      this.error('Init error:', err);
      this.setUnavailable('Connection failed');
    }
  }

  async onDeleted() {
    this.log('Thermostat device deleted:', this.getName());
    // Clean up real-time listeners
    for (const inst of [this._targetTempInstance, this._measureTempInstance, this._onoffInstance, this._modeInstance]) {
      if (inst) {
        try { inst.destroy(); } catch (_) {}
      }
    }
  }
}

module.exports = ThermostatDevice;
