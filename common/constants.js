'use strict';

// ══════════════════════════════════════════════════════════════════
// common/constants.js  —  SHARED CONSTANTS
// ══════════════════════════════════════════════════════════════════
//
//  PROFILES           — normal / strict / solar
//  DEFAULT_SETTINGS   — full settings object defaults
//  ACTIONS            — action type identifiers (target_temperature, hoiax_power, etc.)
//  HOIAX_POWER_STEPS  — [B] Water heater step-down levels per model
//  CHARGER_DEFAULTS   — [C] EV charger min/start current defaults
//  EFFEKT_TIERS       — Norwegian capacity tariff tier thresholds (kW)
//  MITIGATION_LOG_MAX — max entries kept in mitigation log
//
//  ✅ STABLE — DO NOT TOUCH unless adding a new device type
// ══════════════════════════════════════════════════════════════════

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
  voltageSystem: 'auto',   // 'auto' | '230v-1phase' | '400v-3phase'
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
  HOIAX_POWER: 'hoiax_power',   // stepped power reduction for Høiax water heaters
};

// Høiax stepped power levels: step down one level per mitigation cycle
// max_power_3000 = Høiax Connected 300 (3000W, 1750W, 1250W)
// max_power      = Høiax Connected 200 (2000W, 1300W, 700W)
const HOIAX_POWER_STEPS = {
  max_power_3000: ['high_power', 'medium_power', 'low_power'],
  max_power:      ['high_power', 'medium_power', 'low_power'],
};

const MITIGATION_LOG_MAX = 100;

// EV charger control defaults (inspired by Sparegris Piggy Charger)
const CHARGER_DEFAULTS = {
  minCurrent: 7,               // Minimum charging current (some chargers unstable at 6A)
  startCurrent: 11,            // Current when resuming from pause (ensures reliable start)
  maxCurrent: 32,              // Maximum charging current
  toggleConfirmedMs: 15000,    // Throttle when last command was confirmed (15s)
  toggleUnconfirmedMs: 45000,  // Throttle when last command was NOT confirmed (45s)
  toggleEmergencyMs: 5000,     // Throttle in emergency >500W over (5s)
  confirmationTimeoutMs: 20000,// How long to wait for offered-current confirmation (20s)
};

// Norwegian effekttariff (capacity tariff) — tier thresholds in kW
// Determines the monthly grid capacity charge based on average of 3 highest daily peaks.
// Source: NVE standard thresholds used by most Norwegian DSOs.
const EFFEKT_TIERS = [
  { maxKW:  2, label: '0–2 kW',   index: 0 },
  { maxKW:  5, label: '2–5 kW',   index: 1 },
  { maxKW: 10, label: '5–10 kW',  index: 2 },
  { maxKW: 15, label: '10–15 kW', index: 3 },
  { maxKW: 20, label: '15–20 kW', index: 4 },
  { maxKW: 25, label: '20–25 kW', index: 5 },
  { maxKW: Infinity, label: '≥ 25 kW', index: 6 },
];

module.exports = { PROFILES, PROFILE_LIMIT_FACTOR, DEFAULT_SETTINGS, ACTIONS, HOIAX_POWER_STEPS, MITIGATION_LOG_MAX, CHARGER_DEFAULTS, EFFEKT_TIERS };
