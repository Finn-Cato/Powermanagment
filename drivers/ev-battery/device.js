'use strict';

const Homey = require('homey');

class EvBatteryDevice extends Homey.Device {

  async onInit() {
    this.log('EV Battery device init:', this.getName());
    const { chargerId } = this.getData();

    // Restore last known value on boot — clamp to 0–100 to discard any stale out-of-range value
    const _rawPct = await this.getStoreValue('batteryPct');
    const lastPct = (typeof _rawPct === 'number' && _rawPct >= 0 && _rawPct <= 100) ? _rawPct : null;
    if (lastPct !== null) {
      await this.setCapabilityValue('ev_battery_input', lastPct).catch(() => {});
      await this.setCapabilityValue('measure_battery', lastPct).catch(() => {});
    } else if (typeof _rawPct === 'number') {
      // Bad stored value — clear it so the slider resets to empty
      await this.setStoreValue('batteryPct', null);
      this.log(`EV Battery: discarded out-of-range stored value ${_rawPct}% — slider reset`);
    }

    // User drags the slider → report to Power Guard + mirror to measure_battery
    this.registerCapabilityListener('ev_battery_input', async (value) => {
      const pct = Math.round(value);
      this.log(`EV Battery: user set ${pct}% for charger ${chargerId}`);

      // Mirror to measure_battery so getCarDevices() polling works
      await this.setCapabilityValue('measure_battery', pct).catch(() => {});

      // Persist so it survives reboot
      await this.setStoreValue('batteryPct', pct);

      // Report to Power Guard app logic
      if (this.homey.app && typeof this.homey.app.reportEvBattery === 'function') {
        this.homey.app.reportEvBattery(chargerId, pct);
      }
    });
  }

  async onDeleted() {
    this.log('EV Battery device deleted:', this.getName());
  }
}

module.exports = EvBatteryDevice;
