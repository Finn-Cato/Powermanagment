'use strict';

const Homey = require('homey');
const { HomeyAPI } = require('homey-api');
const { Mutex } = require('async-mutex');
const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const https = require('https');
const { movingAverage, isSpike, timestamp } = require('./common/tools');
const { applyAction, restoreDevice } = require('./common/devices');
const { PROFILES, PROFILE_LIMIT_FACTOR, DEFAULT_SETTINGS, MITIGATION_LOG_MAX, CHARGER_DEFAULTS, EFFEKT_TIERS, PRICE_DEFAULTS, MODES, MODES_DEFAULTS } = require('./common/constants');

// Minimum time to wait after any mitigation before restoring any device.
// Acts as a safety net for cases where the headroom snapshot is unreliable (e.g. 0W at snapshot time).
const RESTORE_COOLDOWN_MS = 240 * 1000; // 240 seconds

/**cd "C:\Github\Powermanagment" ; homey app run
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
    // Set process timezone to Homey's configured timezone so all Date methods return local time
    const tz = this.homey.clock.getTimezone();
    process.env.TZ = tz;

    this.log('========================================');
    this.log(`Power Guard initialising... (TZ=${tz})`);
    this.log('[Power Consumption] Tracking system initializing');
    this.log('========================================');

    this._mutex = new Mutex();
    this._powerBuffer = [];
    this._spikeConsecutiveCount = 0;  // how many consecutive readings were spike-filtered
    this._spikeLastFilteredValue = null; // last value that was spike-filtered
    this._overLimitCount = 0;
    this._mitigatedDevices = [];
    this._lastMitigationTime = 0;
    this._lastDeviceOffTime = 0;   // timestamp of last successful device-off (for dynamic restore guard)
    this._mitigationLog = [];
    this._deviceReliability = {};  // {deviceId: {comErrors: 0, reliability: 1.0}}
    this._missingPowerActive = false; // true when we're in missing-power mitigation mode
    this._hanSuspendedUntil = 0;     // timestamp until which missing-data timeout is suppressed (Flow action)

    // Restore mitigated devices from persistent storage
    try {
      const saved = this.homey.settings.get('_mitigatedDevices');
      if (Array.isArray(saved) && saved.length > 0) {
        // Keep evProactive shed entries alive across restart — they will be restored
        // by _proactiveEVLoadShed once it confirms the charger session is truly over.
        // Non-proactive entries (normal mitigation) are kept as-is for _triggerRestore.
        this._mitigatedDevices = saved;
        const proactiveCount = saved.filter(m => m.evProactive).length;
        this.log(`Restored ${saved.length} mitigated device(s) from previous session (${proactiveCount} EV-proactive — won't auto-restore until charger session ends)`);
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
    this._hanInFallbackMode = false;
    this._hanWatchdogCount = 0;
    this._hanRawLog = [];         // Ring buffer: last 20 raw readings {time, value, source}
    this._phaseCurrents = {};    // Latest per-phase amps from HAN: {capId: amps}
    this._evPowerData = {};
    this._evBatteryState = {};    // Per-charger battery reports: {deviceId: {pct, hoursNeeded, updatedAt}}
    this._activeCarOverride = {};  // Temporary per-charger override: {deviceId: {capacityKwh, targetPct, setAt}}
    this._evCapabilityInstances = {};
    this._powerConsumptionData = {}; // Track power history for all devices: {deviceId: {current, avg, peak, readings[]}}
    this._powerCapabilityInstances = {}; // measure_power capability instances keyed by deviceId
    this._adaxCapabilityInstances = {};  // Adax temp/onoff capability instances keyed by deviceId
    this._adaxRawPower = {};             // Raw (unestimated) measure_power value for Adax devices
    this._adaxState = {};               // {deviceId: {measT, targT, onoff}} for Adax estimation
    this.log('[Power Consumption] Data object initialized');
    this._lastEVAdjustTime = 0;
    this._lastProactiveSheddingTime = 0;
    this._lastProactiveRestoreTime = 0;
    this._pendingChargerCommands = {};  // Track outstanding charger commands {deviceId: timestamp}
    this._chargerState = {};             // Per-charger confirmation & reliability: {deviceId: {lastCommandA, commandTime, confirmed, reliability, lastAdjustTime}}
    this._lastAnyChargerRampUpTime = 0;  // Shared settling timer — blocks all chargers from ramping for 30s after any one ramps
    this._lastMitigationScan = [];      // Last mitigation scan results per device (for diagnostics)
    this._deviceCacheReady = false;
    this._lastCacheTime = null;
    this._saveQueue = [];
    // Unified app log for remote diagnostics
    this._appLog = [];          // Ring buffer: last 500 entries {time, category, message}
    this._appStartTime = Date.now();

    // Price engine state (SECTION 12)
    // Set _priceState = null to disable entirely, or remove _startPriceEngine() call below.
    this._priceState    = null;   // null = no data yet; populated by _fetchAndEvaluatePrices()
    this._priceSettings = Object.assign({}, PRICE_DEFAULTS);
    this._priceEngineInterval = null;

    // Mode engine state (SECTION 13)
    this._modeSettings = JSON.parse(JSON.stringify(MODES_DEFAULTS));
    this._nightSetBySchedule = false;  // true only when scheduler activated Night — prevents reverting a manual Night press
    this._modeSchedulerInterval = null;

    // Hourly energy tracking
    this._hourlyEnergy = {
      currentHour: new Date().getHours(),
      accumulatedWh: 0,        // Watt-hours accumulated this hour
      lastReadingW: 0,         // Last power reading in watts
      lastReadingTime: null,   // Timestamp of last reading
      history: [],             // Last 24 hours: [{hour, date, kWh}]
      hourStartKnown: false,   // True only after a full hour rollover since app start
    };
    // Restore hourly energy history from persistent storage
    try {
      const savedEnergy = this.homey.settings.get('_hourlyEnergyHistory');
      if (Array.isArray(savedEnergy)) {
        this._hourlyEnergy.history = savedEnergy.slice(-24);  // Keep last 24 entries
      }
    } catch (_) {}
    // Restore in-progress hour accumulation so restarts don't zero out the current hour
    try {
      const savedState = this.homey.settings.get('_hourlyEnergyState');
      if (savedState && savedState.currentHour === this._hourlyEnergy.currentHour) {
        this._hourlyEnergy.accumulatedWh = savedState.accumulatedWh || 0;
        this._hourlyEnergy.lastReadingW  = savedState.lastReadingW  || 0;
        // Leave lastReadingTime = null so the first post-restart reading creates a clean baseline
        // (the 60s gap sanity check would skip accumulation for the restart gap anyway)
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

    // Charge Now overrides — populated by charge-now driver devices
    this._chargeNow = {};

    // Remove persisted mitigation entries whose action no longer matches the priority list
    // (e.g. user changed action in the UI between sessions, or removed a device)
    this._cleanStaleMitigatedEntries();

    // Migrate settings from older versions (runs once per schema version bump)
    this._migrateSettings();

    // Clean up legacy _allDevicesCache from settings (was storing full API objects for all devices)
    try { this.homey.settings.unset('_allDevicesCache'); } catch (_) {}

    // Reload in-memory settings whenever the settings page writes via H.set().
    // Also re-broadcast priorityList so other open settings pages stay in sync.
    this.homey.settings.on('set', (key) => {
      this._loadSettings();
      // Debounced file backup — only for user-facing keys, ignores internal keys
      this._scheduleSettingsFileSave(key);
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
      if (this._api) await this._subscribeDevicePower();
    } catch (err) {
      this.error('Device power subscriptions error (non-fatal):', err);
    }

    try {
      if (this._api) await this._connectToEVChargers();
    } catch (err) {
      this.error('EV charger connection error (non-fatal):', err);
    }

    // Populate battery state immediately on startup so the UI shows data right away
    setTimeout(() => this._pollAllCarBatteries().catch(err => this.error('[CarBattery] Startup poll error:', err)), 5000);

    this._perfStats = { cpuSample: process.cpuUsage(), calls: {} };
    this._watchdogInterval  = setInterval(async () => { const _t = Date.now(); await this._watchdog().catch(err => this.error('[Watchdog] Error:', err)); this._trackCallTime('watchdog', Date.now() - _t); }, 10000);
    this._cacheRefreshInterval = setInterval(() => this._cacheDevices().catch(err => this.error('[Cache] Refresh error:', err)), 300000);
    this._queueProcessorInterval = setInterval(async () => { const _t = Date.now(); await this._processSaveQueue().catch(err => this.error('[Queue] Save error:', err)); this._trackCallTime('saveQueue', Date.now() - _t); }, 3000);
    this._resourceMonitorInterval = setInterval(() => this._resourceMonitor(), 5 * 60 * 1000);

    // Start spot price engine — non-fatal, charger control still works without it
    // To remove price feature entirely: delete this block + SECTION 12 at bottom of file
    try {
      await this._startPriceEngine();
    } catch (err) {
      this.error('Price engine start error (non-fatal):', err);
    }

    // Start mode scheduler (Home/Night/Away/Holiday) — non-fatal
    try {
      await this._startModeScheduler();
    } catch (err) {
      this.error('Mode scheduler start error (non-fatal):', err);
    }

    // Initialize power consumption tracking after API is ready (don't call on startup, it fails)
    // It will populate when HAN readings arrive or when the tab is first opened
    this._writeDebugLog('===== APP STARTED =====' );
    this._appLogEntry('system', 'App started');

    this.log('Power Guard ready (device cache: ' +
      (this._deviceCacheReady ? 'YES' : 'NO') + ')');
    this._appLogEntry('system', 'Power Guard ready (device cache: ' + (this._deviceCacheReady ? 'YES' : 'NO') + ')');
    this._appLogEntry('system', '[PerfTest] v2 - riktig kode kjorer pa Homey!');
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

  // ─── Event-based device power subscriptions ─────────────────────────────
  async _subscribeDevicePower() {
    if (!this._api) return;
    let subscribeCount = 0;
    let failCount = 0;
    try {
      const allDevices = await this._api.devices.getDevices();
      for (const device of Object.values(allDevices)) {
        if (!device || !Array.isArray(device.capabilities)) continue;
        if (!device.capabilities.includes('measure_power')) continue;

        const devId    = device.id;
        const devName  = device.name || 'Unknown';
        const devClass = (device.class || '').toLowerCase();
        const driverId = device.driverId || '';
        const driverLow = driverId.toLowerCase();
        const nameLow   = devName.toLowerCase();

        // Same filters as former _updatePowerConsumption
        if (driverLow === 'power-guard' || nameLow.includes('power guard')) continue;
        if (devClass === 'meter' || nameLow.includes('han') || driverLow.includes('meter')) continue;
        if (devClass === 'socket' && (nameLow.includes('light') || nameLow.includes('lamp'))) continue;

        // Seed tracking entry with the current snapshot so readings don't start at 0
        const initW = device.capabilitiesObj?.measure_power?.value || 0;
        if (!this._powerConsumptionData[devId]) {
          this._powerConsumptionData[devId] = {
            deviceId: devId, name: devName, class: devClass,
            readings: [], current: initW, avg: initW, peak: initW,
          };
        }

        const isAdax = driverId.includes('no.adax');
        if (isAdax) {
          const co = device.capabilitiesObj || {};
          this._adaxRawPower[devId] = initW;
          this._adaxState[devId] = {
            measT: co.measure_temperature?.value ?? null,
            targT: co.target_temperature?.value  ?? null,
            onoff: co.onoff?.value               ?? null,
          };
        }

        try {
          const inst = await device.makeCapabilityInstance('measure_power', value => {
            this._onDevicePowerEvent(devId, devName, devClass, driverId, value);
          });
          this._powerCapabilityInstances[devId] = inst;
          subscribeCount++;

          if (isAdax) {
            if (!this._adaxCapabilityInstances[devId]) this._adaxCapabilityInstances[devId] = [];
            if (device.capabilities.includes('measure_temperature')) {
              const tInst = await device.makeCapabilityInstance('measure_temperature', v => {
                if (!this._adaxState[devId]) this._adaxState[devId] = {};
                this._adaxState[devId].measT = v;
                this._recomputeAdaxCurrent(devId);
              });
              this._adaxCapabilityInstances[devId].push(tInst);
            }
            if (device.capabilities.includes('target_temperature')) {
              const ttInst = await device.makeCapabilityInstance('target_temperature', v => {
                if (!this._adaxState[devId]) this._adaxState[devId] = {};
                this._adaxState[devId].targT = v;
                this._recomputeAdaxCurrent(devId);
              });
              this._adaxCapabilityInstances[devId].push(ttInst);
            }
            if (device.capabilities.includes('onoff')) {
              const onInst = await device.makeCapabilityInstance('onoff', v => {
                if (!this._adaxState[devId]) this._adaxState[devId] = {};
                this._adaxState[devId].onoff = v;
                this._recomputeAdaxCurrent(devId);
              });
              this._adaxCapabilityInstances[devId].push(onInst);
            }
          }
        } catch (err) {
          failCount++;
          this.error(`[PowerSub] Failed to subscribe to "${devName}": ${err.message}`);
        }
      }
    } catch (err) {
      this.error('[PowerSub] getDevices failed:', err);
    }
    this.log(`[PowerSub] Subscribed to ${subscribeCount} devices (${failCount} failed)`);
    this._appLogEntry('system', `Power subscriptions: ${subscribeCount} devices`);
  }

  _onDevicePowerEvent(devId, devName, devClass, driverId, rawW) {
    if (!this._powerConsumptionData[devId]) {
      this._powerConsumptionData[devId] = {
        deviceId: devId, name: devName, class: devClass,
        readings: [], current: 0, avg: 0, peak: 0,
      };
    }
    if ((driverId || '').includes('no.adax')) {
      this._adaxRawPower[devId] = rawW || 0;
      this._recomputeAdaxCurrent(devId);
    } else {
      this._powerConsumptionData[devId].current = rawW || 0;
    }
  }

  _recomputeAdaxCurrent(devId) {
    const rawW = this._adaxRawPower[devId] || 0;
    const data = this._powerConsumptionData[devId];
    if (!data) return;
    let currentW = rawW;
    if (currentW > 0) {
      const isMitigated = (this._mitigatedDevices || []).some(m => m.deviceId === devId);
      if (isMitigated) {
        currentW = 0;
      } else {
        const adax  = this._adaxState[devId] || {};
        const measT = adax.measT ?? null;
        const targT = adax.targT ?? null;
        const onoff = adax.onoff ?? null;
        if (onoff === false) {
          currentW = 0;
        } else if (measT != null && targT != null) {
          const diff = targT - measT;
          if (diff <= 0)       currentW = 0;
          else if (diff < 0.5) currentW = Math.round(currentW * 0.20);
          else if (diff < 2.0) currentW = Math.round(currentW * 0.50);
          // else diff >= 2.0 → keep rated 100%
        }
      }
    }
    data.current = currentW;
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
    // Use /userdata if available (production Homey), else skip
    const fs = require('fs');
    const candidates = ['/userdata', __dirname];
    for (const dir of candidates) {
      try {
        fs.accessSync(dir, fs.constants.W_OK);
        return require('path').join(dir, 'powerguard-settings.json');
      } catch (_) { /* not writable */ }
    }
    return null;
  }

  async _saveSettingsToFile() {
    const filePath = this._getSettingsFilePath();
    if (!filePath) return; // no writable path available — Homey settings API is the primary store
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
      await fs.writeFile(filePath, JSON.stringify(settingsData, null, 2));
      this.log('Settings persisted to file');
    } catch (err) {
      this.error('Failed to save settings to file:', err);
    }
  }

  /**
   * Debounced file save — only triggers for user-facing settings keys.
   * Prevents disk-write spam when internal keys (_deviceCache, _dailyPeaks, etc.) are updated.
   */
  _scheduleSettingsFileSave(key) {
    const publicKeys = new Set([
      'enabled', 'profile', 'powerLimitW',
      'phase1LimitA', 'phase2LimitA', 'phase3LimitA',
      'smoothingWindow', 'spikeMultiplier', 'hysteresisCount', 'cooldownSeconds',
      'priorityList', 'voltageSystem', 'mainCircuitA', 'selectedMeterDeviceId',
    ]);
    if (!publicKeys.has(key)) return;
    clearTimeout(this._settingsFileSaveTimer);
    this._settingsFileSaveTimer = setTimeout(() => {
      this._saveSettingsToFile().catch(err => this.error('File save failed:', err));
    }, 2000);
  }

  async _loadSettingsFromFile() {
    const fs = require('fs').promises;
    try {
      const filePath = this._getSettingsFilePath();
      if (!filePath) return null;
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
      errorMarginPercent: s.get('errorMarginPercent') ?? DEFAULT_SETTINGS.errorMarginPercent,
      missingPowerTimeoutS: s.get('missingPowerTimeoutS') ?? DEFAULT_SETTINGS.missingPowerTimeoutS,
      dynamicRestoreGuard: s.get('dynamicRestoreGuard') ?? DEFAULT_SETTINGS.dynamicRestoreGuard,
      dynamicHourlyBudget: false, // Always disabled — budget is informational only, not a control source
      evHeadroomW:       s.get('evHeadroomW')       ?? DEFAULT_SETTINGS.evHeadroomW,
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
    const margin = 1 - ((this._settings.errorMarginPercent || 0) / 100);
    const base = this._settings.powerLimitW * factor * margin;
    // Dynamic hourly budget is informational only — always use fixed limit for control.
    // Hourly energy tracking and budget charts still work normally via _hourlyEnergy (Section 3).
    return base;
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
  /**
   * One-time settings migrations keyed by schema version.
   * Runs on every startup but each migration only applies once.
   * Current migrations:
   *   v2 — Reset voltageSystem to 'auto' so the app detects phases from the HAN sensor.
   *   v3 — Clear chargerPhasesManual on all priority list entries so auto-detection takes over.
   *        The manual phase selector has been removed from the UI; auto-detection now works for
   *        all supported chargers (Easee via offeredCurrent, Zaptec via sentCurrent).
   */
  _migrateSettings() {
    const CURRENT_SCHEMA = 3;
    let version = 0;
    try { version = parseInt(this.homey.settings.get('_settingsSchemaVersion') || 0, 10) || 0; } catch (_) {}

    if (version < 2) {
      this.log('[Migration] Running schema v2: resetting voltageSystem → auto-detect from HAN');

      // Clear any manually-set voltageSystem so auto-detection takes over
      try { this.homey.settings.unset('voltageSystem'); } catch (_) {}
      if (this._settings) {
        this._settings.voltageSystem = DEFAULT_SETTINGS.voltageSystem;
      }
    }

    if (version < 3) {
      this.log('[Migration] Running schema v3: clearing chargerPhasesManual overrides → auto-detect');
      try {
        const pl = this.homey.settings.get('priorityList') || [];
        let changed = false;
        for (const entry of pl) {
          if (entry.chargerPhasesManual) {
            entry.chargerPhasesManual = false;
            entry.chargerPhases = undefined;  // Force default (3) until auto-detect kicks in
            changed = true;
            this.log(`[Migration] v3: cleared chargerPhasesManual for ${entry.name || entry.deviceId}`);
          }
        }
        if (changed) {
          this.homey.settings.set('priorityList', pl);
          if (this._settings) this._settings.priorityList = pl;
        }
      } catch (_) {}
    }

    if (version < CURRENT_SCHEMA) {
      try { this.homey.settings.set('_settingsSchemaVersion', CURRENT_SCHEMA); } catch (_) {}
      this.log(`[Migration] Schema v${CURRENT_SCHEMA} complete`);
    }
  }

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
      await this._triggerRestore(currentPower).catch(err => this.error('Force restore error:', err));
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
        return { time: timestamp(new Date(e.time)), value: e.value, source: e.source };
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
      const hanRegex = /\bhan\b/;
      const candidates = allDeviceList.filter(d => {
        const hasPower = Array.isArray(d.capabilities) && d.capabilities.includes('measure_power');
        if (!hasPower) return false;

        // Must be identifiable as a meter/HAN device, not just any device with power measurement
        const name = (d.name || '').toLowerCase();
        const driver = (d.driverId || '').toLowerCase();
        const deviceClass = (d.class || '').toLowerCase();

        // Easee Equalizer: class 'other', driver 'equalizer', app 'no.easee'
        const isEaseeEqualizer = driver === 'equalizer' &&
          d.driver && d.driver.owner_uri === 'homey:app:no.easee';

        return deviceClass === 'meter' || isEaseeEqualizer ||
          name.includes('meter') || name.includes('frient') || hanRegex.test(name) ||
          name.includes('futurehome') || name.includes('tibber') || name.includes('easee') ||
          driver.includes('meter') || driver.includes('frient') || hanRegex.test(driver) ||
          driver.includes('futurehome') || driver.includes('tibber');
      });

      if (candidates.length > 1) {
        // If multiple candidates, prefer the one currently reporting the highest power
        // This avoids picking a newly-added dongle that has not yet received P1 data
        candidates.sort((a, b) => {
          const aW = Number((a.capabilitiesObj?.measure_power?.value) ?? 0);
          const bW = Number((b.capabilitiesObj?.measure_power?.value) ?? 0);
          return bW - aW;
        });
        this.log(`[HAN] ${candidates.length} meter candidates — picking highest power: "${candidates[0].name}" (${Math.round(Number(candidates[0].capabilitiesObj?.measure_power?.value ?? 0))} W)`);
      }
      hanDevice = candidates[0] || null;
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
      if (this._hanInFallbackMode) {
        this._hanInFallbackMode = false;
        this._appLogEntry('han', `Events resumed: ${value}W`);
      }
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
    this._hanPollInterval = setInterval(async () => { const _t = Date.now(); await this._pollHANPower().catch(err => this.error('[HAN] Poll error:', err)); this._trackCallTime('hanPoll', Date.now() - _t); }, 10000);
    setTimeout(() => this._pollHANPower().catch(err => this.error('[HAN] Initial poll error:', err)), 2000);
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

        // Only process if we haven't had an event-based reading in the last 15 seconds
        // This avoids double-processing when events ARE working.
        // 15s chosen because HAN meter sends events every ~10s — 8s was too tight and
        // caused continuous poll fallback activation even when events were healthy.
        if (timeSinceLastReading > 15000) {
          // Only log to appLog when entering fallback mode (not every poll cycle)
          if (!this._hanInFallbackMode) {
            this._hanInFallbackMode = true;
            this._appLogEntry('han', `Poll fallback active: ${value}W (no event for ${Math.round(timeSinceLastReading / 1000)}s) — control frozen until events resume`);
          }
          this.log(`[HAN Poll] Fallback reading: ${value} W (no event for ${Math.round(timeSinceLastReading / 1000)}s)`);
          this._hanPollCount++;
          this._pushHanRawLog(value, 'poll');
          // Do NOT call _onPowerReading during fallback — stale poll data could cause
          // incorrect ramp/mitigation decisions. All control is frozen until HAN events resume.
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

    // ── Missing power guard ──────────────────────────────────────────────────
    // If no real reading has arrived for longer than missingPowerTimeoutS, and the
    // feature is enabled, force a synthetic reading at the effective limit so that
    // mitigation kicks in and we don't accidentally overshoot the capacity tariff.
    const timeoutS = this._settings.missingPowerTimeoutS || 0;
    if (timeoutS > 0 && this._settings.enabled) {
      const ageSec = this._lastHanReading ? (Date.now() - this._lastHanReading) / 1000 : Infinity;
      const hanSuspended = Date.now() < this._hanSuspendedUntil;
      if (ageSec > timeoutS && !hanSuspended) {
        if (!this._missingPowerActive) {
          this._missingPowerActive = true;
          this.log(`[HAN Poll] No reading for ${Math.round(ageSec)}s (timeout ${timeoutS}s) — forcing mitigation`);
          this._appLogEntry('han', `Missing power guard triggered after ${Math.round(ageSec)}s of silence`);
        }
        // Synthesise a reading just above the effective limit so mitigation fires
        const syntheticPower = this._getEffectiveLimit() + 100;
        this._checkLimits(syntheticPower).catch(err => this.error('Missing power checkLimits error:', err));
      } else if (this._missingPowerActive) {
        // Readings have resumed (or suspension lifted) — clear the flag
        this._missingPowerActive = false;
        const reason = hanSuspended ? 'HAN suspension active' : 'readings resumed';
        this.log(`[HAN Poll] Missing power guard cleared — ${reason}`);
        this._appLogEntry('han', `Missing power guard cleared — ${reason}`);
      }
    }
  }

  _onPowerReading(rawValue) {
    // Coerce to number — some cloud-based meters may report as string
    rawValue = Number(rawValue);
    if (isNaN(rawValue)) return;
    const _tReading = Date.now();

    // Cap negative power to 0 (solar export should not count as usage)
    if (rawValue < 0) rawValue = 0;

    this._lastHanReading = Date.now();

    // Clear missing power guard if it was active
    if (this._missingPowerActive) {
      this._missingPowerActive = false;
      this.log('[HAN] Real reading received — clearing missing power guard');
      this._appLogEntry('han', 'Missing power guard cleared — real reading received');
    }

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
          const phases = evData?.detectedPhases || entry.chargerPhases || 3;
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
          this._powerBuffer = [rawValue, rawValue];
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
    this._updateVirtualDevice({ power: rawValue }).catch(() => {});  // raw = matches HAN sensor tile in real-time
    this._checkLimits(smoothed, rawValue).catch((err) => this.error('checkLimits error:', err));
    
    // Update power consumption for all devices
    try {
      this._updatePowerConsumption(smoothed);
    } catch (err) {
      this.error('[Power Consumption] Unexpected error:', err);
    }

    // Cache status into settings so the settings page can read it via H.get()
    // No throttle — HAN readings already arrive ~1-2s apart, and settings page polls every 2s.
    this._cacheStatus();
    this._trackCallTime('onPowerReading', Date.now() - _tReading);
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
   *   1. Charger-reported phases (live W/A ratio) — reliable regardless of load balance or time of day
   *   2. HAN live phase currents: if L2 or L3 carries > 0.3 A → 3-phase
   *   3. HAN capabilities: if meter exposes L2/L3 capability → 3-phase install
   *   4. Default: 1-phase (safe assumption when no data)
   * Returns 1 or 3.
   */
  _detectSystemPhases() {
    // 1. Charger-reported phases — most reliable, derived from live W/A ratio
    //    (not affected by balanced loads or HAN port reporting gaps)
    const chargerPhases = Object.values(this._evPowerData || {})
      .map(d => d.detectedPhases)
      .filter(Boolean);
    if (chargerPhases.length > 0) {
      return chargerPhases.some(p => p === 3) ? 3 : 1;
    }
    // 2. HAN live phase current data
    if (this._phaseCurrents) {
      const b = this._phaseCurrents['measure_current.L2'] ?? this._phaseCurrents['measure_current.phase_b'] ?? 0;
      const c = this._phaseCurrents['measure_current.L3'] ?? this._phaseCurrents['measure_current.phase_c'] ?? 0;
      if (b > 0.3 || c > 0.3) return 3;
    }
    // 3. HAN capabilities — if the meter reports L2/L3 capabilities, the install is 3-phase
    if (this._hanDevice) {
      const caps = this._hanDevice.capabilities || [];
      const has3PhaseCap = caps.some(cap =>
        cap === 'measure_current.L2' || cap === 'measure_current.L3' ||
        cap === 'measure_current.phase_b' || cap === 'measure_current.phase_c'
      );
      if (has3PhaseCap) return 3;
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

  /**
   * Get a YYYY-MM-DD date key in Europe/Oslo timezone.
   * Fixes critical bug: toISOString() returns UTC which is wrong around midnight in Norway.
   * Used for hourly energy, daily peaks, and 7-day calendar.
   */
  _getOsloDateKey(ts = Date.now()) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Oslo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date(ts));
    const map = Object.fromEntries(
      parts.filter(p => p.type !== 'literal').map(p => [p.type, p.value])
    );
    return `${map.year}-${map.month}-${map.day}`;
  }

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
        date: this._getOsloDateKey(now - 1),  // Date of the completed hour (Oslo timezone)
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
      this._hourlyEnergy.hourStartKnown = true;  // From here on we know exactly where the hour started
      // Persist fresh state for new hour
      try {
        this.homey.settings.set('_hourlyEnergyState', {
          currentHour,
          accumulatedWh: 0,
          lastReadingW: powerW,
        });
      } catch (_) {}
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

    // Persist in-progress state so accumulation survives app restarts
    try {
      this.homey.settings.set('_hourlyEnergyState', {
        currentHour: this._hourlyEnergy.currentHour,
        accumulatedWh: this._hourlyEnergy.accumulatedWh,
        lastReadingW: this._hourlyEnergy.lastReadingW,
      });
    } catch (_) {}
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

    // Current hour: accumulated kWh so far, and projected end-of-hour kW
    const currentHourKWh = Math.round(this._hourlyEnergy.accumulatedWh) / 1000;
    const msIntoHour     = now.getTime() % 3600000;
    const fractionOfHour = msIntoHour / 3600000;
    // Projected = what the hourly kWh would be if the rest of the hour continues at the same avg rate
    const projectedKWh   = fractionOfHour > 0.01
      ? Math.round((currentHourKWh / fractionOfHour) * 1000) / 1000
      : 0;
    const todayStr = this._getOsloDateKey(now.getTime());
    const todayPeak = this._dailyPeaks[todayStr] || 0;
    // Warn when the projected end-of-hour value would beat today's best completed hour
    const wouldBeNewDailyPeak = projectedKWh > todayPeak && fractionOfHour > 0.05;

    return {
      monthlyKW: Math.round(monthlyKW * 1000) / 1000,
      tierLabel: tier.label,
      tierIndex: tier.index,
      tierMaxKW: tier.maxKW === Infinity ? null : tier.maxKW,
      top3: top3.map(p => ({ date: p.date, kw: Math.round(p.kw * 1000) / 1000 })),
      dailyPeakCount: allPeaks.length,
      allPeaks: allPeaks,  // All days for calendar display
      currentHourKWh: Math.round(currentHourKWh * 1000) / 1000,
      projectedKWh:   Math.round(projectedKWh * 1000) / 1000,
      todayPeakKW:    Math.round(todayPeak * 1000) / 1000,
      wouldBeNewDailyPeak,
      accumulatedWh:    Math.round(this._hourlyEnergy.accumulatedWh || 0),
      fractionOfHour:   Math.round(fractionOfHour * 1000) / 1000,
      hourStartKnown:   this._hourlyEnergy.hourStartKnown === true,
      hourlyHistory:    (this._hourlyEnergy.history || []).slice(-24),
      dailyPeaksByDate: (() => {
        const cutoff = new Date(now);
        cutoff.setDate(cutoff.getDate() - 6);
        cutoff.setHours(0, 0, 0, 0);
        const cutoffStr = this._getOsloDateKey(cutoff.getTime());
        return Object.entries(this._dailyPeaks)
          .filter(([date]) => date >= cutoffStr)
          .map(([date, kw]) => ({ date, kw: Math.round(Number(kw) * 1000) / 1000 }))
          .sort((a, b) => a.date.localeCompare(b.date));
      })(),
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

  async _checkLimits(smoothedPower, rawPower) {
    this._refreshSettings();
    if (!this._settings.enabled) return;

    const limit = this._getEffectiveLimit();
    const overLimit = smoothedPower > limit;

    // EV charger dynamic adjustment uses raw (unsmoothed) power for faster reaction.
    // Smoothed power is still used for hysteresis and normal device mitigation.
    const evPower = rawPower ?? smoothedPower;
    const hasEVChargers = (this._settings.priorityList || []).some(
      e => e.enabled !== false && e.action === 'dynamic_current'
    );
    if (hasEVChargers) {
      await this._adjustEVChargersForPower(evPower).catch(err => this.error('EV adjust error:', err));
      await this._proactiveEVLoadShed(evPower).catch(err => this.error('EV load shed error:', err));
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
    } else if (!overLimit && smoothedPower < (limit - 500) && this._mitigatedDevices.length > 0) {
      await this._triggerRestore(smoothedPower);
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

      // EV charger current is managed exclusively by _adjustEVChargersForPower (runs on every
      // HAN reading) — one engine owns current to avoid conflicting commands to the same charger.

      // Primary sort: user-defined priority. Secondary sort: push high-comError devices to end
      // Unreliable devices are attempted last to avoid getting stuck.
      const priorityList = [...(this._settings.priorityList || [])]
        .sort((a, b) => {
          const priDiff = a.priority - b.priority;
          if (priDiff !== 0) return priDiff;
          return this._getDeviceComErrors(a.deviceId) - this._getDeviceComErrors(b.deviceId);
        });
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
          // Allow Høiax stepped devices AND thermostats to be further stepped down.
          // Each thermostat re-mitigation lowers temp by another 3°C from the current live value
          // (floor 5°C). applyAction returns false when floor is reached, which stops stepping.
          // previousState always holds the ORIGINAL pre-mitigation temp for a clean restore.
          if (entry.action === 'hoiax_power' || entry.action === 'target_temperature') {
            // fall through — stepped re-mitigation handled below
          } else {
            // Check if the stored action still matches the priority-list action.
            // If the user changed the action (e.g. "onoff" → "target_temperature") the
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

          // ── Idle guard ────────────────────────────────────────────────────────
          // Skip thermostats/heaters that are not currently drawing power.
          // A thermostat set to 13°C in a 22°C room draws 0W — mitigating it wastes
          // a cycle slot without reducing household load at all.
          // Detection priority:
          //   1. measure_power < 50W  → definitely idle
          //   2. tuya_thermostat_load_status === false  → element not firing
          //   3. onoff === false  → device already off
          // Only applies to thermostat/heater actions. Does NOT apply if already
          // mitigated in step 2 (was heating earlier, now cooled — keep it off).
          if (entry.action === 'target_temperature' || entry.action === 'onoff' || entry.action === 'hoiax_power') {
            let isIdle = false;
            let idleReason = '';
            if (!entry.ignorePowerCheck && caps.includes('measure_power') && obj.measure_power != null) {
              const pw = typeof obj.measure_power.value === 'number' ? obj.measure_power.value : obj.measure_power;
              if (pw < 50) { isIdle = true; idleReason = `measure_power=${Math.round(pw)}W`; }
            }
            if (!isIdle && caps.includes('tuya_thermostat_load_status') && obj.tuya_thermostat_load_status != null) {
              const ls = obj.tuya_thermostat_load_status.value !== undefined ? obj.tuya_thermostat_load_status.value : obj.tuya_thermostat_load_status;
              if (ls === false) { isIdle = true; idleReason = 'tuya_thermostat_load_status=false'; }
            }
            if (!isIdle && caps.includes('onoff') && obj.onoff != null) {
              const onoffVal = obj.onoff.value !== undefined ? obj.onoff.value : obj.onoff;
              if (onoffVal === false) { isIdle = true; idleReason = 'onoff=false'; }
            }

            const existingMitigationCheck = this._mitigatedDevices.find(m => m.deviceId === entry.deviceId);
            if (isIdle) {
              if (!existingMitigationCheck) {
                // Not yet mitigated — skip entirely, device contributes nothing to overload
                this.log(`[Mitigation] SKIP ${entry.name}: idle (${idleReason}) — not drawing power, skipping this cycle`);
                scanResults.push({ name: entry.name, action: entry.action, result: `idle-skip (${idleReason})` });
                continue;
              } else if (existingMitigationCheck.step2Applied) {
                // Already turned off in step 2 — skip (already off)
                this.log(`[Mitigation] SKIP ${entry.name}: idle (${idleReason}) and step 2 already applied`);
                scanResults.push({ name: entry.name, action: entry.action, result: `idle-skip step2 already done (${idleReason})` });
                continue;
              }
              // existingMitigation but step2 not yet applied — fall through to step 2
              // (temp was lowered in step 1; device may restart when room cools → turn it off)
            }
          }
          // ─────────────────────────────────────────────────────────────────────

          // Check if already mitigated (re-entry for Høiax / thermostat two-step)
          const existingMitigation = this._mitigatedDevices.find(m => m.deviceId === entry.deviceId);

          // Only snapshot on first mitigation — keep original state for full restore
          const previousState = existingMitigation ? existingMitigation.previousState : this._snapshotState(device);

          // ── Thermostat two-step logic ──────────────────────────────────────────
          // Step 1 (first mitigation):  lower temp by 3°C via applyAction
          // Step 2 (re-mitigation):     turn thermostat OFF — only after step 1 has had
          //   time to take effect (THERMOSTAT_STEP2_DELAY_MS). This prevents the system from
          //   turning off a thermostat that already reduced its load by 3°C — give the
          //   reduction time to bring power under the limit first.
          // Restore:                    turn back ON → set to original temp
          // Minimum time between step 1 and step 2 — gives room for thermal response
          const THERMOSTAT_STEP2_MIN_MS = 3 * 60 * 1000; // 3 minutes absolute minimum
          if (existingMitigation && entry.action === 'target_temperature') {
            if (!existingMitigation.step2Applied) {
              const step1Age = now - (existingMitigation.mitigatedAt || 0);
              // Absolute minimum wait
              if (step1Age < THERMOSTAT_STEP2_MIN_MS) {
                const waitSecs = Math.ceil((THERMOSTAT_STEP2_MIN_MS - step1Age) / 1000);
                this.log(`[Mitigation] SKIP ${entry.name}: step-1 too recent (${waitSecs}s remaining before step 2 allowed)`);
                scanResults.push({ name: entry.name, action: entry.action, result: `step2 delayed (${waitSecs}s left)` });
                continue;
              }
              // Power-based guard: if device has measure_power and is now < 50W,
              // the 3°C reduction has already cut the load — no need for step 2.
              if (caps.includes('measure_power') && obj.measure_power != null) {
                const pw = typeof obj.measure_power.value === 'number' ? obj.measure_power.value : Number(obj.measure_power);
                if (pw < 50) {
                  this.log(`[Mitigation] SKIP step 2 for ${entry.name}: measure_power=${Math.round(pw)}W — step-1 reduction already working, no turn-off needed`);
                  scanResults.push({ name: entry.name, action: entry.action, result: `step2 skipped (power ${Math.round(pw)}W < 50W — step1 sufficient)` });
                  continue;
                }
              }
            }
            if (caps.includes('onoff')) {
              if (obj.onoff && obj.onoff.value === false) {
                // Currently off — nothing more we can do
                this.log(`[Mitigation] SKIP ${entry.name}: thermostat already off (step 2 done)`);
                scanResults.push({ name: entry.name, action: entry.action, result: 'already off (step 2)' });
                continue;
              }
              // Turn the thermostat off
              await device.setCapabilityValue({ capabilityId: 'onoff', value: false });
              existingMitigation.mitigatedAt = now;
              if (existingMitigation.step2Applied) {
                // Step 2 was already applied once — this is a hardware bounce-back (thermostat
                // restarted itself). Turn it off again but DON'T consume the mitigatedThisCycle
                // slot so other devices in the priority list can still be processed this cycle.
                this.log(`[Mitigation] BOUNCE: ${entry.name} bounced back ON after step 2 — turned OFF again (not consuming cycle slot)`);
                scanResults.push({ name: entry.name, action: entry.action, result: 'bounce suppressed (step 2 re-applied)' });
                this._persistMitigatedDevices();
                continue;
              }
              // First time step 2 is applied — mark it so bounce-backs don't block the list
              existingMitigation.step2Applied = true;
              this.log(`[Mitigation] SUCCESS: ${entry.name} thermostat step 2 — turned OFF`);
            } else {
              // No onoff capability — cannot turn off, nothing more to do
              this.log(`[Mitigation] SKIP ${entry.name}: thermostat has no onoff cap, cannot do step 2`);
              scanResults.push({ name: entry.name, action: entry.action, result: 'skip step 2 (no onoff cap)' });
              continue;
            }
          } else {
            // Step 1 for thermostats, or Høiax stepped reduction
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
          }
          this._lastMitigationTime = now;
          this._lastDeviceOffTime = now;   // track for dynamic restore guard
          this._updateDeviceReliability(entry.deviceId, true);
          this._persistMitigatedDevices();
          this._fireTrigger('mitigation_applied', { device_name: device.name, action: entry.action });
          await this._updateVirtualDevice({ alarm: true });
          const _prevT = previousState && previousState.target_temperature != null ? previousState.target_temperature : null;
          const _newT  = (_prevT != null && entry.action === 'target_temperature') ? Math.max(5, _prevT - 3) : null;
          const _tempStr = _newT != null ? ` (${_prevT}→${_newT}°C)` : '';
          this.log(`[Mitigation] SUCCESS: ${entry.name} mitigated with action=${entry.action}${_tempStr}`);
          this._appLogEntry('mitigation', `Mitigert: ${entry.name}${_tempStr || ` (${entry.action})`}`);
          scanResults.push({ name: entry.name, action: entry.action, result: `SUCCESS` });
          mitigatedThisCycle = true;
          // Don't break — continue to build full scan results for diagnostics
        } catch (err) {
          // If device was removed, skip it rather than blocking mitigation
          const errMsg = (err.message || '').toLowerCase();
          if (errMsg.includes('not_found') || errMsg.includes('device_not_found') || errMsg.includes('timed out')) {
            this.log(`[Mitigation] Device ${entry.deviceId} (${entry.name}) not found or unreachable, skipping`);
            this._updateDeviceReliability(entry.deviceId, false);
            scanResults.push({ name: entry.name, action: entry.action, result: `error: ${errMsg.substring(0, 80)}` });
            continue;
          }
          this._updateDeviceReliability(entry.deviceId, false);
          this.error(`Mitigation failed for ${entry.deviceId}:`, err);
          scanResults.push({ name: entry.name, action: entry.action, result: `error: ${(err.message || '').substring(0, 80)}` });
        }
      }

      // Store scan results for diagnostics (visible via getStatus), capped at 20
      this._lastMitigationScan = scanResults.slice(-20);
      this.log(`[Mitigation] Scan complete: ${JSON.stringify(scanResults)}`);

      // ── All options exhausted but still over limit ─────────────────────────
      // Fire flow trigger + timeline notification so the user can send push via Flow.
      if (!mitigatedThisCycle && currentPower > this._getEffectiveLimit()) {
        const now2 = Date.now();
        const NOTIFY_COOLDOWN = 15 * 60 * 1000; // Max once per 15 minutes
        if (!this._lastOverLimitNotifyTime || (now2 - this._lastOverLimitNotifyTime) >= NOTIFY_COOLDOWN) {
          this._lastOverLimitNotifyTime = now2;
          const limitW = Math.round(this._getEffectiveLimit());
          const currentW = Math.round(currentPower);
          const overW = currentW - limitW;
          this._fireTrigger('all_devices_exhausted', { power: currentW, limit: limitW, over: overW });
          this.homey.notifications.createNotification({
            excerpt: `⚡ Power Guard: ${currentW}W — ${overW}W over grensen (${limitW}W). Alle enheter er dempet.`,
          }).catch(err => this.error('[Notification] Failed:', err.message));
          this.log(`[Mitigation] All devices exhausted, still ${overW}W over limit — trigger + notification sent`);
          this._appLogEntry('mitigation', `Alle enheter uttømt: ${overW}W over grensen`);
        }
      }
    } finally {
      release();
    }
  }

  _canMitigate(entry) {
    const minRuntime = (entry.minRuntimeSeconds || 0) * 1000;
    if (entry.startedAt && Date.now() - entry.startedAt < minRuntime) return false;
    return true;
  }

  /**
   * Update per-device communication reliability.
   * Exponential moving average: 99% old + 1% new.
   * comErrors increments on failure, resets on success.
   * Unreliable devices are sorted to the end of the priority list.
   */
  _updateDeviceReliability(deviceId, success) {
    if (!this._deviceReliability[deviceId]) {
      this._deviceReliability[deviceId] = { comErrors: 0, reliability: 1.0 };
    }
    const r = this._deviceReliability[deviceId];
    r.reliability = 0.99 * r.reliability + 0.01 * (success ? 1 : 0);
    if (success) {
      r.comErrors = 0;
    } else {
      r.comErrors += 1;
    }
  }

  /**
   * Returns the comError count for a device (0 if unknown = treat as reliable).
   */
  _getDeviceComErrors(deviceId) {
    return (this._deviceReliability[deviceId] || { comErrors: 0 }).comErrors;
  }

  // ─── Restore ──────────────────────────────────────────────────────────────

  /**
   * Dynamic restore guard:
   * After a device is turned OFF, wait longer if we have lots of time left in the current hour.
   * This prevents rapid on/off cycling of high-power devices when there's budget pressure.
   * Wait = 5 min if >30 min left in hour, 1 min if <5 min left, linear in between.
   */
  _getDynamicRestoreWaitMs() {
    if (!this._settings.dynamicRestoreGuard) return 0;
    const msToNextHour = 3600000 - (Date.now() % 3600000);
    const MAX_WAIT = 5 * 60 * 1000;  // 5 min when >30 min left
    const MIN_WAIT = 1 * 60 * 1000;  // 1 min when <5 min left
    const T_MAX = 30 * 60 * 1000;
    const T_MIN = 5 * 60 * 1000;
    if (msToNextHour >= T_MAX) return MAX_WAIT;
    if (msToNextHour <= T_MIN) return MIN_WAIT;
    return MIN_WAIT + (MAX_WAIT - MIN_WAIT) * ((msToNextHour - T_MIN) / (T_MAX - T_MIN));
  }

  async _triggerRestore(smoothedPower) {
    if (!this._api) return;
    const release = await this._mutex.acquire();
    try {
      // Never auto-restore dynamic_current (EV charger) entries here.
      // Charger current is managed exclusively by _adjustEVChargersForPower, which already
      // ramps current back up when budget allows. If _triggerRestore ran here it would send
      // the charger straight back to 32A the moment power dips under the limit — undoing
      // the EV adjust work and causing an infinite oscillation loop (32A → step down →
      // under limit → restore to 32A → step down → ...).
      //
      // IMPORTANT: find the last NON-charger entry so that a charger sitting at the end of
      // _mitigatedDevices doesn't permanently block thermostats/water heaters from restoring.
      let toRestoreIdx = -1;
      for (let i = this._mitigatedDevices.length - 1; i >= 0; i--) {
        const m = this._mitigatedDevices[i];
        if (m.action !== 'dynamic_current' && !m.evProactive) {
          toRestoreIdx = i;
          break;
        }
      }
      if (toRestoreIdx < 0) return; // Nothing to restore (only EV charger or proactive entries)
      const toRestore = this._mitigatedDevices[toRestoreIdx];

      // Post-mitigation cooldown: block ALL restores for 240 s after the last mitigation event.
      // This is a safety net for cases where the headroom guard can't fire because the device
      // had 0W / unknown power at snapshot time (e.g. water heater in passive cycle).
      if (this._lastMitigationTime > 0) {
        const cooldownRemaining = RESTORE_COOLDOWN_MS - (Date.now() - this._lastMitigationTime);
        if (cooldownRemaining > 0) {
          this.log(`[Restore] Post-mitigation cooldown: ${Math.round(cooldownRemaining / 1000)}s remaining — skipping restore`);
          return;
        }
      }

      // Headroom guard: refuse to restore if projected power (current + device's stored draw)
      // would push us over the limit. This prevents the charger+water-heater oscillation where
      // the heater turns off → charger ramps up → heater turns back on → over limit → repeat.
      //
      // Fix B: account for EV charger settling windows.
      // HAN meter readings lag up to 10 s behind reality. If a charger just received a ramp-up
      // command (commandTime < 20 s ago), its actual draw may already be higher than smoothedPower
      // shows. We compute a settlingDelta — sum of (expected − measured) for settling chargers —
      // and add it to smoothedPower before the headroom check so we don't restore a thermostat
      // while the charger is still mid-ramp.
      if (smoothedPower != null && toRestore.action !== 'dynamic_current') {
        const devicePowerW = toRestore.previousState && toRestore.previousState.measurePower;
        if (devicePowerW && devicePowerW > 50) {
          const limit = this._getEffectiveLimit();

          // Compute extra power that settling chargers have commanded but HAN hasn't measured yet.
          let settlingDelta = 0;
          const now = Date.now();
          const settlingChargers = (this._settings.priorityList || []).filter(e =>
            e.enabled !== false && e.action === 'dynamic_current' && this._isCarConnected(e.deviceId)
          );
          for (const ce of settlingChargers) {
            const cState = this._chargerState[ce.deviceId];
            if (!cState?.commandTime || (now - cState.commandTime) >= 20000 || cState.lastCommandA == null) continue;
            const evData = this._evPowerData[ce.deviceId];
            const phases = evData?.detectedPhases || ce.chargerPhases || 3;
            const voltage = phases * 230;
            const measuredPw = evData?.powerW || 0;
            const expectedPw = cState.lastCommandA * voltage;
            if (expectedPw > measuredPw) settlingDelta += (expectedPw - measuredPw);
          }

          const effectivePower = smoothedPower + settlingDelta;
          const projected = effectivePower + devicePowerW;
          if (projected > limit * 0.95) {
            this.log(`[Restore] Headroom guard: projected ${Math.round(projected)}W (effective ${Math.round(effectivePower)}W [measured ${Math.round(smoothedPower)}W + settling ${Math.round(settlingDelta)}W] + device ${Math.round(devicePowerW)}W) vs limit ${Math.round(limit)}W — skipping restore`);
            return;
          }
        }
      }

      // Dynamic global guard: must wait N minutes after last device-off before restoring anything
      const dynamicWaitMs = this._getDynamicRestoreWaitMs();
      const timeSinceOff = Date.now() - this._lastDeviceOffTime;
      if (dynamicWaitMs > 0 && timeSinceOff < dynamicWaitMs) {
        this.log(`[Restore] Dynamic guard active: ${Math.round((dynamicWaitMs - timeSinceOff) / 1000)}s remaining (time left in hour ${Math.round((3600000 - Date.now() % 3600000) / 60000)}min)`);
        return;
      }

      const entry = (this._settings.priorityList || []).find(e => e.deviceId === toRestore.deviceId);
      const minOffTime = ((entry && entry.minOffTimeSeconds) || 0) * 1000;
      if (Date.now() - toRestore.mitigatedAt < minOffTime) return;

      try {
        const device = await withTimeout(
          this._api.devices.getDevice({ id: toRestore.deviceId }),
          10000, `getDevice(${toRestore.deviceId})`
        );
        if (!device) { this._mitigatedDevices.splice(toRestoreIdx, 1); this._persistMitigatedDevices(); return; }

        const restored = await restoreDevice(device, toRestore.action, toRestore.previousState);
        if (restored) {
          this._mitigatedDevices.splice(toRestoreIdx, 1);
          this._addLog(`Restored: ${device.name}`);
          this._appLogEntry('mitigation', `Restored: ${device.name}`);
          this._persistMitigatedDevices();
          // Clear alarm if no non-charger devices remain mitigated AND no charger is paused/throttled
          const anyNonChargerLeft = this._mitigatedDevices.some(m => m.action !== 'dynamic_current');
          const anyChargerLimited = this._mitigatedDevices.some(m =>
            m.action === 'dynamic_current' && (m.currentTargetA === 0 || m.currentTargetA === null || m.currentTargetA < (m.previousState?.targetCurrent || 32))
          );
          if (!anyNonChargerLeft && !anyChargerLimited) {
            this._fireTrigger('mitigation_cleared', { device_name: device.name });
            await this._updateVirtualDevice({ alarm: false });
          }
        } else {
          // restoreDevice returned false (e.g. action no longer matches device capabilities).
          // Remove the stuck entry so it doesn't block all future restores.
          this.log(`[Restore] restoreDevice returned false for ${device.name} (action=${toRestore.action}) — removing stuck entry`);
          this._mitigatedDevices.splice(toRestoreIdx, 1);
          this._persistMitigatedDevices();
          const anyNonChargerLeft2 = this._mitigatedDevices.some(m => m.action !== 'dynamic_current');
          const anyChargerLimited2 = this._mitigatedDevices.some(m =>
            m.action === 'dynamic_current' && (m.currentTargetA === 0 || m.currentTargetA === null || m.currentTargetA < (m.previousState?.targetCurrent || 32))
          );
          if (!anyNonChargerLeft2 && !anyChargerLimited2) {
            this._fireTrigger('mitigation_cleared', { device_name: device.name });
            await this._updateVirtualDevice({ alarm: false });
          }
        }
      } catch (err) {
        // If device was removed from Homey, clean up the stale mitigation entry
        const errMsg = (err.message || '').toLowerCase();
        if (errMsg.includes('not_found') || errMsg.includes('device_not_found') || errMsg.includes('timed out')) {
          this.log(`[Restore] Device ${toRestore.deviceId} gone or unreachable, removing stale entry`);
          this._mitigatedDevices.splice(toRestoreIdx, 1);
          this._persistMitigatedDevices();
          return;
        }
        this._updateDeviceReliability(toRestore.deviceId, false);
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
    this._triggerPowerLimitExceeded     = this.homey.flow.getTriggerCard('power_limit_exceeded');
    this._triggerMitigationApplied      = this.homey.flow.getTriggerCard('mitigation_applied');
    this._triggerMitigationCleared      = this.homey.flow.getTriggerCard('mitigation_cleared');
    this._triggerProfileChanged         = this.homey.flow.getTriggerCard('profile_changed');
    this._triggerModeChanged            = this.homey.flow.getTriggerCard('mode_changed');
    this._triggerChargerCurrentChanged  = this.homey.flow.getTriggerCard('charger_should_change_current');
    this._triggerChargerShouldPause     = this.homey.flow.getTriggerCard('charger_should_pause');
    this._triggerChargerShouldResume    = this.homey.flow.getTriggerCard('charger_should_resume');
    this._triggerAllDevicesExhausted    = this.homey.flow.getTriggerCard('all_devices_exhausted');

    const condEnabled = this.homey.flow.getConditionCard('guard_enabled');
    if (condEnabled) condEnabled.registerRunListener(() => this._settings.enabled);

    const condOverLimit = this.homey.flow.getConditionCard('is_over_limit');
    if (condOverLimit) condOverLimit.registerRunListener(() =>
      this._overLimitCount >= this._settings.hysteresisCount);

    const condProfile = this.homey.flow.getConditionCard('profile_is');
    if (condProfile) condProfile.registerRunListener((args) =>
      this._settings.profile === args.profile);

    const condMode = this.homey.flow.getConditionCard('mode_is');
    if (condMode) condMode.registerRunListener((args) =>
      this._modeSettings.activeMode === args.mode);

    const actEnable = this.homey.flow.getActionCard('enable_guard');
    if (actEnable) actEnable.registerRunListener(() => {
      this._settings.enabled = true;
      this.homey.settings.set('enabled', true);
      this._updateVirtualDevice({ onoff: true }).catch(() => {});
    });

    const actDisable = this.homey.flow.getActionCard('disable_guard');
    if (actDisable) actDisable.registerRunListener(() => {
      this._settings.enabled = false;
      this.homey.settings.set('enabled', false);
      this._updateVirtualDevice({ onoff: false }).catch(() => {});
    });

    const actProfile = this.homey.flow.getActionCard('set_profile');
    if (actProfile) actProfile.registerRunListener((args) => this._setProfile(args.profile));

    const actMode = this.homey.flow.getActionCard('set_mode');
    if (actMode) actMode.registerRunListener((args) => this.activateMode(args.mode));

    const actReset = this.homey.flow.getActionCard('reset_statistics');
    if (actReset) actReset.registerRunListener(() => this._resetStatistics());

    const actReportPower = this.homey.flow.getActionCard('report_power');
    if (actReportPower) actReportPower.registerRunListener((args) => {
      const watts = Number(args.power_w);
      if (isNaN(watts) || watts < 0) throw new Error('Invalid power value');
      this.log(`[HAN] Flow-reported power reading: ${Math.round(watts)}W`);
      this._appLogEntry('han', `Flow-reported power: ${Math.round(watts)}W`);
      this._onPowerReading(watts);
    });

    const actSuspendHan = this.homey.flow.getActionCard('suspend_han_monitoring');
    if (actSuspendHan) actSuspendHan.registerRunListener((args) => {
      const minutes = Math.min(Math.max(Number(args.duration_minutes) || 10, 1), 60);
      this._hanSuspendedUntil = Date.now() + minutes * 60 * 1000;
      this.log(`[HAN] Monitoring suspended for ${minutes} min via Flow (until ${timestamp(new Date(this._hanSuspendedUntil))})`);
      this._appLogEntry('han', `HAN monitoring suspended for ${minutes} min via Flow`);
      this._cacheStatus();
    });

    const actEvBattery = this.homey.flow.getActionCard('report_ev_battery');
    if (actEvBattery) {
      actEvBattery.registerArgumentAutocompleteListener('charger', async (query) => {
        const list = (this._settings.priorityList || []).filter(e => e.batteryCapacityKwh || e.carDeviceId);
        return list
          .filter(e => !query || e.name.toLowerCase().includes(query.toLowerCase()))
          .map(e => ({ id: e.deviceId, name: e.name }));
      });
      actEvBattery.registerRunListener(async (args) => {
        const deviceId   = args.charger && args.charger.id;
        const batteryPct = Number(args.battery_pct);
        if (!deviceId || isNaN(batteryPct)) throw new Error('Invalid charger or battery level');
        this.reportEvBattery(deviceId, batteryPct);
      });
    }

    const actEvPower = this.homey.flow.getActionCard('report_ev_power');
    if (actEvPower) {
      actEvPower.registerArgumentAutocompleteListener('charger', async (query) => {
        const list = (this._settings.priorityList || []).filter(e =>
          e.enabled !== false && e.action === 'dynamic_current'
        );
        return list
          .filter(e => !query || e.name.toLowerCase().includes(query.toLowerCase()))
          .map(e => ({ id: e.deviceId, name: e.name }));
      });
      actEvPower.registerRunListener(async (args) => {
        const deviceId = args.charger && args.charger.id;
        const powerW   = typeof args.power === 'number' ? args.power : parseFloat(args.power);
        if (!deviceId) throw new Error('Invalid charger');
        if (isNaN(powerW) || powerW < 0) throw new Error('Invalid power value');
        if (!this._evPowerData[deviceId]) this._evPowerData[deviceId] = {};
        this._evPowerData[deviceId].powerW = powerW;
        if (powerW > 100) this._evPowerData[deviceId].lastActiveMs = Date.now();
        this.log(`[EV] Flow reported power: ${args.charger.name} = ${powerW}W`);
      });
    }

    const actEvConnected = this.homey.flow.getActionCard('report_ev_car_connected');
    if (actEvConnected) {
      actEvConnected.registerArgumentAutocompleteListener('charger', async (query) => {
        const list = (this._settings.priorityList || []).filter(e =>
          e.enabled !== false && e.action === 'dynamic_current'
        );
        return list
          .filter(e => !query || e.name.toLowerCase().includes(query.toLowerCase()))
          .map(e => ({ id: e.deviceId, name: e.name }));
      });
      actEvConnected.registerRunListener(async (args) => {
        const deviceId  = args.charger && args.charger.id;
        const connected = args.connected === 'true';
        if (!deviceId) throw new Error('Invalid charger');
        if (!this._evPowerData[deviceId]) this._evPowerData[deviceId] = {};
        this._evPowerData[deviceId].carConnectedAlarm = connected;
        this.log(`[EV] Flow reported car ${connected ? 'connected' : 'disconnected'}: ${args.charger.name}`);
        this._addLog(`EV car ${connected ? 'tilkoblet' : 'frakoblet'} (flow): ${args.charger.name}`);
      });
    }

    const actSetActiveCar = this.homey.flow.getActionCard('set_active_car');
    if (actSetActiveCar) {
      actSetActiveCar.registerArgumentAutocompleteListener('charger', async (query) => {
        const list = (this._settings.priorityList || []).filter(e =>
          e.enabled !== false && e.action === 'dynamic_current'
        );
        return list
          .filter(e => !query || e.name.toLowerCase().includes(query.toLowerCase()))
          .map(e => ({ id: e.deviceId, name: e.name }));
      });
      actSetActiveCar.registerRunListener(async (args) => {
        const deviceId   = args.charger && args.charger.id;
        const batteryKwh = Number(args.battery_kwh);
        const targetPct  = Number(args.target_pct);
        if (!deviceId) throw new Error('Invalid charger');
        if (isNaN(batteryKwh) || batteryKwh <= 0) throw new Error('Invalid battery capacity');
        if (isNaN(targetPct) || targetPct < 0 || targetPct > 100) throw new Error('Invalid target percentage');
        if (!this._activeCarOverride) this._activeCarOverride = {};
        this._activeCarOverride[deviceId] = { capacityKwh: batteryKwh, targetPct, setAt: Date.now() };
        this.log(`[EV] Active car override: ${args.charger.name} → ${batteryKwh}kWh, target ${targetPct}%`);
        this._appLogEntry('charger', `Aktiv bil satt for ${args.charger.name}: ${batteryKwh}kWh, mål ${targetPct}%`);
        // Re-calculate hoursNeeded immediately using current battery % if known
        const bst = this._evBatteryState[deviceId];
        if (bst && typeof bst.pct === 'number') {
          this.reportEvBattery(deviceId, bst.pct);
        } else {
          this._fetchAndEvaluatePrices().catch(() => {});
        }
      });
    }
  }

  _fireTrigger(id, tokens) {
    const map = {
      power_limit_exceeded:   this._triggerPowerLimitExceeded,
      mitigation_applied:     this._triggerMitigationApplied,
      mitigation_cleared:     this._triggerMitigationCleared,
      profile_changed:        this._triggerProfileChanged,
      mode_changed:           this._triggerModeChanged,
      all_devices_exhausted:  this._triggerAllDevicesExhausted,
    };
    const card = map[id];
    if (!card) return;
    // Ensure device_name is always a string — Homey rejects undefined token values
    const safeTokens = Object.assign({}, tokens);
    if ('device_name' in safeTokens) safeTokens.device_name = String(safeTokens.device_name || 'Unknown');
    card.trigger(safeTokens).catch((err) => this.error('Trigger error:', err));
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
    this._appLog.push({ time: timestamp(), category: category, message: message });
    if (this._appLog.length > 500) this._appLog.shift();
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
        voltageSystem: s.get('voltageSystem') ?? 'auto',
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
      measurePower:       obj.measure_power      ? obj.measure_power.value      : undefined,
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

  // ─── Performance / resource monitoring ───────────────────────────────────────

  /**
   * Track how long a named call took. Warns immediately if > 500 ms.
   * Stats are collected for _resourceMonitor() and reset every 5 min.
   */
  _trackCallTime(name, ms) {
    if (!this._perfStats) return;
    const s = this._perfStats.calls[name] || (this._perfStats.calls[name] = { count: 0, total: 0, max: 0 });
    s.count++;
    s.total += ms;
    if (ms > s.max) s.max = ms;
    if (ms > 500) this.log(`[Perf] SLOW ${name}: ${ms}ms`);
  }

  /**
   * Logs CPU and memory usage every 5 minutes.
   * Check Homey app log for [Perf] lines to see resource trends.
   * Calls are sorted by total accumulated time — the top entry is the biggest CPU consumer.
   */
  _resourceMonitor() {
    try {
      // process.memoryUsage() reads /proc/self/statm which is unavailable in Homey's sandbox
      // Wrap separately so CPU and call stats still work if memory fails
      let memLine = '[Perf] RAM: n/a';
      try {
        const mem = process.memoryUsage();
        const toMB = b => (b / 1048576).toFixed(1);
        memLine = `[Perf] RAM: rss=${toMB(mem.rss)}MB heap=${toMB(mem.heapUsed)}/${toMB(mem.heapTotal)}MB`;
      } catch (_) {}

      const cpuDelta = process.cpuUsage(this._perfStats.cpuSample);
      this._perfStats.cpuSample = process.cpuUsage();
      const cpuMs = Math.round((cpuDelta.user + cpuDelta.system) / 1000);
      memLine += ` | CPU(5min): ${cpuMs}ms`;

      this.log(memLine);
      this._appLogEntry('system', memLine);

      const objLine =
        `[Perf] evChargers=${Object.keys(this._evPowerData || {}).length}` +
        ` adax=${Object.keys(this._adaxState || {}).length}` +
        ` powerDevices=${Object.keys(this._powerConsumptionData || {}).length}` +
        ` appLog=${(this._appLog || []).length}` +
        ` saveQueue=${(this._saveQueue || []).length}`;
      this.log(objLine);
      this._appLogEntry('system', objLine);

      const calls = Object.entries(this._perfStats.calls);
      if (calls.length > 0) {
        // Sort by total time descending — first entry = biggest CPU consumer
        calls.sort((a, b) => b[1].total - a[1].total);
        const parts = calls.map(([k, v]) => {
          const avg = Math.round(v.total / v.count);
          return `${k}:avg=${avg}ms max=${v.max}ms tot=${v.total}ms`;
        });
        const callLine = `[Perf] Calls: ${parts.join(' | ')}`;
        this.log(callLine);
        this._appLogEntry('system', callLine);

        const [topName, topV] = calls[0];
        if (topV.total > 60000) {
          const warnLine = `[Perf] ADVARSEL: "${topName}" brukte ${topV.total}ms på 5min — undersøk denne`;
          this.log(warnLine);
          this._appLogEntry('system', warnLine);
        }
      }
      this._perfStats.calls = {}; // Reset for next window
    } catch (e) {
      this.error('[Perf] Monitor error:', e.message);
      this._appLogEntry('system', '[Perf] FEIL: ' + e.message);
    }
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
          const ownerUri = (d.driver && d.driver.owner_uri) || d.driverId || '';

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
            caps.includes('evcharger_charging') ||
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
            isEasee:      (d.driverId === 'charger' && d.driver && d.driver.owner_uri === 'homey:app:no.easee'),
            isZaptec:     (d.class === 'evcharger' && d.driver && d.driver.owner_uri === 'homey:app:com.zaptec'),
            isEnua:       (d.driver && d.driver.owner_uri === 'homey:app:no.enua'),
            isAdax:       (d.driverId || '').includes('no.adax') || (d.driver && d.driver.owner_uri === 'homey:app:no.adax.smart-heater.homey-app'),
            isHoiax:      (d.driverId || '').includes('no.hoiax') || (d.driver && d.driver.owner_uri === 'homey:app:no.hoiax'),
            zbProductId:  (d.settings && d.settings.zb_product_id) ? String(d.settings.zb_product_id) : null,
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
   * No-op: charger limits are now managed entirely by the charger's own app.
   * Power Guard only adjusts dynamic current (ID48) up/down and never touches
   * the permanent Ladergrense (target_charger_current / ID47).
   */
  async applyCircuitLimitsToChargers() {
    this.log('[CircuitLimit] Skipped — charger limits managed by charger\'s own app');
    return { ok: true, results: [] };
  }

  /**
   * Check if a car is physically connected to a charger.
   * Uses WHITELIST approach: only returns true when we have positive evidence.
   * Easee statuses: 1=disconnected, 2=awaiting_start, 3=charging, 4=completed, 5=error
   * If status is unknown/null/unrecognized → assume NOT connected (safe default).
   */
  _isCarConnected(deviceId) {
    // Flow-controlled chargers: use real signals (car_connected alarm, power draw,
    // recent command) instead of always returning true. Without this check PG ramps
    // up endlessly even when no car is plugged in (0W).
    const _fcEntry = (this._settings.priorityList || []).find(e => e.deviceId === deviceId);
    if (_fcEntry?.flowControlled) {
      const evData = this._evPowerData[deviceId];
      const cState = this._chargerState?.[deviceId] || {};
      // Zaptec exposes alarm_generic.car_connected — use it if available
      if (evData?.carConnectedAlarm != null) return evData.carConnectedAlarm === true;
      // Fallback: consider connected if drawing power or recently commanded (2min grace for startup)
      const powerW = evData?.powerW || 0;
      const recentCommand = cState.commandTime && (Date.now() - cState.commandTime) < 120000;
      return powerW > 50 || recentCommand;
    }

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
      // Easee: cable plugged in but not actively charging (paused by PG or awaiting car)
      'Car connected', 'car_connected', 'CAR_CONNECTED', 'CarConnected',
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

  /**
   * Called by the 'report_ev_battery' flow action (and POST /ev-battery-report).
   * Stores battery state and re-calculates hours needed to reach the target charge level.
   * Triggers an immediate price engine re-evaluation so deadline logic applies right away.
   *
   * @param {string} deviceId   - charger deviceId from priorityList
   * @param {number} batteryPct - current battery level 0–100
   */
  reportEvBattery(deviceId, batteryPct) {
    const entry = (this._settings.priorityList || []).find(
      e => e.deviceId === deviceId && (e.batteryCapacityKwh || e.carDeviceId)
    );
    if (!entry) {
      this.log(`[EV Battery] No battery-configured entry for ${deviceId}`);
      return;
    }

    // Use temporary override (set_active_car flow) if present and recent (48h)
    const override = this._activeCarOverride && this._activeCarOverride[deviceId];
    const overrideAge = override ? Date.now() - override.setAt : Infinity;
    const useOverride = override && overrideAge < 48 * 3600 * 1000;

    const capacityKwh = useOverride ? override.capacityKwh : entry.batteryCapacityKwh;
    const targetPct   = useOverride ? override.targetPct   : (entry.targetChargePercent ?? 80);
    const phases      = entry.chargerPhases       || 1;
    const circuitA    = entry.circuitLimitA       || 16;
    const chargerKw   = (circuitA * 230 * phases) / 1000;

    let hoursNeeded = null;
    if (typeof capacityKwh === 'number' && capacityKwh > 0) {
      const pctNeeded = Math.max(0, targetPct - batteryPct);
      hoursNeeded = Math.round((pctNeeded / 100) * capacityKwh / chargerKw * 10) / 10;
    }

    this._evBatteryState[deviceId] = {
      pct:         batteryPct,
      hoursNeeded: hoursNeeded,
      updatedAt:   Date.now(),
    };

    this.log(`[EV Battery] ${entry.name}: ${batteryPct}% → needs ${hoursNeeded}h (${capacityKwh}kWh @ ${chargerKw.toFixed(1)}kW, target ${targetPct}%)`);
    this._appLogEntry('charger', `EV battery report: ${entry.name} ${batteryPct}% → ${hoursNeeded !== null ? hoursNeeded + 'h needed' : 'capacity not configured'}`);

    // Trigger price re-evaluation so deadline logic uses the new hoursNeeded.
    // Cooldown: skip if prices were evaluated within the last 5 minutes — the next
    // scheduled evaluation will pick up the updated battery state anyway, and making
    // repeated HTTP requests to hvakosterstrommen.no on every Flow invocation is wasteful.
    const timeSinceLastEval = this._priceState ? Date.now() - this._priceState.updatedAt : Infinity;
    if (timeSinceLastEval > 5 * 60 * 1000) {
      this._fetchAndEvaluatePrices().catch(err => this.error('[EV Battery] Price re-eval error:', err));
    } else {
      this.log(`[EV Battery] Skipping price re-eval — last eval was ${Math.round(timeSinceLastEval / 1000)}s ago`);
    }
  }

  /**
   * Poll battery % from the linked car Homey device and feed it into reportEvBattery().
   * @param {string} chargerId - deviceId of the EV charger in priorityList
   */
  async _pollCarBattery(chargerId) {
    const entry = (this._settings.priorityList || []).find(
      e => e.deviceId === chargerId && e.carDeviceId
    );
    if (!entry) return;
    const BATTERY_CAPS = ['measure_battery', 'batterylevel', 'battery', 'ev_battery_level', 'battery_level'];
    try {
      const device = await withTimeout(
        this._api.devices.getDevice({ id: entry.carDeviceId }),
        8000, `pollCarBattery(${entry.carDeviceId})`
      );
      if (!device) return;
      const obj = device.capabilitiesObj || {};
      const cap = BATTERY_CAPS.find(c => obj[c] != null);
      if (!cap) {
        this.log(`[CarBattery] ${entry.name}: no battery capability found on linked car device`);
        return;
      }
      const pct = obj[cap].value;
      if (typeof pct !== 'number') return;
      this.log(`[CarBattery] ${entry.name}: read ${Math.round(pct)}% from car device (${cap})`);
      this.reportEvBattery(chargerId, Math.round(pct));
    } catch (err) {
      this.log(`[CarBattery] ${entry.name}: poll failed — ${err.message}`);
    }
  }

  /** Poll battery % for all chargers that have a linked car device */
  async _pollAllCarBatteries() {
    if (!this._api) return;
    const priceChargers = (this._settings.priorityList || []).filter(
      e => e.carDeviceId
    );
    for (const entry of priceChargers) {
      await this._pollCarBattery(entry.deviceId);
    }
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
        const _devOwner = (device.driver && device.driver.owner_uri) || device.driverId || '';
        if (_devOwner.includes('com.zaptec') && !caps.some(c => _zaptecChargeCaps.includes(c))) {
          this.log(`[Zaptec] "${entry.name}" (${entry.deviceId}) appears to be the Zaptec meter/installation device. Searching for real charger...`);
          try {
            const allDevs = await withTimeout(this._api.devices.getDevices(), 10000, 'getAllDevicesForZaptecRedirect');
            const realCharger = Object.values(allDevs).find(d => {
              const dCaps = d.capabilities || [];
              const dOwner = (d.driver && d.driver.owner_uri) || d.driverId || '';
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
        const initialPw = obj.measure_power ? (obj.measure_power.value || 0) : 0;
        this._evPowerData[entry.deviceId] = {
          name:           entry.name || device.name,
          powerW:         initialPw,
          isCharging:     obj.onoff ? obj.onoff.value !== false
                        : obj.toggleChargingCapability ? obj.toggleChargingCapability.value !== false
                        : obj.charging_button ? obj.charging_button.value !== false
                        : obj.evcharger_charging ? obj.evcharger_charging.value !== false
                        : false,
          chargerStatus:  obj.charger_status ? obj.charger_status.value
                        : obj.chargerStatusCapability ? obj.chargerStatusCapability.value
                        : null,
          carConnectedAlarm: obj['alarm_generic.car_connected'] ? obj['alarm_generic.car_connected'].value : null,
          offeredCurrent: obj['measure_current.offered'] ? obj['measure_current.offered'].value : null,
          isConnected:    null,  // derived below
          lastActiveMs:   initialPw > 100 ? Date.now() : 0,  // last time charger drew >100W
        };

        // Derive connected state using whitelist approach
        this._evPowerData[entry.deviceId].isConnected = this._isCarConnected(entry.deviceId);

        // On startup: if charger is already running, Power Guard takes control immediately.
        // _adjustEVChargersForPower will detect the untracked-but-running charger and set it to
        // 6A on the first HAN reading. No immunity window — we always start from 6A and ramp up.

        // Listen to measure_power changes
        if (caps.includes('measure_power')) {
          const pwrInst = device.makeCapabilityInstance('measure_power', (value) => {
            if (this._evPowerData[entry.deviceId]) {
              const pw = typeof value === 'number' ? value : 0;
              this._evPowerData[entry.deviceId].powerW = pw;
              if (pw > 100) this._evPowerData[entry.deviceId].lastActiveMs = Date.now();
            }
          });
          this._evCapabilityInstances[entry.deviceId + '_power'] = pwrInst;
        }

        // Listen to charger_status changes (Easee specific)
        if (caps.includes('charger_status')) {
          const csInst = device.makeCapabilityInstance('charger_status', (value) => {
            if (this._evPowerData[entry.deviceId]) {
              const wasConnected = this._evPowerData[entry.deviceId].isConnected;
              this._evPowerData[entry.deviceId].chargerStatus = value;
              this._evPowerData[entry.deviceId].isConnected = this._isCarConnected(entry.deviceId);
              this.log(`[EV] ${entry.name} charger_status changed to: ${value} → connected: ${this._evPowerData[entry.deviceId].isConnected}`);
              this._appLogEntry('charger', `${entry.name} status: ${value} → connected: ${this._evPowerData[entry.deviceId].isConnected}`);
              // Car just connected — poll battery from linked car device
              if (!wasConnected && this._evPowerData[entry.deviceId].isConnected) {
                this._pollCarBattery(entry.deviceId).catch(() => {});
                // New physical session (car unplugged + replugged) — reset the charging-complete
                // notification flag so the next completed charge sends a fresh notification.
                // This is the ONLY place this flag should be reset — doing it here (on true
                // disconnect→connect transition) prevents Norgespris/flat-rate users from getting
                // repeated notifications when PG resumes the charger after a completed session.
                if (!this._chargerState[entry.deviceId]) this._chargerState[entry.deviceId] = {};
                this._chargerState[entry.deviceId].chargingCompleteNotified = false;
              }
              // Charger reported Completed mid-session: re-issue the current command so
              // the session restarts. This happens when the car briefly resets after a
              // pause/resume cycle and the charger thinks the session ended.
              const completedStatuses = ['completed', 'COMPLETED', 'Completed', 4];
              if (completedStatuses.includes(value)) {
                const tracked = this._mitigatedDevices.find(m => m.deviceId === entry.deviceId && m.currentTargetA > 0);
                if (tracked) {
                  this._appLogEntry('charger', `${entry.name} reported Completed mid-session — re-issuing ${tracked.currentTargetA}A in 3s`);
                  setTimeout(() => {
                    this._setEaseeChargerCurrent(entry.deviceId, tracked.currentTargetA).catch(() => {});
                  }, 3000);
                }
              }
            }
          });
          this._evCapabilityInstances[entry.deviceId + '_status'] = csInst;
        }

        // Listen to chargerStatusCapability changes (Enua specific)
        if (caps.includes('chargerStatusCapability')) {
          const enuaStatusInst = device.makeCapabilityInstance('chargerStatusCapability', (value) => {
            if (this._evPowerData[entry.deviceId]) {
              const wasConnected = this._evPowerData[entry.deviceId].isConnected;
              this._evPowerData[entry.deviceId].chargerStatus = value;
              this._evPowerData[entry.deviceId].isConnected = this._isCarConnected(entry.deviceId);
              // Cross-link: also update isCharging from status
              this._evPowerData[entry.deviceId].isCharging = (value === 'Charging');
              this.log(`[EV] ${entry.name} chargerStatusCapability changed to: ${value} → connected: ${this._evPowerData[entry.deviceId].isConnected}, charging: ${this._evPowerData[entry.deviceId].isCharging}`);
              this._appLogEntry('charger', `${entry.name} Enua status: ${value} → connected: ${this._evPowerData[entry.deviceId].isConnected}, charging: ${this._evPowerData[entry.deviceId].isCharging}`);
              // Car just connected — poll battery from linked car device
              if (!wasConnected && this._evPowerData[entry.deviceId].isConnected) {
                this._pollCarBattery(entry.deviceId).catch(() => {});
              }
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
            const d = this._evPowerData[entry.deviceId];
            if (d) {
              d.carConnectedAlarm = value;
              d.isConnected = this._isCarConnected(entry.deviceId);
              this.log(`[EV] ${entry.name} alarm_generic.car_connected changed to: ${value} → connected: ${d.isConnected}`);
              // Car unplugged — reset any synthesised Completed so the next session starts clean
              if (!value) {
                d.zeroPowerSince      = null;
                if (d._completedSynthesised) {
                  d.chargerStatus        = null;
                  d._completedSynthesised = false;
                }
              }
            }
          });
          this._evCapabilityInstances[entry.deviceId + '_car_connected'] = carInst;
        }

        // Listen to evcharger_charging changes (FutureHome specific)
        if (caps.includes('evcharger_charging')) {
          const fhInst = device.makeCapabilityInstance('evcharger_charging', (value) => {
            if (this._evPowerData[entry.deviceId]) {
              this._evPowerData[entry.deviceId].isCharging = value !== false;
              this.log(`[EV] ${entry.name} evcharger_charging changed to: ${value}`);
            }
          });
          this._evCapabilityInstances[entry.deviceId + '_evcharger_charging'] = fhInst;
        }

        // Listen to charging_button changes (Zaptec specific)
        if (caps.includes('charging_button')) {
          const btnInst = device.makeCapabilityInstance('charging_button', (value) => {
            const d = this._evPowerData[entry.deviceId];
            if (d) {
              const btnOn = value !== false;
              d.isCharging = btnOn;
              if (!btnOn && d.carConnectedAlarm === true && (d.powerW || 0) < 100) {
                d.chargerStatus = 'Completed'; // lading ferdig — Zaptec has no status capability
              } else if (btnOn && d.chargerStatus === 'Completed') {
                d.chargerStatus = null; // new session
              }
              this.log(`[EV] ${entry.name} charging_button changed to: ${value} → chargerStatus: ${d.chargerStatus ?? 'n/a'}`);
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
    this._evPollInterval = setInterval(async () => { const _t = Date.now(); await this._pollEVChargerData().catch(err => this.error('[EV] Poll error:', err)); this._trackCallTime('evPoll', Date.now() - _t); }, 5000);
    this.log('EV charger polling started (5s interval)');
  }

  /**
   * Check if a charger's offered current confirms our last command.
   * Updates confirmation state and reliability score per charger.
   * Called on offered-current capability updates and during polling.
   */
  _checkChargerConfirmation(deviceId) {
    const state = this._chargerState[deviceId];
    if (!state || state.confirmed || state.timedOut || state.lastCommandA == null) return;  // Already resolved or no pending command

    const evData = this._evPowerData[deviceId];
    if (!evData || evData.offeredCurrent == null) return;

    const now = Date.now();
    const elapsed = now - (state.commandTime || 0);

    // Easee chargers briefly offer full power (16A) when turning ON before enforcing
    // the dynamic limit. measure_current.offered updates with ~5-8s delay after a command.
    // Require minimum elapsed time before accepting confirmation to avoid matching stale values.
    const minConfirmMs = state.delayedConfirm ? 8000 : 0;

    // Check if offered current matches commanded current (within 1A)
    if (state.lastCommandA != null && elapsed >= minConfirmMs && Math.abs(evData.offeredCurrent - state.lastCommandA) <= 1) {
      state.confirmed = true;
      state.reliability = (state.reliability ?? 0.5) * 0.99 + 0.01;  // Success → nudge up
      this.log(`[EV] \u2713 Confirmed: ${evData.name} → ${evData.offeredCurrent}A (commanded ${state.lastCommandA}A, took ${Math.round(elapsed / 1000)}s, reliability=${(state.reliability * 100).toFixed(1)}%)`);
      this._appLogEntry('charger', `Confirmed: ${evData.name} → ${evData.offeredCurrent}A (commanded ${state.lastCommandA}A, ${Math.round(elapsed / 1000)}s)`);
    } else if (elapsed > (state.delayedConfirm ? 40000 : CHARGER_DEFAULTS.confirmationTimeoutMs)) {
      // Timed out waiting for confirmation
      state.reliability = (state.reliability ?? 0.5) * 0.99;  // Failure → nudge down
      state.timedOut = true;  // Stop re-checking until next command
      this.log(`[EV] \u2717 Unconfirmed: ${evData.name} → offered ${evData.offeredCurrent}A but commanded ${state.lastCommandA}A (${Math.round(elapsed / 1000)}s, reliability=${(state.reliability * 100).toFixed(1)}%)`);
      this._appLogEntry('charger', `Unconfirmed: ${evData.name} → offered ${evData.offeredCurrent}A but commanded ${state.lastCommandA}A (${Math.round(elapsed / 1000)}s)`);

      // If the charger settled below what was commanded, learn that as its effective max.
      // This handles any charger whose hardware or firmware cap is lower than the configured
      // circuitLimitA — next budget calculation will respect the real ceiling automatically.
      // Skip when offered current has delayed confirmation — the stale reading
      // doesn't reflect the actual command, leading to false max learning.
      if (!state.delayedConfirm && evData.offeredCurrent < state.lastCommandA - 1 && evData.offeredCurrent >= CHARGER_DEFAULTS.minCurrent) {
        const prev = state.learnedMaxA ?? state.lastCommandA;
        state.learnedMaxA = Math.min(prev, Math.round(evData.offeredCurrent));
        this._appLogEntry('charger', `${evData.name} learned max: ${state.learnedMaxA}A (settled at ${evData.offeredCurrent}A, commanded ${state.lastCommandA}A)`);
      }
    }
  }

  /**
   * Poll all tracked EV chargers for fresh capability values.
   * Ensures power/status updates even if the Easee driver doesn't fire events.
   */
  async _pollEVChargerData() {
    if (!this._api) return;
    // Include both dynamic_current AND charge_pause — Zaptec/Enua on charge_pause
    // were previously excluded, leaving their powerW/isCharging stale after restart.
    const entries = (this._settings.priorityList || []).filter(e =>
      (e.action === 'dynamic_current' || e.action === 'charge_pause') && e.enabled !== false
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

        // Snapshot previous state for change detection
        const prevConnected = data.isConnected;
        const prevCharging  = data.isCharging;
        const prevPowerW    = data.powerW;

        // Update power
        if (obj.measure_power && obj.measure_power.value != null) {
          data.powerW = typeof obj.measure_power.value === 'number' ? obj.measure_power.value : 0;
        }
        // Update charger_status (Easee)
        if (obj.charger_status && obj.charger_status.value != null) {
          data.chargerStatus = obj.charger_status.value;
          data.isConnected = this._isCarConnected(entry.deviceId);
        }
        // Update chargerStatusCapability (Enua)
        if (obj.chargerStatusCapability && obj.chargerStatusCapability.value != null) {
          data.chargerStatus = obj.chargerStatusCapability.value;
          data.isConnected = this._isCarConnected(entry.deviceId);
          data.isCharging = /^charging$/i.test(obj.chargerStatusCapability.value);
        }
        // Update toggleChargingCapability (Enua)
        if (obj.toggleChargingCapability && obj.toggleChargingCapability.value != null) {
          data.isCharging = obj.toggleChargingCapability.value !== false;
          data.isConnected = this._isCarConnected(entry.deviceId);
        }
        // Update charging_button (Zaptec)
        // Zaptec Go has no charger_status capability, so we synthesise 'Completed' when:
        //   charging_button = false  (Zaptec says "not charging")
        //   car_connected   = true   (car still physically plugged in)
        //   powerW          = 0      (no actual power draw)
        // Without this, _isCarConnected returns true forever (car_connected alarm) and
        // _adjustEVChargersForPower keeps ramping current endlessly even though lading er ferdig.
        if (obj.charging_button && obj.charging_button.value != null) {
          const btnOn = obj.charging_button.value !== false;
          data.isCharging = btnOn;
          if (!btnOn && data.carConnectedAlarm === true && (data.powerW || 0) < 100) {
            data.chargerStatus = 'Completed'; // synthesised — Zaptec "lading ferdig" + bil tilkoblet
          } else if (btnOn && data.chargerStatus === 'Completed') {
            data.chargerStatus = null; // new session started — clear synthesised status
          }
        }
        // Update onoff
        if (obj.onoff && obj.onoff.value != null) {
          data.isCharging = obj.onoff.value !== false;
        }
        // Update offered current
        if (obj['measure_current.offered'] && obj['measure_current.offered'].value != null) {
          data.offeredCurrent = typeof obj['measure_current.offered'].value === 'number' ? obj['measure_current.offered'].value : null;
        }
        // Update alarm_generic.car_connected (Zaptec)
        if (obj['alarm_generic.car_connected'] && obj['alarm_generic.car_connected'].value != null) {
          data.carConnectedAlarm = obj['alarm_generic.car_connected'].value;
          data.isConnected = this._isCarConnected(entry.deviceId);
        }

        // Stamp last confirmed charging time — used for grace window in status reporting
        if (data.isCharging === true || (data.powerW || 0) > 200) {
          data.lastChargingAt = Date.now();
        }

        // Log when connection or charging state changes
        const connChanged    = data.isConnected !== prevConnected;
        const chargingChanged = data.isCharging  !== prevCharging;
        const powerJump      = Math.abs((data.powerW || 0) - (prevPowerW || 0)) > 500;
        if (connChanged || chargingChanged || powerJump) {
          const graceAgo = data.lastChargingAt ? Math.round((Date.now() - data.lastChargingAt) / 1000) + 's ago' : 'never';
          this.log(`[EV Poll] ${entry.name}: connected=${data.isConnected} charging=${data.isCharging} power=${Math.round(data.powerW || 0)}W status=${data.chargerStatus ?? 'n/a'} lastCharging=${graceAgo}`);
          this._appLogEntry('charger', `${entry.name} status update: connected=${data.isConnected} charging=${data.isCharging} power=${Math.round(data.powerW || 0)}W`);
        }

        // Auto-detect charger phases from power/current ratio when actively charging.
        // 1-phase: ~230 W/A, 3-phase: ~690 W/A. Midpoint threshold at 460.
        // Requires 3 consecutive consistent readings before updating detectedPhases —
        // prevents a single low reading during charger ramp-up from wrongly setting 1-phase.
        // Primary: offeredCurrent (W/A ratio). Fallback: currentTargetA (what we sent as P1).
        // Zaptec Go lacks measure_current.offered, so we use currentTargetA as denominator.
        // A 1-phase Zaptec will ignore P2/P3 and only draw 1-phase power even if we send 3-phase,
        // so powerW/currentTargetA reliably reflects the charger's actual phase count.
        // Thresholds (W/A):  1-phase IT ≈133,  1-phase TN ≈230,  3-phase IT ≈400,  3-phase TN ≈690.
        // Threshold 300 separates 1-phase (≤230) from 3-phase (≥400) for both IT and TN networks.
        let _phaseDetectRef = null;
        // For flow-controlled chargers, entry.currentTargetA is never updated (commands go via
        // flow triggers, not written back to priorityList). Fall back to _chargerState.lastCommandA
        // which _handleFlowControlledCharger always sets when sending a command.
        const _sentAmps = entry.currentTargetA || this._chargerState[entry.deviceId]?.lastCommandA || 0;
        if (data.powerW > 200 && data.offeredCurrent > 0) {
          _phaseDetectRef = { method: 'offeredCurrent', ratio: data.powerW / data.offeredCurrent };
        } else if (data.powerW > 200 && _sentAmps >= 6) {
          // Fallback: use the last commanded P1 current as denominator.
          // Only valid when charger is actively drawing power at a known setpoint (≥6A).
          _phaseDetectRef = { method: 'sentCurrent', ratio: data.powerW / _sentAmps };
        }
        if (_phaseDetectRef) {
          const { ratio } = _phaseDetectRef;
          const detected = ratio < 300 ? 1 : 3;
          // Smooth W/A ratio with EMA (70% old, 30% new) to avoid display noise from
          // HAN meter instant-reading variance (±100–200W on a fixed ampere setpoint).
          // Do NOT update EMA when ratio is below minimum physical threshold — this
          // prevents BMS end-of-charge limiting (e.g. 9 W/A at full battery) from
          // corrupting the stored value. Min: 150 W/A (1-phase), 400 W/A (3-phase).
          const _wpaMin = ratio < 300 ? 150 : 400;
          if (ratio >= _wpaMin) {
            data.wattsPerAmp = data.wattsPerAmp
              ? Math.round(data.wattsPerAmp * 0.7 + ratio * 0.3)
              : Math.round(ratio);
          }
          if (!data._phaseVote || data._phaseVote.value !== detected) {
            data._phaseVote = { value: detected, count: 1 };
          } else {
            data._phaseVote.count++;
            if (data._phaseVote.count >= 3 && data.detectedPhases !== detected) {
              this.log(`[EV] ${entry.name} confirmed ${detected}-phase via ${_phaseDetectRef.method} (ratio ${ratio.toFixed(0)} W/A, 3 consistent readings)`);
              this._appLogEntry('charger', `${entry.name} detected ${detected}-phase charging (${ratio.toFixed(0)} W/A, method=${_phaseDetectRef.method})`);
              data.detectedPhases = detected;
              // Persist confirmed phase into priorityList so it survives restarts.
              // Skip if user has manually locked the phase count (chargerPhasesManual=true).
              const pl = this.homey.settings.get('priorityList') || [];
              const idx = pl.findIndex(e => e.deviceId === entry.deviceId);
              if (idx !== -1 && !pl[idx].chargerPhasesManual && pl[idx].chargerPhases !== detected) {
                pl[idx] = { ...pl[idx], chargerPhases: detected };
                this.homey.settings.set('priorityList', pl);
              }
            }
          }
        }

        // Zero-power timeout: Zaptec Go keeps charging_button=true even after the car
        // finishes charging. We can't rely on charging_button going false. If isCharging=true
        // but powerW stays below 50W for 3+ minutes while we're actively sending current
        // (≥6A), synthesise chargerStatus='Completed' so the charger loop stops ramping.
        // Reset when powerW rises above 200W (new charging session started).
        {
          const cState = this._chargerState[entry.deviceId];
          const sentA   = cState?.lastCommandA ?? 0;
          if (data.isCharging === true && (data.powerW || 0) < 50 && sentA >= 6) {
            if (!data.zeroPowerSince) data.zeroPowerSince = now;
          } else if ((data.powerW || 0) > 200) {
            data.zeroPowerSince = null;
            if (data._completedSynthesised) {
              data.chargerStatus      = null;
              data._completedSynthesised = false;
            }
          }
          if (data.zeroPowerSince && !data._completedSynthesised &&
              (now - data.zeroPowerSince) > 3 * 60 * 1000) {
            data.chargerStatus         = 'Completed';
            data._completedSynthesised = true;
            this.log(`[EV] ${entry.name}: 3-min zero-power timeout → synthesised chargerStatus='Completed' (isCharging=${data.isCharging}, sentA=${sentA}A)`);
            this._appLogEntry('charger', `${entry.name}: zero-power timeout → Completed (sentA=${sentA}A)`);
          }
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
   *  - Keeps charger at minimum 6A instead of pausing (keeps car charging)
   *  - Only pauses charger in true emergency (household alone exceeds limit)
   *  - Start threshold prevents restarting paused charger until enough headroom (6A startCurrent)
   *  - Confirmation tracking: reads measure_current.offered to verify commands took effect
   *  - Proportional current scaling when charger is active (smoother adjustments)
   *  - Multi-charger: available headroom is pooled and split evenly across all active chargers
   */
  /**
   * Proactively turn off non-EV devices when EV budget is insufficient to charge.
   * Priority list order is respected: top = turned off first.
   * When budget recovers or car disconnects, restores proactively shed devices.
   */
  async _proactiveEVLoadShed(smoothedPower) {
    if (!this._api) return;
    const now = Date.now();
    const limit = this._getEffectiveLimit();

    const connectedChargers = (this._settings.priorityList || []).filter(e =>
      e.enabled !== false && e.action === 'dynamic_current' && this._isCarConnected(e.deviceId)
    );

    // Calculate effective charger power using actual measured data only.
    // The settling window (commanded current) is intentionally NOT used here — during a step-down
    // the settling window uses the new lower commanded current, which inflates nonChargerUsage and
    // shrinks the budget, causing proactive shed to fire when it shouldn't. Real measured power is
    // always the correct basis for the shed/restore decision.
    //
    // offeredCurrent is only used as a fallback during the settling window (< 20 s after a command
    // was sent) — covering the lag between a ramp-up command and the HAN meter reflecting it.
    // Outside the settling window we trust measured power exclusively, which correctly handles:
    //   • Completed session (pw=0, offeredCurrent=16A stale) → 0W
    //   • Car-paused / bil nekter (pw=0, no recent command) → 0W
    //   • PG-paused (0A sent, offeredCurrent=0) → 0W
    const totalChargerPowerW = connectedChargers.reduce((sum, e) => {
      const evData = this._evPowerData[e.deviceId];
      const pw = evData?.powerW || 0;
      if (pw > 200) return sum + pw; // actively charging — use measured value directly
      // Low measured power: only use offeredCurrent estimate within settling window
      const cState = this._chargerState[e.deviceId];
      const inSettlingWindow = cState?.commandTime && (now - cState.commandTime) < 20000 && cState.lastCommandA > 0;
      if (!inSettlingWindow) return sum; // no recent command — trust that 0W means 0W
      const phases = evData?.detectedPhases || e.chargerPhases || 3;
      const voltage = phases * 230;
      const offered = evData?.offeredCurrent || 0;
      return sum + (offered > 0 ? offered * voltage : 0);
    }, 0);

    const nonChargerUsage = Math.max(0, smoothedPower - totalChargerPowerW);
    const budget = limit - nonChargerUsage;

    // Track last time any EV charger was actively drawing power (>100W).
    // Used to prevent restoring shed devices during brief charger pauses/adjustments.
    if (totalChargerPowerW > 100) this._evChargerLastActiveMs = now;

    // Phase-aware minimum budget: sum of minCurrent × voltage per connected charger.
    // A 1-phase charger needs only 6A × 230W = 1380W; a 3-phase needs 6A × 690W = 4140W.
    // Using a hardcoded 690W here would cause 1-phase users to shed heating devices 3× too early.
    //
    // Exclude chargers that will not be drawing power soon:
    //  - Price 'av' mode: intentionally paused by price engine, won't resume until next cheap hour
    //  - PG-paused: Power Guard itself paused the charger (currentTargetA === 0) because household
    //    load is already too high — protecting headroom for a charger PG can't run is pointless
    //    and causes thermostats to be shed for no benefit.
    const priceState = this._priceState;
    const activeChargers = connectedChargers.filter(e => {
      const mode = priceState?.chargeModes?.[e.deviceId] ?? priceState?.chargeMode;
      if (mode === 'av') return false;
      const mitigated = this._mitigatedDevices.find(m => m.deviceId === e.deviceId && m.action === 'dynamic_current');
      if (mitigated && (mitigated.currentTargetA === 0 || mitigated.currentTargetA === null)) return false;
      // Charging complete — car still plugged in but session is over, don't keep heaters shed
      const evD = this._evPowerData[e.deviceId];
      const chargingDone = (evD?.powerW || 0) < 100 &&
        [4, 'completed', 'COMPLETED', 'Completed'].includes(evD?.chargerStatus);
      if (chargingDone) return false;
      // Idle charger timeout — car plugged in but not charging for >5 min.
      // Prevents disco-effect where heaters shed/restore repeatedly for a parked car.
      const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
      const lastActive = evD?.lastActiveMs || 0;
      if ((evD?.powerW || 0) < 100 && lastActive > 0 && (now - lastActive) > IDLE_TIMEOUT_MS) return false;
      // Also exclude if charger has NEVER been active since app start (car was already idle)
      if ((evD?.powerW || 0) < 100 && lastActive === 0) return false;
      return true;
    });
    const minBudgetNeeded = activeChargers.reduce((sum, e) => {
      const evData = this._evPowerData[e.deviceId];
      const phases = evData?.detectedPhases || e.chargerPhases || 3;
      return sum + CHARGER_DEFAULTS.minCurrent * (phases * 230);
    }, 0);

    const proactivelyShed = this._mitigatedDevices.filter(m => m.evProactive);

    // Guard: don't restore evProactive entries before _connectToEVChargers has populated
    // _evPowerData. If it's empty we have no idea whether a charger is still active,
    // so restoring heaters that were shed for a charging session would be premature.
    // Safety valve: after 3 minutes give up waiting — something went wrong with connect.
    const evChargerEntries = (this._settings.priorityList || []).filter(e => e.action === 'dynamic_current');
    const evConnectAge = Date.now() - (this._appStartTime || 0);
    const evDataReady = evChargerEntries.length === 0
      || Object.keys(this._evPowerData).length > 0
      || evConnectAge > 180000; // 3 min timeout — don't block restore forever
    if (!evDataReady && proactivelyShed.length > 0) {
      this.log('[EV] Skipping proactive restore — evPowerData not yet populated (waiting for _connectToEVChargers)');
    }

    // Chargers with "Shed heaters when charging" enabled that are currently active
    const priorityActiveChargers = activeChargers.filter(e => {
      const plEntry = (this._settings.priorityList || []).find(pl => pl.deviceId === e.deviceId);
      return plEntry?.chargerPriority === true;
    });

    // ── Restore phase ──────────────────────────────────────────────────────────
    // Two restore rules depending on how the device was shed:
    //   evPriorityChargerId set → restore only when that charger session ends or pauses (price 'av')
    //   budget-based shed      → restore when no charger connected or budget sufficient (+ hysteresis)
    const restoreBudgetNeeded = minBudgetNeeded + 2000;
    const budgetSufficient = budget >= restoreBudgetNeeded;
    let restoredThisCycle = false;
    for (const shed of [...proactivelyShed]) {
      if (restoredThisCycle) break;
      // Don't restore until evPowerData is ready — see guard above
      if (!evDataReady) break;
      // Option 3: stagger sequential restores — wait 60s between each device restore while chargers
      // are still connected. Prevents 3 shed devices all coming back in 15 seconds and causing a spike.
      if (connectedChargers.length > 0 && now - this._lastProactiveRestoreTime < 60000) break;
      let shouldRestore;
      if (shed.evPriorityChargerId) {
        // Priority shed: restore when that charger's session ends OR when budget is now sufficient
        // (Option 1: don't restore into an overload — check headroom even after session ends)
        const sessionActive = activeChargers.some(e => e.deviceId === shed.evPriorityChargerId);
        shouldRestore = !sessionActive && (!connectedChargers.length || budgetSufficient);
      } else {
        // Budget shed: restore when no charger connected or budget now comfortable
        shouldRestore = !connectedChargers.length || budgetSufficient;
      }
      if (!shouldRestore) continue;
      // Don't restore within 3 minutes of a charger actively drawing power.
      // Applies to ALL shed types — charger is mid-ramp and will need the headroom shortly.
      // Prevents disco-effect: budget looks OK between ramp steps → restore fires → next
      // ramp step pushes over limit → shed fires again.
      const EV_COOLDOWN_MS = 3 * 60 * 1000;
      if (now - (this._evChargerLastActiveMs || 0) < EV_COOLDOWN_MS) continue;
      // Min 2 min before restoring when a charger is still connected — avoids rapid re-shed.
      // Bypassed when no charger is connected (session is over).
      if (connectedChargers.length > 0 && now - shed.mitigatedAt < 120000) continue;
      const device = await withTimeout(
        this._api.devices.getDevice({ id: shed.deviceId }),
        10000, `proactiveRestore(${shed.deviceId})`
      ).catch(() => null);
      if (!device) continue;
      const ok = await restoreDevice(device, shed.action, shed.previousState).catch(() => false);
      if (ok) {
        this._mitigatedDevices = this._mitigatedDevices.filter(m => m.deviceId !== shed.deviceId);
        this._persistMitigatedDevices();
        const entry = (this._settings.priorityList || []).find(e => e.deviceId === shed.deviceId);
        this.log(`[EV] Proactive restore: ${entry?.name || shed.deviceId} turned back on`);
        this._addLog(`EV shed restore: ${entry?.name || shed.deviceId} turned back on`);
        this._lastProactiveRestoreTime = now;
        restoredThisCycle = true;
      }
    }
    if (restoredThisCycle) return;

    // ── Priority shed phase ───────────────────────────────────────────────────
    // For chargers with "Shed heaters when charging" ON: proactively shed non-EV devices
    // only when the budget is actually insufficient — prevents unnecessary shed when the
    // household load is low and the charger has plenty of headroom.
    if (priorityActiveChargers.length > 0 && budget < minBudgetNeeded && now - this._lastProactiveSheddingTime >= 60000) {
      const alreadyMitigated = new Set(this._mitigatedDevices.map(m => m.deviceId));
      const sortedList = [...(this._settings.priorityList || [])].sort((a, b) => a.priority - b.priority);
      for (const charger of priorityActiveChargers) {
        const chargerEntry = (this._settings.priorityList || []).find(e => e.deviceId === charger.deviceId);
        for (const entry of sortedList) {
          if (entry.enabled === false) continue;
          if (entry.action === 'dynamic_current') continue;
          if (alreadyMitigated.has(entry.deviceId)) continue;
          if (!this._canMitigate(entry)) continue;
          const device = await withTimeout(
            this._api.devices.getDevice({ id: entry.deviceId }),
            10000, `priorityShed(${entry.deviceId})`
          ).catch(() => null);
          if (!device) continue;
          const obj = device.capabilitiesObj || {};
          // Idle guard: skip thermostats not drawing power (lowering a temp that isn't heating does nothing).
          // Do NOT skip onoff/hoiax devices at 0W — water heaters cycle on later and we want
          // them pre-emptively off for the whole charging session.
          if (entry.action === 'target_temperature') {
            const caps = Object.keys(obj);
            const pw = obj.measure_power?.value ?? obj.measure_power ?? null;
            if (typeof pw === 'number' && pw < 50) continue;
            if (pw == null && caps.includes('tuya_thermostat_load_status') && obj.tuya_thermostat_load_status != null) {
              const ls = obj.tuya_thermostat_load_status.value !== undefined ? obj.tuya_thermostat_load_status.value : obj.tuya_thermostat_load_status;
              if (ls === false) continue;
            }
            if (pw == null && caps.includes('onoff') && obj.onoff != null) {
              const onoffVal = obj.onoff.value !== undefined ? obj.onoff.value : obj.onoff;
              if (onoffVal === false) continue;
            }
          }
          const previousState = this._snapshotState(device);
          const ok = await applyAction(device, entry.action).catch(() => false);
          if (!ok) continue;
          this._mitigatedDevices.push({ deviceId: entry.deviceId, action: entry.action, previousState, mitigatedAt: now, evProactive: true, evPriorityChargerId: charger.deviceId });
          this._persistMitigatedDevices();
          this._lastProactiveSheddingTime = now;
          this._lastDeviceOffTime = now;
          this.log(`[EV] Priority shed: ${entry.name} turned off — charger ${chargerEntry?.name || charger.deviceId} is charging`);
          this._addLog(`EV priority shed: ${entry.name} off (charger ${chargerEntry?.name || charger.deviceId} active)`);
          await this._updateVirtualDevice({ alarm: true }).catch(() => {});
          return; // One device per cycle
        }
      }
    }

    // ── Budget-based shed phase ───────────────────────────────────────────────
    // For chargers without chargerPriority: shed only when budget is too tight.
    // Use activeChargers (not connectedChargers) — a car with status=completed is physically
    // plugged in but done charging. It needs no headroom, so don't shed heaters on its behalf.
    if (!activeChargers.length || budgetSufficient) return;
    if (now - this._lastProactiveSheddingTime < 60000) return;

    const priorityList = [...(this._settings.priorityList || [])].sort((a, b) => a.priority - b.priority);
    const alreadyMitigated = new Set(this._mitigatedDevices.map(m => m.deviceId));

    for (const entry of priorityList) {
      if (entry.enabled === false) continue;
      if (entry.action === 'dynamic_current') continue;
      if (alreadyMitigated.has(entry.deviceId)) continue;
      if (!this._canMitigate(entry)) continue;

      const device = await withTimeout(
        this._api.devices.getDevice({ id: entry.deviceId }),
        10000, `proactiveShed(${entry.deviceId})`
      ).catch(() => null);
      if (!device) continue;

      const obj = device.capabilitiesObj || {};
      if (entry.action === 'target_temperature' || entry.action === 'onoff' || entry.action === 'hoiax_power') {
        const caps = Object.keys(obj);
        const pw = obj.measure_power?.value ?? obj.measure_power ?? null;
        if (typeof pw === 'number' && pw < 50) continue;
        if (pw == null && caps.includes('tuya_thermostat_load_status') && obj.tuya_thermostat_load_status != null) {
          const ls = obj.tuya_thermostat_load_status.value !== undefined ? obj.tuya_thermostat_load_status.value : obj.tuya_thermostat_load_status;
          if (ls === false) continue;
        }
        if (pw == null && caps.includes('onoff') && obj.onoff != null) {
          const onoffVal = obj.onoff.value !== undefined ? obj.onoff.value : obj.onoff;
          if (onoffVal === false) continue;
        }
      }

      const previousState = this._snapshotState(device);
      const ok = await applyAction(device, entry.action).catch(() => false);
      if (!ok) continue;

      this._mitigatedDevices.push({ deviceId: entry.deviceId, action: entry.action, previousState, mitigatedAt: now, evProactive: true });
      this._persistMitigatedDevices();
      this._lastProactiveSheddingTime = now;
      this._lastDeviceOffTime = now;
      this.log(`[EV] Proactive shed: ${entry.name} turned off — budget ${Math.round(budget)}W < needed ${Math.round(restoreBudgetNeeded)}W`);
      this._addLog(`EV proactive shed: ${entry.name} off (budget ${Math.round(budget)}W < ${Math.round(restoreBudgetNeeded)}W)`);
      await this._updateVirtualDevice({ alarm: true }).catch(() => {});
      break; // One device per cycle
    }
  }

  async _adjustEVChargersForPower(rawPower) {
    const now = Date.now();

    const chargerEntries = (this._settings.priorityList || []).filter(e =>
      e.enabled !== false && e.action === 'dynamic_current'
    );
    if (!chargerEntries.length) return;

    const limit = this._getEffectiveLimit();
    const totalOverload = Math.max(0, rawPower - limit);

    // Detect emergency: power is significantly over limit (>500W)
    const isEmergency = totalOverload > 500;

    // Global floor: don't even evaluate more often than every 2s (prevents API spam)
    if (now - (this._lastEVAdjustTime || 0) < 2000) return;

    // ── Multi-charger shared budget ─────────────────────────────────────────
    // Sum all connected chargers' power as a group, subtract once from household,
    // then divide available headroom equally. This prevents each charger
    // independently claiming all available headroom when multiple are active.
    const connectedEntries = chargerEntries.filter(e => this._isCarConnected(e.deviceId));
    const totalChargerPowerW = connectedEntries.reduce((sum, e) => {
      const pw = this._evPowerData[e.deviceId]?.powerW || 0;
      return sum + (pw > 200 ? pw : 0);
    }, 0);
    // Only count chargers actually drawing power as active — a connected-but-idle
    // charger (car plugged in but not charging) should not split the headroom budget.
    const chargingCount = connectedEntries.filter(e => {
      const evData = this._evPowerData[e.deviceId];
      return (evData?.powerW || 0) > 200 || (evData?.offeredCurrent || 0) > 0;
    }).length;
    const activeChargerCount = Math.max(1, chargingCount);
    const sharedNonChargerUsage = Math.max(0, rawPower - totalChargerPowerW);
    const sharedAvailableW = limit - sharedNonChargerUsage;
    const householdAloneExceedsLimit = sharedNonChargerUsage > (limit - 200);
    if (connectedEntries.length > 1) {
      this.log(`[EV] Multi-charger: ${connectedEntries.length} connected, ${activeChargerCount} charging, totalCharger=${Math.round(totalChargerPowerW)}W, household=${Math.round(sharedNonChargerUsage)}W, shared=${Math.round(sharedAvailableW)}W`);
    }
    // ────────────────────────────────────────────────────────────────────────

    const HEADROOM_TO_RAMP_DEFAULT = 300;   // Fallback headroom (W) before stepping up 1A (used until phase detected)
    const HEADROOM_AFTER_STEPDOWN_DEFAULT = 750; // Fallback post-stepdown headroom
    const STEPDOWN_GUARD_MS        = 60000; // Window after step-down where higher headroom applies
    const RAMP_UP_COOLDOWN         = 60000; // 1 minute between up-steps per charger
    const SETTLE_WINDOW            = 30000; // 30s shared settling — no charger ramps until meter confirms previous step
    let madeIncrease = false;        // Belt-and-suspenders: also blocks a second ramp within the same cycle

    for (const entry of chargerEntries) {
      const brand = this._getChargerBrand?.(entry.deviceId);
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

      // Clear mitigation when charging is complete — car is full, no more power draw.
      // Status 4 / 'completed' means the car accepted the full charge and stopped.
      // We keep the car as "connected" (still plugged in) but stop showing "device controlled".
      {
        const evData = this._evPowerData[entry.deviceId];
        const cs = evData?.chargerStatus;
        // Only treat as "charging complete" when BOTH the status says Completed AND
        // the charger is drawing less than 500W. Easee sometimes sends spurious
        // Completed events mid-session while the car is still pulling full current.
        //
        // IMPORTANT: Easee also reports status=Completed when PG turned it off with onoff=false
        // (e.g. during a price-pause). In that case the car is NOT actually full — the Easee
        // just reports Completed whenever it's switched off. We must NOT skip the charger in
        // this case or it will never start again.
        //
        // Guard: only honour Completed if PG has actively been charging this session
        // (alreadyTracked with currentTargetA > 0). If PG never sent a start command this
        // session, Completed is stale/Easee-generated and should be ignored.
        const _tracked = this._mitigatedDevices.find(m => m.deviceId === entry.deviceId);
        const _pgWasCharging = _tracked && (_tracked.currentTargetA > 0);
        const isChargingComplete = [4, 'completed', 'COMPLETED', 'Completed'].includes(cs)
                                && (evData?.powerW || 0) < 500
                                && _pgWasCharging;
        if (isChargingComplete) {
          const stale = this._mitigatedDevices.findIndex(m => m.deviceId === entry.deviceId);
          if (stale >= 0) {
            this._mitigatedDevices.splice(stale, 1);
            this._persistMitigatedDevices();
            this._fireTrigger('mitigation_cleared', { device_name: entry.name });
            this.log(`[EV] Removed mitigation for fully-charged car: ${entry.name} (status=${cs})`);
            // Only notify once per charging session — flag reset when a new session begins
            if (!this._chargerState[entry.deviceId]) this._chargerState[entry.deviceId] = {};
            if (!this._chargerState[entry.deviceId].chargingCompleteNotified) {
              this._chargerState[entry.deviceId].chargingCompleteNotified = true;
              this.homey.notifications.createNotification({
                excerpt: `✅ ${entry.name}: ferdig ladet`,
              }).catch(() => {});
            }
          }
          continue;
        }
      }

      // ── Simple 1A step control ────────────────────────────────────────────────
      // Down: immediate on every reading when over budget.
      // Up:   max 1A every 60s — gives HAN and charger time to stabilise before next step.
      // No phase detection needed — 1A is always the step regardless of phase.
      const cState = this._chargerState[entry.deviceId] || {};
      const alreadyTracked = this._mitigatedDevices.find(m => m.deviceId === entry.deviceId);
      const evDataNow = this._evPowerData[entry.deviceId];
      // If not yet tracked but charger is already mid-session (actively charging), seed
      // currentTargetA from offeredCurrent so step-down has a starting point on app restart.
      // Only seed when status confirms charging is already in progress — fresh connects must
      // always start paused so the ramp begins from 6A, never from whatever the charger offers.
      const offeredA = evDataNow?.offeredCurrent || 0;
      const alreadyCharging = ['charging', 'CHARGING', 3].includes(evDataNow?.chargerStatus);
      // Never inherit offeredCurrent from the charger — always start at 6A and ramp up.
      // If not tracked, currentTargetA = null (isPaused) so the running-but-untracked detection
      // below will immediately set it to 6A.
      const currentTargetA = alreadyTracked?.currentTargetA ?? null;
      const isPaused = currentTargetA === 0 || currentTargetA === null;
      const circuitLimitA = entry.circuitLimitA || 32;
      const isChargeNow = !!(this._chargeNow && this._chargeNow[entry.deviceId]);
      const priceCap = isChargeNow ? circuitLimitA : this._getPriceCurrentCap(entry.deviceId, circuitLimitA);
      // Use learnedMaxA if available — the charger's actual hardware ceiling, learned
      // by observing that offeredCurrent stopped increasing despite higher commands.
      // This prevents endless ramp-up attempts for chargers with a lower physical max
      // than the configured circuitLimitA (e.g. 16A charger with circuitLimitA=32).
      const effectiveMax = cState?.learnedMaxA ?? circuitLimitA;
      const maxA = Math.min(CHARGER_DEFAULTS.maxCurrent, effectiveMax, priceCap > 0 ? priceCap : 0);

      const overLimit = rawPower > limit;
      const headroomW = limit - rawPower; // positive = under limit, negative = over
      // EV headroom buffer: reserve evHeadroomW watts for household before allowing charger ramp-up.
      // Step-down and emergency logic are unaffected — only ramp-up/resume decisions use this.
      const evHeadroomBuffer = this._settings.evHeadroomW || 0;
      const evEffectiveHeadroomW = headroomW - evHeadroomBuffer;
      // Phase-aware headroom: use the charger's actual W/A ratio (learned from power/current)
      // to ensure headroom covers the real cost of +1A. Fallback: phases × 700W (≈√3×400V, safe 3-phase TN).
      // This prevents oscillation where 300W headroom looks sufficient but +1A actually costs ~690W (3-phase).
      const evWpa = evDataNow?.wattsPerAmp || ((evDataNow?.detectedPhases || entry.chargerPhases || 3) * 700);
      const HEADROOM_TO_RAMP = Math.max(HEADROOM_TO_RAMP_DEFAULT, Math.round(evWpa * 1.1));
      const HEADROOM_AFTER_STEPDOWN = Math.max(HEADROOM_AFTER_STEPDOWN_DEFAULT, Math.round(evWpa * 1.2));
      // Anti-oscillation: require larger headroom for 60s after a step-down so the charger
      // doesn't immediately ramp back up into the same overload that triggered the step-down.
      const recentStepDown = cState.lastStepDownTime && (now - cState.lastStepDownTime) < STEPDOWN_GUARD_MS;
      const headroomThreshold = recentStepDown ? HEADROOM_AFTER_STEPDOWN : HEADROOM_TO_RAMP;

      let targetCurrent;
      // Resume immunity: after turning ON, the Easee charger briefly spikes to full hardware
      // power (16A) before it enforces the dynamic limit we set. This spike can be 4000–10000W
      // over our soft limit — we must NEVER pause during this window.
      const resumeImmune = !!(cState.resumeImmunityUntil && now < cState.resumeImmunityUntil);

      // Step-down cooldown: after stepping down, wait before stepping down again
      // to let the charger and HAN meter settle. Prevents rapid oscillation (7→8→7→8...).
      // On emergency (>500W over limit) bypass the cooldown so we step every HAN reading.
      const STEP_DOWN_COOLDOWN = 15000; // 15s between step-downs (normal)
      const stepDownReady = isEmergency || !cState.lastStepDownTime || (now - cState.lastStepDownTime) >= STEP_DOWN_COOLDOWN;

      if (isChargeNow && overLimit) {
        // Charge Now but over watt limit: step down for safety, but never fully pause
        if (isPaused) {
          targetCurrent = CHARGER_DEFAULTS.minCurrent;
        } else if (currentTargetA <= CHARGER_DEFAULTS.minCurrent) {
          targetCurrent = CHARGER_DEFAULTS.minCurrent; // hold at minimum, don't pause
        } else if (stepDownReady) {
          targetCurrent = currentTargetA - 1;
          if (!this._chargerState[entry.deviceId]) this._chargerState[entry.deviceId] = {};
          this._chargerState[entry.deviceId].lastStepDownTime = now;
        } else {
          targetCurrent = currentTargetA;
        }
      } else if (priceCap <= 0) {
        // Price engine wants charger fully off → pause
        targetCurrent = null;
        if (!this._chargerState[entry.deviceId]) this._chargerState[entry.deviceId] = {};
        // Clear capacity-wait flag — charger is stopped by price, not capacity shortage
        this._chargerState[entry.deviceId].waitingForCapacity = false;
        this._chargerState[entry.deviceId].minResumeW = null;
        this._chargerState[entry.deviceId].headroomW  = null;
        if (!isPaused) {
          this.log(`[EV] Price pause: ${entry.name} — Mode=av`);
          this._appLogEntry('charger', `${entry.name}: pauset pga. pris (Mode=av)`);
          // Timeline notification — once per price-pause event (cooldown 30 min)
          const _ppState = this._chargerState[entry.deviceId] || {};
          const _ppAge = now - (_ppState.lastPricePauseNotifyAt || 0);
          if (_ppAge >= 30 * 60 * 1000) {
            if (!this._chargerState[entry.deviceId]) this._chargerState[entry.deviceId] = {};
            this._chargerState[entry.deviceId].lastPricePauseNotifyAt = now;
            this.homey.notifications.createNotification({
              excerpt: `⏸ ${entry.name}: ladingen er pauset — dyr strøm`,
            }).catch(() => {});
          }
        }
      } else if (resumeImmune) {
        // Inside resume immunity window — Easee is still enforcing the new current limit.
        // Must be checked BEFORE householdAloneExceedsLimit: the raw power spike right after
        // charger startup makes sharedNonChargerUsage look like the household alone is over
        // limit (Easee's powerW is stale for ~15s), which would immediately re-pause and
        // create a pause→resume→pause oscillation loop.
        targetCurrent = currentTargetA;
        this.log(`[EV] Resume immunity: ${entry.name} — holding ${currentTargetA}A (${Math.round((cState.resumeImmunityUntil - now) / 1000)}s left, overload=${Math.round(totalOverload)}W)`);
      } else if (householdAloneExceedsLimit) {
        // Household alone (without charger) exceeds limit → pause charger.
        // Only reached outside the resume immunity window so the stale powerW issue
        // (charger.powerW = 0 for ~15s after startup) cannot trigger a false pause.
        targetCurrent = null;
      } else if (overLimit) {
        // Total power over limit — step down 1A, or pause if already at minimum.
        if (isPaused) {
          targetCurrent = null;
        } else if (currentTargetA <= CHARGER_DEFAULTS.minCurrent) {
          targetCurrent = null; // at minimum, must pause
        } else if (stepDownReady) {
          targetCurrent = currentTargetA - 1;
          if (!this._chargerState[entry.deviceId]) this._chargerState[entry.deviceId] = {};
          this._chargerState[entry.deviceId].lastStepDownTime = now;
        } else {
          targetCurrent = currentTargetA; // step-down cooldown active, hold
        }
      } else if (isPaused) {
        // Resume from pause when enough headroom — always start at 6A.
        // Budget guard: verify headroom covers the actual cost of minCurrent amps.
        // Uses learned wattsPerAmp (W/A ratio from real measurements) so a 1-phase charger
        // uses ~170W/A and a 3-phase uses ~690W/A. Falls back to phases×230V if not yet learned.
        // Without this guard a tightly loaded house (e.g. 560W headroom) would resume a
        // charger that needs 1000W minimum → immediate overload → pause → disco loop.
        // Conservative W/A floor: take max of learned value and phases×230V.
        // Prevents a transient 1-phase flicker from corrupting wattsPerAmp to ~40 W/A,
        // which would underestimate minResumeW (6×40=240W vs correct 6×690=4140W)
        // and cause spurious resume that immediately overloads the circuit.
        const _phases = evDataNow?.detectedPhases || entry.chargerPhases || 3;
        const _wpa = Math.max(evDataNow?.wattsPerAmp || 0, _phases * 230);
        const minResumeW = CHARGER_DEFAULTS.minCurrent * _wpa;
        const sinceLastAny = now - (this._lastAnyChargerRampUpTime || 0);
        if (!this._chargerState[entry.deviceId]) this._chargerState[entry.deviceId] = {};
        if (evEffectiveHeadroomW >= Math.max(headroomThreshold, minResumeW) && !madeIncrease && sinceLastAny >= SETTLE_WINDOW && priceCap > 0) {
          targetCurrent = CHARGER_DEFAULTS.minCurrent;
          this._chargerState[entry.deviceId].lastRampUpTime = now;
          this._chargerState[entry.deviceId].waitingForCapacity = false;
          this._lastAnyChargerRampUpTime = now;
          this.log(`[EV] Resume: ${entry.name} → ${targetCurrent}A (${Math.round(evEffectiveHeadroomW)}W eff. headroom${evHeadroomBuffer > 0 ? `, buf ${evHeadroomBuffer}W` : ''})`);
          this._appLogEntry('charger', `${entry.name}: starter lading → ${targetCurrent}A (${Math.round(evEffectiveHeadroomW)}W ledig)`);
          // Timeline notification when resuming from a price pause
          const _priceWasPaused = (this._chargerState[entry.deviceId] || {}).lastPricePauseNotifyAt > 0;
          if (_priceWasPaused) {
            this.homey.notifications.createNotification({
              excerpt: `▶ ${entry.name}: starter lading — billig time`,
            }).catch(() => {});
            this._chargerState[entry.deviceId].lastPricePauseNotifyAt = 0;
          }
        } else {
          targetCurrent = null; // not enough headroom or settling — stay paused
          // Track capacity-waiting state: set on first transition, clear when headroom recovers
          const notEnoughCapacity = evEffectiveHeadroomW < minResumeW;
          if (notEnoughCapacity) {
            // Always keep minResumeW/headroomW fresh so the UI shows current numbers
            this._chargerState[entry.deviceId].minResumeW = minResumeW;
            this._chargerState[entry.deviceId].headroomW  = evEffectiveHeadroomW;
            if (!this._chargerState[entry.deviceId].waitingForCapacity) {
              this._chargerState[entry.deviceId].waitingForCapacity = true;
              this._chargerState[entry.deviceId].waitingSince = now;
              this.log(`[EV] Venter på kapasitet: ${entry.name} — trenger ${Math.round(minResumeW)}W (${_phases}-fase, ${Math.round(_wpa)}W/A), ${Math.round(evEffectiveHeadroomW)}W ledig`);
              this._appLogEntry('charger', `${entry.name}: venter på ledig kapasitet (trenger ${Math.round(minResumeW)}W, ${Math.round(evEffectiveHeadroomW)}W ledig)`);
            } else {
              // Still waiting — re-log every 60s so the log shows we're alive and current numbers
              const waitingSince = this._chargerState[entry.deviceId].waitingSince || now;
              const lastWaitLog  = this._chargerState[entry.deviceId].lastWaitLog  || 0;
              if (now - lastWaitLog >= 60000) {
                this._chargerState[entry.deviceId].lastWaitLog = now;
                const waitedMin = Math.round((now - waitingSince) / 60000);
                this.log(`[EV] Fremdeles venter: ${entry.name} — ledig ${Math.round(evEffectiveHeadroomW)}W, trenger ${Math.round(minResumeW)}W (ventet ${waitedMin}min)`);
                this._appLogEntry('charger', `${entry.name}: venter på kapasitet — ${Math.round(evEffectiveHeadroomW)}W ledig, trenger ${Math.round(minResumeW)}W (${waitedMin}min)`);
              }
            }
          } else {
            // Headroom is now sufficient — blocked by settling window or madeIncrease, not capacity
            this._chargerState[entry.deviceId].waitingForCapacity = false;
            this._chargerState[entry.deviceId].minResumeW = null;
            this._chargerState[entry.deviceId].headroomW  = null;
            this._chargerState[entry.deviceId].waitingSince = null;
            this._chargerState[entry.deviceId].lastWaitLog  = null;
            // Log why we're still paused despite sufficient headroom (debugging aid)
            const _blockReasons = [];
            if (madeIncrease)               _blockReasons.push('annen lader rampet opp denne syklusen');
            if (sinceLastAny < SETTLE_WINDOW) _blockReasons.push(`settling (${Math.round((SETTLE_WINDOW - sinceLastAny) / 1000)}s igjen)`);
            if (priceCap <= 0)              _blockReasons.push('pris blokkerer');
            if (_blockReasons.length > 0) {
              const lastBlockLog = this._chargerState[entry.deviceId].lastBlockLog || 0;
              if (now - lastBlockLog >= 60000) {
                this._chargerState[entry.deviceId].lastBlockLog = now;
                this.log(`[EV] Nok kapasitet men venter: ${entry.name} — ${_blockReasons.join(', ')}`);
              }
            } else {
              this._chargerState[entry.deviceId].lastBlockLog = null;
            }
          }
        }
      } else if (cState.timedOut && !isPaused && (evDataNow?.offeredCurrent || 0) < 1) {
        // timedOut=true means the charger ignored our last command (offered 0A when we commanded >0A).
        // If this has persisted for more than 5 minutes the charger is stuck — do a pause/resume reset.
        // The resume will clear timedOut=false so the next cycle can ramp up normally from 6A.
        const timedOutSince = cState.commandTime || 0;
        const TIMEOUT_RECOVERY_MS = 5 * 60 * 1000;
        if (evEffectiveHeadroomW >= headroomThreshold && now - timedOutSince >= TIMEOUT_RECOVERY_MS) {
          this.log(`[EV] timedOut recovery: ${entry.name} — pausing then resuming to reset charger state (stuck ${Math.round((now - timedOutSince) / 60000)}min)`);
          this._appLogEntry('charger', `${entry.name}: nullstiller lader (ignorerte kommando i ${Math.round((now - timedOutSince) / 60000)}min)`);
          if (!this._chargerState[entry.deviceId]) this._chargerState[entry.deviceId] = {};
          this._chargerState[entry.deviceId].timedOut = false;
          targetCurrent = null; // force pause this cycle — next cycle will see isPaused=true and resume at 6A
        } else {
          targetCurrent = currentTargetA; // not enough headroom yet or too soon — hold
        }
      } else if (evEffectiveHeadroomW >= headroomThreshold && currentTargetA < maxA && !cState.timedOut) {
        // Under limit with headroom — ramp up 1A if both per-charger 60s and shared 30s settling are satisfied.
        // BMS ceiling detection: if the car consumes far less W/A than expected, the car's own BMS is
        // limiting current (e.g. trickle at end-of-charge, or car max < circuit max).
        // In this case stop ramping. After a grace period, step back to minimum so that if the car
        // resumes full charging (e.g. BMS allows more again, or car reconnects) we don't have a large
        // uncontrolled peak from a high commanded current suddenly being accepted.
        const BMS_CEILING_WPA     = 50;             // W/A — below this = BMS is limiting hard
        const BMS_STEP_DOWN_DELAY = 3 * 60 * 1000; // hold 3 min at ceiling before stepping back to min
        const _wpaLearned = evDataNow?.wattsPerAmp; // EMA-smoothed, null/0 if not yet learned
        const atBmsCeiling = _wpaLearned && _wpaLearned > 0 && _wpaLearned < BMS_CEILING_WPA;

        if (!this._chargerState[entry.deviceId]) this._chargerState[entry.deviceId] = {};

        if (atBmsCeiling) {
          // Car is BMS-limiting — track how long we've been in this state
          if (!cState.bmsLimitedSince) {
            this._chargerState[entry.deviceId].bmsLimitedSince = now;
            this.log(`[EV] BMS ceiling detected: ${entry.name} at ${currentTargetA}A — ${Math.round(_wpaLearned)}W/A < ${BMS_CEILING_WPA}W/A, holding`);
          }
          const limitedForMs = now - (this._chargerState[entry.deviceId].bmsLimitedSince || now);
          if (limitedForMs >= BMS_STEP_DOWN_DELAY) {
            // Car has been trickling for long enough → step back to minimum current.
            // This avoids a sudden peak if the car decides to resume full charging.
            // Also reset wattsPerAmp so next ramp-up session starts with a fresh measurement.
            targetCurrent = CHARGER_DEFAULTS.minCurrent;
            this._chargerState[entry.deviceId].bmsLimitedSince = 0;
            if (this._evPowerData[entry.deviceId]) this._evPowerData[entry.deviceId].wattsPerAmp = 0;
            this.log(`[EV] BMS ceiling: ${entry.name} stepping back to ${CHARGER_DEFAULTS.minCurrent}A after ${Math.round(limitedForMs / 60000)}min trickle (${Math.round(_wpaLearned)}W/A)`);
            this._appLogEntry('charger', `${entry.name}: BMS-grense → tilbake til ${CHARGER_DEFAULTS.minCurrent}A (var ${Math.round(_wpaLearned)}W/A i ${Math.round(limitedForMs / 60000)}min)`);
          } else {
            targetCurrent = currentTargetA; // within grace period — hold, don't ramp
          }
        } else {
          // Normal car response — clear any BMS ceiling state and ramp up as usual
          if (cState.bmsLimitedSince) {
            this._chargerState[entry.deviceId].bmsLimitedSince = 0;
          }
          const lastRampUp   = cState.lastRampUpTime || 0;
          const sinceLastAny = now - (this._lastAnyChargerRampUpTime || 0);
          if (!madeIncrease && now - lastRampUp >= RAMP_UP_COOLDOWN && sinceLastAny >= SETTLE_WINDOW) {
            targetCurrent = currentTargetA + 1;
            this._chargerState[entry.deviceId].lastRampUpTime = now;
            this._lastAnyChargerRampUpTime = now;
            this.log(`[EV] Ramp up: ${entry.name} ${currentTargetA}A → ${targetCurrent}A (${Math.round(evEffectiveHeadroomW)}W eff. headroom, need ${headroomThreshold}W${evHeadroomBuffer > 0 ? `, buf ${evHeadroomBuffer}W` : ''}${recentStepDown ? ', post-stepdown guard' : ''})`);
            this._appLogEntry('charger', `${entry.name}: ramp ${currentTargetA}A → ${targetCurrent}A (${Math.round(evEffectiveHeadroomW)}W ledig, krav ${headroomThreshold}W${recentStepDown ? ', anti-osc' : ''})`);
          } else {
            targetCurrent = currentTargetA; // wait for cooldown or settling window
          }
        }
      } else {
        targetCurrent = currentTargetA; // under limit, at max, or headroom too small — stay
      }

      const isIncrease = targetCurrent !== null && (isPaused ? targetCurrent > 0 : targetCurrent > currentTargetA);

      // Skip if nothing changed — but only when charger is truly idle.
      // If the charger is drawing power but Power Guard has no tracked state (e.g. after
      // app restart, car reconnect, or offeredCurrent was null), take control immediately
      // at minimum current instead of silently skipping.
      const chargerActuallyRunning = (evDataNow?.powerW || 0) > 200 || (evDataNow?.offeredCurrent || 0) > 0;
      if (targetCurrent === null && isPaused && !chargerActuallyRunning) continue;
      if (targetCurrent === null && isPaused && chargerActuallyRunning) {
        // Easee retains offeredCurrent=6 internally even after charging completes.
        // Without this guard: isChargingComplete removes the charger from tracking → next cycle
        // sees offeredCurrent>0 → "tar kontroll" restarts → car rejects (full) → Completed again → loop.
        const completedStatuses = [4, 'completed', 'COMPLETED', 'Completed'];
        if (completedStatuses.includes(evDataNow?.chargerStatus) && (evDataNow?.powerW || 0) < 200) continue;
        // Price engine wants charger off — don't fight it while Easee winds down (offeredCurrent
        // stays > 0 for ~20s after a pause command, which would otherwise trigger "tar kontroll"
        // and cause a pause → resume → pause loop until Easee fully stops).
        if (priceCap <= 0) continue;
        targetCurrent = CHARGER_DEFAULTS.minCurrent;
        this.log(`[EV] Taking control: ${entry.name} drawing ${Math.round(evDataNow?.powerW||0)}W untracked — forcing to ${CHARGER_DEFAULTS.minCurrent}A`);
        this._appLogEntry('charger', `${entry.name}: tar kontroll → ${CHARGER_DEFAULTS.minCurrent}A (var ${Math.round(evDataNow?.powerW||0)}W ukontrollert)`);
      }
      if (targetCurrent !== null && targetCurrent === currentTargetA) continue;
      // At full current and not yet tracked — register as monitored (no alarm) and skip sending command
      if (!alreadyTracked && targetCurrent !== null && targetCurrent >= (entry.circuitLimitA || 32)) {
        this._mitigatedDevices.push({
          deviceId: entry.deviceId,
          action: 'dynamic_current',
          previousState: { targetCurrent: entry.circuitLimitA || 32 },
          mitigatedAt: now,
          currentTargetA: targetCurrent
        });
        this._persistMitigatedDevices();
        continue;
      }

      // No start-threshold block needed: brand handlers now resume at Math.min(startCurrent, targetCurrent)
      // so the resume current is always within the calculated budget.

      let success = false;
      if (entry.flowControlled) {
        success = await this._handleFlowControlledCharger(entry.deviceId, entry.name, targetCurrent).catch(() => false);
      } else if (brand === 'easee' || !brand) {
        success = await this._setEaseeChargerCurrent(entry.deviceId, targetCurrent).catch(() => false);
      } else if (brand === 'enua') {
        await this._setEnuaCurrent(entry.deviceId, targetCurrent).catch(err => this.error('[EV] Enua current set error:', err));
        success = true;
      } else if (brand === 'zaptec') {
        await this._setZaptecCurrent(entry.deviceId, targetCurrent).catch(err => this.error('[EV] Zaptec current set error:', err));
        success = true;
      } else if (brand === 'futurehome') {
        await this._setFutureHomeCurrent(entry.deviceId, targetCurrent).catch(err => this.error('[EV] FutureHome current set error:', err));
        success = true;
      } else {
        this.log(`[EV] Unknown brand for "${entry.name}" (${entry.deviceId}) — cannot adjust current. Re-run device cache refresh.`);
      }
      if (!success) {
        // Still update lastAdjustTime on failure to prevent immediate retry spam
        if (!this._chargerState[entry.deviceId]) this._chargerState[entry.deviceId] = {};
        this._chargerState[entry.deviceId].lastAdjustTime = now;
        continue;
      }

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
        // Charger restored to full — keep in _mitigatedDevices so devices tab still shows "controlled"
        const wasLimited = alreadyTracked.currentTargetA === 0 || alreadyTracked.currentTargetA === null ||
                           alreadyTracked.currentTargetA < (entry.circuitLimitA || 32);
        alreadyTracked.currentTargetA = targetCurrent;
        this._persistMitigatedDevices();
        if (wasLimited) {
          this._addLog(`Charger restored: ${entry.name} → ${targetCurrent}A`);
          this._fireTrigger('mitigation_cleared', { device_name: entry.name });
          // Clear alarm only if no charger is still paused or limited below its circuit limit
          const anyStillLimited = this._mitigatedDevices.some(m => {
            if (m.currentTargetA === 0 || m.currentTargetA === null) return true;
            const pEntry = chargerEntries.find(c => c.deviceId === m.deviceId);
            return pEntry && m.currentTargetA < (pEntry.circuitLimitA || 32);
          });
          if (!anyStillLimited) {
            await this._updateVirtualDevice({ alarm: false }).catch(() => {});
          }
        }
      }

      // Track that an increase was made this cycle — prevents a second charger from also ramping up
      if (isIncrease) madeIncrease = true;
    }
  }

  // ─── Dynamic EV Charger Control ────────────────────────────────────────────

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
    // Capability-based detection (most reliable)
    if (caps.includes('toggleChargingCapability')) return 'enua';
    if (caps.includes('charging_button')) return 'zaptec';
    // Check Easee BEFORE futurehome — Easee chargers also have evcharger_charging
    if (caps.some(c => ['dynamic_charger_current', 'dynamicChargerCurrent',
      'dynamicCircuitCurrentP1', 'target_charger_current'].includes(c))) return 'easee';
    if (caps.includes('evcharger_charging')) return 'futurehome';
    // Fallback: use pre-computed brand flags stored in device cache.
    // Covers Enua v2.0+ which may rename capabilities but always has a stable owner_uri.
    if (cached.isEnua)   return 'enua';
    if (cached.isZaptec) return 'zaptec';
    if (cached.isEasee)  return 'easee';
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
        // Try known IDs first (go=installation_current_control, home=home_installation_current_control),
        // then fuzzy match. Note: 'set_installation_current' does NOT exist in the Zaptec app.
        let action = zaptecActions.find(a => a.id === 'installation_current_control')
                  || zaptecActions.find(a => a.id === 'home_installation_current_control')
                  || zaptecActions.find(a => /current|ampere|limit|strøm/i.test(a.id));
        if (!action) {
          // Try broader URI match
          const broader = allActions.filter(a => (a.uri || '').includes('zaptec'));
          action = broader.find(a => /current|ampere|limit|strøm/i.test(a.id));
        }
        if (action) {
          // Detect arg names from action descriptor for better diagnostics
          const argsArr = Array.isArray(action.args) ? action.args : [];
          const argNames = argsArr.map(a => a.name || a.id || JSON.stringify(a)).join(', ') || 'n/a';
          const result = { uri: action.uri, actionId: action.id, argsStyle: 'zaptec3phase' };
          this._flowActionCache[brand] = result;
          this.log(`[Zaptec] Discovered flow action: ${action.uri}/${action.id} | args: [${argNames}]`);
          this.log(`[Zaptec] Full action descriptor: ${JSON.stringify(action)}`);
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
          // Find the argument name used for current/ampere so we call the flow correctly
          const argsArr = Array.isArray(action.args) ? action.args : [];
          const currentArg = argsArr.find(a => /current|ampere|str.m|limit|max/i.test(a.name || a.id || ''));
          const currentArgName = (currentArg && (currentArg.name || currentArg.id)) || 'current';
          const result = { uri: action.uri, actionId: action.id, argsStyle: 'enuaSingle', currentArgName };
          this._flowActionCache[brand] = result;
          const argNames = argsArr.map(a => a.name || a.id || JSON.stringify(a)).join(', ') || 'n/a';
          this.log(`[Enua] Discovered flow action: ${action.uri}/${action.id} | args: [${argNames}] | using currentArgName: "${currentArgName}"`);
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
    // Zaptec Go uses 'installation_current_control', Zaptec Home uses 'home_installation_current_control'.
    // Discover the correct flow action (cached after first lookup).
    // If enumeration fails, callZaptecFlow will probe all known action IDs directly.
    // Zaptec Go = installation_current_control, Home = home_installation_current_control,
    // Go 2 = go2_installation_current_control, Pro = pro_installation_current_control.
    const flowAction = await this._discoverFlowAction('zaptec');

    // Resolve charger phases from priority list (default 3 if unknown)
    const _zaptecEntry = (this._settings.priorityList || []).find(e => e.deviceId === deviceId);
    const _zaptecPhases = _zaptecEntry?.chargerPhases || 3;

    const maxRetries = 2;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const device = await withTimeout(
          this._api.devices.getDevice({ id: deviceId }),
          10000, `getDevice(${deviceId})`
        );
        if (!device) return false;

        this._pendingChargerCommands[deviceId] = Date.now();

        // Helper to call the Zaptec flow action with the discovered ID.
        // For 1-phase chargers (TN), P2 and P3 must be 0 — sending same amps
        // on all phases causes Zaptec to reject or misinterpret the command.
        // If discovery failed (flowAction=null), probes all 4 known action IDs and
        // caches the first one that works (handles Go, Home, Go 2, Pro without guessing).
        const callZaptecFlow = async (amps) => {
          const p2 = _zaptecPhases >= 2 ? amps : 0;
          const p3 = _zaptecPhases >= 3 ? amps : 0;
          if (flowAction) {
            this.log(`[Zaptec] Calling flow ${flowAction.actionId} → P1=${amps}A P2=${p2}A P3=${p3}A (${_zaptecPhases}-phase)`);
            await withTimeout(
              this._api.flow.runFlowCardAction({
                uri: flowAction.uri,
                id: flowAction.actionId,
                args: { device: { id: deviceId, name: device.name }, current1: amps, current2: p2, current3: p3 }
              }),
              10000, `zaptecFlow(${deviceId}, ${amps}A)`
            );
            return;
          }
          // Fallback probe: try all known model-specific IDs in order
          const probeIds = ['installation_current_control', 'home_installation_current_control',
                            'go2_installation_current_control', 'pro_installation_current_control'];
          let lastErr;
          for (const actionId of probeIds) {
            try {
              this.log(`[Zaptec] Probing action ${actionId} → P1=${amps}A P2=${p2}A P3=${p3}A`);
              await withTimeout(
                this._api.flow.runFlowCardAction({
                  uri: 'homey:app:com.zaptec',
                  id: actionId,
                  args: { device: { id: deviceId, name: device.name }, current1: amps, current2: p2, current3: p3 }
                }),
                10000, `zaptecFlow(${deviceId}, ${amps}A)`
              );
              if (!this._flowActionCache) this._flowActionCache = {};
              this._flowActionCache['zaptec'] = { uri: 'homey:app:com.zaptec', actionId, argsStyle: 'zaptec3phase' };
              this.log(`[Zaptec] Probed and cached working action: ${actionId}`);
              return;
            } catch (err) {
              if (!err.message?.toLowerCase().includes('unknown')) throw err;
              lastErr = err;
            }
          }
          this.log(`[Zaptec] No working flow action found during probe. Last error: ${lastErr?.message}`);
        };

        // ── Pause: set charging_button to false ──
        if (currentA === null || currentA === 0) {
          if (device.capabilities.includes('charging_button')) {
            await withTimeout(
              device.setCapabilityValue({ capabilityId: 'charging_button', value: false }),
              10000, `zaptecPause(${deviceId})`
            );
          }
          // NOTE: do NOT call callZaptecFlow(0) here. For Zaptec, sending
          // installation_current_control=0A via the Flow action terminates the session
          // (OperatingMode → Connected_Finished), which shows as "Ferdig" in the Zaptec app
          // and requires the cable to be physically replugged to restart.
          // charging_button=false alone is sufficient to pause without ending the session.
          this._addLog(`Zaptec paused: ${device.name}`);
          this._appLogEntry('charger', `Zaptec paused: ${device.name}`);
          if (!this._chargerState[deviceId]) this._chargerState[deviceId] = {};
          Object.assign(this._chargerState[deviceId], { lastCommandA: 0, commandTime: Date.now(), confirmed: false, timedOut: false });
          delete this._pendingChargerCommands[deviceId];
          return true;
        }

        // ── Resume from pause: turn on first, then set current ──
        const alreadyTracked = this._mitigatedDevices.find(m => m.deviceId === deviceId);
        // Also treat fresh starts (!alreadyTracked) as paused — outer scheduler sees isPaused=true
        // (currentTargetA=null) but _setZaptecCurrent has no way to know that without this check.
        const wasPaused = !alreadyTracked || (alreadyTracked.currentTargetA === 0 || alreadyTracked.currentTargetA === null);
        if (wasPaused && device.capabilities.includes('charging_button')) {
          const btnVal = device.capabilitiesObj?.charging_button?.value;
          if (btnVal === false) {
            // Always resume at 6A (startCurrent = minCurrent) — ramps up 1A/min from there.
            const resumeA = Math.min(CHARGER_DEFAULTS.startCurrent, currentA);
            // Activate charging_button FIRST (awaited). If Zaptec rejects it the charger is in
            // Connected_Finished (completed session) — no point sending a current command, give up
            // gracefully without retrying. Physical cable reconnect is needed to start a new session.
            try {
              await withTimeout(
                device.setCapabilityValue({ capabilityId: 'charging_button', value: true }),
                10000, `zaptecResume(${deviceId})`
              );
            } catch (btnErr) {
              this.log(`[Zaptec] Resume rejected — charger likely in Connected_Finished: ${btnErr.message}`);
              this._appLogEntry('charger', `Zaptec ${device.name}: aktivering avvises (sesjon avsluttet — kabel ut/inn for ny sesjon)`);
              delete this._pendingChargerCommands[deviceId];
              return true; // give up gracefully, no retry
            }
            await callZaptecFlow(resumeA);
            this._addLog(`Zaptec resumed: ${device.name} → ${resumeA}A (next cycle will optimize to ${currentA}A)`);
            this._appLogEntry('charger', `Zaptec resumed: ${device.name} → ${resumeA}A (target=${currentA}A, vil rampe opp)`);
            if (!this._chargerState[deviceId]) this._chargerState[deviceId] = {};
            Object.assign(this._chargerState[deviceId], { lastCommandA: resumeA, commandTime: Date.now(), confirmed: false, timedOut: false });
            delete this._pendingChargerCommands[deviceId];
            return true;
          }
        }

        // ── Normal current adjustment via Flow API ──
        // Just send the new current limit directly. Do NOT check charging_button here —
        // Zaptec resets charging_button to false after a session is established, so false
        // is the normal steady-state even during active charging. Checking it here wrongly
        // triggers the "button off" path on every ramp step.
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
  //  Min current: CHARGER_DEFAULTS.minCurrent (6A)
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
          // Use the dynamically discovered arg name (e.g. 'current', 'ampere', 'maxCurrent')
          const argName = flowAction.currentArgName || 'current';
          await withTimeout(
            this._api.flow.runFlowCardAction({
              uri: flowAction.uri,
              id: flowAction.actionId,
              args: { device: { id: deviceId, name: device.name }, [argName]: amps }
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
          // Always resume at 6A (startCurrent = minCurrent) — ramps up 1A/min from there.
          const resumeA = Math.min(CHARGER_DEFAULTS.startCurrent, currentA);
          const clampedA = Math.max(CHARGER_DEFAULTS.minCurrent, Math.min(32, resumeA));
          // Set current limit via flow first
          await callEnuaFlow(clampedA);
          // Then enable charging
          await withTimeout(
            device.setCapabilityValue({ capabilityId: 'toggleChargingCapability', value: true }),
            10000, `enuaResume(${deviceId})`
          );
          this._addLog(`Enua resumed: ${device.name} → ${clampedA}A (next cycle will optimize to ${currentA}A)`);
          this._appLogEntry('charger', `Enua resumed: ${device.name} → ${clampedA}A (target=${currentA}A, will ramp up, status was: ${chargerStatus})`);
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
   * Set FutureHome EV charger state via evcharger_charging capability (on/off only).
   * No dynamic current control available — pause sets evcharger_charging=false,
   * resume sets evcharger_charging=true.
   * @param {string} deviceId
   * @param {number|null} currentA - null/0 to pause, any positive value to resume
   * @returns {Promise<boolean>} true if successful
   */
  // ══════════════════════════════════════════════════════════════════
  // █ SECTION 8b — EV CHARGER — FUTUREHOME                                      █
  // ══════════════════════════════════════════════════════════════════
  //  Homey app: no.futurehome (FutureHome hub / El-bil Lader)
  //  Pause:   evcharger_charging = false
  //  Resume:  evcharger_charging = true
  //  Note:    No dynamic current capability — on/off control only.
  //
  //  ⚠️ ACTIVE
  // ══════════════════════════════════════════════════════════════════

  async _setFutureHomeCurrent(deviceId, currentA) {
    if (!this._api) return false;

    const pendingTs = this._pendingChargerCommands[deviceId];
    if (pendingTs && (Date.now() - pendingTs) < 15000) {
      this.log(`[FutureHome] Skipping ${deviceId}, command still pending (${Math.round((Date.now() - pendingTs) / 1000)}s ago)`);
      return false;
    }

    try {
      const device = await withTimeout(
        this._api.devices.getDevice({ id: deviceId }),
        10000, `getDevice(${deviceId})`
      );
      if (!device) return false;

      this._pendingChargerCommands[deviceId] = Date.now();

      const pause = currentA === null || currentA === 0;
      const newVal = !pause;

      await withTimeout(
        device.setCapabilityValue({ capabilityId: 'evcharger_charging', value: newVal }),
        10000, `futureHomePauseResume(${deviceId}, ${newVal})`
      );

      const action = pause ? 'paused' : 'resumed';
      this._addLog(`FutureHome ${action}: ${device.name}`);
      this._appLogEntry('charger', `FutureHome ${action}: ${device.name}`);
      if (!this._chargerState[deviceId]) this._chargerState[deviceId] = {};
      Object.assign(this._chargerState[deviceId], {
        lastCommandA: pause ? 0 : currentA,
        commandTime: Date.now(),
        confirmed: false,
        timedOut: false
      });
      delete this._pendingChargerCommands[deviceId];
      return true;

    } catch (err) {
      delete this._pendingChargerCommands[deviceId];
      this.error(`[FutureHome] Failed to set charger state for ${deviceId}:`, err);
      return false;
    }
  }

  /**
   * Set Easee charger current using the HomeyAPI.
   * Only adjusts dynamic current (Midlertidig) — never touches Ladergrense or circuit/fuse settings.
   * Routes to brand-specific handlers for Zaptec and Enua.
   * @param {string} deviceId - Device ID
   * @param {number|null} currentA - Target current in amps (or null to pause)
   * @returns {Promise<boolean>} true if set successfully
   */
  // ══════════════════════════════════════════════════════════════════
  // █ SECTION 9 — EV CHARGER — EASEE                                            █
  // ══════════════════════════════════════════════════════════════════
  //  Homey app: no.easee
  //  Pause:   onoff = false
  //  Current: setCapabilityValue on dynamic_charger_current or dynamicChargerCurrent
  //  Ladergrense (ID47) and Sikringsgrense are managed by the charger's own app.
  //
  //  ✅ WORKING — Reasonably stable, test before changing
  // ══════════════════════════════════════════════════════════════════

  /**
   * Fires Homey flow triggers instead of calling a charger API directly.
   * Used when `entry.flowControlled = true` in the priority list.
   * The user wires the triggers to their own charger app in Homey flows.
   */
  async _handleFlowControlledCharger(deviceId, deviceName, currentA) {
    const alreadyTracked = this._mitigatedDevices.find(m => m.deviceId === deviceId);
    const wasPaused = alreadyTracked && (alreadyTracked.currentTargetA === 0 || alreadyTracked.currentTargetA === null);

    if (currentA === null) {
      this._triggerChargerShouldPause?.trigger({ device_name: deviceName })
        .catch(e => this.error('[FlowCharger] pause trigger error:', e));
      this._addLog(`Flow trigger: pause — ${deviceName}`);
      this._appLogEntry('charger', `Flow-controlled: pause — ${deviceName}`);
    } else if (wasPaused) {
      const startA = Math.min(CHARGER_DEFAULTS.startCurrent, currentA);
      this._triggerChargerShouldResume?.trigger({ device_name: deviceName, current_a: startA })
        .catch(e => this.error('[FlowCharger] resume trigger error:', e));
      this._addLog(`Flow trigger: resume → ${startA}A — ${deviceName}`);
      this._appLogEntry('charger', `Flow-controlled: resume → ${startA}A (target=${currentA}A) — ${deviceName}`);
    } else {
      this._triggerChargerCurrentChanged?.trigger({ device_name: deviceName, current_a: currentA })
        .catch(e => this.error('[FlowCharger] current trigger error:', e));
      this._addLog(`Flow trigger: current → ${currentA}A — ${deviceName}`);
      this._appLogEntry('charger', `Flow-controlled: current → ${currentA}A — ${deviceName}`);
    }

    // Track state so Power Guard knows what it last told the charger to do
    if (!this._chargerState[deviceId]) this._chargerState[deviceId] = {};
    Object.assign(this._chargerState[deviceId], {
      lastCommandA: currentA ?? 0, commandTime: Date.now(), confirmed: true, timedOut: false,
    });
    return true;
  }

  async _setEaseeChargerCurrent(deviceId, currentA) {
    if (!this._api) return false;

    // Route to flow-trigger handler FIRST — if user checked "flow-controlled",
    // always use flow triggers regardless of detected brand.
    const _plEntry = (this._settings.priorityList || []).find(e => e.deviceId === deviceId);
    if (_plEntry?.flowControlled) return this._handleFlowControlledCharger(deviceId, _plEntry.name, currentA);

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
            await withTimeout(
              device.setCapabilityValue({ capabilityId: 'onoff', value: false }),
              10000, `setOnOff(${deviceId})`
            );
            // Pre-arm the dynamic current limit to 6A so the next start always begins at minimum,
            // regardless of what current the charger was running at when it stopped.
            const dynCap = ['dynamic_charger_current', 'dynamicChargerCurrent', 'dynamicCircuitCurrentP1', 'target_charger_current']
              .find(cap => (device.capabilities || []).includes(cap));
            if (dynCap) {
              await withTimeout(
                device.setCapabilityValue({ capabilityId: dynCap, value: CHARGER_DEFAULTS.minCurrent }),
                10000, `preArmCurrent(${deviceId})`
              ).catch(() => {});
            }
            this._addLog(`Easee paused: ${device.name}`);
            this._appLogEntry('charger', `Easee paused: ${device.name} (pre-armed at ${CHARGER_DEFAULTS.minCurrent}A for next start)`);
            // Record command for confirmation tracking
            if (!this._chargerState[deviceId]) this._chargerState[deviceId] = {};
            Object.assign(this._chargerState[deviceId], { lastCommandA: 0, commandTime: Date.now(), confirmed: false, timedOut: false });
            delete this._pendingChargerCommands[deviceId];
            return true;
          }
          delete this._pendingChargerCommands[deviceId];
          return false;
        }

        // Item 2: When resuming from pause, set current first then turn on
        const alreadyTracked = this._mitigatedDevices.find(m => m.deviceId === deviceId);
        const isOff = device.capabilitiesObj?.onoff?.value === false;
        const wasPaused = isOff || (alreadyTracked && (alreadyTracked.currentTargetA === 0 || alreadyTracked.currentTargetA === null));
        if (wasPaused && device.capabilities.includes('onoff')) {
          if (isOff) {
            // Always resume at 6A (startCurrent = minCurrent) — ramps up 1A/min from there.
            const resumeCurrent = Math.min(CHARGER_DEFAULTS.startCurrent, currentA);

            const dynCap = ['dynamic_charger_current', 'dynamicChargerCurrent', 'dynamicCircuitCurrentP1', 'target_charger_current']
              .find(cap => (device.capabilities || []).includes(cap));
            if (dynCap) {
              await withTimeout(
                device.setCapabilityValue({ capabilityId: dynCap, value: resumeCurrent }),
                10000, `setStartCurrent(${deviceId})`
              );
              // Brief delay before turning on — gives Easee time to register the limit
              await new Promise(r => setTimeout(r, 3000));
            }
            await withTimeout(
              device.setCapabilityValue({ capabilityId: 'onoff', value: true }),
              10000, `resumeCharger(${deviceId})`
            );
            // Re-assert current limit after startup — Easee firmware resets the dynamic
            // limit internally when onoff=true fires, causing the car to draw at hardware
            // max (16A) for several seconds. Sending the limit again immediately after
            // startup overrides the firmware reset and enforces the correct A from start.
            if (dynCap) {
              await new Promise(r => setTimeout(r, 500));
              await device.setCapabilityValue({ capabilityId: dynCap, value: resumeCurrent }).catch(() => {});
              await new Promise(r => setTimeout(r, 2000));
              await device.setCapabilityValue({ capabilityId: dynCap, value: resumeCurrent }).catch(() => {});
            }
            this._addLog(`Easee resumed: ${device.name} → ${resumeCurrent}A (next cycle will optimize to ${currentA}A)`);
            this._appLogEntry('charger', `Easee resumed: ${device.name} → ${resumeCurrent}A (target=${currentA}A, will ramp up)`);
            // Record command for confirmation tracking
            const delayedConfirm = dynCap === 'target_charger_current';
            if (!this._chargerState[deviceId]) this._chargerState[deviceId] = {};
            Object.assign(this._chargerState[deviceId], {
              lastCommandA: resumeCurrent, commandTime: Date.now(), confirmed: false, timedOut: false,
              delayedConfirm, resumeImmunityUntil: Date.now() + (delayedConfirm ? 120000 : 60000),
            });
            this.log(`[Easee] Resume via ${dynCap} — ${delayedConfirm ? '120s' : '60s'} immunity window active`);
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
          this._addLog(`Easee dynamic: ${device.name} → ${currentA}A`);
          this._appLogEntry('charger', `Easee current: ${device.name} → ${currentA}A (${dynCap})`);
          // Record command for confirmation tracking
          if (!this._chargerState[deviceId]) this._chargerState[deviceId] = {};
          Object.assign(this._chargerState[deviceId], { lastCommandA: currentA, commandTime: Date.now(), confirmed: false, timedOut: false, delayedConfirm: dynCap === 'target_charger_current' });
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

  // ══════════════════════════════════════════════════════════════════
  // █ SECTION 10 — DIAGNOSTICS & SETTINGS PAGE API                              █
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
      lastHanReading: this._lastHanReading ? timestamp(new Date(this._lastHanReading)) : null,
      hanSuspendedUntil: this._hanSuspendedUntil > Date.now() ? this._hanSuspendedUntil : null,
      cooldownSeconds: this._settings.cooldownSeconds,
      lastMitigationTime: this._lastMitigationTime ? timestamp(new Date(this._lastMitigationTime)) : null,
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
      const ts = new Date().toISOString();
      const line = `[${ts}] ${message}`;
      // _powerConsumptionLog removed — use _appLog instead
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

    // Always include devices from the priority list (any controllable action),
    // regardless of device name or class — so any device managed by PowerGuard shows up.
    const managedDeviceIds = new Set(
      (this._settings.priorityList || [])
        .filter(e => e.action !== 'charge_pause' && e.action !== 'dynamic_current' && e.enabled !== false)
        .map(e => e.deviceId)
    );
    const managedThermostatIds = managedDeviceIds; // kept for compat below
    
    this.log(`[FloorHeater] ==== START FLOOR HEATER CHECK ====`);
    this.log(`[FloorHeater] Total devices in cache: ${allDevices.length}`);
    this.log(`[FloorHeater] HomeyAPI available: ${!!this._api}`);
    
    for (const cached of allDevices) {
      if (!cached) continue;
      
      const name = (cached.name || '').toLowerCase();
      const cls = (cached.class || '').toLowerCase();
      
      // Identify thermostats / heaters (works for all brands: Futurehome, Z-Wave, Zigbee, etc.)
      // Also always include any device managed by PowerGuard (onoff, dim, target_temperature).
      const isFloorHeater = cls === 'thermostat' ||
                            cls === 'heater' ||
                            name.includes('floor') ||
                            name.includes('varme') ||
                            name.includes('heating') ||
                            name.includes('gulv') ||
                            name.includes('termostat') ||
                            name.includes('thermostat') ||
                            managedDeviceIds.has(cached.id);
      
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
      const hasTuyaLoadStatus = caps.includes('tuya_thermostat_load_status');
      const hasTuyaMode = caps.includes('tuya_thermostat_mode');
      const hasZg9030aModes = caps.includes('zg9030a_modes'); // Futurehome ZG9030A thermostat
      const canControl = targetTempCap !== null || hasOnOff;
      
      this.log(`[FloorHeater]   targetTempCap: ${targetTempCap || 'NONE'} | measureTempCap: ${measureTempCap || 'NONE'} | onoff: ${hasOnOff} | tuyaLoad: ${hasTuyaLoadStatus} | zg9030a: ${hasZg9030aModes}`);
      
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
          // ── isOn: reflects whether the thermostat is ENABLED (toggle button) ──
          // Rule: if device has onoff, isOn = onoff. Period. Nothing else touches it.
          //       The toggle shows "is this thermostat turned on", not "is it heating now".
          //       Heating state (orange row/badge) is handled separately via power/load_status.
          // Fallback for devices with no onoff: use mode signals instead.
          if (hasOnOff && source.capabilitiesObj.onoff) {
            const v = source.capabilitiesObj.onoff;
            isOn = v.value !== undefined ? v.value : v;
          } else if (hasTuyaLoadStatus && source.capabilitiesObj.tuya_thermostat_load_status) {
            // No onoff cap — use element state as best proxy
            const v = source.capabilitiesObj.tuya_thermostat_load_status;
            isOn = v.value !== undefined ? v.value : v;
          } else if (hasTuyaMode && source.capabilitiesObj.tuya_thermostat_mode) {
            // No onoff/load cap — 'off' means disabled, anything else means enabled
            const v = source.capabilitiesObj.tuya_thermostat_mode;
            const mode = v.value !== undefined ? v.value : v;
            isOn = !(mode === 'off' || mode === '0' || mode === 0);
          } else if (hasZg9030aModes && source.capabilitiesObj.zg9030a_modes) {
            // Futurehome ZG9030A with no onoff cap
            const v = source.capabilitiesObj.zg9030a_modes;
            const mode = v.value !== undefined ? v.value : v;
            isOn = !(mode === 'off' || mode === 0 || mode === '0');
          }
          // Log Futurehome mode for diagnostics
          if (hasZg9030aModes && source.capabilitiesObj.zg9030a_modes) {
            const v = source.capabilitiesObj.zg9030a_modes;
            const mode = v.value !== undefined ? v.value : v;
            this.log(`[FloorHeater]   [Futurehome] zg9030a_modes=${JSON.stringify(mode)} isOn=${isOn}`);
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
      if (liveDevice && liveDevice.zone && typeof liveDevice.zone === 'object' && liveDevice.zone.name) {
        zoneName = liveDevice.zone.name;
      } else if (cached.zoneName) {
        zoneName = cached.zoneName;
      } else if (cached.zone && typeof cached.zone === 'object' && cached.zone.name) {
        zoneName = cached.zone.name;
      }
      
      // If no zone, use driver/brand name instead of "Unknown"
      if (!zoneName) {
        const driverStr = (liveDevice && liveDevice.driverId) || cached.driverId || '';
        zoneName = driverStr.replace(/^homey:app:/, '').replace(/[:.]/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim() || '';
      }

      // Check if this heater is currently being controlled by the mitigation engine
      const mitigEntry = (this._mitigatedDevices || []).find(m => m.deviceId === cached.id);
      const mitigated = !!mitigEntry;
      // step 1 = lowered 3°C (device still on), step 2 = turned off
      const mitigationStep = mitigated ? (isOn === false ? 2 : 1) : 0;

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
        mitigated: mitigated,
        mitigationStep: mitigationStep,
        capabilities: caps,
        timestamp: timestamp()
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
        this._appLogEntry('charger', `[FloorHeater] Control failed: HomeyAPI not available`);
        return { ok: false, error: 'HomeyAPI not available' };
      }
      
      // Get the LIVE device object from the API (has setCapabilityValue method)
      const device = await this._api.devices.getDevice({ id: deviceId });
      
      if (!device) {
        this._appLogEntry('charger', `[FloorHeater] Device not found: ${deviceId}`);
        return { ok: false, error: 'Device not found' };
      }

      // Helper: try object-style first, fall back to string-style (handles homey-api version differences)
      const setCap = async (capId, val) => {
        try {
          await device.setCapabilityValue({ capabilityId: capId, value: val });
        } catch (e1) {
          // Fallback to old string-style API
          await device.setCapabilityValue(capId, val);
        }
      };
      
      // Use capabilities array (most reliable) and capabilitiesObj for values
      const caps = device.capabilities || [];
      const obj  = device.capabilitiesObj || {};
      this._appLogEntry('charger', `[FloorHeater] ${action} "${device.name}" val=${value} caps=${caps.join(',')}`);
      
      // Find correct target temperature capability
      let targetTempCap = null;
      for (const candidate of ['target_temperature', 'set_temperature', 'setpoint_temperature', 'heating_setpoint', 'desired_temperature']) {
        if (caps.includes(candidate)) { targetTempCap = candidate; break; }
      }
      
      if (action === 'on') {
        if (caps.includes('onoff')) {
          await setCap('onoff', true);
        } else if (caps.includes('toggleChargingCapability')) {
          await setCap('toggleChargingCapability', true);
        } else {
          return { ok: false, error: `${device.name} has no on/off capability` };
        }
        // User manually turned device ON — clear any mitigation so the bounce guard
        // doesn't immediately fight back and turn it off again.
        const prevLen = this._mitigatedDevices.length;
        this._mitigatedDevices = this._mitigatedDevices.filter(m => m.deviceId !== deviceId);
        if (this._mitigatedDevices.length !== prevLen) {
          this._persistMitigatedDevices();
          this.log(`[FloorHeater] ${device.name} cleared from mitigation list (manual ON override)`);
        }
        this._appLogEntry('charger', `[FloorHeater] ${device.name} → ON`);
        return { ok: true, message: `${device.name} turned on` };
        
      } else if (action === 'off') {
        if (caps.includes('onoff')) {
          await setCap('onoff', false);
        } else if (caps.includes('toggleChargingCapability')) {
          await setCap('toggleChargingCapability', false);
        } else {
          return { ok: false, error: `${device.name} has no on/off capability` };
        }
        this._appLogEntry('charger', `[FloorHeater] ${device.name} → OFF`);
        return { ok: true, message: `${device.name} turned off` };
        
      } else if (action === 'setTarget') {
        const temp = parseFloat(value);
        if (isNaN(temp)) {
          return { ok: false, error: 'Invalid temperature value' };
        }
        if (!targetTempCap) {
          this._appLogEntry('charger', `[FloorHeater] No temp cap on "${device.name}". Caps: ${caps.join(',')}`);
          return { ok: false, error: `${device.name} has no temperature control capability` };
        }
        // Switch to manual/heat mode first so thermostats with a cloud schedule
        // (e.g. FutureHome) don't revert the temperature change immediately.
        if (caps.includes('thermostat_mode')) {
          const currentMode = obj.thermostat_mode ? obj.thermostat_mode.value : null;
          if (currentMode !== 'heat') {
            this._appLogEntry('charger', `[FloorHeater] ${device.name} switching thermostat_mode → heat (was: ${currentMode})`);
            await setCap('thermostat_mode', 'heat');
          }
        }
        await setCap(targetTempCap, temp);
        this._appLogEntry('charger', `[FloorHeater] ${device.name} set to ${temp}°C via ${targetTempCap} ✓`);
        return { ok: true, message: `${device.name} set to ${temp}°C` };
        
      } else if (action === 'setHoiax') {
        // Set Høiax water heater power level for mode
        const maxPowerCap = caps.includes('max_power_3000') ? 'max_power_3000'
                          : caps.includes('max_power_2000') ? 'max_power_2000'
                          : caps.includes('max_power')      ? 'max_power'
                          : null;
        if (value === 'off') {
          if (caps.includes('onoff')) {
            await setCap('onoff', false);
            this._appLogEntry('charger', `[FloorHeater] Høiax ${device.name} → OFF`);
            return { ok: true, message: `${device.name} turned off` };
          }
          return { ok: false, error: `${device.name} has no onoff capability` };
        }
        if (!maxPowerCap) {
          return { ok: false, error: `${device.name} has no Høiax power capability` };
        }
        // Ensure device is on before setting power level
        if (caps.includes('onoff') && obj.onoff && obj.onoff.value === false) {
          await setCap('onoff', true);
        }
        await setCap(maxPowerCap, value);
        this._appLogEntry('charger', `[FloorHeater] Høiax ${device.name} set to ${value} via ${maxPowerCap} ✓`);
        return { ok: true, message: `${device.name} set to ${value}` };
      } else {
        return { ok: false, error: `Unknown action: ${action}` };
      }
    } catch (err) {
      this._appLogEntry('charger', `[FloorHeater] ✗ ${action} on ${deviceId}: ${err.message}`);
      return { ok: false, error: err.message };
    }
  }

  // ─── Public API (settings UI) ─────────────────────────────────────────────

  _updatePowerConsumption(currentTotalW) {
    // Update rolling window stats — current values are kept live by capability subscriptions.
    // Called periodically from the watchdog to update avg/peak.
    try {
      const entries = Object.values(this._powerConsumptionData);
      if (!entries.length) return;
      entries.forEach(data => {
        // Re-apply Adax mitigation check on each tick (mitigated state changes asynchronously)
        if (Object.prototype.hasOwnProperty.call(this._adaxRawPower, data.deviceId)) {
          this._recomputeAdaxCurrent(data.deviceId);
        }
        data.readings.push(data.current);
        if (data.readings.length > 30) data.readings.shift();
        if (data.readings.length > 0) {
          data.avg  = Math.round(data.readings.reduce((a, b) => a + b, 0) / data.readings.length);
          data.peak = Math.max(...data.readings);
        }
      });
    } catch (err) {
      this._writeDebugLog(`ERROR in _updatePowerConsumption: ${err.message}`);
    }
  }

  getPowerConsumption() {
    // Return ALL devices with measure_power capability, sorted by current power
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
      const entries = (this._appLog || []).filter(e => e.category === 'energy' || e.category === 'cache' || e.category === 'system');
      const log = entries.map(e => `[${e.time}] ${e.message}`).join('\n');
      return {
        ok: true,
        log: log || '[No log entries yet]',
        lines: entries.length,
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
            if (this._chargerState[entry.deviceId]?.waitingForCapacity) {
              status = 'waiting_capacity';
              statusLabel = 'Venter på ledig kapasitet';
            } else {
              status = 'paused';
              statusLabel = 'Paused by Power Guard';
            }
            currentA = 0;
          } else if (mitigated.currentTargetA >= (entry.circuitLimitA || 32)) {
            status = 'charging';
            statusLabel = 'Charging (' + mitigated.currentTargetA + 'A)';
            currentA = mitigated.currentTargetA;
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
          // Connected but not drawing power — check if price control is holding it back
          const _priceCapNow = this._getPriceCurrentCap(entry.deviceId, entry.circuitLimitA || 32);
          if (_priceCapNow <= 0) {
            status = 'waiting_price';
            statusLabel = 'Venter på billig time';
          } else {
            status = 'connected';
            statusLabel = 'Connected';
          }
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
          detectedPhases: evData.detectedPhases || null,
          wattsPerAmp: evData.wattsPerAmp || null,
          chargeNow: !!(this._chargeNow && this._chargeNow[entry.deviceId]),
          minResumeW: (this._chargerState[entry.deviceId] || {}).minResumeW || null,
          headroomW:  (this._chargerState[entry.deviceId] || {}).headroomW  != null ? (this._chargerState[entry.deviceId] || {}).headroomW : null,
        };
      });

    return {
      enabled:          this._settings.enabled,
      profile:          this._settings.profile,
      currentPowerW:    movingAverage(this._powerBuffer, this._settings.smoothingWindow),
      rawPowerW:        this._powerBuffer.length > 0 ? this._powerBuffer[this._powerBuffer.length - 1] : null,
      limitW:           this._getEffectiveLimit(),
      overLimitCount:   this._overLimitCount,
      mitigatedDevices: this._mitigatedDevices.map(m => ({
        deviceId: m.deviceId,
        action:   m.action,
        prevTemp: m.previousState && m.previousState.target_temperature != null ? m.previousState.target_temperature : null,
      })),
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
    for (const key of [
      '_watchdogInterval',
      '_cacheRefreshInterval',
      '_hanPollInterval',
      '_resourceMonitorInterval',
      '_queueProcessorInterval',
      '_priceEngineInterval',
      '_modeSchedulerInterval',
    ]) {
      if (this[key]) {
        clearInterval(this[key]);
        this[key] = null;
      }
    }
    if (this._settingsFileSaveTimer) {
      clearTimeout(this._settingsFileSaveTimer);
      this._settingsFileSaveTimer = null;
    }
    if (this._hanCapabilityInstance) {
      try { this._hanCapabilityInstance.destroy(); } catch (_) {}
    }
    for (const inst of Object.values(this._evCapabilityInstances || {})) {
      try { inst.destroy(); } catch (_) {}
    }
    for (const inst of Object.values(this._powerCapabilityInstances || {})) {
      try { inst.destroy(); } catch (_) {}
    }
    for (const instList of Object.values(this._adaxCapabilityInstances || {})) {
      for (const inst of (Array.isArray(instList) ? instList : [])) {
        try { inst.destroy(); } catch (_) {}
      }
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
                            'evcharger_charging', 'evcharger_charging_state',
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

      // Detect charger type — check Easee BEFORE FutureHome (Easee also has evcharger_charging)
      const isZaptec = caps.includes('charging_button');
      const isEnua = caps.includes('toggleChargingCapability');
      const isEasee = caps.includes('target_charger_current') || caps.includes('target_circuit_current') ||
                      caps.includes('dynamic_charger_current') || caps.includes('dynamicChargerCurrent');
      const isFutureHome = !isEasee && caps.includes('evcharger_charging');

      if (isZaptec) {
        // ── Zaptec test path ──
        results.steps.push({ step: 'Charger type', ok: true, detail: 'Zaptec (charging_button + Flow API dynamic current)' });

        const btnVal = obj.charging_button ? obj.charging_button.value : null;
        results.steps.push({ step: 'charging_button', ok: true, detail: `Current value: ${btnVal}` });

        // Write-back test: only run when charging_button is true (charging active).
        // Zaptec rejects charging_button=true (Resume command) when not paused/scheduled.
        // Treat "not Paused nor Scheduled" error as OK — it means the charger is already running.
        if (btnVal === true) {
          try {
            await device.setCapabilityValue({ capabilityId: 'charging_button', value: true });
            results.steps.push({ step: 'Write test', ok: true, detail: `Wrote charging_button = true (no change needed)` });
          } catch (err) {
            const isExpected = err.message && err.message.toLowerCase().includes('not paused');
            results.steps.push({ step: 'Write test', ok: isExpected,
              detail: isExpected
                ? `OK — charger is already active (Zaptec rejects Resume when not paused, as expected)`
                : `Failed to write charging_button: ${err.message}` });
          }
        } else {
          results.steps.push({ step: 'Write test', ok: true, detail: `Skipped — charger is paused/finished (Zaptec rejects writes when already paused)` });
        }

        // Check car connected status
        const carConnected = obj['alarm_generic.car_connected'] ? obj['alarm_generic.car_connected'].value : 'unknown';
        results.steps.push({ step: 'Car connected', ok: true, detail: `${carConnected}` });

        // Check available installation current (read-only)
        const availCurrent = obj.available_installation_current ? obj.available_installation_current.value : 'unknown';
        results.steps.push({ step: 'Installation current', ok: true, detail: `Available: ${availCurrent}A` });

        // Test Flow API by actually calling the known action with 0A (safe no-op).
        // Homey only enumerates flow actions for apps that have been used in a Flow —
        // so enumeration will always fail for new users. Instead, we probe directly
        // with the two known IDs (Go = installation_current_control,
        // Home = home_installation_current_control) and treat a non-"unknown action"
        // response as success.
        const knownIds = ['installation_current_control', 'home_installation_current_control',
                         'go2_installation_current_control', 'pro_installation_current_control'];
        let flowOk = false;
        let workingId = null;
        let flowErr = null;
        for (const actionId of knownIds) {
          try {
            await this._api.flow.runFlowCardAction({
              uri: 'homey:app:com.zaptec',
              id: actionId,
              args: { device: { id: deviceId, name: device.name }, current1: 0, current2: 0, current3: 0 }
            });
            flowOk = true;
            workingId = actionId;
            break;
          } catch (err) {
            // "unknown action" = action doesn't exist; any other error = action exists but failed
            if (!err.message?.toLowerCase().includes('unknown')) {
              flowOk = true;
              workingId = actionId;
              break;
            }
            flowErr = err.message;
          }
        }
        if (flowOk) {
          results.steps.push({ step: 'Flow API', ok: true, detail: `Action "${workingId}" confirmed working — dynamic current ready` });
          // Warm up the cache so real commands use the correct ID immediately
          if (!this._flowActionCache) this._flowActionCache = {};
          this._flowActionCache['zaptec'] = { uri: 'homey:app:com.zaptec', actionId: workingId, argsStyle: 'zaptec3phase' };
        } else {
          results.steps.push({ step: 'Flow API', ok: false, detail: `Neither known Zaptec action responded. Last error: ${flowErr || 'unknown'}. Dynamic current control may not work.` });
        }

        results.success = !results.steps.some(s => s.ok === false);

      } else if (isEnua) {
        // ── Enua test path ──
        results.steps.push({ step: 'Charger type', ok: true, detail: 'Enua Charge E (toggleChargingCapability + Flow API dynamic current)' });

        const chargingVal = obj.toggleChargingCapability ? obj.toggleChargingCapability.value : null;
        results.steps.push({ step: 'toggleChargingCapability', ok: true, detail: `Current value: ${chargingVal}` });

        // Write-back test (write same value back — no actual change)
        try {
          const writeVal = chargingVal !== null ? chargingVal : true;
          await device.setCapabilityValue({ capabilityId: 'toggleChargingCapability', value: writeVal });
          results.steps.push({ step: 'Write test', ok: true, detail: `Wrote toggleChargingCapability = ${writeVal} (same as current — no change)` });
        } catch (err) {
          results.steps.push({ step: 'Write test', ok: false, detail: `Failed to write toggleChargingCapability: ${err.message}` });
        }

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
              results.steps.push({ step: 'Flow API', ok: false, detail: 'No Enua flow actions found via enumeration. Dynamic current control via Flow API may not work.' });
            }
          }
        } catch (flowErr) {
          results.steps.push({ step: 'Flow API', ok: false, detail: `Flow API error: ${flowErr.message}` });
        }

        results.success = !results.steps.some(s => s.ok === false);

      } else if (isFutureHome) {
        // ── FutureHome test path ──
        results.steps.push({ step: 'Charger type', ok: true, detail: 'FutureHome El-bil Lader (evcharger_charging on/off control)' });

        const chargingVal = obj.evcharger_charging ? obj.evcharger_charging.value : null;
        results.steps.push({ step: 'evcharger_charging', ok: true, detail: `Current value: ${chargingVal}` });

        const stateVal = obj.evcharger_charging_state ? obj.evcharger_charging_state.value : 'unknown';
        results.steps.push({ step: 'evcharger_charging_state', ok: true, detail: `State: ${stateVal}` });

        // Write-back test (write same value back — no actual change)
        try {
          const writeVal = chargingVal !== null ? chargingVal : true;
          await device.setCapabilityValue({ capabilityId: 'evcharger_charging', value: writeVal });
          results.steps.push({ step: 'Write test', ok: true, detail: `Wrote evcharger_charging = ${writeVal} (same as current — no change)` });
          results.success = true;
        } catch (err) {
          results.steps.push({ step: 'Write test', ok: false, detail: `Failed to write evcharger_charging: ${err.message}` });
        }

        results.steps.push({ step: 'Note', ok: true, detail: 'FutureHome supports pause/resume only — no dynamic current control available.' });

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
        const ownerUri = (device.driver && device.driver.owner_uri) || device.driverId || '';
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

  // ════════════════════════════════════════════════════════════════
  // █ SECTION 12 — SPOT PRICE ENGINE                                           █
  // ════════════════════════════════════════════════════════════════
  //  Fetches spot prices from hvakosterstrommen.no every 30 min.
  //  Evaluates current price level (billig/normal/dyr/ekstremt dyr) and
  //  derive a charge mode (av/lav/normal/maks) with hysteresis.
  //
  //  ADDITIVE: only caps charger current via _getPriceCurrentCap().
  //  Power Guard's hard watt-limit enforcement is unaffected.
  //  If price control is disabled or data unavailable: cap = circuitLimitA (no effect).
  //
  //  TO REMOVE ENTIRELY:
  //    1. Delete this SECTION 12 block
  //    2. Delete the _startPriceEngine() call in onInit
  //    3. Remove PRICE_DEFAULTS from constants.js and its import here
  //    5. Remove getPriceData / setPriceSettings from api.js
  //    6. Remove the price tab from settings/index.html
  // ════════════════════════════════════════════════════════════════

  async _startPriceEngine() {
    const saved = this.homey.settings.get('priceSettings');
    if (saved && typeof saved === 'object') {
      this._priceSettings = Object.assign({}, PRICE_DEFAULTS, saved);
    }
    // Restore last known price state so price control is active immediately on restart,
    // before the first API fetch completes. Without this, _priceState = null for the
    // duration of the fetch → _getPriceCurrentCap() returns circuitLimitA (no restriction),
    // which means a charger paused for high price may briefly start drawing power.
    const savedState = this.homey.settings.get('priceStateCache');
    if (savedState && typeof savedState === 'object' && savedState.updatedAt) {
      // Only use cache if it's less than 2 hours old (prices change hourly)
      const ageMs = Date.now() - (savedState.updatedAt || 0);
      if (ageMs < 2 * 60 * 60 * 1000) {
        this._priceState = savedState;
        this.log(`[Price] Restored cached price state (${Math.round(ageMs / 60000)}min old): level=${savedState.level} mode=${savedState.chargeMode}`);
      } else {
        this.log(`[Price] Cached price state too old (${Math.round(ageMs / 60000)}min), waiting for fresh fetch`);
      }
    }
    await this._fetchAndEvaluatePrices();
    // Refresh every 30 minutes
    this._priceEngineInterval = setInterval(async () => { const _t = Date.now(); await this._fetchAndEvaluatePrices().catch(err => this.error('[Price] Fetch error:', err)); this._trackCallTime('priceEngine', Date.now() - _t); }, 30 * 60 * 1000);
  }

  async _fetchAndEvaluatePrices() {
    try {
      const cfg = this._priceSettings;
      const now = new Date();
      const entries = await this._priceFetchAllRelevant(now, cfg);
      if (!entries.length) return;

      const currentEntry = entries.find(e => now >= e.start && now < e.end);
      if (!currentEntry) return;

      const lookahead  = this._priceBuildWindow(entries, now, cfg.lookaheadHours || 18);
      const stats      = this._priceStats(lookahead.map(e => e.adjustedOre));
      const suggested  = this._priceSuggestLevel(currentEntry.adjustedOre, stats);
      const prev       = this._priceState;
      const finalLevel = this._priceApplyHysteresis(prev ? prev.level : null, suggested, currentEntry.adjustedOre, stats);

      const nextEntry = entries.find(e => e.start.getTime() === currentEntry.end.getTime()) || null;

      // ── Shared charge mode — one window for all chargers, current split equally ─
      const rawMode        = this._priceSuggestChargeMode(currentEntry, nextEntry, finalLevel, stats, lookahead, cfg);
      const deadlineForced = this._deadlineForced === true;
      this._deadlineForced = false;
      let finalMode        = deadlineForced
        ? rawMode
        : this._priceApplyChargeModeHysteresis(prev ? prev.chargeMode : null, rawMode, currentEntry, nextEntry, finalLevel, stats, lookahead, cfg);

      // Copy the shared mode into per-charger map (for UI display per charger)
      const priceChargers = (this._settings.priorityList || []).filter(e => e.priceControlled);
      const chargeModes = {};
      for (const ce of priceChargers) chargeModes[ce.deviceId] = finalMode;

      const r2 = v => Math.round(v * 100) / 100;

      // Suppress global chargeMode when no connected car needs charging.
      // Use all entries with a linked car device (carDeviceId), not just priceControlled ones.
      const carEntries = (this._settings.priorityList || []).filter(e => e.carDeviceId);
      if (carEntries.length > 0 && carEntries.every(e => {
        const evData = this._evPowerData[e.deviceId];
        if (!evData || !evData.isConnected) return true; // not connected → nothing to charge
        const bst = this._evBatteryState[e.deviceId];
        return bst && typeof bst.pct === 'number' && bst.pct >= 99; // connected but full
      })) {
        finalMode = null;
      }

      this._priceState = {
        level:      finalLevel,
        chargeMode: finalMode,   // backward compat — first charger's mode (or global if no chargers)
        chargeModes,             // per-charger: { deviceId: 'av' | 'lav' | 'normal' | 'maks' }
        currentOre: r2(currentEntry.adjustedOre),
        spotOre:    r2(currentEntry.spotOre),
        nextOre:    nextEntry ? r2(nextEntry.adjustedOre) : null,
        nightDiscount: currentEntry.nightDiscountApplied,
        norgespris: currentEntry.norgesprisApplied ? (cfg.norgesprisFlatOre || 50) : 0,
        entries: lookahead.map(e => ({
          hour:  e.start.toISOString(),
          ore:   r2(e.adjustedOre),
          // Use hysteresis-applied level for the current hour so chart bar matches the badge
          level: e.start.getTime() === currentEntry.start.getTime()
            ? finalLevel
            : this._priceSuggestLevel(e.adjustedOre, stats),
        })),
        stats: {
          min:    r2(stats.min),
          max:    r2(stats.max),
          mean:   r2(stats.mean),
          p25:    r2(stats.p25),
          p75:    r2(stats.p75),
          p90:    r2(stats.p90),
          spread: r2(stats.spread),
        },
        source:    'api',
        updatedAt: Date.now(),
      };

      this._appLogEntry('system', `[Price] Level=${finalLevel} (${r2(currentEntry.adjustedOre)}øre) Mode=${finalMode}`);

      // Persist price state so it can be restored immediately on next app restart,
      // preventing a price-control blackout while waiting for the first API fetch.
      this.homey.settings.set('priceStateCache', this._priceState);

      // Auto-update EV battery state from linked car devices (every 30 min price cycle)
      this._pollAllCarBatteries().catch(err => this.error('[CarBattery] Poll error:', err));
    } catch (err) {
      this.error('[Price] Evaluation error:', err);
    }
  }

  async _priceFetchAllRelevant(now, cfg) {
    const area = cfg.priceArea || 'NO4';
    const toDateParts = (d) => {
      const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Oslo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
      return { year: p.find(x => x.type === 'year').value, month: p.find(x => x.type === 'month').value, day: p.find(x => x.type === 'day').value };
    };
    const fetchDay = async (y, m, d) => {
      const url = `https://www.hvakosterstrommen.no/api/v1/prices/${y}/${m}-${d}_${area}.json`;
      return new Promise((resolve, reject) => {
        https.get(url, (res) => {
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode} for ${url}`));
            res.resume();
            return;
          }
          let raw = '';
          res.on('data', chunk => { raw += chunk; });
          res.on('end', () => {
            try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
          });
        }).on('error', reject);
      });
    };
    const today = toDateParts(now);
    let rows = await fetchDay(today.year, today.month, today.day);
    try {
      const tmw = toDateParts(new Date(now.getTime() + 86400000));
      const tmwRows = await fetchDay(tmw.year, tmw.month, tmw.day);
      if (!Array.isArray(tmwRows)) {
        this._appLogEntry('system', `[Price] Tomorrow fetch returned non-array: ${JSON.stringify(tmwRows).slice(0, 120)}`);
      } else if (tmwRows.length === 0) {
        this._appLogEntry('system', '[Price] Tomorrow fetch returned 0 rows (not yet published?)');
      } else {
        rows = rows.concat(tmwRows);
      }
    } catch (err) { this._appLogEntry('system', `[Price] Tomorrow fetch failed: ${err.message}`); }
    return this._priceParseRows(rows, cfg);
  }

  _priceParseRows(rows, cfg) {
    const getLocalHour = (date) =>
      Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Oslo', hour: '2-digit', hour12: false }).format(date));
    const isNight = (h) => h >= (cfg.nightStartHour || 22) || h < (cfg.nightEndHour || 6);
    const parsed = rows
      .filter(r => r && typeof r.NOK_per_kWh === 'number' && r.time_start)
      .map(r => {
        const start = new Date(r.time_start);
        const end   = new Date(r.time_end);
        if (isNaN(start.getTime())) return null;
        const localHour    = getLocalHour(start);
        const spotOre      = r.NOK_per_kWh * 100;
        const nightDiscount = isNight(localHour) ? (cfg.nightDiscountOre || 0) : 0;
        // Norgespris: flat rate replaces spot — you always pay cfg.norgesprisFlatOre regardless of spot
        const adjustedOre = cfg.norgesprisEnabled
          ? (cfg.norgesprisFlatOre || 50)
          : (spotOre - nightDiscount);
        return { start, end, localHour, spotOre, nightDiscountApplied: nightDiscount > 0, norgesprisApplied: !!cfg.norgesprisEnabled, adjustedOre };
      })
      .filter(Boolean)
      .sort((a, b) => a.start - b.start);
    const seen = new Set();
    return parsed.filter(e => { const k = e.start.getTime(); if (seen.has(k)) return false; seen.add(k); return true; });
  }

  _priceBuildWindow(entries, now, hours) {
    const end = new Date(now.getTime() + hours * 3600000);
    return entries.filter(e => e.end > now && e.start < end);
  }

  _priceStats(values) {
    if (!values.length) return { min: 0, max: 0, mean: 0, p25: 0, p50: 0, p75: 0, p90: 0, spread: 0 };
    const s = [...values].sort((a, b) => a - b);
    const pct = (p) => { const i = (s.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return lo === hi ? s[lo] : s[hi] * (i - lo) + s[lo] * (1 - (i - lo)); };
    const mean = s.reduce((a, b) => a + b, 0) / s.length;
    return { min: s[0], max: s[s.length - 1], mean, p25: pct(0.25), p50: pct(0.5), p75: pct(0.75), p90: pct(0.9), spread: s[s.length - 1] - s[0] };
  }

  _priceSuggestLevel(ore, stats) {
    const { spread, p25, p75, p90, mean } = stats;
    if (spread <= 8)  return 'normal';
    if (spread <= 16) return ore <= p25 ? 'billig' : 'normal';
    if (spread <= 32) {
      if (ore <= p25)       return 'billig';
      if (ore >= p75 + 1)   return 'dyr';
      return 'normal';
    }
    if (ore <= p25)                            return 'billig';
    if (ore >= p90 && ore >= mean + 18)        return 'ekstremt dyr';
    if (ore >= p75)                            return 'dyr';
    return 'normal';
  }

  _priceApplyHysteresis(prev, suggested, ore, stats) {
    if (!prev || prev === suggested) return suggested;
    // Flat-rate pricing: spread is ~0, all price margins are meaningless — skip hysteresis.
    if (stats.spread <= 8) return suggested;
    const marginSoft = stats.spread <= 32 ? 6 : 4;  // for billig ↔ normal (less critical)
    const marginHard = 1;                             // for normal ↔ dyr/ekstremt (must react fast)
    if (prev === 'billig'       && suggested === 'normal'      && ore <= stats.p25 + marginSoft) return 'billig';
    if (prev === 'normal') {
      if (suggested === 'billig'      && ore >  stats.p25 - marginSoft) return 'normal';
      if (suggested === 'dyr'         && ore <  stats.p75 + marginHard) return 'normal';
      if (suggested === 'ekstremt dyr'&& ore <  stats.p90 + marginHard) return 'normal';
    }
    if (prev === 'dyr') {
      if (suggested === 'normal'      && ore >= stats.p75 - marginHard) return 'dyr';
      if (suggested === 'ekstremt dyr'&& ore <  stats.p90 + marginHard) return 'dyr';
    }
    if (prev === 'ekstremt dyr' && suggested === 'dyr' && ore >= Math.max(stats.p90 - marginHard, stats.mean + 18 - marginHard)) return 'ekstremt dyr';
    return suggested;
  }

  _priceSuggestChargeMode(currentEntry, nextEntry, level, stats, lookahead, cfg) {
    // ── Resolve hoursNeeded — largest across all chargers sets the shared window ─
    // All chargers use the same cheapest-hours window; the dynamic current loop
    // already splits available power equally between them.
    let hoursNeeded = null;
    const priceChargers = (this._settings.priorityList || []).filter(e => e.batteryCapacityKwh || e.carDeviceId);
    let maxHours = 0; let anyValid = false;
    for (const e of priceChargers) {
      const bst = this._evBatteryState[e.deviceId];
      if (!bst || Date.now() - bst.updatedAt > 24 * 3_600_000) continue;
      if (typeof bst.hoursNeeded === 'number') { anyValid = true; maxHours = Math.max(maxHours, bst.hoursNeeded); }
    }
    if (anyValid) hoursNeeded = maxHours;

    // If all chargers are already at/above their target percentage — stop charging.
    // hoursNeeded===0 should not fall through to "use all hours" via hoursBeforeDeadline.length.
    if (anyValid && hoursNeeded === 0) {
      this.log('[Price] All chargers at/above target — returning av');
      this._deadlineForced = true;
      return 'av';
    }

    if (hoursNeeded === null) {
      const manual = this.homey.settings.get('ev_ladebehov_timer');
      if (typeof manual === 'number' && manual > 0) hoursNeeded = manual;
    }

    // ── Deadline + smart-skip logic ───────────────────────────────────────────
    const ferdigKl = this.homey.settings.get('ev_ferdig_ladet_kl'); // e.g. "07:00"
    if (ferdigKl && typeof ferdigKl === 'string' && ferdigKl.includes(':')) {
      const [hh, mm]   = ferdigKl.split(':').map(Number);
      const now        = currentEntry.start;
      const deadline   = new Date(now);
      deadline.setHours(hh, mm || 0, 0, 0);
      if (deadline <= now) deadline.setDate(deadline.getDate() + 1);

      const hoursRemaining = (deadline - now) / 3_600_000;

      const hoursBeforeDeadline = lookahead.filter(e =>
        e.start >= currentEntry.start && e.start < deadline
      );

      // If hoursNeeded is unknown, charge during ALL hours before the deadline
      // (deadline is set so the car must be ready — can't skip charging entirely).
      const effectiveHoursNeeded = (hoursNeeded !== null && hoursNeeded > 0)
        ? hoursNeeded
        : hoursBeforeDeadline.length;

      if (effectiveHoursNeeded > 0) {
        // CRITICAL: deadline imminent — force max regardless of price
        if (hoursRemaining <= effectiveHoursNeeded + 1) {
          this.log(`[Price] Deadline forcing 'maks': ${hoursRemaining.toFixed(1)}h left, ${effectiveHoursNeeded.toFixed(1)}h needed`);
          this._deadlineForced = true;
          return 'maks';
        }

        // FLAT-RATE PRICING: with near-zero price spread (Norgespris / regulated tariff),
        // all hours cost the same — the cheapest-hours rule is meaningless. Just charge.
        if (stats.spread <= 8) {
          this.log(`[Price] Deadline mode (flat-rate spread=${stats.spread.toFixed(1)}) — charging freely`);
          this._deadlineForced = true;
          return 'maks';
        }

        // CHEAPEST-HOURS RULE: pick the N cheapest hours before the deadline.
        // Charge only during those hours — off during everything else.
        // Power Guard's hard power limit still applies on top via the dynamic current loop.
        const cheapestN = [...hoursBeforeDeadline]
          .sort((a, b) => a.adjustedOre - b.adjustedOre)
          .slice(0, Math.ceil(effectiveHoursNeeded))
          .map(e => e.start.getTime());

        const isInCheapestN = cheapestN.includes(currentEntry.start.getTime());
        this.log(`[Price] Deadline mode: ${cheapestN.length} cheapest hours selected before ${ferdigKl}${hoursNeeded === null ? ' (no hoursNeeded → all window hours)' : ''}, current hour ${isInCheapestN ? 'IS' : 'is NOT'} in charging window`);

        this._deadlineForced = true; // bypass hysteresis — deadline rule is authoritative
        return isInCheapestN ? 'maks' : 'av';
      }
    }

    // ── Standard price logic (no deadline or no hoursNeeded) ─────────────────
    const ore       = currentEntry.adjustedOre;
    const nextOre   = nextEntry ? nextEntry.adjustedOre : ore;
    const cheapest  = [...lookahead].sort((a, b) => a.adjustedOre - b.adjustedOre).slice(0, cfg.cheapHoursTarget || 6);
    const isCheapest = cheapest.some(e => e.start.getTime() === currentEntry.start.getTime());
    if (level === 'ekstremt dyr') return 'av';
    if (level === 'dyr')    return isCheapest ? 'normal' : 'lav';
    if (level === 'billig') return (isCheapest && ore <= stats.p25) ? 'maks' : 'normal';
    if (isCheapest && ore <= stats.p50) return 'normal';
    if (nextOre >= ore + 10) return 'normal';  // pre-charge before price jumps
    return 'lav';
  }

  _priceApplyChargeModeHysteresis(prev, suggested, currentEntry, nextEntry, level, stats, lookahead, cfg) {
    if (!prev || prev === suggested) return suggested;
    if (level === 'ekstremt dyr') return 'av';
    // Flat-rate pricing (Norgespris or near-zero spread): every hour costs the same.
    // Hysteresis margins are based on price differences that don't exist here — skip it
    // entirely so the charger can freely transition between modes (especially exit 'av').
    if (stats.spread <= 8) return suggested;
    const ore        = currentEntry.adjustedOre;
    const nextOre    = nextEntry ? nextEntry.adjustedOre : ore;
    const cheapest   = [...lookahead].sort((a, b) => a.adjustedOre - b.adjustedOre).slice(0, cfg.cheapHoursTarget || 6);
    const isCheapest = cheapest.some(e => e.start.getTime() === currentEntry.start.getTime());
    const margin     = 5;
    if (prev === 'av') {
      if (suggested === 'lav'    && ore <= stats.p50 - margin) return 'lav';
      if (suggested === 'normal' && (isCheapest || ore <= stats.p50 - margin || nextOre >= ore + 10 + margin)) return 'normal';
      if (suggested === 'maks'   && isCheapest && ore <= stats.p25 - margin) return 'maks';
      return 'av';
    }
    if (prev === 'lav') {
      if (suggested === 'av'     && !(level === 'dyr' && ore >= stats.p75 + margin)) return 'lav';
      if (suggested === 'normal' && !(isCheapest || ore <= stats.p50 - margin || nextOre >= ore + 10 + margin)) return 'lav';
      if (suggested === 'maks'   && !(isCheapest && ore <= stats.p25 - margin)) return 'lav';
    }
    if (prev === 'normal') {
      if (suggested === 'lav'    && (isCheapest || ore <= stats.p50 + margin || nextOre >= ore + 10 - margin)) return 'normal';
      if (suggested === 'av'     && !(level === 'dyr' && ore >= stats.p75 + margin)) return 'normal';
      if (suggested === 'maks'   && !(isCheapest && ore <= stats.p25 - margin)) return 'normal';
    }
    if (prev === 'maks') {
      if (suggested === 'normal' && isCheapest && ore <= stats.p25 + margin) return 'maks';
      if (suggested === 'lav'    && isCheapest && ore <= stats.p50 + margin) return 'normal';
      if (suggested === 'av'     && !(level === 'dyr' && ore >= stats.p75 + margin)) return ore > stats.p50 ? 'lav' : 'normal';
    }
    return suggested;
  }

  /**
   * Returns the price-based current cap for a charger.
   * Additive layer on top of Power Guard's hard watt-limit.
   * Returns circuitLimitA (no restriction) when price control is off or data unavailable.
   */
  _getPriceCurrentCap(deviceId, circuitLimitA) {
    if (!this._priceSettings.enabled || !this._priceState) return circuitLimitA;
    const mode = (deviceId && this._priceState.chargeModes && this._priceState.chargeModes[deviceId])
      || this._priceState.chargeMode;
    const cfg  = this._priceSettings;
    if (mode === 'av')   return 0;  // Pause
    if (mode === 'lav')  return Math.max(CHARGER_DEFAULTS.minCurrent, Math.floor(circuitLimitA * (cfg.capLav  || 0.5)));
    if (mode === 'maks') return Math.floor(circuitLimitA * (cfg.capMaks || 1.0));
    return circuitLimitA; // 'normal' = no price restriction
  }

  /** Triggers an immediate price re-fetch — called by the Refresh button in settings */
  async refreshPriceData() {
    await this._fetchAndEvaluatePrices();
  }

  /** Public getter used by api.js getPriceData endpoint */
  getPriceData() {
    return {
      state:    this._priceState,
      settings: this._priceSettings,
    };
  }

  /** Called by api.js setPriceSettings — saves and re-evaluates immediately */
  async savePriceSettings(settings) {
    if (!settings || typeof settings !== 'object') return;
    this._priceSettings = Object.assign({}, PRICE_DEFAULTS, settings);
    this.homey.settings.set('priceSettings', this._priceSettings);
    await this._fetchAndEvaluatePrices().catch(err => this.error('[Price] Re-fetch error:', err));
  }

  // ════════════════════════════════════════════════════════════════
  // █ SECTION 13 — MODE ENGINE  (Home / Night / Away / Holiday)               █
  // ════════════════════════════════════════════════════════════════
  //  _startModeScheduler() — loads saved settings, applies current mode, starts
  //      a 60-second tick that auto-switches Home↔Night based on schedule.
  //  activateMode(mode)    — public; saves active mode, fires flow trigger,
  //      calls _applyMode.
  //  _applyMode(mode)      — sets device states (temp / on-off) for the mode.
  //  getModesSettings()    — API getter: returns modeSettings + priorityList.
  //  saveModesSettings()   — API setter: merges partial updates and persists.
  // ════════════════════════════════════════════════════════════════

  async _startModeScheduler() {
    const saved = this.homey.settings.get('modeSettings');
    if (saved && typeof saved === 'object') {
      this._modeSettings = Object.assign(JSON.parse(JSON.stringify(MODES_DEFAULTS)), saved);
      if (!this._modeSettings.devicePrefs) this._modeSettings.devicePrefs = {};
      if (!this._modeSettings.nightSchedule) this._modeSettings.nightSchedule = JSON.parse(JSON.stringify(MODES_DEFAULTS.nightSchedule));
    }
    // Apply current mode on startup (deferred so API is ready),
    // then immediately run the night schedule check so the correct
    // mode is active even if the app restarts mid-night or mid-day.
    setTimeout(async () => {
      try {
        await this.activateMode(this._modeSettings.activeMode);
        // activateMode() clears _nightSetBySchedule, but on startup the schedule
        // should always win in both directions (night→home at morning, home→night at night).
        this._nightSetBySchedule = true;
        await this._checkNightSchedule();
      } catch (err) {
        this.error('[Modes] Startup apply error:', err);
      }
    }, 5000);
    // Check Night schedule every minute
    this._modeSchedulerInterval = setInterval(async () => { const _t = Date.now(); await this._checkNightSchedule().catch(err => this.error('[Modes] Night schedule error:', err)); this._trackCallTime('modeScheduler', Date.now() - _t); }, 60 * 1000);
    this.log(`[Modes] Scheduler started. Active mode: ${this._modeSettings.activeMode}`);
  }

  async _checkNightSchedule() {
    const sched = this._modeSettings.nightSchedule || {};
    if (sched.type !== 'custom') {
      this._appLogEntry('system', `[NightSched] Skipped — type="${sched.type}" (not custom)`);
      return;  // 'homey'/'off' = disabled, manual only
    }

    // Use Homey's configured timezone so times match what the user entered in the UI
    const tz = this.homey.clock.getTimezone();
    const now = new Date();
    const localNow = new Date(now.toLocaleString('en-US', { timeZone: tz }));
    const nowMins  = localNow.getHours() * 60 + localNow.getMinutes();
    // Use != null so fromHH/toHH of 0 (midnight) is preserved instead of replaced by default
    const fromMins = (sched.fromHH != null ? sched.fromHH : 22) * 60 + (sched.fromMM != null ? sched.fromMM : 0);
    const toMins   = (sched.toHH  != null ? sched.toHH  : 7)  * 60 + (sched.toMM  != null ? sched.toMM  : 0);

    // Spans midnight when fromMins > toMins
    const isNightTime = fromMins > toMins
      ? nowMins >= fromMins || nowMins < toMins
      : nowMins >= fromMins && nowMins < toMins;

    const current = this._modeSettings.activeMode;
    this._appLogEntry('system',
      `[NightSched] local=${localNow.getHours()}:${String(localNow.getMinutes()).padStart(2,'0')} (${nowMins}min) from=${fromMins}min to=${toMins}min isNight=${isNightTime} mode=${current} bySchedule=${this._nightSetBySchedule}`);

    // Only auto-switch between home↔night.  Away/Holiday are always manual.
    if (isNightTime && current === 'home') {
      await this.activateMode('night');
      this._nightSetBySchedule = true;  // mark scheduler ownership AFTER activateMode clears it
    } else if (!isNightTime && current === 'night' && this._nightSetBySchedule) {
      // Only revert to Home if the scheduler originally set Night.
      // If the user manually pressed Night during the day, _nightSetBySchedule is false → don't override.
      this._nightSetBySchedule = false;
      await this.activateMode('home');
    }
  }

  async activateMode(mode) {
    const valid = [MODES.HOME, MODES.NIGHT, MODES.AWAY, MODES.HOLIDAY];
    if (!valid.includes(mode)) return;
    this._nightSetBySchedule = false;  // any external/manual call clears scheduler ownership
    const previous = this._modeSettings.activeMode;
    this._modeSettings.activeMode = mode;
    this.homey.settings.set('modeSettings', this._modeSettings);
    if (mode !== previous) {
      this._fireTrigger('mode_changed', { mode });
      this._appLogEntry('system', `Mode changed: ${previous} → ${mode}`);
      this.log(`[Modes] Active mode: ${mode}`);
      try { this.homey.api.realtime('modeChanged', { mode }); } catch (_) {}
    }
    await this._applyMode(mode);
  }

  async _applyMode(mode, filterDeviceId = null) {
    const prefs = this._modeSettings.devicePrefs || {};
    const priorityList = this.homey.settings.get('priorityList') || [];
    if (!this._api) return;

    if (!filterDeviceId) {
      this._appLogEntry('charger', `[Modes] Applying mode="${mode}" to ${priorityList.length} entries. Prefs keys: ${Object.keys(prefs).length}`);
    }

    for (const entry of priorityList) {
      // If called from a single-device pref change, only process that device
      if (filterDeviceId && entry.deviceId !== filterDeviceId) continue;
      if (entry.enabled === false) continue;
      const devPrefs = prefs[entry.deviceId];
      if (!devPrefs) continue;
      const modePref = devPrefs[mode];
      if (!modePref || modePref.value == null) continue;

      try {
        const action = entry.action;
        if (action === 'target_temperature') {
          if (modePref.value === 'off') {
            await this.controlFloorHeater(entry.deviceId, 'off');
          } else {
            await this.controlFloorHeater(entry.deviceId, 'setTarget', modePref.value);
          }
        } else if (action === 'hoiax_power') {
          await this.controlFloorHeater(entry.deviceId, 'setHoiax', modePref.value);
        } else if (action === 'onoff') {
          const wantOn = modePref.value === 'on';
          // Don't restore a power-guarded device — let Power Guard re-evaluate
          const isMitigated = this._mitigatedDevices.some(m => m.deviceId === entry.deviceId);
          if (wantOn && isMitigated) continue;
          await this.controlFloorHeater(entry.deviceId, wantOn ? 'on' : 'off', wantOn);
        } else if (action === 'charge_pause' || action === 'dynamic_current') {
          const wantOn = modePref.value === 'on';
          const wantOff = modePref.value === 'off';
          if (!wantOn && !wantOff) continue;
          // Charge Now active — don't let mode engine pause this charger
          if (wantOff && this._chargeNow && this._chargeNow[entry.deviceId]) continue;
          // Don't un-pause a charger that Power Guard is currently throttling
          const isMitigated = this._mitigatedDevices.some(m => m.deviceId === entry.deviceId);
          if (wantOn && isMitigated) continue;
          // Don't turn on a charger that the price engine wants off
          const priceCap = this._getPriceCurrentCap(entry.deviceId, entry.circuitLimitA || 32);
          if (wantOn && priceCap <= 0) continue;
          await this.controlFloorHeater(entry.deviceId, wantOn ? 'on' : 'off', wantOn);
        }
      } catch (err) {
        this.error(`[Modes] Error applying ${mode} to "${entry.name}":`, err.message);
      }
    }
  }

  getModesSettings() {
    const priorityList = this.homey.settings.get('priorityList') || [];
    // Enrich each entry with runtime-detected charger phases (auto-detected from live W/A ratio)
    const enriched = priorityList.map(e => {
      const detected = this._evPowerData?.[e.deviceId]?.detectedPhases;
      return detected ? { ...e, detectedPhases: detected } : e;
    });
    return {
      modeSettings: this._modeSettings,
      priorityList: enriched,
    };
  }

  async saveModesSettings(body) {
    if (!body || typeof body !== 'object') return;
    if (body.nightSchedule && typeof body.nightSchedule === 'object') {
      this._modeSettings.nightSchedule = Object.assign(
        {}, this._modeSettings.nightSchedule, body.nightSchedule
      );
    }
    const prefsChanged = body.devicePrefs && typeof body.devicePrefs === 'object';
    if (prefsChanged) {
      this._modeSettings.devicePrefs = body.devicePrefs;
    }
    this.homey.settings.set('modeSettings', this._modeSettings);
    // If device preferences changed, re-apply the active mode for the changed device only.
    // Passing changedDeviceId avoids re-triggering ALL devices (e.g. EV chargers) on every click.
    if (prefsChanged) {
      const changedDeviceId = body.changedDeviceId || null;
      await this._applyMode(this._modeSettings.activeMode, changedDeviceId).catch(err =>
        this.error('[Modes] Error re-applying mode after pref save:', err.message)
      );
    }
  }

}

module.exports = PowerGuardApp;
