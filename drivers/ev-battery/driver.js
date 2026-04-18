'use strict';

const Homey = require('homey');

class EvBatteryDriver extends Homey.Driver {

  async onInit() {
    this.log('EV Battery driver initialised');
  }

  async onPairListDevices() {
    const priorityList = this.homey.settings.get('priorityList') || [];
    return priorityList
      .filter(e => e.enabled !== false && (e.action === 'dynamic_current' || e.action === 'charge_pause'))
      .map(e => ({
        name: `EV Batteri — ${e.name}`,
        data: { id: `ev-battery-${e.deviceId}`, chargerId: e.deviceId },
      }));
  }
}

module.exports = EvBatteryDriver;
