'use strict';
module.exports = {
  async getStatus({ homey }) {
    const s = homey.app.getStatus();
    const rawList = homey.settings.get('priorityList') || [];
    return {
      currentPowerW:    Math.round(s.currentPowerW || 0),
      limitW:           Math.round(s.limitW || 0),
      overLimitCount:   s.overLimitCount || 0,
      mitigatedDevices: s.mitigatedDevices || [],
      lastMitigationScan: s.lastMitigationScan || [],
      priorityList: rawList.map(function(e) {
        return { deviceId: e.deviceId, name: e.name, action: e.action, enabled: e.enabled !== false };
      }),
    };
  },
};
