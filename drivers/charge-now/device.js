'use strict';

const Homey = require('homey');

class ChargeNowDevice extends Homey.Device {

  async onInit() {
    this.log('Charge Now device init:', this.getName());
    const { chargerId } = this.getData();

    // Restore persisted state on boot
    const wasOn = this.getStoreValue('chargeNow') === true;
    await this.setCapabilityValue('onoff', wasOn).catch(() => {});
    if (wasOn && this.homey.app) {
      this.homey.app._chargeNow[chargerId] = Date.now();
    }

    this.registerCapabilityListener('onoff', async (value) => {
      const app = this.homey.app;
      if (!app) return;
      if (value) {
        app._chargeNow[chargerId] = Date.now();
        this.log(`Charge Now ON for ${chargerId}`);
      } else {
        delete app._chargeNow[chargerId];
        this.log(`Charge Now OFF for ${chargerId}`);
        // Force laderen tilbake til "pauset" tilstand så neste syklus
        // starter fra 6A og sjekker pris/headroom på nytt (istedenfor å
        // fortsette ved nåværende høye strøm fra kriseknapp-perioden).
        const tracked = app._mitigatedDevices?.find(m => m.deviceId === chargerId);
        if (tracked) {
          tracked.currentTargetA = 0;
        }
      }
      await this.setStoreValue('chargeNow', value);
      // Trigger immediate re-evaluation so effect is instant
      app._forceChargerRecheck?.().catch(() => {});
    });
  }

  async onDeleted() {
    const { chargerId } = this.getData();
    if (this.homey.app) {
      delete this.homey.app._chargeNow[chargerId];
    }
    this.log('Charge Now device deleted:', chargerId);
  }
}

module.exports = ChargeNowDevice;
