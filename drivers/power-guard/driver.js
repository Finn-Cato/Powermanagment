'use strict';

const Homey = require('homey');

class PowerGuardDriver extends Homey.Driver {

  async onInit() {
    this.log('Power Guard driver initialised');
  }

  async onPairListDevices() {
    // Always return the single virtual device entry.
    // If it already exists, Homey will show it as already added
    // rather than showing an empty list.
    return [
      {
        name: this.homey.__('device.name'),
        data: { id: 'power-guard-virtual' },
      },
    ];
  }
}

module.exports = PowerGuardDriver;
