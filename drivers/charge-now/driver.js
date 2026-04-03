'use strict';

const Homey = require('homey');

class ChargeNowDriver extends Homey.Driver {

  async onInit() {
    this.log('Charge Now driver initialised');
  }

  async onPairListDevices() {
    const priorityList = this.homey.settings.get('priorityList') || [];
    return priorityList
      .filter(e => e.enabled !== false && (e.action === 'dynamic_current' || e.action === 'charge_pause'))
      .map(e => ({
        name: `Kriseknappen — ${e.name}`,
        data: { id: `charge-now-${e.deviceId}`, chargerId: e.deviceId },
      }));
  }
}

module.exports = ChargeNowDriver;
