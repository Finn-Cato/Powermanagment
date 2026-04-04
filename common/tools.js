'use strict';

/**
 * Compute moving average of the last N values.
 * @param {number[]} buffer
 * @param {number} windowSize
 * @returns {number}
 */
function movingAverage(buffer, windowSize) {
  if (!buffer.length) return 0;
  const slice = buffer.slice(-windowSize);
  return slice.reduce((sum, v) => sum + v, 0) / slice.length;
}

/**
 * Return true if value is a spike relative to the current average.
 * @param {number} value
 * @param {number} average
 * @param {number} multiplier
 * @returns {boolean}
 */
function isSpike(value, average, multiplier) {
  if (average === 0) return false;
  return value > average * multiplier;
}

/**
 * Clamp a value between min and max.
 */
function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/**
 * Format a timestamp for logging in local time (Homey timezone).
 * @param {Date} [d] - Optional date, defaults to now
 * @returns {string} Local ISO-like string without trailing Z
 */
function timestamp(d) {
  if (!d) d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${ms}`;
}

module.exports = { movingAverage, isSpike, clamp, timestamp };
