'use strict';

const PROFILES = {
  NORMAL: 'normal',
  STRICT: 'strict',
  SOLAR: 'solar',
};

// How much of the limit to use per profile (multiplier)
const PROFILE_LIMIT_FACTOR = {
  [PROFILES.NORMAL]: 1.0,
  [PROFILES.STRICT]: 0.9,
  [PROFILES.SOLAR]: 1.05,
};

const DEFAULT_SETTINGS = {
  enabled: true,
  profile: PROFILES.NORMAL,
  powerLimitW: 10000,
  phase1LimitA: 0,   // 0 = disabled
  phase2LimitA: 0,
  phase3LimitA: 0,
  smoothingWindow: 5,       // number of readings for moving average
  spikeMultiplier: 2.0,     // reading > avg * this is ignored
  hysteresisCount: 3,       // consecutive readings over limit before acting
  cooldownSeconds: 30,      // min seconds between mitigation steps
  voltageSystem: '230v-1phase',   // '230v-1phase' or '400v-3phase'
  phaseDistribution: 'balanced',  // charger phase distribution
  mainCircuitA: 25,               // main circuit breaker amperage
  priorityList: [],         // [{deviceId, name, priority, action, minRuntimeSeconds, minOffTimeSeconds}]
};

const ACTIONS = {
  TURN_OFF: 'onoff',
  DIM: 'dim',
  TARGET_TEMP: 'target_temperature',
  CHARGE_PAUSE: 'charge_pause',  // uses onoff for chargers that support it
  DYNAMIC_CURRENT: 'dynamic_current',
};

const MITIGATION_LOG_MAX = 100;

module.exports = { PROFILES, PROFILE_LIMIT_FACTOR, DEFAULT_SETTINGS, ACTIONS, MITIGATION_LOG_MAX };
