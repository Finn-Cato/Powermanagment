'use strict';
module.exports = {
  async getStatus({ homey }) {
    const s = homey.app.getStatus();
    return {
      effekttariff:  s.effekttariff  || null,
      hourlyEnergy:  s.hourlyEnergy  || null,
      limitW:        Math.round(s.limitW || 0),
      currentPowerW: Math.round(s.currentPowerW || 0),
    };
  },
};
