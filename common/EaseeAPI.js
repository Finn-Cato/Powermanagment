'use strict';

const BASE_URL = 'https://api.easee.com';

class EaseeAPI {
  constructor(homey) {
    this.homey = homey;
    this._accessToken = null;
    this._refreshToken = null;
    this._tokenExpiry = null;
  }

  // ─── Auth ────────────────────────────────────────────────────────────────

  async login(username, password) {
    const res = await this._request('POST', '/api/accounts/login', {
      userName: username,
      password,
    }, false);
    this._accessToken = res.accessToken;
    this._refreshToken = res.refreshToken;
    this._tokenExpiry = Date.now() + res.expiresIn * 1000 - 60_000; // 1 min buffer
    await this._saveTokens();
    return res;
  }

  async _refreshAccessToken() {
    const res = await this._request('POST', '/api/accounts/refresh_token', {
      accessToken: this._accessToken,
      refreshToken: this._refreshToken,
    }, false);
    this._accessToken = res.accessToken;
    this._refreshToken = res.refreshToken;
    this._tokenExpiry = Date.now() + res.expiresIn * 1000 - 60_000;
    await this._saveTokens();
  }

  async _saveTokens() {
    await this.homey.settings.set('easee_access_token', this._accessToken);
    await this.homey.settings.set('easee_refresh_token', this._refreshToken);
    await this.homey.settings.set('easee_token_expiry', this._tokenExpiry);
  }

  async loadTokens() {
    this._accessToken = await this.homey.settings.get('easee_access_token');
    this._refreshToken = await this.homey.settings.get('easee_refresh_token');
    this._tokenExpiry = await this.homey.settings.get('easee_token_expiry');
  }

  async _ensureToken() {
    if (!this._accessToken) await this.loadTokens();
    if (!this._accessToken) throw new Error('Not authenticated. Please configure credentials.');
    if (Date.now() >= this._tokenExpiry) await this._refreshAccessToken();
  }

  // ─── Generic Request ─────────────────────────────────────────────────────

  async _request(method, path, body = null, auth = true) {
    if (auth) await this._ensureToken();

    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (auth) headers['Authorization'] = `Bearer ${this._accessToken}`;

    const options = { method, headers };
    if (body) options.body = JSON.stringify(body);

    const response = await fetch(`${BASE_URL}${path}`, options);

    if (!response.ok) {
      const text = await response.text().catch(() => response.statusText);
      throw new Error(`Easee API ${method} ${path} → ${response.status}: ${text}`);
    }

    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  // ─── Account / Discovery ─────────────────────────────────────────────────

  async getSites() {
    return this._request('GET', '/api/sites');
  }

  async getSite(siteId) {
    return this._request('GET', `/api/sites/${siteId}`);
  }

  async getChargers() {
    return this._request('GET', '/api/chargers');
  }

  async getCharger(chargerId) {
    return this._request('GET', `/api/chargers/${chargerId}`);
  }

  async getEqualizers() {
    // Equalizers are discovered per site
    const sites = await this.getSites();
    const equalizers = [];
    for (const site of sites) {
      if (site.equalizers && site.equalizers.length > 0) {
        equalizers.push(...site.equalizers.map(e => ({ ...e, siteId: site.id, siteName: site.name })));
      }
    }
    return equalizers;
  }

  // ─── Charger State & Config ──────────────────────────────────────────────

  async getChargerState(chargerId) {
    return this._request('GET', `/api/chargers/${chargerId}/state`);
  }

  async getChargerConfig(chargerId) {
    return this._request('GET', `/api/chargers/${chargerId}/config`);
  }

  async getChargerSettings(chargerId) {
    return this._request('GET', `/api/chargers/${chargerId}/settings`);
  }

  async updateChargerSettings(chargerId, settings) {
    // settings is an object e.g. { smartCharging: true, lockCablePermanently: false }
    return this._request('POST', `/api/chargers/${chargerId}/settings`, settings);
  }

  // ─── Charger Commands ────────────────────────────────────────────────────

  async startCharging(chargerId) {
    return this._request('POST', `/api/chargers/${chargerId}/commands/start_charging`);
  }

  async stopCharging(chargerId) {
    return this._request('POST', `/api/chargers/${chargerId}/commands/stop_charging`);
  }

  async pauseCharging(chargerId) {
    return this._request('POST', `/api/chargers/${chargerId}/commands/pause_charging`);
  }

  async resumeCharging(chargerId) {
    return this._request('POST', `/api/chargers/${chargerId}/commands/resume_charging`);
  }

  async toggleCharging(chargerId) {
    return this._request('POST', `/api/chargers/${chargerId}/commands/toggle_charging`);
  }

  async rebootCharger(chargerId) {
    return this._request('POST', `/api/chargers/${chargerId}/commands/reboot`);
  }

  // ─── Current Limits ──────────────────────────────────────────────────────

  /**
   * Set the dynamic charger current (changes frequently — safe for automation).
   * Min 0A (stops charging), max limited by circuit/max setting.
   */
  async setDynamicChargerCurrent(chargerId, current) {
    return this._request('POST', `/api/chargers/${chargerId}/settings`, {
      dynamicChargerCurrent: current,
    });
  }

  /**
   * Set dynamic circuit current for all chargers on a circuit (via master charger).
   * @param {string} siteId
   * @param {number} circuitId
   * @param {number} p1 Phase 1 amps
   * @param {number} p2 Phase 2 amps
   * @param {number} p3 Phase 3 amps
   */
  async setDynamicCircuitCurrent(siteId, circuitId, p1, p2, p3) {
    return this._request('POST', `/api/sites/${siteId}/circuits/${circuitId}/dynamicCurrent`, {
      phase1Current: p1,
      phase2Current: p2,
      phase3Current: p3,
    });
  }

  async getCircuitDynamicCurrent(siteId, circuitId) {
    return this._request('GET', `/api/sites/${siteId}/circuits/${circuitId}/dynamicCurrent`);
  }

  // ─── Ongoing Session / Energy ─────────────────────────────────────────────

  async getOngoingSession(chargerId) {
    return this._request('GET', `/api/chargers/${chargerId}/sessions/ongoing`);
  }

  async getLatestSession(chargerId) {
    return this._request('GET', `/api/chargers/${chargerId}/sessions/latest`);
  }

  // ─── Equalizer ───────────────────────────────────────────────────────────

  async getEqualizer(equalizerId) {
    return this._request('GET', `/api/equalizers/${equalizerId}`);
  }

  async getEqualizerState(equalizerId) {
    return this._request('GET', `/api/equalizers/${equalizerId}/state`);
  }

  async getEqualizerConfig(equalizerId) {
    return this._request('GET', `/api/equalizers/${equalizerId}/config`);
  }

  async updateEqualizerSettings(siteId, equalizerId, settings) {
    return this._request('POST', `/api/sites/${siteId}/equalizers/${equalizerId}/settings`, settings);
  }

  // ─── Observations (live telemetry) ───────────────────────────────────────

  async getChargerObservations(chargerId, from, to) {
    const params = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
    return this._request('GET', `/api/chargers/${chargerId}/observations?${params}`);
  }
}

module.exports = EaseeAPI;
