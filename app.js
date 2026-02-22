'use strict';

const Homey = require('homey');
const { HomeyAPI } = require('homey-api');
const { Mutex } = require('async-mutex');
const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const { movingAverage, isSpike, timestamp } = require('./common/tools');
const { applyAction, restoreDevice } = require('./common/devices');
const { PROFILES, PROFILE_LIMIT_FACTOR, DEFAULT_SETTINGS, MITIGATION_LOG_MAX } = require('./common/constants');

class PowerGuardApp extends Homey.App {

  async onInit() {
    this.log('========================================');
    this.log('Power Guard initialising...');
    this.log('[Power Consumption] Tracking system initializing');
    this.log('========================================');

    this._mutex = new Mutex();
    this._powerBuffer = [];
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
    this._evPowerData = {};
    this._evCapabilityInstances = {};
    this._powerConsumptionData = {}; // Track power history for all devices: {deviceId: {current, avg, peak, readings[]}}
    this._powerConsumptionLog = []; // In-memory log for debug
    this._cachedDevices = null; // All devices from API (including non-controllable ones)
    this.log('[Power Consumption] Data object initialized');
    this._lastEVAdjustTime = 0;
    this._deviceCacheReady = false;
    this._lastCacheTime = null;
    this._saveQueue = [];

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
      }
      // When power limit or profile changes, immediately re-evaluate chargers
      if (['powerLimitW', 'profile', 'enabled', 'phase1LimitA', 'phase2LimitA', 'phase3LimitA'].includes(key)) {
        this.log(`[Settings] ${key} changed, forcing charger re-evaluation`);
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
    } catch (err) {
      this.error('HomeyAPI init error:', err);
    }

    try {
      if (this._api) await this._connectToHAN();
    } catch (err) {
      this.error('HAN connection error (non-fatal):', err);
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

    this.log('Power Guard ready (device cache: ' +
      (this._deviceCacheReady ? 'YES' : 'NO') + ')');
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

  // ─── HAN Port integration ──────────────────────────────────────────────────

  _getHANDeviceBrand() {
    if (!this._hanDevice) return 'Unknown';
    const name = (this._hanDevice.name || '').toLowerCase();
    const mfg = (this._hanDeviceManufacturer || '').toLowerCase();
    const driver = (this._hanDevice.driverId || '').toLowerCase();
    if (name.includes('frient') || mfg.includes('frient') || driver.includes('frient')) return 'Frient Electricity Meter';
    if (name.includes('futurehome') || mfg.includes('futurehome') || driver.includes('futurehome')) return 'Futurehome HAN';
    if (name.includes('tibber') || mfg.includes('tibber') || driver.includes('tibber')) return 'Tibber Pulse';
    if (name.includes('aidon') || mfg.includes('aidon')) return 'Aidon HAN';
    if (name.includes('kaifa') || mfg.includes('kaifa')) return 'Kaifa HAN';
    return this._hanDeviceName || 'Unknown meter';
  }

  async _connectToHAN() {
    const allDevices = await this._api.devices.getDevices();

    const hanDevice = Object.values(allDevices).find(d => {
      const hasPower = Array.isArray(d.capabilities) && d.capabilities.includes('measure_power');
      if (!hasPower) return false;
      
      // Must be identifiable as a meter/HAN device, not just any device with power measurement
      const name = (d.name || '').toLowerCase();
      const driver = (d.driverId || '').toLowerCase();
      const deviceClass = (d.class || '').toLowerCase();
      
      const isMeterLike = deviceClass === 'meter' ||
        name.includes('meter') || name.includes('frient') || name.includes('han') ||
        name.includes('futurehome') || name.includes('tibber') ||
        driver.includes('meter') || driver.includes('frient') || driver.includes('han') ||
        driver.includes('futurehome') || driver.includes('tibber');
      
      return isMeterLike;
    });

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

    // makeCapabilityInstance is the correct homey-api v3 way to subscribe to capability changes
    this._hanCapabilityInstance = hanDevice.makeCapabilityInstance('measure_power', (value) => {
      this._onPowerReading(value);
    });

    // Phase values (optional — only if the HAN device reports them)
    for (const phase of ['measure_power.phase1', 'measure_power.phase2', 'measure_power.phase3']) {
      if (Array.isArray(hanDevice.capabilities) && hanDevice.capabilities.includes(phase)) {
        hanDevice.makeCapabilityInstance(phase, (value) => this._onPhaseReading(phase, value));
      }
    }

    // Active polling fallback: read HAN value every 10 seconds
    // Some Frient HAN firmware only fires events when the value changes significantly.
    // This ensures we always have fresh data for mitigation decisions.
    if (this._hanPollInterval) clearInterval(this._hanPollInterval);
    this._hanPollInterval = setInterval(() => this._pollHANPower().catch(() => {}), 10000);
    this.log('HAN active polling started (10s interval)');
  }

  async _pollHANPower() {
    if (!this._hanDevice) return;
    try {
      // Re-fetch the device to get the latest capability values
      const device = await this._api.devices.getDevice({ id: this._hanDeviceId });
      if (!device) return;

      const capObj = device.capabilitiesObj;
      if (capObj && capObj.measure_power && capObj.measure_power.value != null) {
        const value = capObj.measure_power.value;
        const timeSinceLastReading = this._lastHanReading ? Date.now() - this._lastHanReading : Infinity;

        // Only process if we haven't had an event-based reading in the last 8 seconds
        // This avoids double-processing when events ARE working
        if (timeSinceLastReading > 8000) {
          this.log(`[HAN Poll] Fallback reading: ${value} W (no event for ${Math.round(timeSinceLastReading / 1000)}s)`);
          this._onPowerReading(value);
        }
      }
    } catch (err) {
      this.log('[HAN Poll] Error: ' + (err.message || err));
    }
  }

  _onPowerReading(rawValue) {
    if (typeof rawValue !== 'number' || isNaN(rawValue)) return;
    this._lastHanReading = Date.now();

    const avg = movingAverage(this._powerBuffer, this._settings.smoothingWindow);
    if (this._powerBuffer.length >= this._settings.smoothingWindow
        && isSpike(rawValue, avg, this._settings.spikeMultiplier)) {
      this.log(`Spike ignored: ${rawValue} W (avg ${avg.toFixed(0)} W)`);
      return;
    }

    this._powerBuffer.push(rawValue);
    if (this._powerBuffer.length > 60) this._powerBuffer.shift();

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
    // Phase values stored for diagnostics only (not shown on virtual device yet)
  }

  // ─── Limit checking ───────────────────────────────────────────────────────

  async _checkLimits(smoothedPower) {
    this._refreshSettings();
    if (!this._settings.enabled) return;

    const limit = this._getEffectiveLimit();
    const overLimit = smoothedPower > limit;

    // EV charger dynamic adjustment runs on EVERY reading — fast response
    // No hysteresis delay, only a short 5-second cooldown between adjustments
    if (overLimit) {
      await this._adjustEVChargersForPower(smoothedPower).catch(err => this.error('EV adjust error:', err));
    } else if (!overLimit && this._mitigatedDevices.some(m => m.action === 'dynamic_current')) {
      // Under limit: try to restore EV chargers gradually
      await this._adjustEVChargersForPower(smoothedPower).catch(err => this.error('EV restore error:', err));
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
      if (now - this._lastMitigationTime < this._settings.cooldownSeconds * 1000) return;

      // First, try to mitigate by adjusting EV chargers (least disruptive)
      await this._mitigateEaseeChargers().catch((err) => this.error('Easee mitigation error:', err));

      const priorityList = [...(this._settings.priorityList || [])].sort((a, b) => a.priority - b.priority);
      const mitigated = new Set(this._mitigatedDevices.map(m => m.deviceId));

      // Then, apply regular mitigation (turn off devices)
      for (const entry of priorityList) {
        if (entry.enabled === false) continue;
        if (entry.action === 'dynamic_current') continue;  // Skip EV chargers here (handled above)
        if (mitigated.has(entry.deviceId)) continue;
        if (!this._canMitigate(entry)) continue;
        try {
          const device = await this._api.devices.getDevice({ id: entry.deviceId });
          if (!device) continue;

          const previousState = this._snapshotState(device);
          const applied = await applyAction(device, entry.action);
          if (!applied) continue;

          this._mitigatedDevices.push({ deviceId: entry.deviceId, action: entry.action, previousState, mitigatedAt: now });
          this._lastMitigationTime = now;
          this._addLog(`Mitigated: ${device.name} (${entry.action})`);
          this._persistMitigatedDevices();
          this._fireTrigger('mitigation_applied', { device_name: device.name, action: entry.action });
          await this._updateVirtualDevice({ alarm: true });
          break;
        } catch (err) {
          this.error(`Mitigation failed for ${entry.deviceId}:`, err);
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
        const device = await this._api.devices.getDevice({ id: toRestore.deviceId });
        if (!device) { this._mitigatedDevices.pop(); this._persistMitigatedDevices(); return; }

        const restored = await restoreDevice(device, toRestore.action, toRestore.previousState);
        if (restored) {
          this._mitigatedDevices.pop();
          this._addLog(`Restored: ${device.name}`);
          this._persistMitigatedDevices();
          if (this._mitigatedDevices.length === 0) {
            this._fireTrigger('mitigation_cleared', {});
            await this._updateVirtualDevice({ alarm: false });
          }
        }
      } catch (err) {
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
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  _resetStatistics() {
    this._powerBuffer = [];
    this._overLimitCount = 0;
    this._mitigationLog = [];
    this.log('Statistics reset');
  }

  _addLog(message) {
    this._mitigationLog.push({ time: timestamp(), message });
    if (this._mitigationLog.length > MITIGATION_LOG_MAX) this._mitigationLog.shift();
    this.log(message);
  }

  // Read current capability values from homey-api capabilitiesObj
  _snapshotState(device) {
    const obj = device.capabilitiesObj || {};
    return {
      onoff:              obj.onoff              ? obj.onoff.value              : undefined,
      dim:                obj.dim                ? obj.dim.value                : undefined,
      target_temperature: obj.target_temperature ? obj.target_temperature.value : undefined,
      target_current:          obj.target_current          ? obj.target_current.value          : undefined,
      target_charger_current:  obj.target_charger_current  ? obj.target_charger_current.value  : undefined,
      target_circuit_current:  obj.target_circuit_current  ? obj.target_circuit_current.value  : undefined,
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
            caps.includes('charge_pause');

          // Check for known controllable device classes
          const isControllableClass =
            d.class === 'light' ||
            d.class === 'socket' ||
            d.class === 'charger' ||
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
              c === 'target_circuit_current' || c === 'charge_pause')
              ? 'capability'
              : ['light', 'socket', 'charger', 'thermostat', 'appliance'].includes(d.class)
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
          };
        });

      this.homey.settings.set('_deviceCache', list);
      this._deviceCacheReady = true;
      this._lastCacheTime = Date.now();
      const elapsed = Date.now() - startTime;
      this.log(`[Cache] Successfully cached ${list.length} controllable devices in ${elapsed}ms`);

    } catch (err) {
      if (isInitialization) {
        throw err;  // Re-throw for initialization retry logic
      } else {
        this.error('[Cache] Device cache error:', err);
        // Don't rethrow for background refresh
      }
    }
  }

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
      e => e.action === 'dynamic_current' && e.enabled !== false
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
    return { ok: true, results };
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
        const device = await this._api.devices.getDevice({ id: entry.deviceId });
        if (!device) continue;
        const caps = device.capabilities || [];
        const obj  = device.capabilitiesObj || {};

        // Store initial snapshot with full state
        this._evPowerData[entry.deviceId] = {
          name:           entry.name || device.name,
          powerW:         obj.measure_power ? (obj.measure_power.value || 0) : 0,
          isCharging:     obj.onoff ? obj.onoff.value !== false : false,
          chargerStatus:  obj.charger_status ? obj.charger_status.value : null,
          offeredCurrent: obj['measure_current.offered'] ? obj['measure_current.offered'].value : null,
          isConnected:    null,  // derived below
        };

        // Derive connected state from charger_status or power
        const cs = this._evPowerData[entry.deviceId].chargerStatus;
        if (cs !== null && cs !== undefined) {
          // Easee statuses: 1=disconnected, 2=awaiting_start, 3=charging, 4=completed, 5=error
          // Also may be string values like 'disconnected', 'awaiting_start', 'charging', 'completed'
          const disconnected = (cs === 1 || cs === 'disconnected' || cs === 'DISCONNECTED');
          this._evPowerData[entry.deviceId].isConnected = !disconnected;
        } else {
          // Fallback: if power > 0, probably connected
          this._evPowerData[entry.deviceId].isConnected = (this._evPowerData[entry.deviceId].powerW > 0);
        }

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
              const disconnected = (value === 1 || value === 'disconnected' || value === 'DISCONNECTED');
              this._evPowerData[entry.deviceId].isConnected = !disconnected;
            }
          });
          this._evCapabilityInstances[entry.deviceId + '_status'] = csInst;
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

        // Listen to offered current
        if (caps.includes('measure_current.offered')) {
          const offInst = device.makeCapabilityInstance('measure_current.offered', (value) => {
            if (this._evPowerData[entry.deviceId]) {
              this._evPowerData[entry.deviceId].offeredCurrent = typeof value === 'number' ? value : null;
            }
          });
          this._evCapabilityInstances[entry.deviceId + '_offered'] = offInst;
        }

      } catch (err) {
        this.error(`EV connect error for ${entry.deviceId}:`, err);
      }
    }
    this.log(`EV charger tracking: ${Object.keys(this._evCapabilityInstances).length} device(s)`);
  }

  // ─── Fast EV Charger Adjustment (runs on every power reading) ──────────────

  /**
   * Rapidly adjust EV chargers to stay under the power limit.
   * Called on every HAN reading — bypasses the main mitigation cooldown.
   * Has its own short 5-second cooldown to avoid hammering the API.
   */
  async _adjustEVChargersForPower(smoothedPower) {
    const now = Date.now();
    // Short cooldown: only 5 seconds between EV adjustments
    if (now - (this._lastEVAdjustTime || 0) < 5000) return;

    const easeeEntries = (this._settings.priorityList || []).filter(e =>
      e.enabled !== false && e.action === 'dynamic_current'
    );
    if (!easeeEntries.length) return;

    const limit = this._getEffectiveLimit();
    const totalOverload = Math.max(0, smoothedPower - limit);

    for (const entry of easeeEntries) {
      const targetCurrent = this._calculateOptimalChargerCurrent(totalOverload, entry);
      const alreadyTracked = this._mitigatedDevices.find(m => m.deviceId === entry.deviceId);

      // Skip if target hasn't changed (within 1A)
      if (alreadyTracked && targetCurrent !== null &&
          Math.abs((alreadyTracked.currentTargetA || 0) - targetCurrent) < 1) {
        continue;
      }
      // Skip if already at full and target is full
      if (!alreadyTracked && targetCurrent !== null && targetCurrent >= (entry.circuitLimitA || 32)) {
        continue;
      }

      const success = await this._setEaseeChargerCurrent(entry.deviceId, targetCurrent).catch(() => false);
      if (!success) continue;

      this._lastEVAdjustTime = now;

      if (targetCurrent !== null && targetCurrent < (entry.circuitLimitA || 32)) {
        // Charger is being limited
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
        // Pause charger
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
   * @returns {number} Target current in amps (6-32), or null to pause
   */
  _calculateOptimalChargerCurrent(totalOverloadW, chargerEntry) {
    const circuitLimitA = chargerEntry.circuitLimitA || 32;

    if (!totalOverloadW || totalOverloadW <= 0) {
      // No overload, charge at maximum (but respect circuit limit)
      return Math.min(32, circuitLimitA);
    }

    const limit = this._getEffectiveLimit();
    const currentUsage = movingAverage(this._powerBuffer, this._settings.smoothingWindow);
    const chargerPowerW = this._evPowerData[chargerEntry.deviceId]?.powerW || 0;

    // Available power = limit minus everything else (non-charger usage)
    // Add a 200W safety margin to get definitively under the limit
    const nonChargerUsage = currentUsage - chargerPowerW;
    const availablePowerW = limit - nonChargerUsage - 200;

    // Use per-charger phase setting: 1-fas = 230V, 3-fas = 692V
    const chargerPhases = chargerEntry.chargerPhases || 3;
    const voltage = chargerPhases === 1 ? 230 : 692;
    const minCurrent = 6;
    const maxCurrent = Math.min(32, circuitLimitA);

    if (availablePowerW <= 0) {
      this.log(`EV calc: usage=${Math.round(currentUsage)}W, charger=${Math.round(chargerPowerW)}W, available=${Math.round(availablePowerW)}W → PAUSE (no headroom)`);
      return null;
    }

    const availableCurrentA = Math.floor(availablePowerW / voltage);  // floor instead of round for safety

    if (availableCurrentA < minCurrent) {
      this.log(`EV calc: available=${Math.round(availablePowerW)}W → ${availableCurrentA}A < min ${minCurrent}A → PAUSE`);
      return null;
    }

    const targetCurrent = Math.max(minCurrent, Math.min(maxCurrent, availableCurrentA));
    this.log(`EV calc: usage=${Math.round(currentUsage)}W, charger=${Math.round(chargerPowerW)}W, available=${Math.round(availablePowerW)}W, circuit=${circuitLimitA}A → ${targetCurrent}A`);
    return targetCurrent;
  }

  /**
   * Adjust an EV charger's current to optimize power usage.
   * @param {string} deviceId - Device ID from priorityList
   * @param {number} targetCurrentA - Target current in amps (or null to pause)
   * @returns {Promise<boolean>} true if adjustment was made
   */
  async _adjustEVChargerCurrent(deviceId, targetCurrentA) {
    if (!this._api) return false;

    try {
      const device = await this._api.devices.getDevice({ id: deviceId });
      if (!device) return false;

      const caps = device.capabilities || [];
      const obj = device.capabilitiesObj || {};

      // Use dynamic_charger_current ("Midlertidig Ladegrense") as primary for load balancing
      // Falls back to other capabilities if not available
      const currentCapability = ['dynamic_charger_current', 'dynamicChargerCurrent', 'dynamicCircuitCurrentP1', 'target_charger_current']
        .find(cap => caps.includes(cap));

      if (!currentCapability) return false;

      const currentValue = obj[currentCapability]?.value || 16;

      // If targetCurrentA is null, pause the charger instead
      if (targetCurrentA === null) {
        if (caps.includes('onoff') && obj.onoff?.value !== false) {
          await device.setCapabilityValue({ capabilityId: 'onoff', value: false });
          this._addLog(`Charger paused: ${device.name}`);
          return true;
        }
        return false;
      }

      // Check if change is significant enough (>= 1A difference)
      if (Math.abs(currentValue - targetCurrentA) < 1) {
        return false;
      }

      // Apply the adjustment
      await device.setCapabilityValue({ capabilityId: currentCapability, value: targetCurrentA });
      this._addLog(`Charger adjusted: ${device.name} ${currentValue}A → ${targetCurrentA}A`);
      return true;
    } catch (err) {
      this.error(`Failed to adjust charger ${deviceId}:`, err);
      return false;
    }
  }

  /**
   * Dynamically control EV chargers during mitigation.
   * Adjusts charger currents to stay within power limit while maximizing charging.
   */
  /**
   * Set Easee charger current using the HomeyAPI.
   * @param {string} deviceId - Device ID
   * @param {number} currentA - Target current in amps (or null to pause)
   * @returns {Promise<boolean>} true if set successfully
   */
  async _setEaseeChargerCurrent(deviceId, currentA) {
    if (!this._api) return false;

    try {
      const device = await this._api.devices.getDevice({ id: deviceId });
      if (!device) return false;

      // If currentA is null, pause by turning off
      if (currentA === null) {
        if (device.capabilities.includes('onoff')) {
          await device.setCapabilityValue({ capabilityId: 'onoff', value: false });
          this._addLog(`Easee paused: ${device.name}`);
          return true;
        }
        return false;
      }

      // Use dynamic_charger_current ("Midlertidig Ladegrense") as primary for Power Guard control
      // This is the temporary/dynamic limit meant for load balancing — does NOT change the permanent Ladegrense
      const dynCap = ['dynamic_charger_current', 'dynamicChargerCurrent', 'dynamicCircuitCurrentP1', 'target_charger_current']
        .find(cap => (device.capabilities || []).includes(cap));

      if (dynCap) {
        await device.setCapabilityValue({ capabilityId: dynCap, value: currentA });
        this._addLog(`Easee ${dynCap === 'target_charger_current' ? 'Ladegrense' : 'Midlertidig'}: ${device.name} → ${currentA}A`);
        return true;
      }

      this.log(`[Easee] Device ${deviceId} doesn't expose dynamic current capability, available: ${(device.capabilities || []).join(', ')}`);
      return false;
    } catch (err) {
      this.error(`Failed to set Easee current for ${deviceId}:`, err);
      return false;
    }
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
      const targetCurrent = this._calculateOptimalChargerCurrent(totalOverload, entry);
      const success = await this._setEaseeChargerCurrent(entry.deviceId, targetCurrent).catch(() => false);

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
        name: e.name, deviceId: e.deviceId, circuitLimitA: e.circuitLimitA, enabled: e.enabled !== false
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
        
        // Skip lights and dimmers
        if (deviceClass === 'light' || deviceClass === 'dimmer') {
          return;
        }
        
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

        // First check: is a car even connected?
        const isConnected = evData.isConnected !== false && evData.isConnected !== null;
        const chargerStatus = evData.chargerStatus;

        // Check for disconnected / idle states
        const isDisconnected = (
          evData.isConnected === false ||
          chargerStatus === 1 || chargerStatus === 'disconnected' || chargerStatus === 'DISCONNECTED'
        );

        if (isDisconnected) {
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

      // Step 2: Find charger(s)
      const priorityList = this._settings.priorityList || [];
      const easeeEntries = priorityList.filter(e => e.action === 'dynamic_current' && e.enabled !== false);

      if (!easeeEntries.length) {
        results.steps.push({ step: 'Find chargers', ok: false, detail: 'No dynamic_current chargers in priority list' });
        return results;
      }
      results.steps.push({ step: 'Find chargers', ok: true, detail: `Found ${easeeEntries.length} charger(s): ${easeeEntries.map(e => e.name).join(', ')}` });

      // Use specified device or first one
      const targetEntry = deviceId
        ? easeeEntries.find(e => e.deviceId === deviceId) || easeeEntries[0]
        : easeeEntries[0];

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
                            'measure_current', 'measure_power', 'onoff', 'charger_status',
                            'measure_current.p1', 'measure_current.p2', 'measure_current.p3',
                            'measure_current.offered', 'measure_voltage'];
      const found = {};
      for (const cap of relevantCaps) {
        if (caps.includes(cap)) {
          found[cap] = obj[cap] ? obj[cap].value : 'no value';
        }
      }
      results.steps.push({ step: 'Capabilities', ok: true, detail: JSON.stringify(found) });

      // Step 5: Find the dynamic current control capability (Midlertidig Ladegrense)
      const dynCap = ['dynamic_charger_current', 'dynamicChargerCurrent', 'dynamicCircuitCurrentP1', 'target_charger_current']
        .find(cap => caps.includes(cap));

      if (!dynCap) {
        results.steps.push({ step: 'Current capability', ok: false, detail: `No current control capability found. Available: ${caps.join(', ')}` });
        return results;
      }

      const currentVal = obj[dynCap] ? obj[dynCap].value : null;
      results.steps.push({ step: 'Current capability', ok: true, detail: `${dynCap} = ${currentVal}A` });

      // Also list ALL capabilities for debugging
      results.steps.push({ step: 'All capabilities', ok: true, detail: caps.join(', ') });

      // Step 6: Test write — set to current value (no actual change, just test the API call)
      try {
        const testVal = currentVal || 16;
        await device.setCapabilityValue({ capabilityId: dynCap, value: testVal });
        results.steps.push({ step: 'Write test', ok: true, detail: `Successfully wrote ${dynCap} = ${testVal}A (same value, safe test)` });
        results.success = true;
      } catch (err) {
        results.steps.push({ step: 'Write test', ok: false, detail: `Failed to write ${dynCap}: ${err.message}` });
      }

    } catch (err) {
      results.steps.push({ step: 'Unexpected error', ok: false, detail: err.message });
    }

    return results;
  }
}

module.exports = PowerGuardApp;
