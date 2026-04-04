'use strict';
module.exports = {
  async getStatus({ homey }) {
    const s = homey.app.getStatus();
    return {
      evChargers: (s.evChargers || []).map(c => ({
        deviceId:       c.deviceId,
        name:           c.name,
        powerW:         c.powerW,
        status:         c.status,
        statusLabel:    c.statusLabel,
        currentA:       c.currentA,
        wattsPerAmp:    c.wattsPerAmp || null,
        detectedPhases: c.detectedPhases || null,
        circuitLimitA:  c.circuitLimitA,
      })),
      currentPowerW: Math.round(s.currentPowerW || 0),
      limitW:        Math.round(s.limitW || 0),
    };
  },
};
