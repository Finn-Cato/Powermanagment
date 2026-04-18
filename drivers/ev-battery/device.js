'use strict';

const Homey = require('homey');

class EvBatteryDevice extends Homey.Device {

  async onInit() {
    this.log('EV Battery device init:', this.getName());
    const { chargerId } = this.getData();

    // Restore last known value on boot
    const lastPct = await this.getStoreValue('batteryPct');
    if (typeof lastPct === 'number') {
      await this.setCapabilityValue('ev_battery_input', lastPct).catch(() => {});
      await this.setCapabilityValue('measure_battery', lastPct).catch(() => {});
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
