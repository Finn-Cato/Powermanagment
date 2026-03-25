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
  [PROFILES.STRICT]: 0.95,
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
  errorMarginPercent: 0,    // reduce effective limit by this % as safety buffer (0 = disabled)
  missingPowerTimeoutS: 120, // seconds with no HAN reading before forcing mitigation (0 = disabled)
  dynamicRestoreGuard: true, // scale restore cooldown with time left in the hour
  dynamicHourlyBudget: false, // allow higher power mid-hour when hourly budget allows it
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
  max_power_2000: ['high_power', 'medium_power', 'low_power'],
  max_power:      ['high_power', 'medium_power', 'low_power'],
};

const MITIGATION_LOG_MAX = 100;

// EV charger control defaults
const CHARGER_DEFAULTS = {
  minCurrent: 6,               // Minimum charging current (Easee supports 6A)
  startCurrent: 11,            // Current when resuming from pause (ensures reliable start)
  maxCurrent: 32,              // Maximum charging current
  toggleConfirmedMs: 15000,    // Throttle for decreases when confirmed (15s — fast response)
  toggleIncreaseMs: 50000,     // Throttle for increases (50s — ramp completes within 240s cooldown)
  toggleUnconfirmedMs: 45000,  // Throttle when last command was NOT confirmed (45s)
  toggleEmergencyMs: 5000,     // Throttle in emergency >500W over (5s)
  confirmationTimeoutMs: 20000,// How long to wait for offered-current confirmation (20s)
  maxStepUpW: 1380,            // Max watts to increase per cycle: 1-phase=6A/step, 3-phase=2A/step
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

// ── Mode engine ──────────────────────────────────────────────────────────────
const MODES = {
  HOME:    'home',
  NIGHT:   'night',
  AWAY:    'away',
  HOLIDAY: 'holiday',
};

// Default modeSettings object stored under Homey settings key 'modeSettings'.
// devicePrefs: { [deviceId]: { home: { value }, night: { value }, away: { value }, holiday: { value } } }
const MODES_DEFAULTS = {
  activeMode: 'home',
  nightSchedule: {
    type: 'custom',   // 'custom' | 'homey'
    fromHH: 22,
    fromMM: 0,
    toHH: 7,
    toMM: 0,
  },
  devicePrefs: {},
};

// Spot price engine defaults
// Changing 'enabled' to true in settings activates price-based charger capping.
const PRICE_DEFAULTS = {
  enabled: false,          // Off by default — user must opt in
  priceArea: 'NO4',        // NO1–NO5
  nightDiscountOre: 12,    // Nettleie night discount subtracted from spot (øre/kWh)
  nightStartHour: 22,
  nightEndHour: 6,
  lookaheadHours: 18,      // How many hours ahead to analyse
  cheapHoursTarget: 6,     // Number of hours counted as "cheapest" in window
  capLav: 0.5,             // Charger current cap when mode=lav  (fraction of circuit limit)
  capMaks: 1.0,            // Charger current cap when mode=maks (no extra restriction)
  norgesprisEnabled: false, // Apply Norwegian Norgespris flat-rate scheme
  norgesprisFlatOre: 50,    // Fixed price you pay: 50 øre incl. VAT (40 in Nordland/Troms/Finnmark)
};

module.exports = { PROFILES, PROFILE_LIMIT_FACTOR, DEFAULT_SETTINGS, ACTIONS, HOIAX_POWER_STEPS, MITIGATION_LOG_MAX, CHARGER_DEFAULTS, EFFEKT_TIERS, PRICE_DEFAULTS, MODES, MODES_DEFAULTS };
