'use strict';

const Homey = require('homey');
const { HomeyAPI } = require('homey-api');
const { Mutex } = require('async-mutex');
const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const { movingAverage, isSpike, timestamp } = require('./common/tools');
const { applyAction, restoreDevice } = require('./common/devices');
const { PROFILES, PROFILE_LIMIT_FACTOR, DEFAULT_SETTINGS, MITIGATION_LOG_MAX, CHARGER_DEFAULTS, EFFEKT_TIERS } = require('./common/constants');

/**
 * Promise wrapper with timeout — prevents hung API calls from blocking the mitigation cycle.
 * @param {Promise} promise - The promise to wrap
 * @param {number} ms - Timeout in milliseconds
 * @param {string} label - Label for error messages
 * @returns {Promise}
 */
function withTimeout(promise, ms, label = 'API call') {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    })
  ]).finally(() => clearTimeout(timer));
}

class PowerGuardApp extends Homey.App {

  // ══════════════════════════════════════════════════════════════════
  // █ SECTION 1 — CORE INFRASTRUCTURE                                         █
  // ══════════════════════════════════════════════════════════════════
  //  Included: onInit, settings, device cache, watchdog, flow cards,
  //            helpers, profile, virtual device, status cache
  //
  //  ✅ STABLE — DO NOT TOUCH unless absolutely necessary
  // ══════════════════════════════════════════════════════════════════

  async onInit() {
    this.log('========================================');
    this.log('Power Guard initialising...');
    this.log('[Power Consumption] Tracking system initializing');
    this.log('========================================');

    this._mutex = new Mutex();
    this._powerBuffer = [];
    this._spikeConsecutiveCount = 0;  // how many consecutive readings were spike-filtered
    this._spikeLastFilteredValue = null; // last value that was spike-filtered
    this._overLimitCount = 0;
    this._mitigatedDevices = [];
    this._lastMitigationTime = 0;
    this._mitigationLog = [];

    // Restore mitigated devices from persistent storage
    try {
      const saved = this.homey.settings.get('_mitigatedDevices');
      if (Array.isArray(saved) && saved.length > 0) {
        this._mitigatedDevices = saved;
        this.log(`Restored ${saved.length} mitigated device(s) from previous session`);
      }
    } catch (_) {}
    this._api = null;
    this._hanCapabilityInstance = null;
    this._hanDevice = null;
    this._hanDeviceName = null;
    this._hanDeviceManufacturer = null;
    this._lastHanReading = null;
    this._hanDeviceId = null;
    this._hanPollInterval = null;
    // HAN diagnostic counters for remote debugging
    this._hanEventCount = 0;
    this._hanPollCount = 0;
    this._hanSpikeCount = 0;
    this._hanWatchdogCount = 0;
    this._hanRawLog = [];         // Ring buffer: last 20 raw readings {time, value, source}
    this._phaseCurrents = {};    // Latest per-phase amps from HAN: {capId: amps}
    this._evPowerData = {};
    this._evCapabilityInstances = {};
    this._powerConsumptionData = {}; // Track power history for all devices: {deviceId: {current, avg, peak, readings[]}}
    this._powerConsumptionLog = []; // In-memory log for debug
    this._cachedDevices = null; // All devices from API (including non-controllable ones)
    this.log('[Power Consumption] Data object initialized');
    this._lastEVAdjustTime = 0;
    this._pendingChargerCommands = {};  // Track outstanding charger commands {deviceId: timestamp}
    this._chargerState = {};             // Per-charger confirmation & reliability: {deviceId: {lastCommandA, commandTime, confirmed, reliability, lastAdjustTime}}
    this._lastMitigationScan = [];      // Last mitigation scan results per device (for diagnostics)
    this._deviceCacheReady = false;
    this._lastCacheTime = null;
    this._saveQueue = [];
    // Unified app log for remote diagnostics
    this._appLog = [];          // Ring buffer: last 300 entries {time, category, message}
    this._appStartTime = Date.now();

    // Hourly energy tracking
    this._hourlyEnergy = {
      currentHour: new Date().getHours(),
      accumulatedWh: 0,        // Watt-hours accumulated this hour
      lastReadingW: 0,         // Last power reading in watts
      lastReadingTime: null,   // Timestamp of last reading
      history: [],             // Last 24 hours: [{hour, date, kWh}]
    };
    // Restore hourly energy history from persistent storage
    try {
      const savedEnergy = this.homey.settings.get('_hourlyEnergyHistory');
      if (Array.isArray(savedEnergy)) {
        this._hourlyEnergy.history = savedEnergy.slice(-24);  // Keep last 24 entries
      }
    } catch (_) {}

    // Effekttariff (capacity tariff) tracking — daily peak kW per day, persisted across restarts
    // Format: { "2026-02-24": 8.5, "2026-02-23": 6.1, ... }
    this._dailyPeaks = {};
    try {
      const saved = this.homey.settings.get('_dailyPeaks');
      if (saved && typeof saved === 'object') {
        this._dailyPeaks = saved;
      }
    } catch (_) {}
    // Clean out entries older than current month on startup
    this._cleanOldDailyPeaks();

    try {
      this._loadSettings();
      // If all settings are empty/null, try loading from file as fallback
      const allNull = Object.values(this._settings).every(v => v == null);
      if (allNull) {
        try {
          const fileSaved = await this._loadSettingsFromFile();
          if (fileSaved) {
            // Restore each setting from file
            Object.entries(fileSaved).forEach(([key, value]) => {
              if (value != null) {
                this.homey.settings.set(key, value);
              }
            });
            this._loadSettings();  // Reload from settings store
            this.log('Settings restored from file backup');
          }
        } catch (fileErr) {
          this.log('File backup not available, using defaults');
        }
      }
    } catch (err) {
      this.error('Settings load error (using defaults):', err);
      this._settings = Object.assign({}, DEFAULT_SETTINGS);
    }

    // Remove persisted mitigation entries whose action no longer matches the priority list
    // (e.g. user changed action in the UI between sessions, or removed a device)
    this._cleanStaleMitigatedEntries();

    // Restore cached devices from previous session
    try {
      const saved = this.homey.settings.get('_allDevicesCache');
      if (Array.isArray(saved) && saved.length > 0) {
        this._cachedDevices = saved;
        this.log(`Restored ${saved.length} devices from cache`);
      }
    } catch (_) {}

    // Reload in-memory settings whenever the settings page writes via H.set().
    // Also re-broadcast priorityList so other open settings pages stay in sync.
    this.homey.settings.on('set', (key) => {
      this._loadSettings();
      // Save to file immediately as backup
      this._saveSettingsToFile().catch((err) => this.error('File save failed:', err));
      if (key === 'priorityList') {
        try { this.homey.api.realtime('priorityList', this.homey.settings.get('priorityList')); } catch (_) {}
        this._connectToEVChargers().catch(() => {});
        // Clean up any persisted mitigation entries whose action changed in the new list
        this._cleanStaleMitigatedEntries();
      }
      // When power limit or profile changes, immediately re-evaluate chargers
      if (['powerLimitW', 'profile', 'enabled', 'phase1LimitA', 'phase2LimitA', 'phase3LimitA'].includes(key)) {
        this.log(`[Settings] ${key} changed, forcing charger re-evaluation`);
        this._appLogEntry('system', `Settings changed: ${key}`);
        this._forceChargerRecheck().catch(err => this.error('Force re-check error:', err));
      }
    });

    try {
      this._registerFlowCards();
    } catch (err) {
      this.error('Flow card registration error:', err);
    }

    try {
      this._api = await HomeyAPI.createAppAPI({ homey: this.homey });
      this.log('HomeyAPI ready');
      this.log('[Power Consumption] API is ready for device tracking');
      this._appLogEntry('system', 'HomeyAPI ready');
    } catch (err) {
      this.error('HomeyAPI init error:', err);
    }

    try {
      if (this._api) await this._connectToHAN();
    } catch (err) {
      this.error('HAN connection error (non-fatal):', err);
      this._appLogEntry('han', `Connection error: ${err.message}`);
    }

    try {
      if (this._api) await this._initializeDeviceCache();
    } catch (err) {
      this.error('Device cache init error:', err);
    }

    try {
      if (this._api) await this._connectToEVChargers();
    } catch (err) {
      this.error('EV charger connection error (non-fatal):', err);
    }

    try {
      if (this._api) await this.applyCircuitLimitsToChargers();
    } catch (err) {
      this.error('Circuit limit push error (non-fatal):', err);
    }

    this._watchdogInterval  = setInterval(() => this._watchdog().catch(() => {}), 10000);
    this._cacheRefreshInterval = setInterval(() => this._cacheDevices().catch(() => {}), 60000);
    this._queueProcessorInterval = setInterval(() => this._processSaveQueue().catch(() => {}), 3000);

    // Initialize power consumption tracking after API is ready (don't call on startup, it fails)
    // It will populate when HAN readings arrive or when the tab is first opened
    this._writeDebugLog('===== APP STARTED =====' );
    this._appLogEntry('system', 'App started');

    this.log('Power Guard ready (device cache: ' +
      (this._deviceCacheReady ? 'YES' : 'NO') + ')');
    this._appLogEntry('system', 'Power Guard ready (device cache: ' + (this._deviceCacheReady ? 'YES' : 'NO') + ')');
  }

  // ─── Device Cache Initialization with Retry Logic ──────────────────────────
  async _initializeDeviceCache() {
    const maxRetries = 3;
    let attempts = 0;

    while (attempts < maxRetries) {
      try {
        this.log(`[Cache] Initializing device cache (attempt ${attempts + 1}/${maxRetries})`);
        await this._cacheDevices(true);  // Pass true to enable error throwing
        this._deviceCacheReady = true;
        this._lastCacheTime = Date.now();
        this.log('[Cache] Device cache initialization: SUCCESS');
        return true;
      } catch (err) {
        attempts++;
        if (attempts < maxRetries) {
          this.log(`[Cache] Retry in 2 seconds... (error: ${err.message})`);
          await new Promise(resolve => setTimeout(resolve, 2000));
        } else {
          this.error('[Cache] Device cache initialization FAILED after retries:', err);
          this._deviceCacheReady = false;
          return false;
        }
      }
    }
  }

  // ─── Settings Save Queue Processor ────────────────────────────────────────
  async _processSaveQueue() {
    if (!this._saveQueue || this._saveQueue.length === 0) return Promise.resolve();

    const item = this._saveQueue[0];
    const retryCount = item.retries || 0;

    if (retryCount > 5) {
      this.log(`[Queue] Max retries exceeded for key: ${item.key}`);
      this._saveQueue.shift();
      return Promise.resolve();
    }

    // Try to save via hSet (Homey settings API)
    const hSet = (key, value) => {
      return new Promise((resolve, reject) => {
        try {
          const result = this.homey.settings.set(key, value);
          if (result && typeof result.then === 'function') {
            result.then(() => resolve()).catch(reject);
          } else {
            resolve();
          }
        } catch (err) {
          reject(err);
        }
      });
    };

    return hSet(item.key, item.value)
      .then(() => {
        this.log(`[Queue] Saved queued key: ${item.key}`);
        this._saveQueue.shift();
      })
      .catch((err) => {
        item.retries = retryCount + 1;
        this.log(`[Queue] Retry ${item.retries} for ${item.key}: ${err.message}`);
      });
  }

  // ─── Enqueue failed settings save ─────────────────────────────────────────
  _enqueueSettingsSave(key, value) {
    const existing = this._saveQueue.find(item => item.key === key);
    if (existing) {
      existing.value = value;
      existing.retries = 0;
    } else {
      this._saveQueue.push({ key, value, retries: 0 });
    }
  }

  // ─── Settings Persistence via File ────────────────────────────────────────
  _getSettingsFilePath() {
    return this.homey.app.dir + '/settings.json';
  }

  async _saveSettingsToFile() {
    const fs = require('fs').promises;
    try {
      const settingsData = {
        enabled: this.homey.settings.get('enabled'),
        profile: this.homey.settings.get('profile'),
        powerLimitW: this.homey.settings.get('powerLimitW'),
        phase1LimitA: this.homey.settings.get('phase1LimitA'),
        phase2LimitA: this.homey.settings.get('phase2LimitA'),
        phase3LimitA: this.homey.settings.get('phase3LimitA'),
        smoothingWindow: this.homey.settings.get('smoothingWindow'),
        spikeMultiplier: this.homey.settings.get('spikeMultiplier'),
        hysteresisCount: this.homey.settings.get('hysteresisCount'),
        cooldownSeconds: this.homey.settings.get('cooldownSeconds'),
        priorityList: this.homey.settings.get('priorityList'),
      };
      const filePath = this._getSettingsFilePath();
      await fs.writeFile(filePath, JSON.stringify(settingsData, null, 2));
      this.log('Settings persisted to file');
    } catch (err) {
      this.error('Failed to save settings to file:', err);
    }
  }

  async _loadSettingsFromFile() {
    const fs = require('fs').promises;
    try {
      const filePath = this._getSettingsFilePath();
      const data = await fs.readFile(filePath, 'utf8');
      const settingsData = JSON.parse(data);
      this.log('Settings loaded from file');
      return settingsData;
    } catch (err) {
      this.log('No persisted settings file found (this is OK on first run)');
      return null;
    }
  }

  _loadSettings() {
    const s = this.homey.settings;
    this._settings = {
      enabled:           s.get('enabled')           ?? DEFAULT_SETTINGS.enabled,
      profile:           s.get('profile')           ?? DEFAULT_SETTINGS.profile,
      powerLimitW:       s.get('powerLimitW')       ?? DEFAULT_SETTINGS.powerLimitW,
      phase1LimitA:      s.get('phase1LimitA')      ?? DEFAULT_SETTINGS.phase1LimitA,
      phase2LimitA:      s.get('phase2LimitA')      ?? DEFAULT_SETTINGS.phase2LimitA,
      phase3LimitA:      s.get('phase3LimitA')      ?? DEFAULT_SETTINGS.phase3LimitA,
      smoothingWindow:   s.get('smoothingWindow')   ?? DEFAULT_SETTINGS.smoothingWindow,
      spikeMultiplier:   s.get('spikeMultiplier')   ?? DEFAULT_SETTINGS.spikeMultiplier,
      hysteresisCount:   s.get('hysteresisCount')   ?? DEFAULT_SETTINGS.hysteresisCount,
      cooldownSeconds:   s.get('cooldownSeconds')   ?? DEFAULT_SETTINGS.cooldownSeconds,
      voltageSystem:     s.get('voltageSystem')     ?? DEFAULT_SETTINGS.voltageSystem,
      phaseDistribution: s.get('phaseDistribution') ?? DEFAULT_SETTINGS.phaseDistribution,
      mainCircuitA:      s.get('mainCircuitA')      ?? DEFAULT_SETTINGS.mainCircuitA,
      priorityList:      s.get('priorityList')      ?? DEFAULT_SETTINGS.priorityList,
    };
  }

  // Reload settings on demand (called before each mitigation cycle)
  _refreshSettings() {
    try {
      this._loadSettings();
    } catch (_) {}
  }

  _getEffectiveLimit() {
    const factor = PROFILE_LIMIT_FACTOR[this._settings.profile] || 1.0;
    return this._settings.powerLimitW * factor;
  }

  /**
   * Persist the mitigated devices list so it survives app restarts.
   * Called after every mutation of _mitigatedDevices.
   */
  _persistMitigatedDevices() {
    try {
      this.homey.settings.set('_mitigatedDevices', this._mitigatedDevices);
    } catch (err) {
      this.error('Failed to persist mitigated devices:', err);
    }
  }

  /**
   * Remove mitigated-device entries whose recorded action no longer matches what the
   * priority list expects. This cleans up stale data left when the user changes an
   * entry's action in the UI, or removes a device from the priority list entirely.
   * Safe to call any time after _settings has been populated.
   */
  _cleanStaleMitigatedEntries() {
    const priorityList = this._settings.priorityList || [];
    const actionMap = new Map(priorityList.map(e => [e.deviceId, e.action]));
    const before = this._mitigatedDevices.length;
    this._mitigatedDevices = this._mitigatedDevices.filter(m => {
      const expectedAction = actionMap.get(m.deviceId);
      if (expectedAction === undefined) {
        this.log(`[Mitigation] Cleanup: removing stale entry for ${m.deviceId} — not in priority list`);
        return false;
      }
      if (m.action !== 'hoiax_power' && expectedAction !== m.action) {
        this.log(`[Mitigation] Cleanup: removing stale entry for ${m.deviceId} — action changed ${m.action} → ${expectedAction}`);
        return false;
      }
      return true;
    });
    if (this._mitigatedDevices.length !== before) {
      this.log(`[Mitigation] Cleaned ${before - this._mitigatedDevices.length} stale mitigated entries`);
      this._persistMitigatedDevices();
    }
  }

  /**
   * Force an immediate re-evaluation of all chargers against current power usage and limits.
   * Called when powerLimitW or profile changes — bypasses cooldowns.
   */
  async _forceChargerRecheck() {
    if (!this._settings.enabled) return;

    // Use the latest known power value
    const currentPower = movingAverage(this._powerBuffer, this._settings.smoothingWindow);
    if (!currentPower && currentPower !== 0) return;

    const limit = this._getEffectiveLimit();
    this.log(`[ForceRecheck] Power: ${Math.round(currentPower)}W, Limit: ${Math.round(limit)}W`);

    // Reset the EV adjust cooldown so adjustment happens immediately
    this._lastEVAdjustTime = 0;

    // Run the EV charger adjustment
    await this._adjustEVChargersForPower(currentPower).catch(err => this.error('Force EV adjust error:', err));

    // Also re-check regular mitigation
    const overLimit = currentPower > limit;
    if (overLimit) {
      this._overLimitCount = this._settings.hysteresisCount; // Skip hysteresis for immediate action
      await this._triggerMitigation(currentPower).catch(err => this.error('Force mitigation error:', err));
    } else if (this._mitigatedDevices.length > 0) {
      await this._triggerRestore().catch(err => this.error('Force restore error:', err));
    }

    this._cacheStatus();
  }

  // ══════════════════════════════════════════════════════════════════
  // █ SECTION 2 — HAN / POWER METER                                           █
  // ══════════════════════════════════════════════════════════════════
  //  Included: HAN device brand detection, raw log, diagnostics,
  //            connectToHAN, poll fallback, spike filter, phase readings
  //
  //  ✅ STABLE — DO NOT TOUCH unless absolutely necessary
  //  NOTE: spike filter auto-reset (SPIKE_RESET_THRESHOLD) is in _onPowerReading
  // ══════════════════════════════════════════════════════════════════

  // ─── HAN Port integration ──────────────────────────────────────────────────

  _getHANDeviceBrand() {
    if (!this._hanDevice) return 'Unknown';
    const name = (this._hanDevice.name || '').toLowerCase();
    const mfg = (this._hanDeviceManufacturer || '').toLowerCase();
    const driver = (this._hanDevice.driverId || '').toLowerCase();
    if (name.includes('frient') || mfg.includes('frient') || driver.includes('frient')) return 'Frient Electricity Meter';
    if (name.includes('futurehome') || mfg.includes('futurehome') || driver.includes('futurehome')) return 'Futurehome HAN';
    if (name.includes('tibber') || mfg.includes('tibber') || driver.includes('tibber')) return 'Tibber Pulse';
    if (name.includes('easee') || driver === 'equalizer') return 'Easee Equalizer';
    if (name.includes('aidon') || mfg.includes('aidon')) return 'Aidon HAN';
    if (name.includes('kaifa') || mfg.includes('kaifa')) return 'Kaifa HAN';
    return this._hanDeviceName || 'Unknown meter';
  }

  _pushHanRawLog(value, source) {
    this._hanRawLog.push({ time: Date.now(), value, source });
    if (this._hanRawLog.length > 20) this._hanRawLog.shift();
  }

  getHanDiagnostic() {
    const selectedId = this.homey.settings.get('selectedMeterDeviceId') || 'auto';
    const hanDevice = this._hanDevice;
    const capValues = {};
    if (hanDevice && hanDevice.capabilitiesObj) {
      for (const [cap, obj] of Object.entries(hanDevice.capabilitiesObj)) {
        capValues[cap] = obj && obj.value !== undefined ? obj.value : null;
      }
    }
    const lastAge = this._lastHanReading ? Math.round((Date.now() - this._lastHanReading) / 1000) : null;
    // Determine primary reading source
    let readingSource = 'none';
    if (this._hanEventCount > 0 && this._hanPollCount === 0) readingSource = 'event';
    else if (this._hanPollCount > 0 && this._hanEventCount === 0) readingSource = 'poll';
    else if (this._hanEventCount > 0 && this._hanPollCount > 0) readingSource = 'event+poll';

    return {
      hanConnected: !!this._hanDeviceId,
      hanDeviceId: this._hanDeviceId || null,
      hanDeviceName: this._hanDeviceName || null,
      hanBrand: this._hanDeviceId ? this._getHANDeviceBrand() : null,
      selectedMeterDeviceId: selectedId,
      selectionMode: selectedId === 'auto' ? 'auto' : 'manual',
      capabilities: hanDevice ? (hanDevice.capabilities || []) : [],
      capabilityValues: capValues,
      lastReadingAgeSeconds: lastAge,
      readingSource: readingSource,
      eventCount: this._hanEventCount,
      pollCount: this._hanPollCount,
      spikeFilterCount: this._hanSpikeCount,
      spikeConsecutiveCount: this._spikeConsecutiveCount || 0,
      watchdogReconnects: this._hanWatchdogCount,
      rawLog: this._hanRawLog.slice(-20).map(function (e) {
        return { time: new Date(e.time).toISOString(), value: e.value, source: e.source };
      }),
      powerBuffer: this._powerBuffer.slice(-10),
      phaseCurrents: this._phaseCurrents || {},
    };
  }

  /**
   * Returns all devices with measure_power capability for the meter selector.
   */
  async getMeterDevices() {
    if (!this._api) return [];
    const allDevices = await this._api.devices.getDevices();
    return Object.values(allDevices)
      .filter(d => Array.isArray(d.capabilities) && d.capabilities.includes('measure_power'))
      .map(d => ({
        id: d.id,
        name: d.name || 'Unknown',
        class: d.class || '',
        driverId: d.driverId || '',
        ownerUri: (d.driver && d.driver.owner_uri) || '',
        capabilities: d.capabilities || [],
      }));
  }

  async _connectToHAN() {
    const allDevices = await this._api.devices.getDevices();
    const allDeviceList = Object.values(allDevices);

    // Check if user has manually selected a specific meter device
    const selectedId = this.homey.settings.get('selectedMeterDeviceId') || null;
    let hanDevice = null;

    if (selectedId && selectedId !== 'auto') {
      hanDevice = allDeviceList.find(d => d.id === selectedId &&
        Array.isArray(d.capabilities) && d.capabilities.includes('measure_power'));
      if (hanDevice) {
        this.log(`[HAN] Using manually selected meter: "${hanDevice.name}" (${hanDevice.id})`);
      } else {
        this.log(`[HAN] Selected meter ${selectedId} not found or missing measure_power, falling back to auto-detect`);
      }
    }

    // Auto-detect if no manual selection or selected device not found
    if (!hanDevice) {
      hanDevice = allDeviceList.find(d => {
        const hasPower = Array.isArray(d.capabilities) && d.capabilities.includes('measure_power');
        if (!hasPower) return false;
        
        // Must be identifiable as a meter/HAN device, not just any device with power measurement
        const name = (d.name || '').toLowerCase();
        const driver = (d.driverId || '').toLowerCase();
        const deviceClass = (d.class || '').toLowerCase();
        
        // Easee Equalizer: class 'other', driver 'equalizer', app 'no.easee'
        const isEaseeEqualizer = driver === 'equalizer' &&
          d.driver && d.driver.owner_uri === 'homey:app:no.easee';

        // Use word-boundary regex for 'han' to avoid matching names like 'Hanna'
        const hanRegex = /\bhan\b/;

        const isMeterLike = deviceClass === 'meter' || isEaseeEqualizer ||
          name.includes('meter') || name.includes('frient') || hanRegex.test(name) ||
          name.includes('futurehome') || name.includes('tibber') || name.includes('easee') ||
          driver.includes('meter') || driver.includes('frient') || hanRegex.test(driver) ||
          driver.includes('futurehome') || driver.includes('tibber');
        
        return isMeterLike;
      });
    }

    if (!hanDevice) {
      this.log('No electricity meter with measure_power capability found. Power Guard will not receive live data until a meter is paired.');
      this._hanDeviceId = null;
      this._hanDevice = null;
      this._hanDeviceName = null;
      this._hanDeviceManufacturer = null;
      return;
    }

    this._hanDeviceId = hanDevice.id;
    this._hanDevice = hanDevice;
    this._hanDeviceName = hanDevice.name || 'Unknown meter';
    this._hanDeviceManufacturer = hanDevice.owner?.name || hanDevice.driverId || null;
    const brand = this._getHANDeviceBrand();
    this.log(`HAN device found: "${this._hanDeviceName}" (${brand}) (${hanDevice.id})`);
    this._writeDebugLog(`[HAN] Device found: "${this._hanDeviceName}" (${brand}) id=${hanDevice.id} caps=[${(hanDevice.capabilities || []).join(', ')}]`);
    this._appLogEntry('han', `Device found: "${this._hanDeviceName}" (${brand}) id=${hanDevice.id}`);
    // Reset diagnostic counters on each connect
    this._hanEventCount = 0;
    this._hanPollCount = 0;
    this._hanSpikeCount = 0;
    this._hanRawLog = [];

    // makeCapabilityInstance is the correct homey-api v3 way to subscribe to capability changes
    this._hanCapabilityInstance = hanDevice.makeCapabilityInstance('measure_power', (value) => {
      this._hanEventCount++;
      this._pushHanRawLog(value, 'event');
      this._onPowerReading(value);
    });

    // Read the initial value immediately — don't wait for the first event or poll
    try {
      const capObj = hanDevice.capabilitiesObj;
      if (capObj && capObj.measure_power && capObj.measure_power.value != null) {
        const initialVal = Number(capObj.measure_power.value);
        this.log(`[HAN] Initial measure_power = ${initialVal} W`);
        this._writeDebugLog(`[HAN] Initial reading: ${initialVal} W`);
        if (!isNaN(initialVal)) {
          this._pushHanRawLog(initialVal, 'initial');
          this._onPowerReading(initialVal);
        }
      } else {
        this.log('[HAN] No initial measure_power value available, waiting for events/poll');
      }
    } catch (initErr) {
      this.log('[HAN] Error reading initial value: ' + (initErr.message || initErr));
    }

    // Phase values (optional — only if the HAN device reports them)
    // Standard HAN meters use measure_power.phase1/phase2/phase3
    // Easee Equalizer uses measure_current.L1/L2/L3 and measure_voltage.L1/L2/L3
    const phaseCapabilities = [
      'measure_power.phase1', 'measure_power.phase2', 'measure_power.phase3',
      'measure_current.L1', 'measure_current.L2', 'measure_current.L3',
      // Futurehome HAN and similar meters use phase_a/b/c naming
      'measure_current.phase_a', 'measure_current.phase_b', 'measure_current.phase_c',
      'measure_voltage.L1', 'measure_voltage.L2', 'measure_voltage.L3',
      'measure_voltage.phase_a', 'measure_voltage.phase_b', 'measure_voltage.phase_c',
    ];
    for (const phase of phaseCapabilities) {
      if (Array.isArray(hanDevice.capabilities) && hanDevice.capabilities.includes(phase)) {
        hanDevice.makeCapabilityInstance(phase, (value) => this._onPhaseReading(phase, value));
      }
    }

    // Active polling fallback — critical for cloud-based meters (Easee Equalizer, etc.)
    // that may not reliably fire capability change events through Homey's API.
    // Poll every 10s, and do an immediate first poll after 2s to get data quickly.
    if (this._hanPollInterval) clearInterval(this._hanPollInterval);
    this._hanPollInterval = setInterval(() => this._pollHANPower().catch(() => {}), 10000);
    setTimeout(() => this._pollHANPower().catch(() => {}), 2000);
    this.log('HAN active polling started (10s interval, first poll in 2s)');
  }

  async _pollHANPower() {
    if (!this._hanDevice) return;
    try {
      // Re-fetch the device to get the latest capability values
      const device = await this._api.devices.getDevice({ id: this._hanDeviceId });
      if (!device) {
        this.log('[HAN Poll] Device not found');
        return;
      }

      const capObj = device.capabilitiesObj;
      if (capObj && capObj.measure_power && capObj.measure_power.value != null) {
        // Coerce to number — some apps may report as string
        const value = Number(capObj.measure_power.value);
        if (isNaN(value)) return;

        const timeSinceLastReading = this._lastHanReading ? Date.now() - this._lastHanReading : Infinity;

        // Only process if we haven't had an event-based reading in the last 8 seconds
        // This avoids double-processing when events ARE working
        if (timeSinceLastReading > 8000) {
          this.log(`[HAN Poll] Fallback reading: ${value} W (no event for ${Math.round(timeSinceLastReading / 1000)}s)`);
          this._hanPollCount++;
          this._pushHanRawLog(value, 'poll');
          this._appLogEntry('han', `Poll fallback: ${value}W (no event for ${Math.round(timeSinceLastReading / 1000)}s)`);
          this._onPowerReading(value);
        }

        // Always update per-phase current data from poll regardless of event age
        // This is critical for charger control accuracy
        const phaseCaps = [
          'measure_current.phase_a', 'measure_current.phase_b', 'measure_current.phase_c',
          'measure_current.L1', 'measure_current.L2', 'measure_current.L3',
        ];
        for (const cap of phaseCaps) {
          if (capObj[cap] && capObj[cap].value != null) {
            this._onPhaseReading(cap, Number(capObj[cap].value));
          }
        }
      } else {
        this.log('[HAN Poll] measure_power value is null or missing');
      }
    } catch (err) {
      this.log('[HAN Poll] Error: ' + (err.message || err));
    }
  }

  _onPowerReading(rawValue) {
    // Coerce to number — some cloud-based meters may report as string
    rawValue = Number(rawValue);
    if (isNaN(rawValue)) return;

    // Cap negative power to 0 (solar export should not count as usage)
    if (rawValue < 0) rawValue = 0;

    this._lastHanReading = Date.now();

    const avg = movingAverage(this._powerBuffer, this._settings.smoothingWindow);
    if (this._powerBuffer.length >= this._settings.smoothingWindow
        && isSpike(rawValue, avg, this._settings.spikeMultiplier)) {
      // Don't filter out legitimate load changes from EV chargers.
      // Calculate max expected charger load from all connected chargers.
      let maxChargerW = 0;
      const evEntries = (this._settings.priorityList || []).filter(e =>
        e.action === 'dynamic_current' && e.enabled !== false
      );
      for (const entry of evEntries) {
        const evData = this._evPowerData[entry.deviceId];
        if (evData && evData.isConnected !== false) {
          const phases = entry.chargerPhases || 3;
          const voltage = phases === 1 ? 230 : 692;
          const circuitA = entry.circuitLimitA || 32;
          maxChargerW += voltage * circuitA;
        }
      }

      // Also add headroom for heater cycling.
      // Smart heaters (Adax etc.) always show onoff=true in Homey but their heating
      // elements cycle on/off at the hardware level, creating real power jumps.
      // We allow for up to the estimated peak wattage of all thermostat/heater devices
      // so those cycling events are not incorrectly filtered as spikes.
      let maxHeaterCycleW = 0;
      if (this._powerConsumptionData) {
        for (const d of Object.values(this._powerConsumptionData)) {
          if (d.class === 'thermostat' || d.class === 'heater') {
            maxHeaterCycleW += d.peak || 0;
          }
        }
      }
      // If we haven't built consumption data yet, use a conservative estimate based
      // on how many heater entries are in the priority list.
      if (maxHeaterCycleW === 0) {
        const heaterEntries = (this._settings.priorityList || []).filter(e =>
          e.action === 'target_temperature' && e.enabled !== false
        );
        maxHeaterCycleW = heaterEntries.length * 1000; // assume 1kW per heater
      }

      const totalHeadroom = maxChargerW + maxHeaterCycleW;
      // If the jump is within charger + heater capacity, allow it
      if (rawValue <= avg + totalHeadroom + 500) {
        this.log(`Spike allowed (charger ${Math.round(maxChargerW)}W + heater ${Math.round(maxHeaterCycleW)}W headroom): ${rawValue}W (avg ${avg.toFixed(0)}W)`);
      } else {
        this.log(`Spike ignored: ${rawValue} W (avg ${avg.toFixed(0)} W, charger headroom ${Math.round(maxChargerW)}W, heater headroom ${Math.round(maxHeaterCycleW)}W)`);
        this._hanSpikeCount++;
        this._spikeConsecutiveCount++;
        this._spikeLastFilteredValue = rawValue;
        this._pushHanRawLog(rawValue, 'spike-filtered');
        this._appLogEntry('han', `Spike filtered: ${rawValue}W (avg ${avg.toFixed(0)}W, charger ${Math.round(maxChargerW)}W, heater ${Math.round(maxHeaterCycleW)}W headroom)`);

        // ── Sustained load change detection ──
        // If the same "spike" level persists for 3+ consecutive readings it is a
        // real load change (e.g. oven turned on), NOT a transient spike.
        // Reset the power buffer so the new level becomes the new baseline.
        const SPIKE_RESET_THRESHOLD = 3;
        if (this._spikeConsecutiveCount >= SPIKE_RESET_THRESHOLD) {
          this.log(`[HAN] Spike filter reset: ${this._spikeConsecutiveCount} consecutive filtered readings at ~${rawValue}W — accepting as new baseline (was avg ${avg.toFixed(0)}W)`);
          this._appLogEntry('han', `Spike filter reset after ${this._spikeConsecutiveCount} consecutive readings: new baseline ~${rawValue}W (was ${avg.toFixed(0)}W)`);
          this._powerBuffer = [rawValue, rawValue, rawValue];
          this._spikeConsecutiveCount = 0;
          this._spikeLastFilteredValue = null;
          // Fall through to normal processing below
        } else {
          return;
        }
      }
    }

    this._powerBuffer.push(rawValue);
    if (this._powerBuffer.length > 60) this._powerBuffer.shift();
    this._spikeConsecutiveCount = 0;  // reset on every accepted reading
    this._spikeLastFilteredValue = null;

    // Accumulate hourly energy (trapezoidal integration)
    this._accumulateHourlyEnergy(rawValue);

    const smoothed = movingAverage(this._powerBuffer, this._settings.smoothingWindow);
    this._updateVirtualDevice({ power: smoothed }).catch(() => {});
    this._checkLimits(smoothed).catch((err) => this.error('checkLimits error:', err));
    
    // Update power consumption for all devices
    try {
      this._updatePowerConsumption(smoothed);
    } catch (err) {
      this.error('[Power Consumption] Unexpected error:', err);
    }

    // Cache status into settings so the settings page can read it via H.get()
    // No throttle — HAN readings already arrive ~1-2s apart, and settings page polls every 2s.
    this._cacheStatus();
  }

  _onPhaseReading(capId, value) {
    if (typeof value !== 'number') return;
    if (!this._phaseCurrents) this._phaseCurrents = {};
    this._phaseCurrents[capId] = value;
  }

  /**
   * Returns per-phase currents {a, b, c} in amps if available from the HAN device.
   * Supports Futurehome HAN (measure_current.phase_a/b/c) and
   * Easee Equalizer / other meters (measure_current.L1/L2/L3).
   * Returns null if phase data is not available.
   */
  _getPhaseCurrents() {
    if (!this._phaseCurrents) return null;
    const p = this._phaseCurrents;
    const a = p['measure_current.phase_a'] ?? p['measure_current.L1'] ?? null;
    const b = p['measure_current.phase_b'] ?? p['measure_current.L2'] ?? null;
    const c = p['measure_current.phase_c'] ?? p['measure_current.L3'] ?? null;
    if (a === null || b === null || c === null) return null;
    if (a < 0 || b < 0 || c < 0) return null;
    return { a, b, c };
  }

  /**
   * Detect whether this installation is single-phase or three-phase.
   * Detection order:
   *   1. Live phase readings: if L2 or L3 carries > 0.3 A → 3-phase
   *   2. HAN capabilities: if meter exposes L2/L3 capability → 3-phase meter → 3-phase install
   *   3. Manual override: voltageSystem setting (only when NOT 'auto')
   *   4. Default: 1-phase (safe assumption when no data)
   * Returns 1 or 3.
   */
  _detectSystemPhases() {
    // 1. Live phase current data is the most reliable signal
    if (this._phaseCurrents) {
      const b = this._phaseCurrents['measure_current.L2'] ?? this._phaseCurrents['measure_current.phase_b'] ?? 0;
      const c = this._phaseCurrents['measure_current.L3'] ?? this._phaseCurrents['measure_current.phase_c'] ?? 0;
      if (b > 0.3 || c > 0.3) return 3;
    }
    // 2. HAN capabilities — if the meter reports L2/L3, the install is 3-phase
    if (this._hanDevice) {
      const caps = this._hanDevice.capabilities || [];
      const has3PhaseCap = caps.some(cap =>
        cap === 'measure_current.L2' || cap === 'measure_current.L3' ||
        cap === 'measure_current.phase_b' || cap === 'measure_current.phase_c'
      );
      if (has3PhaseCap) return 3;
    }
    // 3. Manual override: respect the explicit user setting
    const vs = this._settings && this._settings.voltageSystem;
    if (vs && vs !== 'auto') {
      return vs.includes('3phase') ? 3 : 1;
    }
    // 4. Safe default
    return 1;
  }

  // ══════════════════════════════════════════════════════════════════
  // █ SECTION 3 — ENERGY TRACKING & CAPACITY TARIFF                           █
  // ══════════════════════════════════════════════════════════════════
  //  Included: hourly energy accumulation (kWh), effekttariff (capacity
  //            tariff) — tracks monthly peak-hours for Norwegian grid tariff
  //
  //  ✅ STABLE — DO NOT TOUCH unless absolutely necessary
  // ══════════════════════════════════════════════════════════════════

  // ─── Hourly Energy Tracking ───────────────────────────────────────────────

  /**
   * Accumulate energy usage using trapezoidal integration of power readings.
   * Rolls over to a new hour when the clock ticks, persisting the completed hour.
   */
  _accumulateHourlyEnergy(powerW) {
    const now = Date.now();
    const currentHour = new Date().getHours();

    // Hour rollover — save completed hour and start fresh
    if (currentHour !== this._hourlyEnergy.currentHour) {
      const completedKWh = Math.round(this._hourlyEnergy.accumulatedWh) / 1000;
      const entry = {
        hour: this._hourlyEnergy.currentHour,
        date: new Date(now - 1).toISOString().slice(0, 10),  // Date of the completed hour
        kWh: Math.round(completedKWh * 1000) / 1000,         // 3 decimal places
      };
      this._hourlyEnergy.history.push(entry);
      // Keep last 24 entries only
      if (this._hourlyEnergy.history.length > 24) {
        this._hourlyEnergy.history = this._hourlyEnergy.history.slice(-24);
      }
      // Persist to settings
      try {
        this.homey.settings.set('_hourlyEnergyHistory', this._hourlyEnergy.history);
      } catch (_) {}
      this.log(`[Energy] Hour ${entry.hour}:00 completed: ${entry.kWh} kWh`);
      this._appLogEntry('energy', `Hour ${entry.hour}:00 completed: ${entry.kWh} kWh`);

      // Update effekttariff daily peak: kWh in one hour = average kW for that hour
      // The hourly kWh value IS the average power in kW for that hour
      this._updateDailyPeak(entry.date, entry.kWh);

      // Reset for new hour
      this._hourlyEnergy.currentHour = currentHour;
      this._hourlyEnergy.accumulatedWh = 0;
      this._hourlyEnergy.lastReadingW = powerW;
      this._hourlyEnergy.lastReadingTime = now;
      return;
    }

    // Normal accumulation: trapezoidal integration (average of last and current reading × elapsed time)
    if (this._hourlyEnergy.lastReadingTime !== null) {
      const elapsedMs = now - this._hourlyEnergy.lastReadingTime;
      // Sanity: ignore gaps > 60s (likely a restart or missed readings)
      if (elapsedMs > 0 && elapsedMs < 60000) {
        const avgPowerW = (this._hourlyEnergy.lastReadingW + powerW) / 2;
        const elapsedH = elapsedMs / 3600000;  // Convert ms to hours
        this._hourlyEnergy.accumulatedWh += avgPowerW * elapsedH;
      }
    }

    this._hourlyEnergy.lastReadingW = powerW;
    this._hourlyEnergy.lastReadingTime = now;
  }

  // ─── Effekttariff (Capacity Tariff) Tracking ──────────────────────────────

  /**
   * Update the daily peak kW for a given date.
   * kWh consumed in 1 hour == average kW for that hour.
   * We keep only the highest hour per day.
   */
  _updateDailyPeak(dateStr, avgKW) {
    const old = this._dailyPeaks[dateStr] || 0;
    if (avgKW > old) {
      this._dailyPeaks[dateStr] = Math.round(avgKW * 1000) / 1000;
      this.log(`[Effekttariff] New daily peak for ${dateStr}: ${avgKW.toFixed(3)} kW (was ${old.toFixed(3)} kW)`);
      this._appLogEntry('energy', `New daily peak for ${dateStr}: ${avgKW.toFixed(3)} kW (was ${old.toFixed(3)} kW)`);
      this._persistDailyPeaks();
    }
  }

  /**
   * Clean out daily peak entries that are not in the current month.
   * Called on startup and on month rollover.
   */
  _cleanOldDailyPeaks() {
    const now = new Date();
    const currentMonth = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
    const keys = Object.keys(this._dailyPeaks);
    let removed = 0;
    for (const key of keys) {
      if (!key.startsWith(currentMonth)) {
        delete this._dailyPeaks[key];
        removed++;
      }
    }
    if (removed > 0) {
      this.log(`[Effekttariff] Cleaned ${removed} old daily peak(s), keeping ${Object.keys(this._dailyPeaks).length} for ${currentMonth}`);
      this._persistDailyPeaks();
    }
  }

  _persistDailyPeaks() {
    try {
      this.homey.settings.set('_dailyPeaks', this._dailyPeaks);
    } catch (_) {}
  }

  /**
   * Calculate the monthly capacity metric (TOP3_AVG):
   * Average of the 3 highest daily peaks this month.
   * Returns { monthlyKW, tier, dailyPeaks, top3 }
   */
  _getEffekttariffStatus() {
    // Clean if we crossed into a new month
    const now = new Date();
    const currentMonth = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
    const firstKey = Object.keys(this._dailyPeaks)[0];
    if (firstKey && !firstKey.startsWith(currentMonth)) {
      this._cleanOldDailyPeaks();
    }

    // Get all daily peaks sorted descending
    const allPeaks = Object.entries(this._dailyPeaks)
      .map(([date, kw]) => ({ date, kw: Number(kw) }))
      .filter(p => Number.isFinite(p.kw) && p.kw >= 0)
      .sort((a, b) => b.kw - a.kw);

    // TOP3 average
    const top3 = allPeaks.slice(0, 3);
    const monthlyKW = top3.length > 0
      ? top3.reduce((sum, p) => sum + p.kw, 0) / top3.length
      : 0;

    // Find current tier
    let tier = EFFEKT_TIERS[EFFEKT_TIERS.length - 1];  // Default to highest
    for (const t of EFFEKT_TIERS) {
      if (monthlyKW < t.maxKW) {
        tier = t;
        break;
      }
    }

    // Current hour's running average kW (what it would be if the hour ended now)
    const currentHourKW = this._hourlyEnergy.accumulatedWh > 0
      ? Math.round(this._hourlyEnergy.accumulatedWh) / 1000
      : 0;
    const todayStr = now.toISOString().slice(0, 10);
    const todayPeak = this._dailyPeaks[todayStr] || 0;
    const wouldBeNewDailyPeak = currentHourKW > todayPeak;

    return {
      monthlyKW: Math.round(monthlyKW * 1000) / 1000,
      tierLabel: tier.label,
      tierIndex: tier.index,
      tierMaxKW: tier.maxKW === Infinity ? null : tier.maxKW,
      top3: top3.map(p => ({ date: p.date, kw: Math.round(p.kw * 1000) / 1000 })),
      dailyPeakCount: allPeaks.length,
      allPeaks: allPeaks.slice(0, 10),  // Top 10 for display
      currentHourKW: Math.round(currentHourKW * 1000) / 1000,
      todayPeakKW: Math.round(todayPeak * 1000) / 1000,
      wouldBeNewDailyPeak,
    };
  }

  // ══════════════════════════════════════════════════════════════════
  // █ SECTION 4 — POWER LIMITS & MITIGATION ENGINE                            █
  // ══════════════════════════════════════════════════════════════════
  //  Included: _checkLimits, _triggerMitigation, _canMitigate, _triggerRestore
  //  Device types handled via common/devices.js applyAction/restoreDevice:
  //    • Heaters (target_temperature / Adax / generic thermostat)
  //    • Water heater (hoiax_power — Høiax Connected)
  //    • EV chargers (charge_pause / dynamic_current — routed to Sections 6–9)
  //
  //  ✅ STABLE — DO NOT TOUCH unless absolutely necessary
  // ══════════════════════════════════════════════════════════════════

  // ─── Limit checking ───────────────────────────────────────────────────────

  async _checkLimits(smoothedPower) {
    this._refreshSettings();
    if (!this._settings.enabled) return;

    const limit = this._getEffectiveLimit();
    const overLimit = smoothedPower > limit;

    // EV charger dynamic adjustment runs on EVERY reading — continuously optimizes
    // charger current based on available headroom, not just when over limit.
    // This keeps chargers charging as much as possible while staying under the limit.
    const hasEVChargers = (this._settings.priorityList || []).some(
      e => e.enabled !== false && e.action === 'dynamic_current'
    );
    if (hasEVChargers) {
      await this._adjustEVChargersForPower(smoothedPower).catch(err => this.error('EV adjust error:', err));
    }

    if (overLimit) {
      this._overLimitCount++;
      if (this._overLimitCount === this._settings.hysteresisCount) {
        this._fireTrigger('power_limit_exceeded', { power: Math.round(smoothedPower) });
      }
    } else {
      this._overLimitCount = 0;
    }

    if (this._overLimitCount >= this._settings.hysteresisCount) {
      await this._triggerMitigation(smoothedPower);
    } else if (!overLimit && this._mitigatedDevices.length > 0) {
      await this._triggerRestore();
    }
  }

  // ─── Mitigation ───────────────────────────────────────────────────────────

  async _triggerMitigation(currentPower) {
    if (!this._api) return;
    const release = await this._mutex.acquire();
    try {
      const now = Date.now();
      const cooldownMs = this._settings.cooldownSeconds * 1000;
      const elapsed = now - this._lastMitigationTime;
      if (elapsed < cooldownMs) {
        this.log(`[Mitigation] Cooldown active: ${Math.round((cooldownMs - elapsed) / 1000)}s remaining`);
        this._appLogEntry('mitigation', `Cooldown active: ${Math.round((cooldownMs - elapsed) / 1000)}s remaining`);
        return;
      }

      // First, try to mitigate by adjusting EV chargers (least disruptive)
      await this._mitigateEaseeChargers().catch((err) => this.error('Easee mitigation error:', err));

      const priorityList = [...(this._settings.priorityList || [])].sort((a, b) => a.priority - b.priority);
      const mitigated = new Set(this._mitigatedDevices.map(m => m.deviceId));

      this.log(`[Mitigation] Starting cycle: power=${Math.round(currentPower)}W, limit=${Math.round(this._getEffectiveLimit())}W, `
        + `devices in list: ${priorityList.length}, already mitigated: ${mitigated.size}`);
      this._appLogEntry('mitigation', `Cycle start: power=${Math.round(currentPower)}W, limit=${Math.round(this._getEffectiveLimit())}W, list=${priorityList.length}, mitigated=${mitigated.size}`);

      // Build diagnostic scan results (visible in settings page)
      const scanResults = [];

      // Then, apply regular mitigation (turn off devices)
      let mitigatedThisCycle = false;
      for (const entry of priorityList) {
        if (entry.enabled === false) {
          this.log(`[Mitigation] SKIP ${entry.name}: disabled`);
          scanResults.push({ name: entry.name, action: entry.action, result: 'disabled' });
          continue;
        }
        if (entry.action === 'dynamic_current') {
          scanResults.push({ name: entry.name, action: entry.action, result: 'ev_charger (handled separately)' });
          continue;  // Skip EV chargers here (handled above)
        }
        if (mitigated.has(entry.deviceId)) {
          // Allow Høiax stepped devices to be further stepped down
          if (entry.action === 'hoiax_power') {
            // fall through — stepped re-mitigation handled below
          } else {
            // Check if the stored action still matches the priority-list action.
            // If the user changed the action (e.g. "dim" → "target_temperature") the
            // persisted entry is stale: drop it so we can re-mitigate with the new action.
            const existingAction = this._mitigatedDevices.find(m => m.deviceId === entry.deviceId)?.action;
            if (existingAction && existingAction !== entry.action) {
              this.log(`[Mitigation] Action changed for ${entry.name}: ${existingAction} → ${entry.action} — clearing stale entry`);
              this._mitigatedDevices = this._mitigatedDevices.filter(m => m.deviceId !== entry.deviceId);
              mitigated.delete(entry.deviceId);
              this._persistMitigatedDevices();
              // fall through to mitigate fresh with the new action
            } else {
              this.log(`[Mitigation] SKIP ${entry.name}: already mitigated`);
              scanResults.push({ name: entry.name, action: entry.action, result: 'already mitigated' });
              continue;
            }
          }
        }
        if (!this._canMitigate(entry)) {
          this.log(`[Mitigation] SKIP ${entry.name}: min runtime not met`);
          scanResults.push({ name: entry.name, action: entry.action, result: 'min runtime not met' });
          continue;
        }
        if (mitigatedThisCycle) {
          scanResults.push({ name: entry.name, action: entry.action, result: 'waiting (1 device per cycle)' });
          continue;
        }
        this.log(`[Mitigation] TRYING ${entry.name} (action=${entry.action})`);
        try {
          const device = await withTimeout(
            this._api.devices.getDevice({ id: entry.deviceId }),
            10000, `getDevice(${entry.deviceId})`
          );
          if (!device) {
            this.log(`[Mitigation] SKIP ${entry.name}: device not found`);
            scanResults.push({ name: entry.name, action: entry.action, result: 'device not found' });
            continue;
          }

          // Log device capabilities so we can debug mismatches
          const caps = device.capabilities || [];
          const obj = device.capabilitiesObj || {};
          const capInfo = {};
          if (caps.includes('target_temperature')) capInfo.target_temp = obj.target_temperature?.value;
          if (caps.includes('onoff')) capInfo.onoff = obj.onoff?.value;
          if (caps.includes('dim')) capInfo.dim = obj.dim?.value;
          this.log(`[Mitigation] ${entry.name} caps: ${caps.join(', ')}`);
          this.log(`[Mitigation] ${entry.name} values: ${JSON.stringify(capInfo)}`);

          // Check if already mitigated (re-entry for Høiax stepped power)
          const existingMitigation = this._mitigatedDevices.find(m => m.deviceId === entry.deviceId);

          // Only snapshot on first mitigation — keep original state for full restore
          const previousState = existingMitigation ? existingMitigation.previousState : this._snapshotState(device);
          const applied = await applyAction(device, entry.action);
          if (!applied) {
            this.log(`[Mitigation] SKIP ${entry.name}: applyAction returned false (already at minimum or no matching capability)`);
            scanResults.push({ name: entry.name, action: entry.action, result: `applyAction=false (caps: ${caps.join(',')}, vals: ${JSON.stringify(capInfo)})` });
            continue;
          }

          if (existingMitigation) {
            // Re-mitigation (Høiax step-down): update timestamp, keep original previousState
            existingMitigation.mitigatedAt = now;
            this._addLog(`Mitigated: ${device.name} (${entry.action}) — stepped down`);
          } else {
            this._mitigatedDevices.push({ deviceId: entry.deviceId, action: entry.action, previousState, mitigatedAt: now });
            this._addLog(`Mitigated: ${device.name} (${entry.action})`);
          }
          this._lastMitigationTime = now;
          this._persistMitigatedDevices();
          this._fireTrigger('mitigation_applied', { device_name: device.name, action: entry.action });
          await this._updateVirtualDevice({ alarm: true });
          this.log(`[Mitigation] SUCCESS: ${entry.name} mitigated with action=${entry.action}`);
          this._appLogEntry('mitigation', `Mitigated: ${entry.name} (action=${entry.action})`);
          scanResults.push({ name: entry.name, action: entry.action, result: `SUCCESS` });
          mitigatedThisCycle = true;
          // Don't break — continue to build full scan results for diagnostics
        } catch (err) {
          // If device was removed, skip it rather than blocking mitigation
          const errMsg = (err.message || '').toLowerCase();
          if (errMsg.includes('not_found') || errMsg.includes('device_not_found') || errMsg.includes('timed out')) {
            this.log(`[Mitigation] Device ${entry.deviceId} (${entry.name}) not found or unreachable, skipping`);
            scanResults.push({ name: entry.name, action: entry.action, result: `error: ${errMsg.substring(0, 80)}` });
            continue;
          }
          this.error(`Mitigation failed for ${entry.deviceId}:`, err);
          scanResults.push({ name: entry.name, action: entry.action, result: `error: ${(err.message || '').substring(0, 80)}` });
        }
      }

      // Store scan results for diagnostics (visible via getStatus)
      this._lastMitigationScan = scanResults;
      this.log(`[Mitigation] Scan complete: ${JSON.stringify(scanResults)}`);
    } finally {
      release();
    }
  }

  _canMitigate(entry) {
    const minRuntime = (entry.minRuntimeSeconds || 0) * 1000;
    if (entry.startedAt && Date.now() - entry.startedAt < minRuntime) return false;
    return true;
  }

  // ─── Restore ──────────────────────────────────────────────────────────────

  async _triggerRestore() {
    if (!this._api) return;
    const release = await this._mutex.acquire();
    try {
      const toRestore = this._mitigatedDevices[this._mitigatedDevices.length - 1];
      if (!toRestore) return;

      const entry = (this._settings.priorityList || []).find(e => e.deviceId === toRestore.deviceId);
      const minOffTime = ((entry && entry.minOffTimeSeconds) || 0) * 1000;
      if (Date.now() - toRestore.mitigatedAt < minOffTime) return;

      try {
        const device = await withTimeout(
          this._api.devices.getDevice({ id: toRestore.deviceId }),
          10000, `getDevice(${toRestore.deviceId})`
        );
        if (!device) { this._mitigatedDevices.pop(); this._persistMitigatedDevices(); return; }

        const restored = await restoreDevice(device, toRestore.action, toRestore.previousState);
        if (restored) {
          this._mitigatedDevices.pop();
          this._addLog(`Restored: ${device.name}`);
          this._appLogEntry('mitigation', `Restored: ${device.name}`);
          this._persistMitigatedDevices();
          if (this._mitigatedDevices.length === 0) {
            this._fireTrigger('mitigation_cleared', {});
            await this._updateVirtualDevice({ alarm: false });
          }
        } else {
          // restoreDevice returned false (e.g. action no longer matches device capabilities).
          // Remove the stuck entry so it doesn't block all future restores.
          this.log(`[Restore] restoreDevice returned false for ${device.name} (action=${toRestore.action}) — removing stuck entry`);
          this._mitigatedDevices.pop();
          this._persistMitigatedDevices();
          if (this._mitigatedDevices.length === 0) {
            this._fireTrigger('mitigation_cleared', {});
            await this._updateVirtualDevice({ alarm: false });
          }
        }
      } catch (err) {
        // If device was removed from Homey, clean up the stale mitigation entry
        const errMsg = (err.message || '').toLowerCase();
        if (errMsg.includes('not_found') || errMsg.includes('device_not_found') || errMsg.includes('timed out')) {
          this.log(`[Restore] Device ${toRestore.deviceId} gone or unreachable, removing stale entry`);
          this._mitigatedDevices.pop();
          this._persistMitigatedDevices();
          return;
        }
        this.error(`Restore failed for ${toRestore.deviceId}:`, err);
      }
    } finally {
      release();
    }
  }

  // ─── Virtual device ───────────────────────────────────────────────────────

  async _updateVirtualDevice(data) {
    try {
      const driver = this.homey.drivers.getDriver('power-guard');
      if (!driver) return;
      const devices = driver.getDevices();
      if (!devices.length) return;
      const vd = devices[0];

      if (data.power !== undefined)
        await vd.setCapabilityValue('measure_power', Math.round(data.power)).catch(() => {});
      if (data.alarm !== undefined)
        await vd.setCapabilityValue('alarm_generic', !!data.alarm).catch(() => {});
      if (data.onoff !== undefined)
        await vd.setCapabilityValue('onoff', !!data.onoff).catch(() => {});
    } catch (_) {}
  }

  // ─── Flow cards ───────────────────────────────────────────────────────────

  _registerFlowCards() {
    this._triggerPowerLimitExceeded = this.homey.flow.getTriggerCardById('power_limit_exceeded');
    this._triggerMitigationApplied  = this.homey.flow.getTriggerCardById('mitigation_applied');
    this._triggerMitigationCleared  = this.homey.flow.getTriggerCardById('mitigation_cleared');
    this._triggerProfileChanged     = this.homey.flow.getTriggerCardById('profile_changed');

    const condEnabled = this.homey.flow.getConditionCardById('guard_enabled');
    if (condEnabled) condEnabled.registerRunListener(() => this._settings.enabled);

    const condOverLimit = this.homey.flow.getConditionCardById('is_over_limit');
    if (condOverLimit) condOverLimit.registerRunListener(() =>
      this._overLimitCount >= this._settings.hysteresisCount);

    const condProfile = this.homey.flow.getConditionCardById('profile_is');
    if (condProfile) condProfile.registerRunListener((args) =>
      this._settings.profile === args.profile);

    const actEnable = this.homey.flow.getActionCardById('enable_guard');
    if (actEnable) actEnable.registerRunListener(() => {
      this._settings.enabled = true;
      this.homey.settings.set('enabled', true);
      this._updateVirtualDevice({ onoff: true }).catch(() => {});
    });

    const actDisable = this.homey.flow.getActionCardById('disable_guard');
    if (actDisable) actDisable.registerRunListener(() => {
      this._settings.enabled = false;
      this.homey.settings.set('enabled', false);
      this._updateVirtualDevice({ onoff: false }).catch(() => {});
    });

    const actProfile = this.homey.flow.getActionCardById('set_profile');
    if (actProfile) actProfile.registerRunListener((args) => this._setProfile(args.profile));

    const actReset = this.homey.flow.getActionCardById('reset_statistics');
    if (actReset) actReset.registerRunListener(() => this._resetStatistics());
  }

  _fireTrigger(id, tokens) {
    const map = {
      power_limit_exceeded: this._triggerPowerLimitExceeded,
      mitigation_applied:   this._triggerMitigationApplied,
      mitigation_cleared:   this._triggerMitigationCleared,
      profile_changed:      this._triggerProfileChanged,
    };
    const card = map[id];
    if (card) card.trigger(tokens || {}).catch((err) => this.error('Trigger error:', err));
  }

  // ─── Profile ──────────────────────────────────────────────────────────────

  _setProfile(profile) {
    if (!Object.values(PROFILES).includes(profile)) return;
    this._settings.profile = profile;
    this.homey.settings.set('profile', profile);
    this._fireTrigger('profile_changed', { profile });
    this.log(`Profile: ${profile}`);
    this._appLogEntry('system', `Profile changed to: ${profile}`);
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  _resetStatistics() {
    this._powerBuffer = [];
    this._spikeConsecutiveCount = 0;
    this._spikeLastFilteredValue = null;
    this._overLimitCount = 0;
    this._mitigationLog = [];
    this.log('Statistics reset');
  }

  _addLog(message) {
    this._mitigationLog.push({ time: timestamp(), message });
    if (this._mitigationLog.length > MITIGATION_LOG_MAX) this._mitigationLog.shift();
    this.log(message);
  }

  _appLogEntry(category, message) {
    this._appLog.push({ time: new Date().toISOString(), category: category, message: message });
    if (this._appLog.length > 300) this._appLog.shift();
  }

  getAppLog() {
    const s = this.homey.settings;
    const cache = s.get('_deviceCache') || [];
    return {
      appLog: this._appLog.slice(),
      mitigationLog: this._mitigationLog.slice(),
      hanDiagnostic: this.getHanDiagnostic(),
      lastMitigationScan: this._lastMitigationScan.slice(),
      settings: {
        enabled: s.get('enabled') ?? true,
        profile: s.get('profile') ?? 'normal',
        powerLimitW: s.get('powerLimitW') ?? 10000,
        phase1LimitA: s.get('phase1LimitA') ?? 0,
        phase2LimitA: s.get('phase2LimitA') ?? 0,
        phase3LimitA: s.get('phase3LimitA') ?? 0,
        smoothingWindow: s.get('smoothingWindow') ?? 5,
        spikeMultiplier: s.get('spikeMultiplier') ?? 2.0,
        hysteresisCount: s.get('hysteresisCount') ?? 3,
        cooldownSeconds: s.get('cooldownSeconds') ?? 30,
        voltageSystem: s.get('voltageSystem') ?? '230v-1phase',
        mainCircuitA: s.get('mainCircuitA') ?? 25,
        selectedMeterDeviceId: s.get('selectedMeterDeviceId') ?? 'auto',
      },
      deviceCacheCount: cache.length,
      uptimeSeconds: Math.round((Date.now() - this._appStartTime) / 1000),
      currentPowerW: Math.round(movingAverage(this._powerBuffer, this._settings.smoothingWindow)),
      limitW: this._getEffectiveLimit(),
      mitigatedDevices: this._mitigatedDevices.map(function (m) { return { deviceId: m.deviceId, action: m.action }; }),
      overLimitCount: this._overLimitCount,
      detectedVoltageSystem: this._detectSystemPhases() === 3 ? '400v-3phase' : '230v-1phase',
    };
  }

  // Read current capability values from homey-api capabilitiesObj
  _snapshotState(device) {
    const obj = device.capabilitiesObj || {};
    return {
      onoff:              obj.onoff              ? obj.onoff.value              : undefined,
      dim:                obj.dim                ? obj.dim.value                : undefined,
      target_temperature: obj.target_temperature ? obj.target_temperature.value : undefined,
      thermostat_mode:    obj.thermostat_mode    ? obj.thermostat_mode.value    : undefined,
      target_current:          obj.target_current          ? obj.target_current.value          : undefined,
      target_charger_current:  obj.target_charger_current  ? obj.target_charger_current.value  : undefined,
      target_circuit_current:  obj.target_circuit_current  ? obj.target_circuit_current.value  : undefined,
      toggleChargingCapability: obj.toggleChargingCapability ? obj.toggleChargingCapability.value : undefined,
      max_power_3000:     obj.max_power_3000     ? obj.max_power_3000.value     : undefined,
      max_power:          obj.max_power          ? obj.max_power.value          : undefined,
    };
  }

  // ─── Watchdog ─────────────────────────────────────────────────────────────

  async _watchdog() {
    try {
      const driver = this.homey.drivers.getDriver('power-guard');
      if (!driver) return;
      const devices = driver.getDevices();
      if (!devices.length) return;
      const vd = devices[0];

      const silentMs = this._lastHanReading ? Date.now() - this._lastHanReading : Infinity;

      if (!this._hanDeviceId || silentMs > 60000) {
        // HAN not found or no readings for 60s → try to reconnect
        this.log('[Watchdog] HAN silent for ' + Math.round(silentMs / 1000) + 's, attempting reconnect...');
        this._writeDebugLog('[HAN] Watchdog reconnect triggered after ' + Math.round(silentMs / 1000) + 's silence');
        this._appLogEntry('han', 'Watchdog reconnect after ' + Math.round(silentMs / 1000) + 's silence');
        this._hanWatchdogCount++;
        try {
          if (this._hanCapabilityInstance) {
            try { this._hanCapabilityInstance.destroy(); } catch (_) {}
            this._hanCapabilityInstance = null;
          }
          if (this._hanPollInterval) {
            clearInterval(this._hanPollInterval);
            this._hanPollInterval = null;
          }
          this._hanDevice = null;
          this._hanDeviceName = null;
          this._hanDeviceManufacturer = null;
          await this._connectToHAN();
          if (this._hanDeviceId) {
            this.log('[Watchdog] HAN reconnected successfully');
          }
        } catch (e) {
          this.log('[Watchdog] HAN reconnect failed: ' + e.message);
        }
      }

      if (!this._hanDeviceId) return;
      if (silentMs > 30000) {
        await vd.setUnavailable(this.homey.__('errors.hanTimeout')).catch(() => {});
      } else {
        await vd.setAvailable().catch(() => {});
      }
    } catch (_) {}

    // Keep settings-page status cache fresh even when no HAN data
    this._cacheStatus();
  }

  // ─── Settings-page cache (avoids need for H.api() which is absent in some firmware) ──

  _cacheStatus() {
    try {
      const status = this.getStatus();
      this.homey.settings.set('_statusCache', status);
      this.homey.api.realtime('status', status);
    } catch (_) {}
  }

  async _cacheDevices(isInitialization = false) {
    if (!this._api) {
      const err = 'API not available';
      if (isInitialization) throw new Error(err);
      this.log('[Cache] ' + err);
      return;
    }

    try {
      this.log('[Cache] Starting device cache fetch...');
      const startTime = Date.now();

      const allDevices = await this._api.devices.getDevices();
      const devicesList = Object.values(allDevices);
      this.log(`[Cache] Found ${devicesList.length} total devices`);
      
      // Store all devices for power consumption tracking
      this._cachedDevices = devicesList;
      this.homey.settings.set('_allDevicesCache', devicesList);

      // Fetch zones for room grouping — best-effort, non-fatal
      let zoneMap = {};
      try {
        const allZones = await this._api.zones.getZones();
        Object.values(allZones).forEach(z => { zoneMap[z.id] = z.name; });
        this.log(`[Cache] Found ${Object.keys(zoneMap).length} zones`);
      } catch (_) {
        this.log('[Cache] Zone fetch failed, using defaults');
      }

      const list = Object.values(allDevices)
        .filter(d => {
          if (!d) return false;
          const caps = d.capabilities || [];
          const ownerUri = (d.driver && d.driver.owner_uri) || d.driverUri || '';

          // Zaptec creates two virtual devices: the charger (charging_button, charge_mode, charging_mode)
          // and the installation/meter device (meter_sum_current, meter_sum_month, etc.).
          // Exclude the meter device — it has no charging control caps and cannot be controlled.
          const isZaptecApp = ownerUri.includes('com.zaptec');
          const zaptecChargingCaps = ['charging_button', 'charge_mode', 'charge_pause', 'charging_mode'];
          if (isZaptecApp && !caps.some(c => zaptecChargingCaps.includes(c))) {
            this.log(`[Filter] Excluding Zaptec meter/installation device "${d.name}" (no charging caps)`);
            return false;
          }

          // Check for controllable capabilities
          const hasControlCapability =
            caps.includes('onoff') ||
            caps.includes('dim') ||
            caps.includes('target_temperature') ||
            caps.includes('target_current') ||
            caps.includes('target_charger_current') ||
            caps.includes('dynamic_charger_current') ||
            caps.includes('dynamicChargerCurrent') ||
            caps.includes('target_circuit_current') ||
            caps.includes('charge_pause') ||
            caps.includes('charge_mode') ||
            caps.includes('charging_button') ||
            caps.includes('toggleChargingCapability') ||
            caps.includes('max_power_3000') ||
            caps.includes('max_power');

          // Check for known controllable device classes
          const isControllableClass =
            d.class === 'light' ||
            d.class === 'socket' ||
            d.class === 'charger' ||
            d.class === 'evcharger' ||
            d.class === 'thermostat' ||
            d.class === 'kettle' ||
            d.class === 'heater' ||
            d.class === 'appliance' ||
            d.class === 'fan' ||
            d.class === 'switch' ||
            d.class === 'other';

          return hasControlCapability || isControllableClass;
        })
        .map(d => {
          // Log each included device with reason
          const caps = d.capabilities || [];
          const includedReason =
            caps.some(c =>
              c === 'onoff' || c === 'dim' || c === 'target_temperature' ||
              c === 'target_current' || c === 'target_charger_current' || c === 'dynamic_charger_current' ||
              c === 'target_circuit_current' || c === 'charge_pause' || c === 'charging_button' || c === 'toggleChargingCapability')
              ? 'capability'
              : ['light', 'socket', 'charger', 'evcharger', 'thermostat', 'appliance'].includes(d.class)
              ? 'class'
              : 'other';

          this.log(`[Filter] Device "${d.name}" included because of ${includedReason} ` +
            `(class=${d.class}, caps=[${caps.join(',')}])`);

          return {
            id:           d.id,
            name:         d.name,
            class:        d.class,
            capabilities: d.capabilities || [],
            zoneName:     zoneMap[d.zone] || 'Other',
            driverId:     d.driverId,
            driverUri:    d.driverUri || '',
            isEasee:      (d.driverId === 'charger' && d.driver && d.driver.owner_uri === 'homey:app:no.easee'),
            isZaptec:     (d.class === 'evcharger' && d.driver && d.driver.owner_uri === 'homey:app:com.zaptec'),
            isEnua:       (d.driver && d.driver.owner_uri === 'homey:app:no.enua'),
            isAdax:       (d.driverUri || '').includes('no.adax') || (d.driver && d.driver.owner_uri === 'homey:app:no.adax.smart-heater.homey-app'),
            isHoiax:      (d.driverUri || '').includes('no.hoiax') || (d.driver && d.driver.owner_uri === 'homey:app:no.hoiax'),
          };
        });

      this.homey.settings.set('_deviceCache', list);
      this._deviceCacheReady = true;
      this._lastCacheTime = Date.now();
      const elapsed = Date.now() - startTime;
      this.log(`[Cache] Successfully cached ${list.length} controllable devices in ${elapsed}ms`);
      this._appLogEntry('cache', `Device cache refreshed: ${list.length} devices in ${elapsed}ms`);

    } catch (err) {
      if (isInitialization) {
        throw err;  // Re-throw for initialization retry logic
      } else {
        this.error('[Cache] Device cache error:', err);
        // Don't rethrow for background refresh
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // █ SECTION 5 — EV CHARGERS — GENERAL ENGINE                                 █
  // ══════════════════════════════════════════════════════════════════
  //  Included: circuit limit application, car connection detection,
  //            capability listeners for all brands, charger confirmation
  //            tracking, EV data polling, fast power-based adjustment,
  //            optimal current calculation
  //  All charger brands share this engine; brand-specific control is in
  //  Sections 6–8 (Zaptec, Enua, Easee).
  //
  //  ⚠️ ACTIVE — Changes here affect ALL charger brands
  // ══════════════════════════════════════════════════════════════════

  /**
   * Push the configured circuit limits from the priority list to each
   * Easee charger's target_charger_current capability (Ladegrense).
   * This sets the permanent max charging limit — NOT the dynamic/temporary limit.
   * Called on init, when system settings are saved, and when a
   * per-charger circuit limit is changed in the System tab.
   */
  async applyCircuitLimitsToChargers() {
    if (!this._api) return { ok: false, reason: 'No API' };

    const entries = (this._settings.priorityList || []).filter(
      e => (e.action === 'dynamic_current' || e.action === 'charge_pause') && e.enabled !== false
    );
    if (!entries.length) return { ok: true, results: [] };

    const results = [];
    for (const entry of entries) {
      const circuitA = entry.circuitLimitA || 32;
      try {
        const device = await this._api.devices.getDevice({ id: entry.deviceId });
        if (!device) {
          results.push({ name: entry.name, ok: false, detail: 'Device not found' });
          continue;
        }

        const caps = device.capabilities || [];
        const obj = device.capabilitiesObj || {};
        const details = [];

        // Push to target_charger_current only (Easee "Ladegrense" / permanent charging limit)
        // Do NOT touch target_circuit_current (Sikringsgrense) — that's the fuse/circuit breaker setting
        if (caps.includes('target_charger_current')) {
          const currentVal = obj.target_charger_current?.value;
          if (currentVal !== circuitA) {
            await device.setCapabilityValue({ capabilityId: 'target_charger_current', value: circuitA });
            this.log(`[CircuitLimit] ${entry.name}: Ladegrense ${currentVal}A → ${circuitA}A`);
            details.push(`Ladegrense: ${circuitA}A`);
          } else {
            details.push(`Ladegrense: already ${circuitA}A`);
          }
        }

        if (details.length > 0) {
          results.push({ name: entry.name, ok: true, detail: details.join(', ') });
        } else {
          results.push({ name: entry.name, ok: false, detail: 'No target_charger_current capability found' });
        }
      } catch (err) {
        this.error(`[CircuitLimit] Failed for ${entry.name}:`, err);
        results.push({ name: entry.name, ok: false, detail: err.message });
      }
    }

    this._addLog(`Circuit limits applied: ${results.filter(r => r.ok).length}/${results.length} chargers`);
    this._appLogEntry('charger', `Circuit limits applied: ${results.filter(r => r.ok).length}/${results.length} chargers`);
    return { ok: true, results };
  }

  /**
   * Check if a car is physically connected to a charger.
   * Uses WHITELIST approach: only returns true when we have positive evidence.
   * Easee statuses: 1=disconnected, 2=awaiting_start, 3=charging, 4=completed, 5=error
   * If status is unknown/null/unrecognized → assume NOT connected (safe default).
   */
  _isCarConnected(deviceId) {
    const evData = this._evPowerData[deviceId];
    if (!evData) return false;  // No data at all → skip

    const cs = evData.chargerStatus;

    // Whitelist: statuses that mean a car IS physically connected
    // Includes Easee/generic statuses (numeric + string) and Enua-specific strings
    const connectedStatuses = [
      // Generic / Easee numeric
      2, 'awaiting_start', 'AWAITING_START', 'AwaitingStart',
      3, 'charging', 'CHARGING', 'Charging',
      4, 'completed', 'COMPLETED', 'Completed',
      // Enua chargerStatusCapability values
      'Connected', 'connected', 'CONNECTED',
      'Paused', 'paused', 'PAUSED',
      'ScheduledCharging', 'scheduledCharging', 'SCHEDULED_CHARGING',
      'WaitingForSchedule', 'waitingForSchedule',
    ];

    if (connectedStatuses.includes(cs)) return true;

    // Zaptec: alarm_generic.car_connected is a boolean (true = car connected)
    if (evData.carConnectedAlarm === true) return true;

    // Secondary check: if charger is drawing meaningful power, something is connected
    if (evData.powerW > 100) return true;

    // Everything else (status 1/Standby/disconnected, 5/error, null) → not connected
    return false;
  }

  async _connectToEVChargers() {
    if (!this._api) return;
    // Tear down old instances
    for (const inst of Object.values(this._evCapabilityInstances || {})) {
      try { inst.destroy(); } catch (_) {}
    }
    this._evCapabilityInstances = {};

    const evEntries = (this._settings.priorityList || []).filter(e =>
      e.action === 'charge_pause' || e.action === 'dynamic_current'
    );

    for (const entry of evEntries) {
      try {
        let device = await withTimeout(
          this._api.devices.getDevice({ id: entry.deviceId }),
          10000, `connectGetDevice(${entry.deviceId})`
        );
        if (!device) continue;
        let caps = device.capabilities || [];
        let obj  = device.capabilitiesObj || {};

        // ── Zaptec meter device auto-redirect ──
        // Zaptec creates two Homey devices: the charger (has charging_button) and the
        // installation/meter device (only has meter_sum_* caps). If the priority list
        // points at the meter device, auto-find and use the real charger instead.
        const _zaptecChargeCaps = ['charging_button', 'charge_mode', 'charge_pause', 'charging_mode'];
        const _devOwner = (device.driver && device.driver.owner_uri) || device.driverUri || '';
        if (_devOwner.includes('com.zaptec') && !caps.some(c => _zaptecChargeCaps.includes(c))) {
          this.log(`[Zaptec] "${entry.name}" (${entry.deviceId}) appears to be the Zaptec meter/installation device. Searching for real charger...`);
          try {
            const allDevs = await withTimeout(this._api.devices.getDevices(), 10000, 'getAllDevicesForZaptecRedirect');
            const realCharger = Object.values(allDevs).find(d => {
              const dCaps = d.capabilities || [];
              const dOwner = (d.driver && d.driver.owner_uri) || d.driverUri || '';
              return dOwner.includes('com.zaptec') && dCaps.some(c => _zaptecChargeCaps.includes(c));
            });
            if (realCharger) {
              this.log(`[Zaptec] Auto-redirecting "${entry.name}" → real charger "${realCharger.name}" (${realCharger.id})`);
              this._appLogEntry('charger', `Zaptec auto-fix: using charger "${realCharger.name}" instead of meter device "${entry.name}"`);
              if (!this._chargerDeviceRedirects) this._chargerDeviceRedirects = {};
              this._chargerDeviceRedirects[entry.deviceId] = realCharger.id;
              device = realCharger;
              caps   = realCharger.capabilities || [];
              obj    = realCharger.capabilitiesObj || {};
            } else {
              this.log(`[Zaptec] No real Zaptec charger device found to redirect to — commands will continue to target ${entry.deviceId}`);
            }
          } catch (rdErr) {
            this.log(`[Zaptec] Redirect lookup failed: ${rdErr.message}`);
          }
        }

        // Store initial snapshot with full state
        this._evPowerData[entry.deviceId] = {
          name:           entry.name || device.name,
          powerW:         obj.measure_power ? (obj.measure_power.value || 0) : 0,
          isCharging:     obj.onoff ? obj.onoff.value !== false
                        : obj.toggleChargingCapability ? obj.toggleChargingCapability.value !== false
                        : obj.charging_button ? obj.charging_button.value !== false
                        : false,
          chargerStatus:  obj.charger_status ? obj.charger_status.value
                        : obj.chargerStatusCapability ? obj.chargerStatusCapability.value
                        : null,
          carConnectedAlarm: obj['alarm_generic.car_connected'] ? obj['alarm_generic.car_connected'].value : null,
          offeredCurrent: obj['measure_current.offered'] ? obj['measure_current.offered'].value : null,
          isConnected:    null,  // derived below
        };

        // Derive connected state using whitelist approach
        this._evPowerData[entry.deviceId].isConnected = this._isCarConnected(entry.deviceId);

        // Listen to measure_power changes
        if (caps.includes('measure_power')) {
          const pwrInst = device.makeCapabilityInstance('measure_power', (value) => {
            if (this._evPowerData[entry.deviceId]) {
              this._evPowerData[entry.deviceId].powerW = typeof value === 'number' ? value : 0;
            }
          });
          this._evCapabilityInstances[entry.deviceId + '_power'] = pwrInst;
        }

        // Listen to charger_status changes (Easee specific)
        if (caps.includes('charger_status')) {
          const csInst = device.makeCapabilityInstance('charger_status', (value) => {
            if (this._evPowerData[entry.deviceId]) {
              this._evPowerData[entry.deviceId].chargerStatus = value;
              this._evPowerData[entry.deviceId].isConnected = this._isCarConnected(entry.deviceId);
              this.log(`[EV] ${entry.name} charger_status changed to: ${value} → connected: ${this._evPowerData[entry.deviceId].isConnected}`);
              this._appLogEntry('charger', `${entry.name} status: ${value} → connected: ${this._evPowerData[entry.deviceId].isConnected}`);
            }
          });
          this._evCapabilityInstances[entry.deviceId + '_status'] = csInst;
        }

        // Listen to chargerStatusCapability changes (Enua specific)
        if (caps.includes('chargerStatusCapability')) {
          const enuaStatusInst = device.makeCapabilityInstance('chargerStatusCapability', (value) => {
            if (this._evPowerData[entry.deviceId]) {
              this._evPowerData[entry.deviceId].chargerStatus = value;
              this._evPowerData[entry.deviceId].isConnected = this._isCarConnected(entry.deviceId);
              // Cross-link: also update isCharging from status
              this._evPowerData[entry.deviceId].isCharging = (value === 'Charging');
              this.log(`[EV] ${entry.name} chargerStatusCapability changed to: ${value} → connected: ${this._evPowerData[entry.deviceId].isConnected}, charging: ${this._evPowerData[entry.deviceId].isCharging}`);
              this._appLogEntry('charger', `${entry.name} Enua status: ${value} → connected: ${this._evPowerData[entry.deviceId].isConnected}, charging: ${this._evPowerData[entry.deviceId].isCharging}`);
            }
          });
          this._evCapabilityInstances[entry.deviceId + '_enua_status'] = enuaStatusInst;
        }

        // Listen to toggleChargingCapability changes (Enua specific)
        if (caps.includes('toggleChargingCapability')) {
          const enuaChargingInst = device.makeCapabilityInstance('toggleChargingCapability', (value) => {
            if (this._evPowerData[entry.deviceId]) {
              this._evPowerData[entry.deviceId].isCharging = value !== false;
              // Cross-link: also re-evaluate isConnected when charging toggle changes
              this._evPowerData[entry.deviceId].isConnected = this._isCarConnected(entry.deviceId);
              this.log(`[EV] ${entry.name} toggleChargingCapability changed to: ${value} → charging: ${this._evPowerData[entry.deviceId].isCharging}, connected: ${this._evPowerData[entry.deviceId].isConnected}`);
            }
          });
          this._evCapabilityInstances[entry.deviceId + '_enua_charging'] = enuaChargingInst;
        }

        // Listen to alarm_generic.car_connected changes (Zaptec specific)
        if (caps.includes('alarm_generic.car_connected')) {
          const carInst = device.makeCapabilityInstance('alarm_generic.car_connected', (value) => {
            if (this._evPowerData[entry.deviceId]) {
              this._evPowerData[entry.deviceId].carConnectedAlarm = value;
              this._evPowerData[entry.deviceId].isConnected = this._isCarConnected(entry.deviceId);
              this.log(`[EV] ${entry.name} alarm_generic.car_connected changed to: ${value} → connected: ${this._evPowerData[entry.deviceId].isConnected}`);
            }
          });
          this._evCapabilityInstances[entry.deviceId + '_car_connected'] = carInst;
        }

        // Listen to charging_button changes (Zaptec specific)
        if (caps.includes('charging_button')) {
          const btnInst = device.makeCapabilityInstance('charging_button', (value) => {
            if (this._evPowerData[entry.deviceId]) {
              this._evPowerData[entry.deviceId].isCharging = value !== false;
              this.log(`[EV] ${entry.name} charging_button changed to: ${value}`);
            }
          });
          this._evCapabilityInstances[entry.deviceId + '_charging_button'] = btnInst;
        }

        // Listen to onoff changes
        if (caps.includes('onoff')) {
          const onInst = device.makeCapabilityInstance('onoff', (value) => {
            if (this._evPowerData[entry.deviceId]) {
              this._evPowerData[entry.deviceId].isCharging = value !== false;
            }
          });
          this._evCapabilityInstances[entry.deviceId + '_onoff'] = onInst;
        }

        // Listen to offered current (also checks command confirmation)
        if (caps.includes('measure_current.offered')) {
          const offInst = device.makeCapabilityInstance('measure_current.offered', (value) => {
            if (this._evPowerData[entry.deviceId]) {
              this._evPowerData[entry.deviceId].offeredCurrent = typeof value === 'number' ? value : null;
              this._checkChargerConfirmation(entry.deviceId);
            }
          });
          this._evCapabilityInstances[entry.deviceId + '_offered'] = offInst;
        }

      } catch (err) {
        this.error(`EV connect error for ${entry.deviceId}:`, err);
      }
    }
    this.log(`EV charger tracking: ${Object.keys(this._evCapabilityInstances).length} device(s)`);

    // Active polling fallback for charger data (some Easee firmware doesn't push events reliably)
    if (this._evPollInterval) clearInterval(this._evPollInterval);
    this._evPollInterval = setInterval(() => this._pollEVChargerData().catch(() => {}), 5000);
    this.log('EV charger polling started (5s interval)');
  }

  /**
   * Check if a charger's offered current confirms our last command.
   * Updates confirmation state and reliability score per charger.
   * Called on offered-current capability updates and during polling.
   */
  _checkChargerConfirmation(deviceId) {
    const state = this._chargerState[deviceId];
    if (!state || state.confirmed || state.timedOut) return;  // Already resolved or no pending command

    const evData = this._evPowerData[deviceId];
    if (!evData || evData.offeredCurrent == null) return;

    const now = Date.now();
    const elapsed = now - (state.commandTime || 0);

    // Check if offered current matches commanded current (within 1A)
    if (state.lastCommandA != null && Math.abs(evData.offeredCurrent - state.lastCommandA) <= 1) {
      state.confirmed = true;
      state.reliability = (state.reliability ?? 0.5) * 0.99 + 0.01;  // Success → nudge up
      this.log(`[EV] \u2713 Confirmed: ${evData.name} → ${evData.offeredCurrent}A (commanded ${state.lastCommandA}A, took ${Math.round(elapsed / 1000)}s, reliability=${(state.reliability * 100).toFixed(1)}%)`);
      this._appLogEntry('charger', `Confirmed: ${evData.name} → ${evData.offeredCurrent}A (commanded ${state.lastCommandA}A, ${Math.round(elapsed / 1000)}s)`);
    } else if (elapsed > CHARGER_DEFAULTS.confirmationTimeoutMs) {
      // Timed out waiting for confirmation
      state.reliability = (state.reliability ?? 0.5) * 0.99;  // Failure → nudge down
      state.timedOut = true;  // Stop re-checking until next command
      this.log(`[EV] \u2717 Unconfirmed: ${evData.name} → offered ${evData.offeredCurrent}A but commanded ${state.lastCommandA}A (${Math.round(elapsed / 1000)}s, reliability=${(state.reliability * 100).toFixed(1)}%)`);
      this._appLogEntry('charger', `Unconfirmed: ${evData.name} → offered ${evData.offeredCurrent}A but commanded ${state.lastCommandA}A (${Math.round(elapsed / 1000)}s)`);
    }
  }

  /**
   * Poll all tracked EV chargers for fresh capability values.
   * Ensures power/status updates even if the Easee driver doesn't fire events.
   */
  async _pollEVChargerData() {
    if (!this._api) return;
    const entries = (this._settings.priorityList || []).filter(e =>
      e.action === 'dynamic_current' && e.enabled !== false
    );
    for (const entry of entries) {
      try {
        const device = await withTimeout(
          this._api.devices.getDevice({ id: entry.deviceId }),
          8000, `pollGetDevice(${entry.deviceId})`
        );
        if (!device) continue;
        const obj = device.capabilitiesObj || {};
        const data = this._evPowerData[entry.deviceId];
        if (!data) continue;

        // Update power
        if (obj.measure_power && obj.measure_power.value != null) {
          data.powerW = typeof obj.measure_power.value === 'number' ? obj.measure_power.value : 0;
        }
        // Update charger_status
        if (obj.charger_status && obj.charger_status.value != null) {
          data.chargerStatus = obj.charger_status.value;
          data.isConnected = this._isCarConnected(entry.deviceId);
        }
        // Update onoff
        if (obj.onoff && obj.onoff.value != null) {
          data.isCharging = obj.onoff.value !== false;
        }
        // Update offered current
        if (obj['measure_current.offered'] && obj['measure_current.offered'].value != null) {
          data.offeredCurrent = typeof obj['measure_current.offered'].value === 'number' ? obj['measure_current.offered'].value : null;
        }

        // Check for command confirmation
        this._checkChargerConfirmation(entry.deviceId);
      } catch (err) {
        // Silently ignore per-charger poll errors
      }
    }
  }

  // ─── Fast EV Charger Adjustment (runs on every power reading) ──────────────

  /**
   * Continuously adjust EV chargers to optimize charging within the power limit.
   * Called on every HAN reading — bypasses the main mitigation cooldown.
   * Per-charger smart throttle: 15s when confirmed, 45s when unconfirmed, 5s on emergency.
   * Key behaviors:
   *  - Keeps charger at minimum 7A instead of pausing (keeps car charging)
   *  - Only pauses charger in true emergency (household alone exceeds limit)
   *  - Start threshold prevents restarting paused charger until enough headroom (11A startCurrent)
   *  - Main fuse protection caps power allocation at the physical fuse limit
   *  - Confirmation tracking: reads measure_current.offered to verify commands took effect
   *  - Proportional current scaling when charger is active (smoother adjustments)
   */
  async _adjustEVChargersForPower(smoothedPower) {
    const now = Date.now();

    const easeeEntries = (this._settings.priorityList || []).filter(e =>
      e.enabled !== false && e.action === 'dynamic_current'
    );
    if (!easeeEntries.length) return;

    const limit = this._getEffectiveLimit();
    const totalOverload = Math.max(0, smoothedPower - limit);

    // Detect emergency: power is significantly over limit (>500W)
    const isEmergency = totalOverload > 500;

    // Global floor: don't even evaluate more often than every 2s (prevents API spam)
    if (now - (this._lastEVAdjustTime || 0) < 2000) return;

    for (const entry of easeeEntries) {
      // Skip chargers with no car connected — no point adjusting them
      if (!this._isCarConnected(entry.deviceId)) {
        // Clean up any stale mitigation for this charger
        const stale = this._mitigatedDevices.findIndex(m => m.deviceId === entry.deviceId);
        if (stale >= 0) {
          this._mitigatedDevices.splice(stale, 1);
          this._persistMitigatedDevices();
          this.log(`[EV] Removed stale mitigation for disconnected charger: ${entry.name}`);
        }
        continue;
      }

      // Per-charger smart throttle based on confirmation state
      // Confirmed commands → shorter wait (charger is responsive)
      // Unconfirmed → longer wait (charger may be slow or unresponsive)
      // Emergency → minimal wait (immediate response needed)
      const cState = this._chargerState[entry.deviceId] || {};
      const isConfirmed = cState.confirmed === true;
      const perChargerThrottle = isEmergency ? CHARGER_DEFAULTS.toggleEmergencyMs
        : isConfirmed ? CHARGER_DEFAULTS.toggleConfirmedMs
        : CHARGER_DEFAULTS.toggleUnconfirmedMs;
      if (now - (cState.lastAdjustTime || 0) < perChargerThrottle) continue;

      const targetCurrent = this._calculateOptimalChargerCurrent(totalOverload, entry);
      const alreadyTracked = this._mitigatedDevices.find(m => m.deviceId === entry.deviceId);

      // Skip if target hasn't changed meaningfully
      // null == null (both paused): skip re-sending pause command
      if (alreadyTracked && targetCurrent === null && (alreadyTracked.currentTargetA === 0 || alreadyTracked.currentTargetA === null)) {
        continue;
      }
      // Same current (within 1A, inclusive): skip re-send that would restart the 45s unconfirmed throttle
      if (alreadyTracked && targetCurrent !== null &&
          Math.abs((alreadyTracked.currentTargetA || 0) - targetCurrent) <= 1) {
        continue;
      }
      // Skip if already at full and target is full
      if (!alreadyTracked && targetCurrent !== null && targetCurrent >= (entry.circuitLimitA || 32)) {
        continue;
      }

      // Charger start threshold: only START a paused charger when enough power for startCurrent
      // This prevents rapid on/off cycling when hovering near the limit
      const isCurrentlyPaused = alreadyTracked && (alreadyTracked.currentTargetA === 0 || alreadyTracked.currentTargetA === null);
      if (isCurrentlyPaused && targetCurrent !== null && targetCurrent < CHARGER_DEFAULTS.startCurrent) {
        // Don't restart below startCurrent — wait until we have headroom for at least 11A
        const chargerPhases = entry.chargerPhases || 3;
        const voltage = chargerPhases === 1 ? 230 : 692;
        const startThresholdW = CHARGER_DEFAULTS.startCurrent * voltage;  // ~2530W for 1-phase, ~7612W for 3-phase
        const chargerPowerW = this._evPowerData[entry.deviceId]?.powerW || 0;
        const nonChargerUsage = smoothedPower - chargerPowerW;
        const availableForStart = limit - nonChargerUsage - 200;
        if (availableForStart < startThresholdW) {
          this.log(`EV throttle: not restarting ${entry.name}, need ${Math.round(startThresholdW)}W (${CHARGER_DEFAULTS.startCurrent}A) but only ${Math.round(availableForStart)}W available`);
          continue;
        }
      }

      const success = await this._setEaseeChargerCurrent(entry.deviceId, targetCurrent, entry.circuitLimitA || 32).catch(() => false);
      if (!success) continue;

      this._lastEVAdjustTime = now;
      // Update per-charger state
      if (!this._chargerState[entry.deviceId]) this._chargerState[entry.deviceId] = {};
      this._chargerState[entry.deviceId].lastAdjustTime = now;

      if (targetCurrent !== null && targetCurrent < (entry.circuitLimitA || 32)) {
        // Charger is being limited (but still charging)
        if (!alreadyTracked) {
          this._mitigatedDevices.push({
            deviceId: entry.deviceId,
            action: 'dynamic_current',
            previousState: { targetCurrent: entry.circuitLimitA || 32 },
            mitigatedAt: now,
            currentTargetA: targetCurrent
          });
          this._fireTrigger('mitigation_applied', { device_name: entry.name, action: 'dynamic_current' });
          await this._updateVirtualDevice({ alarm: true }).catch(() => {});
        } else {
          alreadyTracked.currentTargetA = targetCurrent;
        }
        this._persistMitigatedDevices();
      } else if (targetCurrent === null) {
        // Pause charger (only on true emergency — household alone exceeds limit)
        if (!alreadyTracked) {
          this._mitigatedDevices.push({
            deviceId: entry.deviceId,
            action: 'dynamic_current',
            previousState: { targetCurrent: entry.circuitLimitA || 32 },
            mitigatedAt: now,
            currentTargetA: 0
          });
          this._fireTrigger('mitigation_applied', { device_name: entry.name, action: 'dynamic_current' });
          await this._updateVirtualDevice({ alarm: true }).catch(() => {});
        } else {
          alreadyTracked.currentTargetA = 0;
        }
        this._persistMitigatedDevices();
      } else if (alreadyTracked && targetCurrent >= (entry.circuitLimitA || 32)) {
        // Charger restored to full
        this._mitigatedDevices = this._mitigatedDevices.filter(m => m.deviceId !== entry.deviceId);
        this._addLog(`Charger restored: ${entry.name} → ${targetCurrent}A`);
        this._persistMitigatedDevices();
        this._fireTrigger('mitigation_cleared', { device_name: entry.name });
        if (this._mitigatedDevices.length === 0) {
          await this._updateVirtualDevice({ alarm: false }).catch(() => {});
        }
      }
    }
  }

  // ─── Dynamic EV Charger Control ────────────────────────────────────────────

  /**
   * Calculate optimal current for an EV charger given the current overload.
   * Respects per-charger circuit limits.
   * @param {number} totalOverloadW - Total power overage in watts
   * @param {Object} chargerEntry - Entry from priorityList (may have circuitLimitA)
   * @returns {number} Target current in amps (7-32), or null to pause
   */
  _calculateOptimalChargerCurrent(totalOverloadW, chargerEntry) {
    const circuitLimitA = chargerEntry.circuitLimitA || 32;
    const chargerPhases = chargerEntry.chargerPhases || 3;
    const voltage = chargerPhases === 1 ? 230 : 692;
    const minCurrent = CHARGER_DEFAULTS.minCurrent;   // 7A (some chargers unstable at 6A)
    const maxCurrent = Math.min(CHARGER_DEFAULTS.maxCurrent, circuitLimitA);

    const limit = this._getEffectiveLimit();
    const currentUsage = movingAverage(this._powerBuffer, this._settings.smoothingWindow);
    const evData = this._evPowerData[chargerEntry.deviceId];
    const chargerPowerW = evData?.powerW || 0;
    const offeredCurrent = evData?.offeredCurrent;
    const mainFuseA = this._settings.mainCircuitA || 25;

    // ── Per-phase current control (preferred) ────────────────────────────────
    // When the HAN sensor provides per-phase amps, use them directly for fuse
    // headroom calculation. This is more accurate than wattage-based math and
    // works correctly regardless of the voltageSystem setting.
    const phaseCurrents = this._getPhaseCurrents();
    if (phaseCurrents) {
      // Estimate charger's contribution per phase
      // offeredCurrent is the most accurate source (it IS the per-phase amps)
      let chargerCurrentPerPhase = 0;
      if (offeredCurrent > 0 && chargerPowerW > 200) {
        chargerCurrentPerPhase = offeredCurrent;
      } else if (chargerPowerW > 200 && chargerPhases > 0) {
        // Derive from measured power: assume symmetric load across phases
        chargerCurrentPerPhase = chargerPowerW / (chargerPhases * 230);
      }

      // Non-charger current on each phase (household-only amperage)
      const nonA = Math.max(0, phaseCurrents.a - (chargerPhases >= 1 ? chargerCurrentPerPhase : 0));
      const nonB = Math.max(0, phaseCurrents.b - (chargerPhases >= 2 ? chargerCurrentPerPhase : 0));
      const nonC = Math.max(0, phaseCurrents.c - (chargerPhases >= 3 ? chargerCurrentPerPhase : 0));

      // Emergency: if non-charger load alone maxes out any phase the charger uses
      const safetyMarginA = 1.5;
      const maxNonChargerPhaseA = chargerPhases >= 3
        ? Math.max(nonA, nonB, nonC)
        : chargerPhases >= 2 ? Math.max(nonA, nonB) : nonA;
      if (maxNonChargerPhaseA >= mainFuseA - safetyMarginA) {
        this.log(`EV calc (phase): household maxes fuse (${maxNonChargerPhaseA.toFixed(1)}A on a phase) → PAUSE`);
        return null;
      }

      // Available headroom = most constrained phase the charger uses
      let availableA = maxCurrent;
      if (chargerPhases >= 1) availableA = Math.min(availableA, mainFuseA - nonA - safetyMarginA);
      if (chargerPhases >= 2) availableA = Math.min(availableA, mainFuseA - nonB - safetyMarginA);
      if (chargerPhases >= 3) availableA = Math.min(availableA, mainFuseA - nonC - safetyMarginA);

      // Also respect the wattage limit (e.g. user set 15 000 W cap)
      const nonChargerUsageForLimit = currentUsage - chargerPowerW;
      const limitHeadroomW = limit - nonChargerUsageForLimit - 200;
      const limitCurrentA = limitHeadroomW / (chargerPhases === 1 ? 230 : 692);
      availableA = Math.min(availableA, limitCurrentA);

      if (availableA < minCurrent) {
        // If household alone exceeds the watt limit, pause the charger entirely (true emergency)
        if (nonChargerUsageForLimit > (limit - 200)) {
          this.log(`EV calc (phase): household alone=${Math.round(nonChargerUsageForLimit)}W > limit=${Math.round(limit)}W → PAUSE`);
          return null;
        }
        this.log(`EV calc (phase): available ${availableA.toFixed(1)}A < min ${minCurrent}A → KEEP MIN`);
        return minCurrent;
      }

      const targetCurrent = Math.max(minCurrent, Math.min(maxCurrent, Math.floor(availableA)));
      this.log(`EV calc (phase): A=${phaseCurrents.a.toFixed(1)} B=${phaseCurrents.b.toFixed(1)} C=${phaseCurrents.c.toFixed(1)}, nonCharger A=${nonA.toFixed(1)} B=${nonB.toFixed(1)} C=${nonC.toFixed(1)}, avail=${availableA.toFixed(1)}A → ${targetCurrent}A`);
      return targetCurrent;
    }

    // ── Fallback: wattage-based calculation (no per-phase data) ─────────────
    // Calculate household usage without this charger
    const nonChargerUsage = currentUsage - chargerPowerW;

    // Cap available power at main fuse limit
    // This prevents allocating more power than the physical fuse can handle
    const systemPhases = this._detectSystemPhases();
    const systemVoltage = 230;
    const maxFuseDrainW = Math.round((systemPhases === 3 ? 1.732 : 1) * systemVoltage * mainFuseA);

    // Available power for charger = minimum of (limit headroom) and (fuse headroom)
    // Safety margin of 200W below the limit to avoid oscillating at the boundary
    const limitHeadroomW = limit - nonChargerUsage - 200;
    const fuseHeadroomW = maxFuseDrainW - nonChargerUsage - 200;
    const availablePowerW = Math.min(limitHeadroomW, fuseHeadroomW);

    // Check if household alone (without charger) exceeds the limit
    // Only then is it a true emergency → pause the charger
    const householdAloneExceedsLimit = nonChargerUsage > (limit - 200);

    if (householdAloneExceedsLimit) {
      // TRUE emergency: household alone exceeds limit, must pause charger entirely
      this.log(`EV calc: household=${Math.round(nonChargerUsage)}W > limit=${Math.round(limit)}W → PAUSE (emergency)`);
      return null;
    }

    if (availablePowerW <= 0) {
      // No headroom but household isn't over limit → keep at minimum current
      this.log(`EV calc: usage=${Math.round(currentUsage)}W, available=${Math.round(availablePowerW)}W → KEEP MIN ${minCurrent}A`);
      return minCurrent;
    }

    // Proportional scaling: when charger is actively drawing power with known offered current,
    // scale proportionally for more accurate adjustment. This accounts for actual voltage,
    // power factor, and phase imbalance rather than assuming a fixed voltage.
    let targetCurrent;
    if (offeredCurrent > 0 && chargerPowerW > 500) {
      // Proportional: offeredCurrent × (desiredPower / actualPower)
      const proportionalA = Math.round(offeredCurrent * (availablePowerW / chargerPowerW));
      targetCurrent = Math.max(minCurrent, Math.min(maxCurrent, proportionalA));
      this.log(`EV calc (proportional): usage=${Math.round(currentUsage)}W, charger=${Math.round(chargerPowerW)}W@${offeredCurrent}A, available=${Math.round(availablePowerW)}W → ${targetCurrent}A`);
    } else {
      // Additive fallback: when charger is not active or no offered current data
      const availableCurrentA = Math.floor(availablePowerW / voltage);
      targetCurrent = Math.max(minCurrent, Math.min(maxCurrent, availableCurrentA));
      this.log(`EV calc (additive): usage=${Math.round(currentUsage)}W, charger=${Math.round(chargerPowerW)}W, available=${Math.round(availablePowerW)}W, fuse=${maxFuseDrainW}W → ${targetCurrent}A`);
    }
    return targetCurrent;
  }

  // ══════════════════════════════════════════════════════════════════
  // █ SECTION 6 — EV CHARGERS — BRAND DETECTION & FLOW DISCOVERY               █
  // ══════════════════════════════════════════════════════════════════
  //  Included: _getChargerBrand (capability-based), _discoverFlowAction
  //            (discovers & caches Zaptec / Enua flow card action IDs)
  //  This is the router — _setChargerCurrent() in Section 5 calls here first,
  //  then dispatches to Section 7 (Zaptec), 8 (Enua), or 9 (Easee).
  //
  //  ⚠️ ACTIVE — may need updates when new charger brands are added
  // ══════════════════════════════════════════════════════════════════

  /**
   * Detect charger brand from cached device capabilities.
   * @param {string} deviceId
   * @returns {'easee'|'zaptec'|'enua'|'unknown'}
   */
  _getChargerBrand(deviceId) {
    // Resolve any device redirect (Zaptec meter device → real charger device)
    deviceId = (this._chargerDeviceRedirects || {})[deviceId] || deviceId;
    const cache = this.homey.settings.get('_deviceCache') || [];
    const cached = cache.find(d => d.id === deviceId);
    if (!cached) return 'unknown';
    const caps = cached.capabilities || [];
    if (caps.includes('toggleChargingCapability')) return 'enua';
    if (caps.includes('charging_button')) return 'zaptec';
    // Easee exposes dynamic current as settable capabilities
    if (caps.some(c => ['dynamic_charger_current', 'dynamicChargerCurrent',
      'dynamicCircuitCurrentP1', 'target_charger_current'].includes(c))) return 'easee';
    return 'unknown';
  }

  /**
   * Discover and cache the Flow action ID for a charger brand's current control.
   * Searches all available flow actions for the matching app URI and current-related action.
   * Results are cached in this._flowActionCache to avoid repeated lookups.
   * @param {'zaptec'|'enua'} brand
   * @returns {Promise<{uri: string, actionId: string, argsStyle: 'zaptec3phase'|'enuaSingle'}|null>}
   */
  async _discoverFlowAction(brand) {
    if (!this._flowActionCache) this._flowActionCache = {};
    if (this._flowActionCache[brand]) return this._flowActionCache[brand];

    try {
      const flowActions = await this._api.flow.getFlowCardActions();
      const allActions = Object.values(flowActions);

      if (brand === 'zaptec') {
        // Look for Zaptec current control actions
        const zaptecActions = allActions.filter(a => a.uri === 'homey:app:com.zaptec');
        // Try exact match first, then fuzzy
        let action = zaptecActions.find(a => a.id === 'installation_current_control');
        if (!action) action = zaptecActions.find(a => /current|ampere|limit|strøm/i.test(a.id));
        if (!action) {
          // Try broader URI match
          const broader = allActions.filter(a => (a.uri || '').includes('zaptec'));
          action = broader.find(a => /current|ampere|limit|strøm/i.test(a.id));
        }
        if (action) {
          const result = { uri: action.uri, actionId: action.id, argsStyle: 'zaptec3phase' };
          this._flowActionCache[brand] = result;
          this.log(`[Zaptec] Discovered flow action: ${action.uri}/${action.id}`);
          return result;
        }
        this.log(`[Zaptec] No current control flow action found. Available Zaptec actions: ${zaptecActions.map(a => a.id).join(', ') || 'none'}`);
        return null;
      }

      if (brand === 'enua') {
        const enuaActions = allActions.filter(a => a.uri === 'homey:app:no.enua');
        let action = enuaActions.find(a => a.id === 'changeCurrentLimitAction');
        if (!action) action = enuaActions.find(a => /current|ampere|limit|strøm/i.test(a.id));
        if (!action) {
          const broader = allActions.filter(a => (a.uri || '').includes('enua'));
          action = broader.find(a => /current|ampere|limit|strøm/i.test(a.id));
        }
        if (action) {
          const result = { uri: action.uri, actionId: action.id, argsStyle: 'enuaSingle' };
          this._flowActionCache[brand] = result;
          // Log full action descriptor so we can verify the expected arg names (e.g. 'current', 'CurrentLimit', etc.)
          const argNames = Array.isArray(action.args) ? action.args.map(a => a.name || a.id || JSON.stringify(a)).join(', ') : 'n/a';
          this.log(`[Enua] Discovered flow action: ${action.uri}/${action.id} | args: [${argNames}]`);
          this.log(`[Enua] Full action descriptor: ${JSON.stringify(action)}`);
          return result;
        }
        this.log(`[Enua] No current control flow action found. Available Enua actions: ${enuaActions.map(a => a.id).join(', ') || 'none'}`);
        return null;
      }
    } catch (err) {
      this.error(`[FlowDiscover] Failed to discover ${brand} flow actions:`, err);
    }
    return null;
  }

  /**
   * Set Zaptec charger current via the Homey Flow API (runFlowCardAction).
   * Dynamically discovers the correct flow action ID from the com.zaptec app.
   * Handles pause via charging_button capability, resume via charging_button + flow.
   * @param {string} deviceId
   * @param {number|null} currentA - Target current in amps, or null to pause
   * @returns {Promise<boolean>} true if successful
   */
  // ══════════════════════════════════════════════════════════════════
  // █ SECTION 7 — EV CHARGER — ZAPTEC GO                                        █
  // ══════════════════════════════════════════════════════════════════
  //  Homey app: com.zaptec
  //  Pause:   charging_button = false
  //  Resume:  charging_button = true  (after setting current via Flow API)
  //  Current: Flow action ‘installation_current_control’
  //           args: { device, current1, current2, current3 }  (per-phase amps)
  //  Auto-redirect: If priority list has the meter/installation device instead
  //                 of the charger, _chargerDeviceRedirects auto-fixes it.
  //
  //  ⚠️ ACTIVE — Flow action arg names may differ across Zaptec firmware
  // ══════════════════════════════════════════════════════════════════

  async _setZaptecCurrent(deviceId, currentA) {
    if (!this._api) return false;

    // Resolve any device redirect (e.g. when priority list has the Zaptec meter device instead of charger)
    deviceId = (this._chargerDeviceRedirects || {})[deviceId] || deviceId;

    // Pending command guard (same 15s guard as Easee)
    const pendingTs = this._pendingChargerCommands[deviceId];
    if (pendingTs && (Date.now() - pendingTs) < 15000) {
      this.log(`[Zaptec] Skipping ${deviceId}, command still pending (${Math.round((Date.now() - pendingTs) / 1000)}s ago)`);
      return false;
    }

    // Discover the correct flow action (cached after first lookup).
    // Fall back to hardcoded known ID if enumeration returns nothing — the API
    // sometimes doesn't enumerate actions for installed apps until they've been
    // used in a Flow at least once. The action may still be callable.
    const flowAction = await this._discoverFlowAction('zaptec') ?? {
      uri: 'homey:app:com.zaptec',
      actionId: 'installation_current_control',
      argsStyle: 'zaptec3phase'
    };

    const maxRetries = 2;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const device = await withTimeout(
          this._api.devices.getDevice({ id: deviceId }),
          10000, `getDevice(${deviceId})`
        );
        if (!device) return false;

        this._pendingChargerCommands[deviceId] = Date.now();

        // Helper to call the Zaptec flow action with the discovered ID
        const callZaptecFlow = async (amps) => {
          if (!flowAction) {
            this.log(`[Zaptec] No flow action discovered, skipping current control`);
            return;
          }
          await withTimeout(
            this._api.flow.runFlowCardAction({
              uri: flowAction.uri,
              id: flowAction.actionId,
              args: { device: { id: deviceId, name: device.name }, current1: amps, current2: amps, current3: amps }
            }),
            10000, `zaptecFlow(${deviceId}, ${amps}A)`
          );
        };

        // ── Pause: set charging_button to false ──
        if (currentA === null || currentA === 0) {
          if (device.capabilities.includes('charging_button')) {
            await withTimeout(
              device.setCapabilityValue({ capabilityId: 'charging_button', value: false }),
              10000, `zaptecPause(${deviceId})`
            );
          }
          // Also set installation current to 0 via flow to prevent any residual draw
          try { await callZaptecFlow(0); } catch (flowErr) {
            this.log(`[Zaptec] Flow pause fallback failed (non-critical): ${flowErr.message}`);
          }
          this._addLog(`Zaptec paused: ${device.name}`);
          this._appLogEntry('charger', `Zaptec paused: ${device.name}`);
          if (!this._chargerState[deviceId]) this._chargerState[deviceId] = {};
          Object.assign(this._chargerState[deviceId], { lastCommandA: 0, commandTime: Date.now(), confirmed: false, timedOut: false });
          delete this._pendingChargerCommands[deviceId];
          return true;
        }

        // ── Resume from pause: turn on first, then set current ──
        const alreadyTracked = this._mitigatedDevices.find(m => m.deviceId === deviceId);
        const wasPaused = alreadyTracked && (alreadyTracked.currentTargetA === 0 || alreadyTracked.currentTargetA === null);
        if (wasPaused && device.capabilities.includes('charging_button')) {
          const btnVal = device.capabilitiesObj?.charging_button?.value;
          if (btnVal === false) {
            const resumeA = Math.max(currentA, CHARGER_DEFAULTS.startCurrent);
            // Set current via flow first, then enable charging
            await callZaptecFlow(resumeA);
            await withTimeout(
              device.setCapabilityValue({ capabilityId: 'charging_button', value: true }),
              10000, `zaptecResume(${deviceId})`
            );
            this._addLog(`Zaptec resumed: ${device.name} → ${resumeA}A`);
            this._appLogEntry('charger', `Zaptec resumed: ${device.name} → ${resumeA}A`);
            if (!this._chargerState[deviceId]) this._chargerState[deviceId] = {};
            Object.assign(this._chargerState[deviceId], { lastCommandA: resumeA, commandTime: Date.now(), confirmed: false, timedOut: false });
            delete this._pendingChargerCommands[deviceId];
            return true;
          }
        }

        // ── Normal current adjustment via Flow API ──
        const clampedA = Math.max(CHARGER_DEFAULTS.minCurrent, Math.min(40, currentA));
        await callZaptecFlow(clampedA);
        this._addLog(`Zaptec strøm: ${device.name} → ${clampedA}A`);
        this._appLogEntry('charger', `Zaptec current: ${device.name} → ${clampedA}A`);
        if (!this._chargerState[deviceId]) this._chargerState[deviceId] = {};
        Object.assign(this._chargerState[deviceId], { lastCommandA: clampedA, commandTime: Date.now(), confirmed: false, timedOut: false });
        delete this._pendingChargerCommands[deviceId];
        return true;

      } catch (err) {
        delete this._pendingChargerCommands[deviceId];
        if (attempt < maxRetries) {
          this.log(`[Zaptec] Retry ${attempt + 1}/${maxRetries} for ${deviceId}: ${err.message}`);
          await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
        this.error(`Failed to set Zaptec current for ${deviceId} after ${maxRetries + 1} attempts:`, err);
        return false;
      }
    }
    return false;
  }

  /**
   * Set Enua charger current via the Homey Flow API (runFlowCardAction).
   * Dynamically discovers the correct flow action ID from the no.enua app.
   * Handles pause via toggleChargingCapability, resume via flow + toggleChargingCapability.
   * @param {string} deviceId
   * @param {number|null} currentA - Target current in amps, or null to pause
   * @returns {Promise<boolean>} true if successful
   */
  // ══════════════════════════════════════════════════════════════════
  // █ SECTION 8 — EV CHARGER — ENUA CHARGE E                                    █
  // ══════════════════════════════════════════════════════════════════
  //  Homey app: no.enua
  //  Pause:   toggleChargingCapability = false
  //  Resume:  toggleChargingCapability = true  (after setting current via Flow API)
  //  Current: Flow action ‘changeCurrentLimitAction’
  //           args: { device, current: <amps> }  — verify arg name in full diagnostic log
  //  Status:  chargerStatusCapability — values: Charging, Connected, Paused,
  //           ScheduledCharging, WaitingForSchedule, Disconnected
  //  Min current: CHARGER_DEFAULTS.minCurrent (7A)
  //
  //  ⚠️ ACTIVE — flow action arg name (‘current’) needs runtime verification
  // ══════════════════════════════════════════════════════════════════

  async _setEnuaCurrent(deviceId, currentA) {
    if (!this._api) return false;

    const pendingTs = this._pendingChargerCommands[deviceId];
    if (pendingTs && (Date.now() - pendingTs) < 15000) {
      this.log(`[Enua] Skipping ${deviceId}, command still pending (${Math.round((Date.now() - pendingTs) / 1000)}s ago)`);
      return false;
    }

    // Discover the correct flow action (cached after first lookup).
    // Fall back to hardcoded known ID if enumeration returns nothing.
    const flowAction = await this._discoverFlowAction('enua') ?? {
      uri: 'homey:app:no.enua',
      actionId: 'changeCurrentLimitAction',
      argsStyle: 'enuaSingle'
    };

    const maxRetries = 2;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const device = await withTimeout(
          this._api.devices.getDevice({ id: deviceId }),
          10000, `getDevice(${deviceId})`
        );
        if (!device) return false;

        this._pendingChargerCommands[deviceId] = Date.now();

        // Helper to call the Enua flow action with the discovered ID
        const callEnuaFlow = async (amps) => {
          if (!flowAction) {
            this.log(`[Enua] No flow action discovered, skipping current control`);
            return;
          }
          await withTimeout(
            this._api.flow.runFlowCardAction({
              uri: flowAction.uri,
              id: flowAction.actionId,
              args: { device: { id: deviceId, name: device.name }, current: amps }
            }),
            10000, `enuaFlow(${deviceId}, ${amps}A)`
          );
        };

        // ── Pause: set toggleChargingCapability to false ──
        if (currentA === null || currentA === 0) {
          if (device.capabilities.includes('toggleChargingCapability')) {
            await withTimeout(
              device.setCapabilityValue({ capabilityId: 'toggleChargingCapability', value: false }),
              10000, `enuaPause(${deviceId})`
            );
          }
          this._addLog(`Enua paused: ${device.name}`);
          this._appLogEntry('charger', `Enua paused: ${device.name}`);
          if (!this._chargerState[deviceId]) this._chargerState[deviceId] = {};
          Object.assign(this._chargerState[deviceId], { lastCommandA: 0, commandTime: Date.now(), confirmed: false, timedOut: false });
          delete this._pendingChargerCommands[deviceId];
          return true;
        }

        // ── Resume from pause: set current via flow, then enable charging ──
        // Check if toggleChargingCapability is currently false (charger was paused)
        const chargingCapVal = device.capabilitiesObj?.toggleChargingCapability?.value;
        const chargerStatus = device.capabilitiesObj?.chargerStatusCapability?.value;
        const enuaIsPaused = chargingCapVal === false
          || chargerStatus === 'Paused' || chargerStatus === 'paused';
        if (enuaIsPaused && device.capabilities.includes('toggleChargingCapability')) {
          const resumeA = Math.max(currentA, CHARGER_DEFAULTS.startCurrent);
          const clampedA = Math.max(CHARGER_DEFAULTS.minCurrent, Math.min(32, resumeA));
          // Set current limit via flow first
          await callEnuaFlow(clampedA);
          // Then enable charging
          await withTimeout(
            device.setCapabilityValue({ capabilityId: 'toggleChargingCapability', value: true }),
            10000, `enuaResume(${deviceId})`
          );
          this._addLog(`Enua resumed: ${device.name} → ${clampedA}A`);
          this._appLogEntry('charger', `Enua resumed: ${device.name} → ${clampedA}A (status was: ${chargerStatus})`);
          if (!this._chargerState[deviceId]) this._chargerState[deviceId] = {};
          Object.assign(this._chargerState[deviceId], { lastCommandA: clampedA, commandTime: Date.now(), confirmed: false, timedOut: false });
          delete this._pendingChargerCommands[deviceId];
          return true;
        }

        // ── Normal current adjustment via Flow API ──
        const clampedA = Math.max(CHARGER_DEFAULTS.minCurrent, Math.min(32, currentA));
        await callEnuaFlow(clampedA);
        this._addLog(`Enua strøm: ${device.name} → ${clampedA}A`);
        this._appLogEntry('charger', `Enua current: ${device.name} → ${clampedA}A (status: ${chargerStatus})`);
        if (!this._chargerState[deviceId]) this._chargerState[deviceId] = {};
        Object.assign(this._chargerState[deviceId], { lastCommandA: clampedA, commandTime: Date.now(), confirmed: false, timedOut: false });
        delete this._pendingChargerCommands[deviceId];
        return true;

      } catch (err) {
        delete this._pendingChargerCommands[deviceId];
        if (attempt < maxRetries) {
          this.log(`[Enua] Retry ${attempt + 1}/${maxRetries} for ${deviceId}: ${err.message}`);
          await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
        this.error(`Failed to set Enua current for ${deviceId} after ${maxRetries + 1} attempts:`, err);
        return false;
      }
    }
    return false;
  }

  /**
   * Set Easee charger current using the HomeyAPI.
   * Also controls target_circuit_current for better Easee integration.
   * Records commands for confirmation tracking and reliability scoring.
   * Routes to brand-specific handlers for Zaptec (Flow API) and Enua (Flow API).
   * @param {string} deviceId - Device ID
   * @param {number} currentA - Target current in amps (or null to pause)
   * @param {number} circuitLimitA - Circuit breaker limit in amps (default 32)
   * @returns {Promise<boolean>} true if set successfully
   */
  // ══════════════════════════════════════════════════════════════════
  // █ SECTION 9 — EV CHARGER — EASEE                                            █
  // ══════════════════════════════════════════════════════════════════
  //  Homey app: no.easee
  //  Pause:   dynamic_charger_current / dynamicChargerCurrent = 0
  //  Current: setCapabilityValue on dynamic_charger_current or dynamicChargerCurrent
  //           + target_circuit_current if available
  //  Circuit limit: applyCircuitLimitsToChargers writes to target_charger_current (Ladegrense)
  //                 — this is the permanent max, not the dynamic limit
  //
  //  ✅ WORKING — Reasonably stable, test before changing
  // ══════════════════════════════════════════════════════════════════

  async _setEaseeChargerCurrent(deviceId, currentA, circuitLimitA = 32) {
    if (!this._api) return false;

    // Route to brand-specific handler for non-Easee chargers
    const brand = this._getChargerBrand(deviceId);
    if (brand === 'zaptec') return this._setZaptecCurrent(deviceId, currentA);
    if (brand === 'enua') return this._setEnuaCurrent(deviceId, currentA);

    // Skip if charger has no car connected
    if (!this._isCarConnected(deviceId)) return false;

    // Item 4: Don't send new commands while a previous command is still pending
    const pendingTs = this._pendingChargerCommands[deviceId];
    if (pendingTs && (Date.now() - pendingTs) < 15000) {
      this.log(`[Easee] Skipping ${deviceId}, command still pending (${Math.round((Date.now() - pendingTs) / 1000)}s ago)`);
      return false;
    }

    const maxRetries = 2;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const device = await withTimeout(
          this._api.devices.getDevice({ id: deviceId }),
          10000, `getDevice(${deviceId})`
        );
        if (!device) return false;

        // Mark command as pending
        this._pendingChargerCommands[deviceId] = Date.now();

        // If currentA is null, pause by turning off
        if (currentA === null) {
          if (device.capabilities.includes('onoff')) {
            // Set circuit current to 0 when pausing (prevents any current flow)
            if ((device.capabilities || []).includes('target_circuit_current')) {
              await withTimeout(
                device.setCapabilityValue({ capabilityId: 'target_circuit_current', value: 0 }),
                10000, `setCircuitCurrentPause(${deviceId})`
              ).catch(e => this.log(`[Easee] target_circuit_current pause failed: ${e.message}`));
            }
            await withTimeout(
              device.setCapabilityValue({ capabilityId: 'onoff', value: false }),
              10000, `setOnOff(${deviceId})`
            );
            this._addLog(`Easee paused: ${device.name}`);
            this._appLogEntry('charger', `Easee paused: ${device.name}`);
            // Record command for confirmation tracking
            if (!this._chargerState[deviceId]) this._chargerState[deviceId] = {};
            Object.assign(this._chargerState[deviceId], { lastCommandA: 0, commandTime: Date.now(), confirmed: false, timedOut: false });
            delete this._pendingChargerCommands[deviceId];
            return true;
          }
          delete this._pendingChargerCommands[deviceId];
          return false;
        }

        // Item 2: When resuming from pause, turn on first then set startCurrent
        const alreadyTracked = this._mitigatedDevices.find(m => m.deviceId === deviceId);
        const wasPaused = alreadyTracked && (alreadyTracked.currentTargetA === 0 || alreadyTracked.currentTargetA === null);
        if (wasPaused && device.capabilities.includes('onoff')) {
          const isOff = device.capabilitiesObj?.onoff?.value === false;
          if (isOff) {
            // Use startCurrent (11A) for reliable resume — ensures charger starts properly
            const resumeCurrent = Math.max(currentA, CHARGER_DEFAULTS.startCurrent);

            const dynCap = ['dynamic_charger_current', 'dynamicChargerCurrent', 'dynamicCircuitCurrentP1', 'target_charger_current']
              .find(cap => (device.capabilities || []).includes(cap));
            if (dynCap) {
              await withTimeout(
                device.setCapabilityValue({ capabilityId: dynCap, value: resumeCurrent }),
                10000, `setStartCurrent(${deviceId})`
              );
            }
            // Set circuit current to max to avoid it being a bottleneck
            if ((device.capabilities || []).includes('target_circuit_current')) {
              await withTimeout(
                device.setCapabilityValue({ capabilityId: 'target_circuit_current', value: circuitLimitA }),
                10000, `setCircuitCurrentResume(${deviceId})`
              ).catch(e => this.log(`[Easee] target_circuit_current resume failed: ${e.message}`));
            }
            await withTimeout(
              device.setCapabilityValue({ capabilityId: 'onoff', value: true }),
              10000, `resumeCharger(${deviceId})`
            );
            this._addLog(`Easee resumed: ${device.name} → ${resumeCurrent}A (startCurrent=${CHARGER_DEFAULTS.startCurrent}A)`);
            this._appLogEntry('charger', `Easee resumed: ${device.name} → ${resumeCurrent}A`);
            // Record command for confirmation tracking
            if (!this._chargerState[deviceId]) this._chargerState[deviceId] = {};
            Object.assign(this._chargerState[deviceId], { lastCommandA: resumeCurrent, commandTime: Date.now(), confirmed: false, timedOut: false });
            delete this._pendingChargerCommands[deviceId];
            return true;
          }
        }

        // Normal current adjustment — Homey capability
        const dynCap = ['dynamic_charger_current', 'dynamicChargerCurrent', 'dynamicCircuitCurrentP1', 'target_charger_current']
          .find(cap => (device.capabilities || []).includes(cap));

        if (dynCap) {
          await withTimeout(
            device.setCapabilityValue({ capabilityId: dynCap, value: currentA }),
            10000, `setCurrent(${deviceId})`
          );
          // Also set target_circuit_current to circuitLimitA so it doesn't bottleneck
          if ((device.capabilities || []).includes('target_circuit_current')) {
            await withTimeout(
              device.setCapabilityValue({ capabilityId: 'target_circuit_current', value: circuitLimitA }),
              10000, `setCircuitCurrent(${deviceId})`
            ).catch(e => this.log(`[Easee] target_circuit_current failed: ${e.message}`));
          }
          this._addLog(`Easee ${dynCap === 'target_charger_current' ? 'Ladegrense' : 'Midlertidig'}: ${device.name} → ${currentA}A`);
          this._appLogEntry('charger', `Easee current: ${device.name} → ${currentA}A (${dynCap})`);
          // Record command for confirmation tracking
          if (!this._chargerState[deviceId]) this._chargerState[deviceId] = {};
          Object.assign(this._chargerState[deviceId], { lastCommandA: currentA, commandTime: Date.now(), confirmed: false, timedOut: false });
          delete this._pendingChargerCommands[deviceId];
          return true;
        }

        this.log(`[Easee] Device ${deviceId} doesn't expose dynamic current capability, available: ${(device.capabilities || []).join(', ')}`);
        delete this._pendingChargerCommands[deviceId];
        return false;

      } catch (err) {
        delete this._pendingChargerCommands[deviceId];
        if (attempt < maxRetries) {
          this.log(`[Easee] Retry ${attempt + 1}/${maxRetries} for ${deviceId}: ${err.message}`);
          await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));  // Back-off: 1s, 2s
          continue;
        }
        this.error(`Failed to set Easee current for ${deviceId} after ${maxRetries + 1} attempts:`, err);
        return false;
      }
    }
    return false;
  }

  /**
   * Mitigate by adjusting Easee chargers specifically.
   */
  async _mitigateEaseeChargers() {
    const easeeEntries = (this._settings.priorityList || []).filter(e =>
      e.enabled !== false && e.action === 'dynamic_current'
    );

    if (!easeeEntries.length) return;

    const limit = this._getEffectiveLimit();
    const currentPower = movingAverage(this._powerBuffer, this._settings.smoothingWindow);
    const totalOverload = Math.max(0, currentPower - limit);

    for (const entry of easeeEntries) {
      // Skip chargers with no car connected
      if (!this._isCarConnected(entry.deviceId)) continue;

      const targetCurrent = this._calculateOptimalChargerCurrent(totalOverload, entry);
      const success = await this._setEaseeChargerCurrent(entry.deviceId, targetCurrent, entry.circuitLimitA || 32).catch(() => false);

      if (success) {
        // Track in mitigatedDevices so the UI shows it as "controlled"
        const alreadyTracked = this._mitigatedDevices.some(m => m.deviceId === entry.deviceId);
        if (targetCurrent !== null && targetCurrent < (entry.circuitLimitA || 32)) {
          // Charger is being limited
          if (!alreadyTracked) {
            this._mitigatedDevices.push({
              deviceId: entry.deviceId,
              action: 'dynamic_current',
              previousState: { targetCurrent: entry.circuitLimitA || 32 },
              mitigatedAt: Date.now(),
              currentTargetA: targetCurrent
            });
            this._fireTrigger('mitigation_applied', { device_name: entry.name, action: 'dynamic_current' });
            await this._updateVirtualDevice({ alarm: true }).catch(() => {});
          } else {
            // Update the tracked current
            const tracked = this._mitigatedDevices.find(m => m.deviceId === entry.deviceId);
            if (tracked) tracked.currentTargetA = targetCurrent;
          }
          this._persistMitigatedDevices();
          this._lastMitigationTime = Date.now();
        } else if (targetCurrent === null) {
          // Charger paused
          if (!alreadyTracked) {
            this._mitigatedDevices.push({
              deviceId: entry.deviceId,
              action: 'dynamic_current',
              previousState: { targetCurrent: entry.circuitLimitA || 32 },
              mitigatedAt: Date.now(),
              currentTargetA: 0
            });
            this._fireTrigger('mitigation_applied', { device_name: entry.name, action: 'dynamic_current' });
            await this._updateVirtualDevice({ alarm: true }).catch(() => {});
          }
          this._persistMitigatedDevices();
          this._lastMitigationTime = Date.now();
        } else if (alreadyTracked) {
          // Charger restored to full — remove from mitigated
          this._mitigatedDevices = this._mitigatedDevices.filter(m => m.deviceId !== entry.deviceId);
          this._addLog(`Charger restored: ${entry.name} → ${targetCurrent}A`);
          this._persistMitigatedDevices();
          this._fireTrigger('mitigation_cleared', { device_name: entry.name });
          if (this._mitigatedDevices.length === 0) {
            await this._updateVirtualDevice({ alarm: false }).catch(() => {});
          }
        }
      }
    }
  }



  // ══════════════════════════════════════════════════════════════════
  // █ SECTION 10 — DIAGNOSTICS & SETTINGS PAGE API                              █
  // ══════════════════════════════════════════════════════════════════
  //  Included: getDiagnosticInfo, debug log, getDevicesForSettings,
  //            getStatus, getAppLog, getPowerConsumption,
  //            testEaseeCharger (charger diagnostics UI),
  //            _updatePowerConsumption, onUninit
  //
  //  ✅ STABLE — Exposed via api.js to the settings UI
  // ══════════════════════════════════════════════════════════════════

  getDiagnosticInfo() {
    const hasApi = !!this._api;
    const cache  = this.homey.settings.get('_deviceCache') || [];
    const smoothed = movingAverage(this._powerBuffer, this._settings.smoothingWindow);
    const limit = this._getEffectiveLimit();
    return {
      hasApi,
      cacheCount: cache.length,
      enabled: this._settings.enabled,
      currentPowerW: Math.round(smoothed),
      limitW: limit,
      overLimitCount: this._overLimitCount,
      hysteresisCount: this._settings.hysteresisCount,
      mitigatedDevices: this._mitigatedDevices.map(m => ({
        deviceId: m.deviceId, action: m.action, currentTargetA: m.currentTargetA
      })),
      powerBufferLen: this._powerBuffer.length,
      hanConnected: !!this._hanDeviceId,
      lastHanReading: this._lastHanReading ? new Date(this._lastHanReading).toISOString() : null,
      cooldownSeconds: this._settings.cooldownSeconds,
      lastMitigationTime: this._lastMitigationTime ? new Date(this._lastMitigationTime).toISOString() : null,
      easeeChargers: (this._settings.priorityList || []).filter(e => e.action === 'dynamic_current').map(e => ({
        name: e.name, deviceId: e.deviceId, circuitLimitA: e.circuitLimitA, enabled: e.enabled !== false,
        brand: this._getChargerBrand(e.deviceId)
      })),
      recentLog: this._mitigationLog.slice(-5),
    };
  }

  // ─── Debug Logging ───────────────────────────────────────────────────────
  _writeDebugLog(message) {
    try {
      const timestamp = new Date().toISOString();
      const line = `[${timestamp}] ${message}`;
      this._powerConsumptionLog.push(line);
      
      // Keep last 500 lines to avoid memory issues
      if (this._powerConsumptionLog.length > 500) {
        this._powerConsumptionLog.shift();
      }
    } catch (err) {
      // Silently fail
    }
  }

  getDevicesForSettings() {
    // Return the startup cache populated by _cacheDevices() during onInit.
    // Calling _api.devices.getDevices() here hangs when invoked from an API
    // endpoint because the HomeyAPI HTTP client doesn't resolve in time.
    // The cache is refreshed every minute by the watchdog.
    const list = this.homey.settings.get('_deviceCache') || [];
    this.log('[devices] serving from cache, count:', list.length);
    return list;
  }

  // ══════════════════════════════════════════════════════════════════
  // █ SECTION 11 — HEATERS — FLOOR / THERMOSTAT (Adax, generic)                 █
  // ══════════════════════════════════════════════════════════════════
  //  Included: checkFloorHeaterConnections (connection probe + zone grouping),
  //            controlFloorHeater (manual on/off/temp from settings UI)
  //  Action used by mitigation engine: ‘target_temperature’ (via devices.js)
  //  Brands: Adax Wi-Fi (no.adax), generic Homey thermostats (any target_temperature)
  //
  //  ✅ WORKING — Stable, tested
  //
  //  NOTE: Water heater (Høiax) uses action ‘hoiax_power’ handled entirely
  //        in common/devices.js — no separate section needed in app.js
  //        Høiax brand: no.hoiax | caps: max_power_3000 or max_power
  // ══════════════════════════════════════════════════════════════════

  async checkFloorHeaterConnections() {
    // Scan all devices and identify floor heaters with control capabilities
    const allDevices = this.homey.settings.get('_deviceCache') || [];
    const floorHeaters = [];
    
    this.log(`[FloorHeater] ==== START FLOOR HEATER CHECK ====`);
    this.log(`[FloorHeater] Total devices in cache: ${allDevices.length}`);
    this.log(`[FloorHeater] HomeyAPI available: ${!!this._api}`);
    
    for (const cached of allDevices) {
      if (!cached) continue;
      
      const name = (cached.name || '').toLowerCase();
      const cls = (cached.class || '').toLowerCase();
      
      // Identify thermostats / heaters (works for all brands: Futurehome, Z-Wave, Zigbee, etc.)
      const isFloorHeater = cls === 'thermostat' || 
                            cls === 'heater' ||
                            name.includes('floor') || 
                            name.includes('varme') || 
                            name.includes('heating') ||
                            name.includes('gulv') ||
                            name.includes('termostat') ||
                            name.includes('thermostat');
      
      if (!isFloorHeater) continue;
      
      this.log(`[FloorHeater] Processing: "${cached.name}" (class: ${cls})`);
      
      // Get LIVE device from HomeyAPI for real-time data and control
      let liveDevice = null;
      let caps = [];
      try {
        if (this._api) {
          liveDevice = await this._api.devices.getDevice({ id: cached.id });
          if (liveDevice && liveDevice.capabilitiesObj) {
            caps = Object.keys(liveDevice.capabilitiesObj);
            this.log(`[FloorHeater]   Live caps: ${caps.join(', ')}`);
            // Log all capability values
            caps.forEach(cap => {
              const obj = liveDevice.capabilitiesObj[cap];
              const val = obj && obj.value !== undefined ? obj.value : 'N/A';
              this.log(`[FloorHeater]     ${cap} = ${val}`);
            });
          }
        }
      } catch (err) {
        this.log(`[FloorHeater]   Live device error: ${err.message}`);
      }
      
      // Fallback to cached caps if live device not available
      if (caps.length === 0) {
        if (cached.capabilitiesObj) {
          caps = Object.keys(cached.capabilitiesObj);
        } else if (Array.isArray(cached.capabilities)) {
          caps = cached.capabilities;
        }
        this.log(`[FloorHeater]   Cached caps: ${caps.join(', ')}`);
      }
      
      // Check for target temperature capability (various names used by different brands)
      let targetTempCap = null;
      for (const candidate of ['target_temperature', 'set_temperature', 'setpoint_temperature', 'heating_setpoint', 'desired_temperature']) {
        if (caps.includes(candidate)) { targetTempCap = candidate; break; }
      }
      
      // Check for measure temperature capability
      let measureTempCap = null;
      for (const candidate of ['measure_temperature', 'temperature', 'current_temperature']) {
        if (caps.includes(candidate)) { measureTempCap = candidate; break; }
      }
      
      const hasOnOff = caps.includes('onoff');
      const hasPower = caps.includes('measure_power');
      const hasThermostatMode = caps.includes('thermostat_mode');
      const canControl = targetTempCap !== null || hasOnOff;
      
      this.log(`[FloorHeater]   targetTempCap: ${targetTempCap || 'NONE'} | measureTempCap: ${measureTempCap || 'NONE'} | onoff: ${hasOnOff}`);
      
      // Read current values from LIVE device (preferred) or cache
      // The liveDevice from HomeyAPI getDevice() has fresh capabilitiesObj values
      let currentTarget = null;
      let currentMeasure = null;
      let currentPowerW = null;
      let isOn = null;
      let thermostatMode = null;
      
      try {
        const source = liveDevice || cached;
        if (source && source.capabilitiesObj) {
          if (targetTempCap && source.capabilitiesObj[targetTempCap]) {
            const v = source.capabilitiesObj[targetTempCap];
            currentTarget = v.value !== undefined ? v.value : v;
          }
          if (measureTempCap && source.capabilitiesObj[measureTempCap]) {
            const v = source.capabilitiesObj[measureTempCap];
            currentMeasure = v.value !== undefined ? v.value : v;
          }
          if (hasPower && source.capabilitiesObj.measure_power) {
            const v = source.capabilitiesObj.measure_power;
            currentPowerW = v.value !== undefined ? v.value : v;
          }
          if (hasOnOff && source.capabilitiesObj.onoff) {
            const v = source.capabilitiesObj.onoff;
            isOn = v.value !== undefined ? v.value : v;
          }
          if (hasThermostatMode && source.capabilitiesObj.thermostat_mode) {
            const v = source.capabilitiesObj.thermostat_mode;
            thermostatMode = v.value !== undefined ? v.value : v;
          }
          this.log(`[FloorHeater]   Values from ${liveDevice ? 'LIVE' : 'CACHED'} device`);
        }
      } catch (err) {
        this.log(`[FloorHeater]   Value read error: ${err.message}`);
      }
      
      this.log(`[FloorHeater]   FINAL -> Target: ${currentTarget}°C | Measure: ${currentMeasure}°C | Power: ${currentPowerW}W | On: ${isOn}`);

      // ── Heater power estimation workaround ──
      // Some heater apps (e.g. Adax) report constant rated wattage even when
      // the heating element is off (thermostat satisfied). For any heater/thermostat
      // with both measure_temperature and target_temperature, estimate actual power:
      // if the room is at or above target, the element is almost certainly idle.
      if (currentMeasure != null && currentTarget != null && currentPowerW != null && currentPowerW > 0) {
        if (isOn === false) {
          this.log(`[FloorHeater]   Power override: ${currentPowerW}W → 0W (heater is OFF)`);
          currentPowerW = 0;
        } else if (currentMeasure >= currentTarget) {
          this.log(`[FloorHeater]   Power override: ${currentPowerW}W → 0W (room ${currentMeasure}°C >= target ${currentTarget}°C)`);
          currentPowerW = 0;  // Room at target → element idle
        }
      }
      
      // Get zone name - try live device first, then cached
      let zoneName = '';
      if (liveDevice && liveDevice.zoneName) {
        zoneName = liveDevice.zoneName;
      } else if (liveDevice && liveDevice.zone && typeof liveDevice.zone === 'object' && liveDevice.zone.name) {
        zoneName = liveDevice.zone.name;
      } else if (cached.zoneName) {
        zoneName = cached.zoneName;
      } else if (cached.zone && typeof cached.zone === 'object' && cached.zone.name) {
        zoneName = cached.zone.name;
      }
      
      // If no zone, use driver/brand name instead of "Unknown"
      if (!zoneName) {
        const driverStr = (liveDevice && liveDevice.driverUri) || cached.driverId || '';
        zoneName = driverStr.replace(/^homey:app:/, '').replace(/[:.]/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim() || '';
      }

      floorHeaters.push({
        deviceId: cached.id,
        name: cached.name,
        class: cached.class,
        zone: zoneName,
        hasTargetTemp: !!targetTempCap,
        hasMeasureTemp: !!measureTempCap,
        hasMeasurePower: hasPower,
        hasOnOff: hasOnOff,
        canControl: canControl,
        targetTempCapability: targetTempCap,
        measureTempCapability: measureTempCap,
        currentTarget: currentTarget,
        currentMeasure: currentMeasure,
        currentPowerW: currentPowerW,
        isOn: isOn,
        thermostatMode: thermostatMode || null,
        capabilities: caps,
        timestamp: new Date().toISOString()
      });
    }
    
    this.log(`[FloorHeater] ==== RESULT: ${floorHeaters.length} floor heaters ====`);
    floorHeaters.forEach(h => {
      this.log(`[FloorHeater]  > ${h.name} | Target: ${h.currentTarget}°C | Measure: ${h.currentMeasure}°C | Control: ${h.canControl} | Caps: ${h.capabilities.join(', ')}`);
    });
    
    return floorHeaters;
  }

  async controlFloorHeater(deviceId, action, value) {
    // Control a floor heater using live HomeyAPI device (not cached data!)
    try {
      if (!this._api) {
        this.log(`[FloorHeater] Control failed: HomeyAPI not available`);
        return { ok: false, error: 'HomeyAPI not available' };
      }
      
      // Get the LIVE device object from the API (has setCapabilityValue method)
      const device = await this._api.devices.getDevice({ id: deviceId });
      
      if (!device) {
        this.log(`[FloorHeater] Device not found via API: ${deviceId}`);
        return { ok: false, error: 'Device not found' };
      }
      
      // Use capabilities array (most reliable) and capabilitiesObj for values
      const caps = device.capabilities || [];
      const obj  = device.capabilitiesObj || {};
      this.log(`[FloorHeater] Control: ${action} on "${device.name}" (value: ${value})`);
      this.log(`[FloorHeater]   Available caps: ${caps.join(', ')}`);
      
      // Find correct target temperature capability
      let targetTempCap = null;
      for (const candidate of ['target_temperature', 'set_temperature', 'setpoint_temperature', 'heating_setpoint', 'desired_temperature']) {
        if (caps.includes(candidate)) { targetTempCap = candidate; break; }
      }
      
      if (action === 'on') {
        if (!caps.includes('onoff')) {
          return { ok: false, error: `${device.name} has no on/off capability` };
        }
        await device.setCapabilityValue({ capabilityId: 'onoff', value: true });
        this.log(`[FloorHeater] ${device.name} turned ON`);
        return { ok: true, message: `${device.name} turned on` };
        
      } else if (action === 'off') {
        if (!caps.includes('onoff')) {
          return { ok: false, error: `${device.name} has no on/off capability` };
        }
        await device.setCapabilityValue({ capabilityId: 'onoff', value: false });
        this.log(`[FloorHeater] ${device.name} turned OFF`);
        return { ok: true, message: `${device.name} turned off` };
        
      } else if (action === 'setTarget') {
        const temp = parseFloat(value);
        if (isNaN(temp)) {
          return { ok: false, error: 'Invalid temperature value' };
        }
        if (!targetTempCap) {
          this.log(`[FloorHeater] No target temp cap found. Available: ${caps.join(', ')}`);
          return { ok: false, error: `${device.name} has no temperature control capability` };
        }
        // Switch to manual/heat mode first so thermostats with a cloud schedule
        // (e.g. FutureHome) don't revert the temperature change immediately.
        if (caps.includes('thermostat_mode')) {
          const currentMode = obj.thermostat_mode ? obj.thermostat_mode.value : null;
          if (currentMode !== 'heat') {
            this.log(`[FloorHeater] ${device.name} switching thermostat_mode → heat (was: ${currentMode})`);
            await device.setCapabilityValue({ capabilityId: 'thermostat_mode', value: 'heat' });
          }
        }
        await device.setCapabilityValue({ capabilityId: targetTempCap, value: temp });
        this.log(`[FloorHeater] ${device.name} set to ${temp}°C via ${targetTempCap}`);
        return { ok: true, message: `${device.name} set to ${temp}°C` };
        
      } else {
        return { ok: false, error: `Unknown action: ${action}` };
      }
    } catch (err) {
      this.log(`[FloorHeater] Control error: ${err.message}`);
      return { ok: false, error: err.message };
    }
  }

  // ─── Public API (settings UI) ─────────────────────────────────────────────

  _updatePowerConsumption(currentTotalW) {
    // Update power consumption tracking for all devices with measure_power
    try {
      let allDevices = [];
      
      // Method 1: Try to use already-cached devices from _cacheDevices
      if (this._deviceCacheReady && Array.isArray(this._cachedDevices)) {
        this._writeDebugLog(`Using cached devices: ${this._cachedDevices.length} devices`);
        allDevices = this._cachedDevices;
      }
      // Method 2: Try to use the saved device cache from settings
      else if (!allDevices.length) {
        const savedCache = this.homey.settings.get('_deviceCache') || [];
        if (Array.isArray(savedCache) && savedCache.length > 0) {
          this._writeDebugLog(`Using saved device cache: ${savedCache.length} devices`);
          allDevices = savedCache;
        }
      }
      
      // Method 3: Fall back to HomeyAPI (only if API is ready and has devices)
      if (!allDevices.length && this._api && this._api.devices) {
        try {
          const apiDevices = this._api.devices.getDevices();
          if (apiDevices && typeof apiDevices === 'object') {
            allDevices = Object.values(apiDevices);
            this._writeDebugLog(`HomeyAPI returned ${allDevices.length} devices`);
          }
        } catch (err) {
          this._writeDebugLog(`HomeyAPI error: ${err.message}`);
        }
      }
      
      if (!allDevices.length) {
        this._writeDebugLog('WARNING: No device sources available yet');
        return;
      }
      
      const beforeCount = Object.keys(this._powerConsumptionData).length;
      let updateCount = 0;
      
      allDevices.forEach(device => {
        if (!device) return;
        
        const deviceName = (device.name || '').toLowerCase();
        const deviceClass = (device.class || '').toLowerCase();
        const deviceDriver = (device.driverId || '').toLowerCase();
        
        // Skip Power Guard itself
        if (deviceDriver === 'power-guard' || deviceName.includes('power guard')) return;
        
        // Skip meters and HAN devices
        if (deviceClass === 'meter' || deviceName.includes('han') || deviceDriver.includes('meter')) return;
        
        // Get capabilities
        let caps = [];
        if (Array.isArray(device.capabilities)) {
          caps = device.capabilities;
        }
        if (!caps.includes('measure_power')) return;
        
        // Skip sockets that are lights (e.g., smart plugs with lights), but allow water heaters and other sockets
        if (deviceClass === 'socket' && (deviceName.includes('light') || deviceName.includes('lamp'))) {
          return;
        }
        
        updateCount++;
        const devId = device.id;
        
        // Get power value
        let currentW = 0;
        if (device.capabilitiesObj?.measure_power?.value) {
          currentW = device.capabilitiesObj.measure_power.value;
        } else if (typeof device.getCapabilityValue === 'function') {
          try {
            currentW = device.getCapabilityValue('measure_power') || 0;
          } catch (_) {}
        }

        // ── Heater power estimation workaround ──
        // Smart heaters (e.g. Adax) are always onoff=true in Homey but their
        // heating element cycles at hardware level. We estimate actual draw
        // based on how close the room is to setpoint:
        //   ≥ target+0.0: element off/idle        → 0W
        //   target-0.5 to target: near setpoint, light cycling  → 20% rated
        //   target-2.0 to target-0.5: moderate cycling           → 50% rated
        //   < target-2.0: actively heating                       → 100% rated
        const devCls = (device.class || '').toLowerCase();
        if ((devCls === 'thermostat' || devCls === 'heater') && currentW > 0) {
          // If this device has already been mitigated, show 0W immediately
          // (command was sent; heater will respond within ~20 min for cloud devices)
          const isMitigated = (this._mitigatedDevices || []).some(m => m.deviceId === devId);
          if (isMitigated) {
            currentW = 0;
          } else {
            const obj = device.capabilitiesObj || {};
            const measT = obj.measure_temperature ? obj.measure_temperature.value : null;
            const targT = obj.target_temperature ? obj.target_temperature.value : null;
            const onoff = obj.onoff ? obj.onoff.value : null;
            if (onoff === false) {
              currentW = 0;
            } else if (measT != null && targT != null) {
              const diff = targT - measT; // positive = room colder than target
              if (diff <= 0) {
                currentW = 0;           // at or above target — element fully idle
              } else if (diff < 0.5) {
                currentW = Math.round(currentW * 0.20); // near setpoint, light cycling
              } else if (diff < 2.0) {
                currentW = Math.round(currentW * 0.50); // moderate cycling
              }
              // else diff >= 2.0 → keep rated 100% (actively heating)
            }
          }
        }
        
        if (!this._powerConsumptionData[devId]) {
          this._powerConsumptionData[devId] = {
            deviceId: devId,
            name: device.name || 'Unknown',
            class: device.class || '',
            readings: [],
            current: currentW,
            avg: currentW,
            peak: currentW,
          };
          this._writeDebugLog(`NEW DEVICE: "${device.name}" (${device.class}) power=${currentW}W`);
        }
        
        const data = this._powerConsumptionData[devId];
        data.current = currentW;
        data.readings.push(currentW);
        if (data.readings.length > 60) data.readings.shift();
        
        if (data.readings.length > 0) {
          data.avg = Math.round(data.readings.reduce((a, b) => a + b, 0) / data.readings.length);
          data.peak = Math.max(...data.readings);
        }
      });
      
      const afterCount = Object.keys(this._powerConsumptionData).length;
      if (updateCount > 0 && afterCount > beforeCount) {
        this._writeDebugLog(`STATUS: Found ${updateCount} devices with measure_power, tracking ${afterCount} total`);
      }
    } catch (err) {
      this._writeDebugLog(`ERROR scanning devices: ${err.message}`);
    }
  }

  getPowerConsumption() {
    // Return ALL devices with measure_power capability, sorted by current power
    
    // If we have no devices yet, try to scan now (don't await, just trigger)
    if (Object.keys(this._powerConsumptionData).length === 0) {
      this._updatePowerConsumption(0);
    }
    
    const tracked = Object.values(this._powerConsumptionData || {});
    
    const msg = `GET request - ${tracked.length} tracked devices`;
    this.log(`[Power Consumption] ${msg}`);
    this._writeDebugLog(msg);
    
    // Log all tracked devices
    if (tracked.length > 0) {
      const devList = tracked.map(d => `"${d.name}"(${d.class})=${d.current}W`).join(' | ');
      this._writeDebugLog(`Devices: ${devList}`);
    } else {
      this._writeDebugLog('No devices tracked');
    }
    
    // Return all devices sorted by current power (highest first)
    const sorted = tracked.sort((a, b) => b.current - a.current);
    
    // Calculate total power and add percentage to each device
    const totalW = sorted.reduce((sum, d) => sum + d.current, 0);
    const withPercent = sorted.map(d => ({
      deviceId: d.deviceId,
      name: d.name,
      class: d.class,
      current: Math.round(d.current),
      avg: Math.round(d.avg),
      peak: Math.round(d.peak),
      percent: totalW > 0 ? Math.round((d.current / totalW) * 100) : 0,
    }));
    
    return {
      timestamp: Date.now(),
      totalW: Math.round(totalW),
      deviceCount: withPercent.length,
      devices: withPercent,
    };
  }

  async getDebugLog() {
    try {
      const log = this._powerConsumptionLog.join('\n');
      return {
        ok: true,
        log: log || '[No log entries yet]',
        lines: this._powerConsumptionLog.length,
        hasDevices: Object.keys(this._powerConsumptionData).length > 0,
        deviceCount: Object.keys(this._powerConsumptionData).length,
      };
    } catch (err) {
      return {
        ok: false,
        error: err.message,
        log: '[Error reading log]',
      };
    }
  }

  getStatus() {
    // Build per-charger status: idle / charging / dynamic / paused
    const evChargerStatus = (this._settings.priorityList || [])
      .filter(e => e.action === 'dynamic_current' && e.enabled !== false)
      .map(entry => {
        const evData = this._evPowerData[entry.deviceId] || {};
        const mitigated = this._mitigatedDevices.find(m => m.deviceId === entry.deviceId);
        let status = 'idle';
        let statusLabel = 'Idle';
        let currentA = 0;

        // Use centralized whitelist check
        const isConnected = this._isCarConnected(entry.deviceId);
        const chargerStatus = evData.chargerStatus;

        if (!isConnected) {
          status = 'idle';
          statusLabel = 'No car connected';
          currentA = 0;
        } else if (mitigated) {
          // Power Guard is controlling this charger
          if (mitigated.currentTargetA === 0 || mitigated.currentTargetA === null) {
            status = 'paused';
            statusLabel = 'Paused by Power Guard';
            currentA = 0;
          } else {
            status = 'dynamic';
            statusLabel = 'Dynamic (' + mitigated.currentTargetA + 'A)';
            currentA = mitigated.currentTargetA;
          }
        } else if (evData.powerW > 100) {
          // Drawing meaningful power = actually charging
          status = 'charging';
          const offeredA = evData.offeredCurrent || (entry.circuitLimitA || 32);
          statusLabel = 'Charging (' + Math.round(offeredA) + 'A)';
          currentA = offeredA;
        } else if (isConnected && (chargerStatus === 2 || chargerStatus === 'awaiting_start' || chargerStatus === 'AWAITING_START')) {
          status = 'waiting';
          statusLabel = 'Waiting to start';
          currentA = 0;
        } else if (isConnected && (chargerStatus === 4 || chargerStatus === 'completed' || chargerStatus === 'COMPLETED')) {
          status = 'completed';
          statusLabel = 'Completed';
          currentA = 0;
        } else if (isConnected) {
          // Connected but not drawing power — could be full, or scheduled
          status = 'connected';
          statusLabel = 'Connected';
          currentA = 0;
        } else {
          // Unknown state
          status = 'idle';
          statusLabel = 'Idle';
          currentA = 0;
        }

        return {
          deviceId: entry.deviceId,
          name: entry.name || evData.name || 'Charger',
          powerW: evData.powerW || 0,
          isCharging: status === 'charging' || status === 'dynamic',
          status: status,
          statusLabel: statusLabel,
          currentA: currentA,
          circuitLimitA: entry.circuitLimitA || 32,
          chargerStatus: chargerStatus,
          // Confirmation tracking & reliability
          confirmed: (this._chargerState[entry.deviceId] || {}).confirmed || false,
          reliability: Math.round(((this._chargerState[entry.deviceId] || {}).reliability ?? 0.5) * 100),
          offeredCurrent: evData.offeredCurrent || null,
        };
      });

    return {
      enabled:          this._settings.enabled,
      profile:          this._settings.profile,
      currentPowerW:    movingAverage(this._powerBuffer, this._settings.smoothingWindow),
      limitW:           this._getEffectiveLimit(),
      overLimitCount:   this._overLimitCount,
      mitigatedDevices: this._mitigatedDevices.map(m => ({ deviceId: m.deviceId, action: m.action })),
      hanConnected:     !!this._hanDeviceId,
      hanDeviceName:    this._hanDeviceId ? this._getHANDeviceBrand() : null,
      hanLastSeen:      this._lastHanReading,
      log:              this._mitigationLog.slice(-20),
      evChargers:       evChargerStatus,
      hourlyEnergy: {
        currentHourKWh: Math.round(this._hourlyEnergy.accumulatedWh) / 1000,
        currentHour:    this._hourlyEnergy.currentHour,
        history:        this._hourlyEnergy.history.slice(-24),
      },
      effekttariff: this._getEffekttariffStatus(),
      lastMitigationScan: this._lastMitigationScan || [],
    };
  }

  async onUninit() {
    if (this._watchdogInterval)     clearInterval(this._watchdogInterval);
    if (this._cacheRefreshInterval) clearInterval(this._cacheRefreshInterval);
    if (this._hanPollInterval)      clearInterval(this._hanPollInterval);
    if (this._hanCapabilityInstance) {
      try { this._hanCapabilityInstance.destroy(); } catch (_) {}
    }
    for (const inst of Object.values(this._evCapabilityInstances || {})) {
      try { inst.destroy(); } catch (_) {}
    }
  }

  /**
   * Test Easee charger control — probes capabilities and tries a small adjustment.
   * Called from the settings UI test button.
   */
  async testEaseeCharger(deviceId) {
    const results = { steps: [], success: false };

    try {
      // Step 1: Check API
      if (!this._api) {
        results.steps.push({ step: 'API check', ok: false, detail: 'HomeyAPI not available' });
        return results;
      }
      results.steps.push({ step: 'API check', ok: true, detail: 'HomeyAPI connected' });

      // Step 2: Find charger(s) — both dynamic_current (Easee) and charge_pause (Zaptec) actions
      const priorityList = this._settings.priorityList || [];
      const chargerEntries = priorityList.filter(e =>
        (e.action === 'dynamic_current' || e.action === 'charge_pause') && e.enabled !== false
      );

      if (!chargerEntries.length) {
        results.steps.push({ step: 'Find chargers', ok: false, detail: 'No chargers in priority list (need dynamic_current or charge_pause action)' });
        return results;
      }
      results.steps.push({ step: 'Find chargers', ok: true, detail: `Found ${chargerEntries.length} charger(s): ${chargerEntries.map(e => e.name).join(', ')}` });

      // Use specified device or first one
      const targetEntry = deviceId
        ? chargerEntries.find(e => e.deviceId === deviceId) || chargerEntries[0]
        : chargerEntries[0];

      // Step 3: Get device from API
      let device;
      try {
        device = await this._api.devices.getDevice({ id: targetEntry.deviceId });
      } catch (err) {
        results.steps.push({ step: 'Get device', ok: false, detail: `Cannot get device ${targetEntry.name}: ${err.message}` });
        return results;
      }
      results.steps.push({ step: 'Get device', ok: true, detail: `Got device: ${device.name}` });

      // Step 4: List capabilities
      const caps = device.capabilities || [];
      const obj = device.capabilitiesObj || {};
      const relevantCaps = ['target_charger_current', 'target_circuit_current', 'target_current',
                            'dynamic_charger_current', 'dynamicChargerCurrent',
                            'dynamicCircuitCurrentP1', 'dynamic_current',
                            'charging_button', 'charge_mode', 'charging_mode',
                            'available_installation_current', 'alarm_generic.car_connected',
                            'toggleChargingCapability', 'chargerStatusCapability',
                            'toggleCableLockCapability', 'changeLedIntensityCapability',
                            'measure_current', 'measure_power', 'onoff', 'charger_status',
                            'measure_current.phase1', 'measure_current.phase2', 'measure_current.phase3',
                            'measure_current.offered', 'measure_voltage'];
      const found = {};
      for (const cap of relevantCaps) {
        if (caps.includes(cap)) {
          found[cap] = obj[cap] ? obj[cap].value : 'no value';
        }
      }
      results.steps.push({ step: 'Capabilities', ok: true, detail: JSON.stringify(found) });

      // Detect charger type
      const isZaptec = caps.includes('charging_button');
      const isEnua = caps.includes('toggleChargingCapability');
      const isEasee = caps.includes('target_charger_current') || caps.includes('target_circuit_current') ||
                      caps.includes('dynamic_charger_current') || caps.includes('dynamicChargerCurrent');

      if (isZaptec) {
        // ── Zaptec test path ──
        results.steps.push({ step: 'Charger type', ok: true, detail: 'Zaptec (charging_button + Flow API dynamic current)' });

        const btnVal = obj.charging_button ? obj.charging_button.value : null;
        results.steps.push({ step: 'charging_button', ok: true, detail: `Current value: ${btnVal}` });

        // Check car connected status
        const carConnected = obj['alarm_generic.car_connected'] ? obj['alarm_generic.car_connected'].value : 'unknown';
        results.steps.push({ step: 'Car connected', ok: true, detail: `${carConnected}` });

        // Check available installation current (read-only)
        const availCurrent = obj.available_installation_current ? obj.available_installation_current.value : 'unknown';
        results.steps.push({ step: 'Installation current', ok: true, detail: `Available: ${availCurrent}A` });

        // Test Flow API availability for dynamic current control
        try {
          const flowActions = await this._api.flow.getFlowCardActions();
          // Find all Zaptec flow actions
          const zaptecActions = Object.values(flowActions).filter(a =>
            a.uri === 'homey:app:com.zaptec'
          );
          // Look for current control action (try known names)
          const currentAction = zaptecActions.find(a =>
            a.id.includes('current') || a.id.includes('Current') || a.id.includes('ampere') || a.id.includes('limit')
          );
          const exactAction = zaptecActions.find(a => a.id === 'installation_current_control');

          if (exactAction) {
            results.steps.push({ step: 'Flow API', ok: true, detail: `Found: installation_current_control (0-40A per phase) — dynamic current ready` });
          } else if (currentAction) {
            results.steps.push({ step: 'Flow API', ok: true, detail: `Found Zaptec current action: "${currentAction.id}" (title: ${currentAction.title || 'N/A'}) — will use this for dynamic current` });
          } else if (zaptecActions.length > 0) {
            const actionList = zaptecActions.map(a => `${a.id}${a.title ? ' (' + (typeof a.title === 'object' ? JSON.stringify(a.title) : a.title) + ')' : ''}`).join(', ');
            results.steps.push({ step: 'Flow API', ok: false, detail: `Found ${zaptecActions.length} Zaptec action(s) but none for current control: ${actionList}` });
          } else {
            // Check if any flow actions exist for Zaptec with different URI pattern
            const allZaptec = Object.values(flowActions).filter(a =>
              (a.uri || '').includes('zaptec') || (a.ownerUri || '').includes('zaptec')
            );
            if (allZaptec.length > 0) {
              const actionList = allZaptec.map(a => `${a.uri}/${a.id}`).join(', ');
              results.steps.push({ step: 'Flow API', ok: false, detail: `No actions at homey:app:com.zaptec, but found Zaptec-related: ${actionList}` });
            } else {
              results.steps.push({ step: 'Flow API', ok: true, detail: 'No Zaptec flow actions found via enumeration — will use hardcoded fallback (installation_current_control). This is normal on some Homey setups.' });
            }
          }
        } catch (flowErr) {
          results.steps.push({ step: 'Flow API', ok: false, detail: `Flow API error: ${flowErr.message}` });
        }

        results.steps.push({ step: 'Control test', ok: true, detail: 'Zaptec: pause=charging_button, dynamic current=Flow API. Read test OK.' });
        results.success = true;

      } else if (isEnua) {
        // ── Enua test path ──
        results.steps.push({ step: 'Charger type', ok: true, detail: 'Enua Charge E (toggleChargingCapability + Flow API dynamic current)' });

        const chargingVal = obj.toggleChargingCapability ? obj.toggleChargingCapability.value : null;
        results.steps.push({ step: 'toggleChargingCapability', ok: true, detail: `Current value: ${chargingVal}` });

        const statusVal = obj.chargerStatusCapability ? obj.chargerStatusCapability.value : null;
        results.steps.push({ step: 'chargerStatusCapability', ok: true, detail: `Status: ${statusVal}` });

        // Check cable lock
        const cableLock = obj.toggleCableLockCapability ? obj.toggleCableLockCapability.value : 'unknown';
        results.steps.push({ step: 'Cable lock', ok: true, detail: `${cableLock}` });

        // Test Flow API availability for dynamic current control
        try {
          const flowActions = await this._api.flow.getFlowCardActions();
          const enuaActions = Object.values(flowActions).filter(a =>
            a.uri === 'homey:app:no.enua'
          );
          const currentAction = enuaActions.find(a =>
            a.id.includes('current') || a.id.includes('Current') || a.id.includes('limit') || a.id.includes('Limit')
          );
          const exactAction = enuaActions.find(a => a.id === 'changeCurrentLimitAction');

          if (exactAction) {
            results.steps.push({ step: 'Flow API', ok: true, detail: `Found: changeCurrentLimitAction (6-32A) — dynamic current ready` });
          } else if (currentAction) {
            results.steps.push({ step: 'Flow API', ok: true, detail: `Found Enua current action: "${currentAction.id}" (title: ${currentAction.title || 'N/A'}) — will use this for dynamic current` });
          } else if (enuaActions.length > 0) {
            const actionList = enuaActions.map(a => `${a.id}${a.title ? ' (' + (typeof a.title === 'object' ? JSON.stringify(a.title) : a.title) + ')' : ''}`).join(', ');
            results.steps.push({ step: 'Flow API', ok: false, detail: `Found ${enuaActions.length} Enua action(s) but none for current control: ${actionList}` });
          } else {
            const allEnua = Object.values(flowActions).filter(a =>
              (a.uri || '').includes('enua') || (a.ownerUri || '').includes('enua')
            );
            if (allEnua.length > 0) {
              const actionList = allEnua.map(a => `${a.uri}/${a.id}`).join(', ');
              results.steps.push({ step: 'Flow API', ok: false, detail: `No actions at homey:app:no.enua, but found Enua-related: ${actionList}` });
            } else {
              results.steps.push({ step: 'Flow API', ok: true, detail: 'No Enua flow actions found via enumeration — will use hardcoded fallback (changeCurrentLimitAction). This is normal on some Homey setups.' });
            }
          }
        } catch (flowErr) {
          results.steps.push({ step: 'Flow API', ok: false, detail: `Flow API error: ${flowErr.message}` });
        }

        results.steps.push({ step: 'Control test', ok: true, detail: 'Enua: pause=toggleChargingCapability, dynamic current=Flow API. Read test OK.' });
        results.success = true;

      } else if (isEasee) {
        // ── Easee test path ──
        const dynCap = ['dynamic_charger_current', 'dynamicChargerCurrent', 'dynamicCircuitCurrentP1', 'target_charger_current']
          .find(cap => caps.includes(cap));

        results.steps.push({ step: 'Charger type', ok: true, detail: 'Easee (dynamic current control)' });

        const currentVal = obj[dynCap] ? obj[dynCap].value : null;
        results.steps.push({ step: 'Current capability', ok: true, detail: `${dynCap} = ${currentVal}A` });

        try {
          const testVal = currentVal || 16;
          await device.setCapabilityValue({ capabilityId: dynCap, value: testVal });
          results.steps.push({ step: 'Write test', ok: true, detail: `Wrote ${dynCap} = ${testVal}A` });
          results.success = true;
        } catch (err) {
          results.steps.push({ step: 'Write test', ok: false, detail: `Failed to write ${dynCap}: ${err.message}` });
        }

      } else {
        // Unknown charger type — check if this is the Zaptec meter/installation device
        const ownerUri = (device.driver && device.driver.owner_uri) || device.driverUri || '';
        const isZaptecMeter = ownerUri.includes('com.zaptec');
        if (isZaptecMeter) {
          results.steps.push({
            step: 'Charger type',
            ok: false,
            detail: `This is the Zaptec installation/meter device (no charging_button found). ` +
              `Zaptec creates two devices in Homey — please select the charger device (not the meter). ` +
              `The app will attempt to auto-redirect to the real charger device automatically at startup. ` +
              `Available caps: ${caps.join(', ')}`
          });
        } else {
          results.steps.push({ step: 'Charger type', ok: false, detail: `Unknown charger type. No dynamic current or charging_button found. Available: ${caps.join(', ')}` });
        }
      }

    } catch (err) {
      results.steps.push({ step: 'Unexpected error', ok: false, detail: err.message });
    }

    return results;
  }

}

module.exports = PowerGuardApp;
