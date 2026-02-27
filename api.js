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

  async getFirmwareInfo({ homey, query }) {
    const search = ((query && query.search) || '').toLowerCase();
    const api = homey.app._api;
    if (!api) return { error: 'API not ready — try again in a moment' };
    // Fetch all devices fresh so we get their .settings
    const all = await api.devices.getDevices();
    const results = [];
    for (const d of Object.values(all || {})) {
      if (!d) continue;
      const name = (d.name || '').toLowerCase();
      const driverId = (d.driverId || '').toLowerCase();
      const driverUri = (d.driverUri || '').toLowerCase();
      const driver = driverId || driverUri;
      if (search && !name.includes(search) && !driver.includes(search)) continue;
      const s = d.settings || {};
      // Z-Wave firmware fields
      const fw = s.zw_firmware_id || s.zw_application_version ||
        // Zigbee / generic firmware fields
        s.firmware || s.firmwareVersion || s.sw_version || s.softwareVersion ||
        s.application_version || s.applicationVersion || null;
      const hwVer = s.zw_hardware_version || s.hardwareVersion || s.hw_version || null;
      results.push({
        name: d.name,
        id: d.id,
        class: d.class,
        driver: driverId || driverUri.replace(/^homey:app:/, ''),
        firmware: fw,
        hardwareVersion: hwVer,
        allSettings: s,
      });
    }
    return results;
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

  // Read live target_charger_current (and target_circuit_current) from each configured charger.
  // Returns a map of { [deviceId]: { target_charger_current, target_circuit_current, caps } }
  async getChargerLimits({ homey }) {
    const app = homey.app;
    if (!app._api) return {};
    const priorityList = homey.settings.get('priorityList') || [];
    const chargers = priorityList.filter(e =>
      (e.action === 'dynamic_current' || e.action === 'charge_pause') && e.enabled !== false
    );
    const limits = {};
    for (const entry of chargers) {
      try {
        const device = await app._api.devices.getDevice({ id: entry.deviceId });
        if (!device) { limits[entry.deviceId] = null; continue; }
        const caps = device.capabilities || [];
        const obj  = device.capabilitiesObj || {};

        // Priority for reading the true Max Current (Ladergrense):
        //   1. max_charger_current cap — if the Homey Easee app exposes ID47 separately (never throttled)
        //   2. pre-mitigation snapshot of target_charger_current — captured before PowerGuard throttled it
        //   3. live target_charger_current — only when charger is not currently mitigated
        const mitigatedEntry = (app._mitigatedDevices || []).find(m => m.deviceId === entry.deviceId);
        const liveCircuit  = obj.target_circuit_current?.value ?? null;
        const liveCharger  = obj.target_charger_current?.value ?? null;

        // Prefer max_charger_current (ID47 permanent) if the Homey Easee app exposes it
        const staticMax = caps.includes('max_charger_current') && (obj.max_charger_current?.value ?? null) > 0
          ? (obj.max_charger_current?.value ?? null) : null;

        const effectiveCharger =
          staticMax != null
            ? staticMax  // Homey cap ID47 directly available
            : (mitigatedEntry && mitigatedEntry.previousState?.targetCurrent != null)
              ? mitigatedEntry.previousState.targetCurrent  // pre-throttle snapshot (key = targetCurrent)
              : liveCharger;  // not throttled, live value = ID47

        // Dump every capability value for diagnostics
        const allValues = {};
        caps.forEach(c => { if (obj[c] && obj[c].value != null) allValues[c] = obj[c].value; });

        limits[entry.deviceId] = {
          target_charger_current: effectiveCharger,
          target_circuit_current: liveCircuit,
          max_charger_current:    caps.includes('max_charger_current')    ? (obj.max_charger_current?.value    ?? null) : null,
          max_circuit_current:    caps.includes('max_circuit_current')    ? (obj.max_circuit_current?.value    ?? null) : null,
          dynamic_charger_current: caps.includes('dynamic_charger_current') ? (obj.dynamic_charger_current?.value ?? null) : null,
          dynamic_circuit_current: caps.includes('dynamic_circuit_current') ? (obj.dynamic_circuit_current?.value ?? null) : null,
          mitigated: !!mitigatedEntry,
          caps: caps.filter(c => c.includes('current') || c.includes('charger') || c.includes('circuit') || c.includes('max')),
          allValues,
        };
      } catch (_) {
        limits[entry.deviceId] = null;
      }
    }
    return limits;
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

  // ─── Section 12 — Direct Easee REST API ──────────────────────────────────

  /**
   * Authenticate against the Easee cloud with a username + password.
   * Tokens are stored in Homey settings for subsequent calls.
   * Called from the settings UI "Connect" button.
   */
  async easeeLogin({ homey, body }) {
    if (!body || typeof body !== 'object') return { ok: false, error: 'Invalid request body' };
    const { username, password } = body;
    return homey.app.loginEaseeDirectAPI(username, password);
  },

  /**
   * Return the current Easee direct API connection status.
   * Used by the settings UI to show connected/disconnected badge.
   */
  async getEaseeStatus({ homey }) {
    return homey.app.getEaseeDirectAPIStatus();
  },

  async getPowerCorrections({ homey }) {
    return homey.settings.get('powerCorrections') ?? { '4512760': 0.1 };
  },

  async setPowerCorrections({ homey, body }) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'Expected an object' };
    // Validate: keys = strings, values = finite numbers
    const clean = {};
    for (const [k, v] of Object.entries(body)) {
      const n = Number(v);
      if (!isFinite(n)) return { ok: false, error: `Invalid multiplier for "${k}": ${v}` };
      clean[String(k).trim()] = n;
    }
    homey.settings.set('powerCorrections', clean);
    if (homey.app && typeof homey.app._loadSettings === 'function') homey.app._loadSettings();
    return { ok: true };
  },
};
