'use strict';

const Homey = require('homey');
const { HomeyAPI } = require('homey-api');

class ThermostatDriver extends Homey.Driver {

  async onInit() {
    this.log('Thermostat driver initialised');
    try {
      this._api = await HomeyAPI.createAppAPI({ homey: this.homey });
    } catch (err) {
      this.error('HomeyAPI init error:', err);
    }
  }

  async onPairListDevices() {
    if (!this._api) {
      throw new Error('API not ready');
    }

    try {
      const allDevices = await this._api.devices.getDevices();

      // Find all controllable thermostats
      const candidates = Object.values(allDevices).filter(device => {
        const caps = device.capabilities || [];
        const cls = (device.class || '').toLowerCase();
        const name = (device.name || '').toLowerCase();

        const isThermostat = cls === 'thermostat';
        const hasTargetTemp = caps.includes('target_temperature') ||
                              caps.includes('set_temperature') ||
                              caps.includes('setpoint_temperature') ||
                              caps.includes('heating_setpoint') ||
                              caps.includes('desired_temperature');
        const hasMeasureTemp = caps.includes('measure_temperature') ||
                               caps.includes('temperature') ||
                               caps.includes('current_temperature');
        const isFloorHeater = name.includes('floor') ||
                              name.includes('varme') ||
                              name.includes('heating') ||
                              name.includes('gulv') ||
                              name.includes('termostat');

        // Include devices that are thermostats or have temperature control
        return isThermostat || ((hasTargetTemp || hasMeasureTemp) && isFloorHeater);
      });

      this.log(`Found ${candidates.length} potential thermostats`);

      return candidates.map(device => ({
        name: device.name,
        data: {
          id: 'therm-' + device.id,
          realDeviceId: device.id,
        },
      }));
    } catch (err) {
      this.error('Device discovery error:', err);
      throw err;
    }
  }
}

module.exports = ThermostatDriver;
