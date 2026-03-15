'use strict';

// ── Shared helper ─────────────────────────────────────────────────────────────
// Returns a plain settings object from Homey persistent storage.
// Used by both getSettings() and getAllData() to avoid duplication.
function _readSettings(s) {
  return {
    enabled:              s.get('enabled')              ?? true,
    profile:              s.get('profile')              ?? 'normal',
    powerLimitW:          s.get('powerLimitW')          ?? 10000,
    phase1LimitA:         s.get('phase1LimitA')         ?? 0,
    phase2LimitA:         s.get('phase2LimitA')         ?? 0,
    phase3LimitA:         s.get('phase3LimitA')         ?? 0,
    smoothingWindow:      s.get('smoothingWindow')      ?? 5,
    spikeMultiplier:      s.get('spikeMultiplier')      ?? 2.0,
    hysteresisCount:      s.get('hysteresisCount')      ?? 3,
    cooldownSeconds:      s.get('cooldownSeconds')      ?? 30,
    errorMarginPercent:   s.get('errorMarginPercent')   ?? 0,
    missingPowerTimeoutS: s.get('missingPowerTimeoutS') ?? 120,
    dynamicRestoreGuard:  s.get('dynamicRestoreGuard')  ?? true,
    voltageSystem:        s.get('voltageSystem')        ?? '230v-1phase',
    phaseDistribution:    s.get('phaseDistribution')    ?? 'balanced',
    mainCircuitA:         s.get('mainCircuitA')         ?? 25,
    classFilters:         s.get('classFilters')         ?? {},
    powerExcluded:        s.get('powerExcluded')        ?? {},
    priorityList:         s.get('priorityList')         ?? [],
    selectedMeterDeviceId: s.get('selectedMeterDeviceId') ?? 'auto',
  };
}

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
    return _readSettings(homey.settings);
  },

  async getDevices({ homey }) {
    return homey.app.getDevicesForSettings();
  },

  async getAllData({ homey }) {
    return {
      settings: _readSettings(homey.settings),
      status:   homey.app.getStatus(),
      devices:  homey.app.getDevicesForSettings(),
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
      'errorMarginPercent', 'missingPowerTimeoutS', 'dynamicRestoreGuard',
      'voltageSystem', 'phaseDistribution', 'mainCircuitA', 'classFilters', 'powerExcluded',
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

  // ─── Section 13 — Spot Price Engine ──────────────────────────────────────

  /** Return current price state + settings for the Price tab */
  async getPriceData({ homey }) {
    return homey.app.getPriceData();
  },

  /** Save price settings and trigger an immediate re-evaluation */
  async setPriceSettings({ homey, body }) {
    if (!body || typeof body !== 'object') return { ok: false, error: 'Invalid body' };
    await homey.app.savePriceSettings(body);
    return { ok: true };
  },
  /** Trigger an immediate price re-fetch from the UI refresh button */
  async refreshPriceData({ homey }) {
    await homey.app.refreshPriceData();
    return { ok: true };
  },

  // ─── Section 14 — EV Smart Charging ──────────────────────────────────────

  /** Read car charging status + schedule settings from app state (no external Logic variables required) */
  async getEvChargingStatus({ homey }) {
    try {
      const evData      = homey.app._evPowerData || {};
      const batteryState = homey.app._evBatteryState || {};
      const priceData   = homey.app.getPriceData();
      const priceState  = priceData.state;
      const chargeMode  = priceState ? priceState.chargeMode : null;
      const now         = Date.now();

      // 2-minute grace window: if charging was confirmed recently, don't flip to "not charging"
      // during brief Easee transitions (current adjustments) or slow startup snapshots.
      const GRACE_MS = 2 * 60 * 1000;

      // Build per-charger status — one entry per tracked EV charger
      const chargerStatuses = Object.entries(evData).map(([deviceId, c]) => {
        const inGrace           = c.lastChargingAt && (now - c.lastChargingAt) < GRACE_MS;
        const bst               = batteryState[deviceId];
        const batteryFull       = bst && typeof bst.pct === 'number' && bst.pct >= 99;
        // Display: raw charger data only — no grace window. Suppress if car is known full (isCharging
        // stays true on Easee/onoff chargers even when car is at 100% and drawing 0W).
        const displayCharging   = !batteryFull && (c.isCharging === true || (c.powerW || 0) > 200);
        // Mismatch: use grace window to avoid flickering during Easee current adjustments
        const effectiveCharging = displayCharging || (c.isConnected && inGrace);
        // Per-charger mode — fall back to global if not yet calculated
        const chargerMode       = (priceState && priceState.chargeModes && priceState.chargeModes[deviceId])
                                  || chargeMode;
        const shouldCharge      = c.isConnected && !batteryFull && chargerMode !== null && chargerMode !== 'av';
        const mismatch          = c.isConnected && shouldCharge && !effectiveCharging;
        return {
          deviceId,
          name:        c.name || deviceId,
          connected:   c.isConnected === true,
          charging:    displayCharging,
          chargeMode:  chargerMode,
          shouldCharge,
          mismatch,
          powerW:      Math.round(c.powerW || 0),
          inGrace:     !!(c.isConnected && inGrace && !displayCharging),
        };
      });

      // Backwards-compatible aggregate fields (used by legacy code paths)
      const bilTilkoblet   = chargerStatuses.some(c => c.connected);
      const bilLaderNa     = chargerStatuses.some(c => c.charging);
      const burdeLadeBilen = bilTilkoblet && chargeMode !== null && chargeMode !== 'av';

      // Next cheap hour
      let nesteBilligeTime = null;
      if (priceState && Array.isArray(priceState.entries)) {
        const isFlat = priceState.stats && priceState.stats.spread === 0;
        if (isFlat) {
          nesteBilligeTime = 'flat_rate';
        } else {
          const cheap = priceState.entries.find(e => new Date(e.hour).getTime() > now && e.level === 'billig');
          if (cheap) {
            const d = new Date(cheap.hour);
            nesteBilligeTime = d.getHours().toString().padStart(2, '0') + ':00';
          }
        }
      }

      return {
        ok: true,
        chargers:           chargerStatuses,
        bil_tilkoblet:      bilTilkoblet,
        bil_lader_na:       bilLaderNa,
        burde_lade_bilen:   burdeLadeBilen,
        lademodus:          chargeMode,
        strompris:          priceState ? priceState.level : null,
        neste_billige_time: nesteBilligeTime,
        ladebehov_timer:    homey.settings.get('ev_ladebehov_timer') ?? null,
        ferdig_ladet_kl:    homey.settings.get('ev_ferdig_ladet_kl') ?? null,
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },

  /** Write ladebehov_timer and ferdig_ladet_kl — stored in app settings (primary) and Homey Logic variables (secondary, if they exist) */
  async setEvChargingSettings({ homey, body }) {
    if (!body || typeof body !== 'object') return { ok: false, error: 'Invalid body' };
    const api = homey.app._api;
    if (!api) return { ok: false, error: 'HomeyAPI not ready' };

    try {
      const timer  = body.ladebehov_timer !== undefined ? Math.max(0, Math.round(Number(body.ladebehov_timer) || 0)) : undefined;
      const ferdig = body.ferdig_ladet_kl  !== undefined ? String(body.ferdig_ladet_kl || '') : undefined;

      // Primary: save to app settings so values persist regardless of Logic variable setup
      if (timer  !== undefined) homey.settings.set('ev_ladebehov_timer',  timer);
      if (ferdig !== undefined) homey.settings.set('ev_ferdig_ladet_kl',  ferdig);

      // Secondary: also update Homey Logic variable if it exists (for HomeyScript integration)
      try {
        const allVars = await api.logic.getVariables();
        const vars = Object.values(allVars || {});
        const setVar = async (name, value) => {
          const v = vars.find(v => v.name === name);
          if (v) await api.logic.updateVariable({ id: v.id, variable: { value } });
        };
        if (timer  !== undefined) await setVar('ladebehov_timer', timer);
        if (ferdig !== undefined) await setVar('ferdig_ladet_kl',  ferdig);
      } catch (_) { /* Logic variables optional */ }

      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },

  /** POST /ev-battery-report — body: { deviceId, batteryPct } */
  async reportEvBattery({ homey, body }) {
    if (!body || typeof body !== 'object') return { ok: false, error: 'Invalid body' };
    const { deviceId, batteryPct } = body;
    if (!deviceId || typeof batteryPct !== 'number' || batteryPct < 0 || batteryPct > 100) {
      return { ok: false, error: 'deviceId (string) and batteryPct (0–100) required' };
    }
    try {
      homey.app.reportEvBattery(deviceId, batteryPct);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },

  /** GET /ev-battery-state — returns stored battery state for all chargers */
  async getEvBatteryState({ homey }) {
    return {
      ok:           true,
      batteryState: homey.app._evBatteryState || {},
    };
  },

  /** Returns all Homey devices that expose a battery % capability — used to populate
   *  the "Car device" selector in the Devices tab so PG can poll battery directly. */
  async getCarDevices({ homey }) {
    const BATTERY_CAPS = ['measure_battery', 'batterylevel', 'battery', 'ev_battery_level', 'battery_level'];
    const cache = homey.settings.get('_deviceCache') || [];
    const devices = cache
      .filter(d => Array.isArray(d.capabilities) && BATTERY_CAPS.some(c => d.capabilities.includes(c)))
      .map(d => ({
        id:         d.id,
        name:       d.name,
        capability: BATTERY_CAPS.find(c => d.capabilities.includes(c)),
      }));
    return { ok: true, devices };
  },

  // ─── Section 15 — Mode Engine ─────────────────────────────────────────────

  async getModesSettings({ homey }) {
    return homey.app.getModesSettings();
  },

  async setModesSettings({ homey, body }) {
    if (!body || typeof body !== 'object') return { ok: false, error: 'Invalid body' };
    await homey.app.saveModesSettings(body);
    return { ok: true };
  },

  async activateMode({ homey, body }) {
    if (!body || typeof body !== 'object') return { ok: false, error: 'Invalid body' };
    await homey.app.activateMode(body.mode);
    return { ok: true };
  },
};
