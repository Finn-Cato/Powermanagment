'use strict';

const Homey = require('homey');

const SETTING_KEYS = [
  'enabled', 'profile', 'powerLimitW', 'cooldownSeconds',
  'hysteresisCount', 'smoothingWindow', 'spikeMultiplier',
  'phase1LimitA', 'phase2LimitA', 'phase3LimitA',
];

class PowerGuardDevice extends Homey.Device {

  async onInit() {
    this.log('Power Guard device init:', this.getName());

    await this.setCapabilityValue('measure_power', 0).catch(() => {});
    await this.setCapabilityValue('alarm_generic', false).catch(() => {});
    await this.setCapabilityValue('onoff', true).catch(() => {});

    // Toggle guard on/off from the device tile
    this.registerCapabilityListener('onoff', async (value) => {
      this.homey.settings.set('enabled', value);
      if (this.homey.app) this.homey.app._settings.enabled = value;
      this.log('Guard enabled via tile:', value);
    });

    // Push current homey.settings values into device settings so the
    // native settings UI shows the correct current values immediately.
    await this._syncSettingsToDevice();
  }

  // Copy app-level homey.settings → device settings (shown in the Homey app).
  async _syncSettingsToDevice() {
    const patch = {};
    for (const key of SETTING_KEYS) {
      const val = this.homey.settings.get(key);
      if (val !== null && val !== undefined) patch[key] = val;
    }
    if (Object.keys(patch).length > 0) {
      await this.setSettings(patch).catch((err) => this.error('syncSettings err:', err));
    }
  }

  // Called by Homey whenever the user changes a device setting in the Homey app.
  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log('Device settings changed:', changedKeys);
    for (const key of changedKeys) {
      this.homey.settings.set(key, newSettings[key]);
    }
    // Reload app.js in-memory settings cache immediately.
    if (this.homey.app && typeof this.homey.app._loadSettings === 'function') {
      this.homey.app._loadSettings();
    }
  }

  async onAdded() {
    this.log('Power Guard device added');
  }

  async onDeleted() {
    this.log('Power Guard device removed');
  }
}

module.exports = PowerGuardDevice;
