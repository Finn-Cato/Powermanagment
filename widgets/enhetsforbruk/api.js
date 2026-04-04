'use strict';
module.exports = {
  async getData({ homey }) {
    const pc  = homey.app.getPowerConsumption();
    const s   = homey.app.getStatus();
    const han = homey.app.getHanDiagnostic();
    return {
      totalW:        pc.totalW,
      devices:       (pc.devices || []).slice(0, 10),
      limitW:        Math.round(s.limitW || 0),
      hanName:       s.hanDeviceName || null,
      phaseCurrents: han.phaseCurrents || {},
      rawPowerW:     s.rawPowerW || null,
    };
  },
};
