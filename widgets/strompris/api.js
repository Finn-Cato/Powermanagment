'use strict';
module.exports = {
  async getData({ homey }) {
    const pd = homey.app.getPriceData();
    const state = pd.state || {};
    return {
      level:      state.level      || null,
      chargeMode: state.chargeMode || null,
      currentOre: state.currentOre != null ? state.currentOre : null,
      spotOre:    state.spotOre    != null ? state.spotOre    : null,
      nextOre:    state.nextOre    != null ? state.nextOre    : null,
      chargeModes: state.chargeModes || {},
      entries:    (state.entries   || []).slice(0, 24),
      stats:      state.stats      || null,
    };
  },
};
