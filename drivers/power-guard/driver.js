'use strict';

const Homey = require('homey');

class PowerGuardDriver extends Homey.Driver {

  async onInit() {
    this.log('Power Guard driver initialised');
  }

  async onPairListDevices() {
    // Only allow one virtual Power Guard device
    const existing = this.getDevices();
    if (existing.length > 0) {
      throw new Error(this.homey.__('errors.deviceExists'));
    }
    return [
      {
        name: this.homey.__('device.name'),
        data: { id: 'power-guard-virtual' },
      },
    ];
  }
}

module.exports = PowerGuardDriver;
