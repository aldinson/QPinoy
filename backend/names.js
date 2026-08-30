'use strict';

/**
 * names.js
 * ─────────────────────────────────────────────────────────────
 * Masking customer names for the "who's ahead of me" roster a
 * customer sees for a venue they've joined. They get to see the
 * shape of the line — who's roughly where — without seeing anyone
 * else's actual name, which is nobody else's business but theirs
 * and the venue's staff.
 *
 * Pure and DB-free on purpose, like queueCore.js/geofence.js — the
 * masking rule itself is a one-line fact worth unit-testing in
 * isolation from any query that happens to call it.
 */

/** "Alice" -> "A****", "Nguyen" -> "N*****". Never reveals more than the first letter. */
function maskWord(word) {
  if (word.length <= 1) return word;
  return word[0] + '*'.repeat(word.length - 1);
}

/**
 * "Alice Chen" -> "A**** C." — first name masked to its initial plus
 * asterisks (so the length is visible but nothing else is), every
 * later name reduced to just an initial. A single-word name masks
 * the same way as a first name, with no trailing initial to add.
 */
function maskCustomerName(fullName) {
  const words = (fullName || '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';
  const [first, ...rest] = words;
  const initials = rest.map((w) => `${w[0].toUpperCase()}.`);
  return [maskWord(first), ...initials].join(' ');
}

module.exports = { maskCustomerName };
