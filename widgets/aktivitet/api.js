'use strict';
module.exports = {
  async getLog({ homey }) {
    const data = homey.app.getDebugLog ? homey.app.getDebugLog() : {};
    const entries = (data.appLog || []).slice(-20).reverse();
    return { entries };
  },
};
