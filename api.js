'use strict';

module.exports = {
  async getStatus({ homey }) {
    return homey.app.getStatus();
  },

  async getPowerConsumption({ homey }) {
    return homey.app.getPowerConsumption();
  },

  async getDebugLog({ homey }) {
    return homey.app.getDebugLog();
  },

  async getFloorHeaters({ homey }) {
    return await homey.app.checkFloorHeaterConnections();
  },

  async controlFloorHeater({ homey, body }) {
    if (!body || typeof body !== 'object') return { ok: false, error: 'Invalid request' };
    return await homey.app.controlFloorHeater(body.deviceId, body.action, body.value);
  },

  async getSettings({ homey }) {
    const s = homey.settings;
    return {
      enabled:           s.get('enabled')           ?? true,
      profile:           s.get('profile')           ?? 'normal',
      powerLimitW:       s.get('powerLimitW')       ?? 10000,
      phase1LimitA:      s.get('phase1LimitA')      ?? 0,
      phase2LimitA:      s.get('phase2LimitA')      ?? 0,
      phase3LimitA:      s.get('phase3LimitA')      ?? 0,
      smoothingWindow:   s.get('smoothingWindow')   ?? 5,
      spikeMultiplier:   s.get('spikeMultiplier')   ?? 2.0,
      hysteresisCount:   s.get('hysteresisCount')   ?? 3,
      cooldownSeconds:   s.get('cooldownSeconds')   ?? 30,
      voltageSystem:     s.get('voltageSystem')     ?? '230v-1phase',
      phaseDistribution: s.get('phaseDistribution') ?? 'balanced',
      mainCircuitA:      s.get('mainCircuitA')      ?? 25,
      classFilters:      s.get('classFilters')      ?? {},
      priorityList:      s.get('priorityList')      ?? [],
      selectedMeterDeviceId: s.get('selectedMeterDeviceId') ?? 'auto',
    };
  },

  async getDevices({ homey }) {
    return homey.app.getDevicesForSettings();
  },

  async getDiagnostic({ homey }) {
    return homey.app.getDiagnosticInfo();
  },

  async getAllData({ homey }) {
    const s = homey.settings;
    return {
      settings: {
        enabled:           s.get('enabled')           ?? true,
        profile:           s.get('profile')           ?? 'normal',
        powerLimitW:       s.get('powerLimitW')       ?? 10000,
        phase1LimitA:      s.get('phase1LimitA')      ?? 0,
        phase2LimitA:      s.get('phase2LimitA')      ?? 0,
        phase3LimitA:      s.get('phase3LimitA')      ?? 0,
        smoothingWindow:   s.get('smoothingWindow')   ?? 5,
        spikeMultiplier:   s.get('spikeMultiplier')   ?? 2.0,
        hysteresisCount:   s.get('hysteresisCount')   ?? 3,
        cooldownSeconds:   s.get('cooldownSeconds')   ?? 30,
        voltageSystem:     s.get('voltageSystem')     ?? '230v-1phase',
        phaseDistribution: s.get('phaseDistribution') ?? 'balanced',
        mainCircuitA:      s.get('mainCircuitA')      ?? 25,
        classFilters:      s.get('classFilters')      ?? {},
        priorityList:      s.get('priorityList')      ?? [],
        selectedMeterDeviceId: s.get('selectedMeterDeviceId') ?? 'auto',
      },
      status:  homey.app.getStatus(),
      devices: homey.app.getDevicesForSettings(),
    };
  },

  async setPriorityList({ homey, body }) {
    // Guard: only save if body is actually an array — a null body from one
    // CF2 path must never overwrite a valid list saved by the other path.
    if (!Array.isArray(body)) return { ok: true };
    homey.settings.set('priorityList', body);
    if (homey.app && typeof homey.app._loadSettings === 'function') {
      homey.app._loadSettings();
    }
    // Push the updated list to all open settings pages (phone + web) in real time.
    try { homey.api.realtime('priorityList', body); } catch (_) {}
    return { ok: true };
  },

  async setSettings({ homey, body }) {
    if (!body || typeof body !== 'object') return { ok: true };
    const allowed = [
      'enabled', 'profile', 'powerLimitW',
      'phase1LimitA', 'phase2LimitA', 'phase3LimitA',
      'smoothingWindow', 'spikeMultiplier', 'hysteresisCount', 'cooldownSeconds',
      'voltageSystem', 'phaseDistribution', 'mainCircuitA', 'classFilters',
    ];
    const changed = [];
    for (const key of allowed) {
      if (body[key] !== undefined) {
        homey.settings.set(key, body[key]);
        changed.push(key);
      }
    }
    // Reload in-memory settings immediately so the profile etc. take effect now
    if (homey.app && typeof homey.app._loadSettings === 'function') {
      homey.app._loadSettings();
    }
    // If power limit or profile changed, force immediate charger re-evaluation
    const limitKeys = ['powerLimitW', 'profile', 'enabled', 'phase1LimitA', 'phase2LimitA', 'phase3LimitA'];
    if (changed.some(k => limitKeys.includes(k)) && homey.app._forceChargerRecheck) {
      homey.app._forceChargerRecheck().catch(() => {});
    }
    return { ok: true };
  },

  async getCacheStatus({ homey }) {
    const app = homey.app;
    const cache = homey.settings.get('_deviceCache') || [];
    const ageMs = app._lastCacheTime ? Date.now() - app._lastCacheTime : null;
    return {
      cacheReady: app._deviceCacheReady || false,
      cacheCount: cache.length,
      cacheAgeSeconds: ageMs ? Math.round(ageMs / 1000) : null,
      apiAvailable: !!app._api,
      hanConnected: !!app._hanDeviceId,
    };
  },

  async refreshDeviceCache({ homey }) {
    const app = homey.app;
    await app._cacheDevices();
    const cache = homey.settings.get('_deviceCache') || [];
    return {
      success: true,
      cacheCount: cache.length,
      cacheReady: app._deviceCacheReady || false,
    };
  },

  async testCharger({ homey, body }) {
    const app = homey.app;
    return app.testEaseeCharger(body ? body.deviceId : null);
  },

  async debugHeaters({ homey }) {
    const app = homey.app;
    if (!app._api) return { error: 'API not ready' };
    const allDevices = homey.settings.get('_deviceCache') || [];
    const results = [];
    for (const cached of allDevices) {
      if (!cached) continue;
      const cls = (cached.class || '').toLowerCase();
      const name = (cached.name || '').toLowerCase();
      const isHeater = cls === 'thermostat' || cls === 'heater' ||
        name.includes('varme') || name.includes('heating') || name.includes('termostat') || name.includes('thermostat');
      if (!isHeater) continue;
      try {
        const live = await app._api.devices.getDevice({ id: cached.id });
        const capValues = {};
        if (live && live.capabilitiesObj) {
          for (const [cap, obj] of Object.entries(live.capabilitiesObj)) {
            capValues[cap] = obj && obj.value !== undefined ? obj.value : null;
          }
        }
        results.push({
          id: cached.id,
          name: cached.name,
          class: cached.class,
          driverId: cached.driverId,
          driverUri: cached.driverUri || (live && live.driverUri) || '',
          ownerUri: (live && live.driver && live.driver.owner_uri) || '',
          isAdax: cached.isAdax || false,
          capabilities: live ? Object.keys(live.capabilitiesObj || {}) : cached.capabilities,
          values: capValues,
        });
      } catch (err) {
        results.push({ id: cached.id, name: cached.name, error: err.message });
      }
    }
    return results;
  },

  async applyCircuitLimits({ homey }) {
    const app = homey.app;
    return app.applyCircuitLimitsToChargers();
  },

  async getMeterDevices({ homey }) {
    return homey.app.getMeterDevices();
  },

  async getHanDiagnostic({ homey }) {
    return homey.app.getHanDiagnostic();
  },

  async setMeterDevice({ homey, body }) {
    if (!body || typeof body !== 'object') return { ok: false, error: 'Invalid request' };
    const deviceId = body.deviceId || 'auto';
    homey.settings.set('selectedMeterDeviceId', deviceId);
    // Reconnect HAN with the new selection
    const app = homey.app;
    if (app._hanCapabilityInstance) {
      try { app._hanCapabilityInstance.destroy(); } catch (_) {}
      app._hanCapabilityInstance = null;
    }
    if (app._hanPollInterval) {
      clearInterval(app._hanPollInterval);
      app._hanPollInterval = null;
    }
    app._hanDevice = null;
    app._hanDeviceName = null;
    app._hanDeviceManufacturer = null;
    app._hanDeviceId = null;
    await app._connectToHAN();
    return {
      ok: true,
      hanConnected: !!app._hanDeviceId,
      hanDeviceName: app._hanDeviceId ? app._getHANDeviceBrand() : null,
    };
  },

  async getAppLog({ homey }) {
    return homey.app.getAppLog();
  },
};
