'use strict';

/**
 * phone.js
 * ─────────────────────────────────────────────────────────────
 * Validation and normalisation for the mobile number every account
 * must supply.
 *
 * Numbers are STORED in E.164 (`+639171234567`) rather than however
 * the user happened to type them. That matters because a phone number
 * is only useful if you can actually dial or SMS it: an SMS gateway
 * wants E.164, and "0917 123 4567", "0917-123-4567" and
 * "+63 917 123 4567" are the same person. Keeping the raw string
 * would mean every consumer re-invents this parsing, and they would
 * not all agree.
 *
 * Filipino mobiles are the common case and are accepted in the shapes
 * people actually write them:
 *
 *   0917 123 4567     ->  +639171234567
 *   09171234567       ->  +639171234567
 *   9171234567        ->  +639171234567   (leading zero dropped)
 *   639171234567      ->  +639171234567
 *   +63 917 123 4567  ->  +639171234567
 *
 * Any other country is accepted in explicit international form
 * (`+<country code><number>`), so a tourist at a clinic or a supplier
 * abroad is not locked out. That is also the escape hatch for a
 * Philippine landline (`+6328...`), which the local-format rules
 * deliberately do not match — the field asks for a cellphone, because
 * the point of collecting it is being able to text someone that their
 * turn is coming up.
 */

// E.164 caps the whole number at 15 digits including the country code;
// 7 is below any real national number and rejects obvious junk.
const E164_RE = /^\+[1-9]\d{6,14}$/;

// Philippine mobile numbers are 10 digits after the country code and
// always start with 9.
const PH_MOBILE_NATIONAL = /^9\d{9}$/;

/**
 * Normalise a user-supplied number to E.164, or return null if it
 * isn't a number we can confidently dial.
 */
function normalisePhone(raw) {
  if (typeof raw !== 'string') return null;

  // Strip the punctuation people use for readability. Everything
  // else — letters, extension markers like "ext" — is left in place
  // so it fails validation loudly rather than being silently mangled
  // into a different number.
  const cleaned = raw.trim().replace(/[\s().\-‐-―]/g, '');
  if (!cleaned) return null;

  if (cleaned.startsWith('+')) {
    return E164_RE.test(cleaned) ? cleaned : null;
  }

  // 09171234567 — the way it's written locally.
  if (/^0\d+$/.test(cleaned)) {
    const national = cleaned.slice(1);
    return PH_MOBILE_NATIONAL.test(national) ? `+63${national}` : null;
  }

  // 639171234567 — country code without the plus.
  if (cleaned.startsWith('63')) {
    const national = cleaned.slice(2);
    return PH_MOBILE_NATIONAL.test(national) ? `+63${national}` : null;
  }

  // 9171234567 — bare national number, leading zero dropped.
  if (PH_MOBILE_NATIONAL.test(cleaned)) return `+63${cleaned}`;

  return null;
}

/**
 * Returns a human-readable problem string, or null if the number is
 * acceptable. Mirrors describePasswordProblem() in password.js so the
 * routes can validate everything the same way.
 */
function describePhoneProblem(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return 'a mobile number is required';
  if (!normalisePhone(raw)) {
    return 'enter a valid mobile number, e.g. 0917 123 4567 (or +63 917 123 4567)';
  }
  return null;
}

module.exports = { normalisePhone, describePhoneProblem };
