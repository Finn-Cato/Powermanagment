'use strict';

const Homey = require('homey');

class EVChargerDevice extends Homey.Device {

  async onInit() {
    this.log('EV Charger device init:', this.getName());

    const realDeviceId = this.getData().realDeviceId;
    const app = this.homey.app;

    if (!app || !app._api) {
      this.setUnavailable('App not ready');
      return;
    }

    try {
      // Get the real device
      const realDevice = await app._api.devices.getDevice({ id: realDeviceId });
      if (!realDevice) {
        this.setUnavailable('Real device not found');
        return;
      }

      this._realDeviceId = realDeviceId;
      this._realDevice = realDevice;

      // Initialize capabilities with current values from real device
      const capObj = realDevice.capabilitiesObj || {};
      const caps = realDevice.capabilities || [];

      // Set measure_power if available
      if (caps.includes('measure_power')) {
        const power = capObj.measure_power ? (capObj.measure_power.value || 0) : 0;
        await this.setCapabilityValue('measure_power', power).catch(() => {});
      }

      // Set target_current if available
      const targetCurrentCap = ['target_current', 'dynamicCircuitCurrentP1', 'dynamic_current']
        .find(cap => caps.includes(cap));
      if (targetCurrentCap) {
        const current = capObj[targetCurrentCap] ? (capObj[targetCurrentCap].value || 16) : 16;
        await this.setCapabilityValue('target_current', current).catch(() => {});
      }

      // Set onoff if available
      if (caps.includes('onoff')) {
        const isOn = capObj.onoff ? (capObj.onoff.value !== false) : true;
        await this.setCapabilityValue('onoff', isOn).catch(() => {});
      }

      // Subscribe to real-time power changes
      if (caps.includes('measure_power')) {
        try {
          this._powerInstance = realDevice.makeCapabilityInstance('measure_power', (value) => {
            if (typeof value === 'number') {
              this.setCapabilityValue('measure_power', value).catch(() => {});
            }
          });
        } catch (err) {
          this.error('Power subscription error:', err);
        }
      }

      // Subscribe to real-time current changes
      if (targetCurrentCap) {
        try {
          this._currentInstance = realDevice.makeCapabilityInstance(targetCurrentCap, (value) => {
            if (typeof value === 'number') {
              this.setCapabilityValue('target_current', value).catch(() => {});
            }
          });
        } catch (err) {
          this.error('Current subscription error:', err);
        }
      }

      // Subscribe to real-time onoff changes
      if (caps.includes('onoff')) {
        try {
          this._onoffInstance = realDevice.makeCapabilityInstance('onoff', (value) => {
            this.setCapabilityValue('onoff', value !== false).catch(() => {});
          });
        } catch (err) {
          this.error('Onoff subscription error:', err);
        }
      }

      // Register listener for manual current adjustment via device tile
      this.registerCapabilityListener('target_current', async (value) => {
        try {
          const cap = ['target_current', 'dynamicCircuitCurrentP1', 'dynamic_current']
            .find(c => (this._realDevice.capabilities || []).includes(c));
          if (cap) {
            await this._realDevice.setCapabilityValue({ capabilityId: cap, value: Math.round(value) });
            this.log(`Current set to ${value}A by user`);
          }
        } catch (err) {
          this.error('Failed to set current:', err);
        }
      });

      // Register listener for pause/resume charging via device tile
      this.registerCapabilityListener('onoff', async (value) => {
        try {
          if ((this._realDevice.capabilities || []).includes('onoff')) {
            await this._realDevice.setCapabilityValue({ capabilityId: 'onoff', value });
            this.log(`Charging ${value ? 'resumed' : 'paused'} by user`);
          }
        } catch (err) {
          this.error('Failed to set onoff:', err);
        }
      });

      this.setAvailable();
    } catch (err) {
      this.error('Init error:', err);
      this.setUnavailable('Connection failed');
    }
  }

  async onDeleted() {
    this.log('EV Charger device deleted:', this.getName());
    // Clean up listeners
    if (this._powerInstance) {
      try {
        this._powerInstance.destroy();
      } catch (_) {}
    }
    if (this._currentInstance) {
      try {
        this._currentInstance.destroy();
      } catch (_) {}
    }
    if (this._onoffInstance) {
      try {
        this._onoffInstance.destroy();
      } catch (_) {}
    }
  }

}

module.exports = EVChargerDevice;
