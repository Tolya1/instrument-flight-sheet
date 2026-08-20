'use strict';
// FAA NASR 28-day subscription cycle arithmetic.
// Known anchor cycle effective date: 2026-08-06 (verified 2026-08-20).
const ANCHOR_UTC = Date.UTC(2026, 7, 6); // months 0-based
const CYCLE_MS = 28 * 24 * 3600 * 1000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Effective date (UTC ms) of the cycle containing `date`, plus the previous one as fallback.
function currentCycle(date = new Date()) {
  const n = Math.floor((date.getTime() - ANCHOR_UTC) / CYCLE_MS);
  return {
    current: new Date(ANCHOR_UTC + n * CYCLE_MS),
    previous: new Date(ANCHOR_UTC + (n - 1) * CYCLE_MS),
  };
}

// "06_Aug_2026" — the filename fragment NASR per-domain zips use.
function nasrStamp(d) {
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${dd}_${MONTHS[d.getUTCMonth()]}_${d.getUTCFullYear()}`;
}

// "2026-08-06" — for display / cache keys.
function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

module.exports = { currentCycle, nasrStamp, isoDate };
