'use strict';

const Homey = require('homey');
const { HomeyAPI } = require('homey-api');
const { Mutex } = require('async-mutex');
const { movingAverage, isSpike, timestamp } = require('./common/tools');
const { applyAction, restoreDevice } = require('./common/devices');
const { PROFILES, PROFILE_LIMIT_FACTOR, DEFAULT_SETTINGS, MITIGATION_LOG_MAX } = require('./common/constants');

class PowerGuardApp extends Homey.App {

  async onInit() {
    this.log('Power Guard initialising...');

    this._mutex = new Mutex();
    this._powerBuffer = [];
    this._overLimitCount = 0;
    this._mitigatedDevices = [];
    this._lastMitigationTime = 0;
    this._mitigationLog = [];
    this._api = null;
    this._hanCapabilityInstance = null;
    this._lastHanReading = null;
    this._hanDeviceId = null;
    this._evPowerData = {};
    this._evCapabilityInstances = {};
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
    });

    try {
      this._registerFlowCards();
    } catch (err) {
      this.error('Flow card registration error:', err);
    }

    try {
      this._api = await HomeyAPI.createAppAPI({ homey: this.homey });
      this.log('HomeyAPI ready');
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

    this._watchdogInterval  = setInterval(() => this._watchdog().catch(() => {}), 10000);
    this._cacheRefreshInterval = setInterval(() => this._cacheDevices().catch(() => {}), 60000);
    this._queueProcessorInterval = setInterval(() => this._processSaveQueue().catch(() => {}), 3000);

    try {
      this.registerApiEndpoints();
    } catch (err) {
      this.error('Failed to register API endpoints:', err);
    }

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

  // ─── API Endpoints for Settings Page ────────────────────────────────────
  registerApiEndpoints() {
    // POST /save-settings - Enhanced settings save with validation & retry queue
    this.homey.api.register('POST', '/save-settings', async (req, res) => {
      try {
        const settings = req.body;
        if (!settings || typeof settings !== 'object') {
          return res.json({
            success: false,
            error: 'Invalid settings object'
          });
        }

        this.log(`[API] Saving ${Object.keys(settings).length} settings...`);

        // Save each setting
        const results = {};
        for (const [key, value] of Object.entries(settings)) {
          try {
            this.homey.settings.set(key, value);
            results[key] = 'success';
            this.log(`[API] ✓ ${key}`);
          } catch (err) {
            results[key] = 'error';
            this.log(`[API] ✗ ${key}: ${err.message}`);
            // Queue failed save for retry
            this._enqueueSettingsSave(key, value);
          }
        }

        // Persist to file as backup
        await this._saveSettingsToFile();

        res.json({ success: true, saved: results });
      } catch (err) {
        this.error('API save-settings error:', err);
        res.json({ success: false, error: err.message });
      }
    });

    // GET /cache-status - Get device cache status for UI
    this.homey.api.register('GET', '/cache-status', async (req, res) => {
      try {
        const cache = this.homey.settings.get('_deviceCache') || [];
        const ageMs = this._lastCacheTime ? Date.now() - this._lastCacheTime : null;
        res.json({
          cacheReady: this._deviceCacheReady,
          cacheCount: cache.length,
          cacheAgeSeconds: ageMs ? Math.round(ageMs / 1000) : null,
          apiAvailable: !!this._api,
          hanConnected: !!this._hanDeviceId
        });
      } catch (err) {
        this.error('API cache-status error:', err);
        res.json({
          cacheReady: false,
          cacheCount: 0,
          apiAvailable: !!this._api,
          error: err.message
        });
      }
    });

    // POST /device-cache-refresh - Manual cache refresh
    this.homey.api.register('POST', '/device-cache-refresh', async (req, res) => {
      try {
        this.log('[API] Manual device cache refresh requested');
        await this._cacheDevices();
        const cache = this.homey.settings.get('_deviceCache') || [];
        res.json({
          success: true,
          cacheCount: cache.length,
          cacheReady: this._deviceCacheReady
        });
      } catch (err) {
        this.error('API device-cache-refresh error:', err);
        res.json({
          success: false,
          error: err.message
        });
      }
    });

    this.log('API endpoints registered');
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
      enabled:          s.get('enabled')          ?? DEFAULT_SETTINGS.enabled,
      profile:          s.get('profile')          ?? DEFAULT_SETTINGS.profile,
      powerLimitW:      s.get('powerLimitW')      ?? DEFAULT_SETTINGS.powerLimitW,
      phase1LimitA:     s.get('phase1LimitA')     ?? DEFAULT_SETTINGS.phase1LimitA,
      phase2LimitA:     s.get('phase2LimitA')     ?? DEFAULT_SETTINGS.phase2LimitA,
      phase3LimitA:     s.get('phase3LimitA')     ?? DEFAULT_SETTINGS.phase3LimitA,
      smoothingWindow:  s.get('smoothingWindow')  ?? DEFAULT_SETTINGS.smoothingWindow,
      spikeMultiplier:  s.get('spikeMultiplier')  ?? DEFAULT_SETTINGS.spikeMultiplier,
      hysteresisCount:  s.get('hysteresisCount')  ?? DEFAULT_SETTINGS.hysteresisCount,
      cooldownSeconds:  s.get('cooldownSeconds')  ?? DEFAULT_SETTINGS.cooldownSeconds,
      priorityList:     s.get('priorityList')     ?? DEFAULT_SETTINGS.priorityList,
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

  // ─── HAN Port integration ──────────────────────────────────────────────────

  async _connectToHAN() {
    const allDevices = await this._api.devices.getDevices();

    const hanDevice = Object.values(allDevices).find(d => {
      const name = (d.name || '').toLowerCase();
      const driverId = (d.driverId || '').toLowerCase();
      const hasPower = Array.isArray(d.capabilities) && d.capabilities.includes('measure_power');
      return hasPower && (
        name.includes('frient') || name.includes('han') ||
        driverId.includes('frient') || driverId.includes('han')
      );
    });

    if (!hanDevice) {
      this.log('frient HAN Port not found. Power Guard will not receive live data until restarted after pairing the HAN device.');
      return;
    }

    this._hanDeviceId = hanDevice.id;
    this.log(`HAN device found: "${hanDevice.name}" (${hanDevice.id})`);

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
      await this._mitigateEVChargers().catch(() => {});

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
        if (!device) { this._mitigatedDevices.pop(); return; }

        const restored = await restoreDevice(device, toRestore.action, toRestore.previousState);
        if (restored) {
          this._mitigatedDevices.pop();
          this._addLog(`Restored: ${device.name}`);
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
      target_current:     obj.target_current     ? obj.target_current.value     : undefined,
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

      if (!this._hanDeviceId) return;
      const silentMs = this._lastHanReading ? Date.now() - this._lastHanReading : Infinity;
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
      this.log(`[Cache] Found ${Object.values(allDevices).length} total devices`);

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
              c === 'target_current' || c === 'charge_pause')
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

        // Store initial snapshot
        this._evPowerData[entry.deviceId] = {
          name:       entry.name || device.name,
          powerW:     obj.measure_power ? (obj.measure_power.value || 0) : 0,
          isCharging: obj.onoff ? obj.onoff.value !== false : true,
        };

        if (caps.includes('measure_power')) {
          this._evCapabilityInstances[entry.deviceId] =
            device.makeCapabilityInstance('measure_power', (value) => {
              if (this._evPowerData[entry.deviceId]) {
                this._evPowerData[entry.deviceId].powerW = typeof value === 'number' ? value : 0;
              }
            });
        }
      } catch (err) {
        this.error(`EV connect error for ${entry.deviceId}:`, err);
      }
    }
    this.log(`EV charger tracking: ${Object.keys(this._evCapabilityInstances).length} device(s)`);
  }

  // ─── Dynamic EV Charger Control ────────────────────────────────────────────

  /**
   * Calculate optimal current for an EV charger given the current overload.
   * Uses the formula: Available Power = Limit - Current Usage
   * @param {number} totalOverloadW - Total power overage in watts
   * @param {Object} chargerEntry - Entry from priorityList
   * @returns {number} Target current in amps (6-32), or null to pause charger
   */
  _calculateOptimalChargerCurrent(totalOverloadW, chargerEntry) {
    if (!totalOverloadW || totalOverloadW <= 0) {
      // No overload, charge at maximum
      return 32;  // Default max for Easee
    }

    const limit = this._getEffectiveLimit();
    const currentUsage = movingAverage(this._powerBuffer, this._settings.smoothingWindow);
    const chargerPowerW = this._evPowerData[chargerEntry.deviceId]?.powerW || 0;

    // Available power without charger
    const availablePowerW = limit - (currentUsage - chargerPowerW);

    if (availablePowerW <= 500) {
      // Less than 500W available, pause charger
      return null;
    }

    // Convert power to current (230V single-phase, simplified)
    // For 3-phase: use 3 * 230 * sqrt(3) = 1196V per phase
    const voltage = 230;  // Simplified: single phase
    const availableCurrentA = Math.round(availablePowerW / voltage);

    // Clamp to min/max (Easee: 6-32A)
    const minCurrent = 6;
    const maxCurrent = 32;
    const targetCurrent = Math.max(minCurrent, Math.min(maxCurrent, availableCurrentA));

    this.log(`EV calc: overload=${totalOverloadW}W, available=${availablePowerW}W → ${targetCurrent}A`);
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

      // Find which current capability is supported
      const currentCapability = ['target_current', 'dynamicCircuitCurrentP1', 'dynamic_current']
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
  async _mitigateEVChargers() {
    const evEntries = (this._settings.priorityList || []).filter(e =>
      e.action === 'dynamic_current' && e.enabled !== false
    );

    if (!evEntries.length) return;

    const limit = this._getEffectiveLimit();
    const currentPower = movingAverage(this._powerBuffer, this._settings.smoothingWindow);
    const totalOverload = Math.max(0, currentPower - limit);

    for (const entry of evEntries) {
      const targetCurrent = this._calculateOptimalChargerCurrent(totalOverload, entry);
      await this._adjustEVChargerCurrent(entry.deviceId, targetCurrent).catch(() => {});
    }
  }

  getDiagnosticInfo() {
    const hasApi = !!this._api;
    const cache  = this.homey.settings.get('_deviceCache') || [];
    return { hasApi, cacheCount: cache.length };
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

  getStatus() {
    return {
      enabled:          this._settings.enabled,
      profile:          this._settings.profile,
      currentPowerW:    movingAverage(this._powerBuffer, this._settings.smoothingWindow),
      limitW:           this._getEffectiveLimit(),
      overLimitCount:   this._overLimitCount,
      mitigatedDevices: this._mitigatedDevices.map(m => ({ deviceId: m.deviceId, action: m.action })),
      hanConnected:     !!this._hanDeviceId,
      hanLastSeen:      this._lastHanReading,
      log:              this._mitigationLog.slice(-20),
      evChargers:       Object.values(this._evPowerData),
    };
  }

  async onUninit() {
    if (this._watchdogInterval)     clearInterval(this._watchdogInterval);
    if (this._cacheRefreshInterval) clearInterval(this._cacheRefreshInterval);
    if (this._hanCapabilityInstance) {
      try { this._hanCapabilityInstance.destroy(); } catch (_) {}
    }
    for (const inst of Object.values(this._evCapabilityInstances || {})) {
      try { inst.destroy(); } catch (_) {}
    }
  }
}

module.exports = PowerGuardApp;
