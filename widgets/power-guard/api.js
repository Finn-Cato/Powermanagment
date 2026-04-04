'use strict';

module.exports = {
  async getStatus({ homey }) {
    const s = homey.app.getStatus();
    return {
      enabled:          s.enabled,
      profile:          s.profile,
      currentPowerW:    Math.round(s.currentPowerW || 0),
      limitW:           Math.round(s.limitW || 0),
      evChargers:       (s.evChargers || []).map(c => ({
        deviceId:       c.deviceId,
        name:           c.name,
        powerW:         c.powerW,
        status:         c.status,
        statusLabel:    c.statusLabel,
        wattsPerAmp:    c.wattsPerAmp || null,
        detectedPhases: c.detectedPhases || null,
      })),
      mitigatedCount:   (s.mitigatedDevices || []).length,
      overLimitCount:   s.overLimitCount || 0,
    };
  },
};
