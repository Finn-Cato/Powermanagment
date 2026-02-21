'use strict';

const Homey = require('homey');
const { HomeyAPI } = require('homey-api');

class EVChargerDriver extends Homey.Driver {

  async onInit() {
    this.log('EV Charger driver initialised');
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

      // Find all controllable EV chargers
      const candidates = Object.values(allDevices).filter(device => {
        const caps = device.capabilities || [];
        const isCharger = device.class === 'charger';
        const hasTargetCurrent = caps.includes('target_current') || caps.includes('dynamicCircuitCurrentP1');
        const hasChargePause = caps.includes('charge_pause');

        // Include devices that are chargers or have charging/current control capabilities
        return isCharger || hasTargetCurrent || hasChargePause;
      });

      this.log(`Found ${candidates.length} potential EV chargers`);

      return candidates.map(device => ({
        name: device.name,
        data: {
          id: 'ev-' + device.id,
          realDeviceId: device.id,
        },
      }));
    } catch (err) {
      this.error('Device discovery error:', err);
      throw err;
    }
  }
}

module.exports = EVChargerDriver;
