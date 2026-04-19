'use strict';

// ══════════════════════════════════════════════════════════════════
// Thermostat Schedule Engine
// ══════════════════════════════════════════════════════════════════
// Pure logic module — no Homey/app dependencies.
// Stores a weekly temperature plan per thermostat device and answers
// the question: "What temperature should this device have RIGHT NOW?"
//
// Data structure (stored under homey.settings key 'thermostatSchedules'):
// [
//   {
//     deviceId:   "abc-123",           // Homey device ID
//     deviceName: "Stue",              // Display name (from device.name)
//     enabled:    true,                // false = schedule ignored for this device
//     schedule: {
//       MO: [{ from: "06:00", to: "22:00", temp: 20 }, { from: "22:00", to: "24:00", temp: 18 }],
//       TU: [...],
//       WE: [...],
//       TH: [...],
//       FR: [{ from: "06:00", to: "23:00", temp: 20 }, { from: "23:00", to: "24:00", temp: 18 }],
//       SA: [{ from: "08:00", to: "23:00", temp: 21 }, { from: "23:00", to: "24:00", temp: 18 }],
//       SU: [{ from: "08:00", to: "22:00", temp: 21 }, { from: "22:00", to: "24:00", temp: 18 }],
//     }
//   },
//   ...
// ]
//
// Notes:
//  - "to": "24:00" means midnight (end of day) — all times are local.
//  - Blocks must not overlap. Gaps are allowed (no temp applied during gap).
//  - Temperature in °C, step 0.5°C.
// ══════════════════════════════════════════════════════════════════

const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/**
 * Parse "HH:MM" → minutes from midnight. "24:00" → 1440.
 */
function _toMinutes(hhmm) {
  const parts = String(hhmm || '').split(':');
  return parseInt(parts[0], 10) * 60 + parseInt(parts[1] || '0', 10);
}

/**
 * Given a device schedule entry and a Date object, return the target
 * temperature for that point in time, or null if no block covers it.
 *
 * @param {object} deviceSchedule  - One entry from the thermostatSchedules array
 * @param {Date}   now             - Current time (defaults to new Date())
 * @returns {number|null}
 */
function getCurrentTemp(deviceSchedule, now) {
  if (!deviceSchedule || deviceSchedule.enabled === false) return null;
  const today = now instanceof Date ? now : new Date();
  const day   = DAYS[today.getDay()];
  const blocks = (deviceSchedule.schedule && deviceSchedule.schedule[day]) || [];
  const nowMin = today.getHours() * 60 + today.getMinutes();

  for (const block of blocks) {
    const fromMin = _toMinutes(block.from);
    const toMin   = _toMinutes(block.to); // 24:00 → 1440
    if (nowMin >= fromMin && nowMin < toMin) {
      return typeof block.temp === 'number' ? block.temp : null;
    }
  }
  return null; // No block covers this time
}

/**
 * Validate a schedule for a single device.
 * Returns { ok: true } or { ok: false, error: "..." }
 */
function validateSchedule(deviceSchedule) {
  if (!deviceSchedule || typeof deviceSchedule !== 'object') return { ok: false, error: 'Not an object' };
  if (!deviceSchedule.deviceId) return { ok: false, error: 'Missing deviceId' };
  if (!deviceSchedule.schedule || typeof deviceSchedule.schedule !== 'object') return { ok: false, error: 'Missing schedule' };

  for (const day of DAYS) {
    const blocks = deviceSchedule.schedule[day];
    if (!Array.isArray(blocks)) continue;
    for (const b of blocks) {
      if (typeof b.from !== 'string' || typeof b.to !== 'string') return { ok: false, error: `Day ${day}: block missing from/to` };
      if (typeof b.temp !== 'number' || b.temp < 5 || b.temp > 35) return { ok: false, error: `Day ${day}: temp out of range (5–35)` };
      if (_toMinutes(b.from) >= _toMinutes(b.to)) return { ok: false, error: `Day ${day}: from >= to` };
    }
  }
  return { ok: true };
}

/**
 * Build a default "all-day same temperature" schedule.
 * Good starting point for a new device entry.
 *
 * @param {number} defaultTemp  - e.g. 20
 * @returns {object}            - schedule object (all 7 days)
 */
function buildDefaultSchedule(defaultTemp) {
  const t = typeof defaultTemp === 'number' ? defaultTemp : 20;
  const allDay = [{ from: '00:00', to: '24:00', temp: t }];
  return {
    MO: allDay.map(b => ({ ...b })),
    TU: allDay.map(b => ({ ...b })),
    WE: allDay.map(b => ({ ...b })),
    TH: allDay.map(b => ({ ...b })),
    FR: allDay.map(b => ({ ...b })),
    SA: allDay.map(b => ({ ...b })),
    SU: allDay.map(b => ({ ...b })),
  };
}

module.exports = { getCurrentTemp, validateSchedule, buildDefaultSchedule, DAYS };
