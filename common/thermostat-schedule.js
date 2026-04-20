'use strict';

// ══════════════════════════════════════════════════════════════════
// Thermostat Schedule Engine
// ══════════════════════════════════════════════════════════════════
// Pure logic module — no Homey/app dependencies.
// Stores a weekly temperature plan per thermostat device and answers
// the question: "What temperature should this device have RIGHT NOW?"
//
// Data structure (stored under homey.settings key 'thermostatPlans'):
// {
//   plans: [
//     {
//       id: "plan_abc",
//       name: "Hjemme",
//       schedule: {
//         MO: [{ from: "06:00", temp: 20 }, { from: "22:00", temp: 18 }],
//         TU: [...],
//         ...
//       },
//       devices: [{ deviceId: "abc-123", deviceName: "Stue" }]
//     }
//   ]
// }
//
// Notes:
//  - Each entry has only a start time ("from"). The period ends when the next entry starts.
//  - The last entry of a day wraps around to midnight and continues until the first entry of the same day.
//  - Temperature in °C, step 0.5°C.
//  - Legacy entries with a "to" field are silently ignored (backward compat).
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
 * Each block covers from its "from" until the next block's "from".
 * The last block of the day wraps around midnight and covers until the
 * first block's "from" the next occurrence of the same day.
 * Legacy blocks with a "to" field are silently ignored.
 *
 * @param {object} deviceSchedule  - One entry from the schedules array
 * @param {Date}   now             - Current time (defaults to new Date())
 * @returns {number|null}
 */
function getCurrentTemp(deviceSchedule, now) {
  if (!deviceSchedule || deviceSchedule.enabled === false) return null;
  const today = now instanceof Date ? now : new Date();
  const dayIdx = today.getDay();
  const day       = DAYS[dayIdx];
  const yesterday = DAYS[(dayIdx + 6) % 7];

  const blocks  = (deviceSchedule.schedule && deviceSchedule.schedule[day])      || [];
  const yBlocks = (deviceSchedule.schedule && deviceSchedule.schedule[yesterday]) || [];

  const nowMin = today.getHours() * 60 + today.getMinutes();

  // Sort blocks by start time (defensive — editor already sorts)
  const sorted = blocks.slice().sort((a, b) => _toMinutes(a.from) - _toMinutes(b.from));

  // Find the last block whose "from" is <= nowMin
  let active = null;
  for (const block of sorted) {
    if (_toMinutes(block.from) <= nowMin) active = block;
  }

  if (active !== null) {
    return typeof active.temp === 'number' ? active.temp : null;
  }

  // nowMin is before the first block of today — use yesterday's last block (wrap-around)
  if (yBlocks.length > 0) {
    const ySorted = yBlocks.slice().sort((a, b) => _toMinutes(a.from) - _toMinutes(b.from));
    const yLast = ySorted[ySorted.length - 1];
    return typeof yLast.temp === 'number' ? yLast.temp : null;
  }

  return null;
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
      if (typeof b.from !== 'string') return { ok: false, error: `Day ${day}: block missing from` };
      if (typeof b.temp !== 'number' || b.temp < 5 || b.temp > 35) return { ok: false, error: `Day ${day}: temp out of range (5–35)` };
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
  const allDay = [{ from: '00:00', temp: t }];
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
