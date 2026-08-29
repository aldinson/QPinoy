'use strict';

/**
 * password.js
 * ─────────────────────────────────────────────────────────────
 * Password hashing on `node:crypto`'s scrypt — no native module, no
 * dependency. That matters here specifically because this code has to
 * run inside a Netlify Function bundled by esbuild, where bcrypt's
 * native binary is a recurring source of "works locally, breaks on
 * deploy". scrypt is memory-hard, is what Node ships for exactly this
 * purpose, and needs nothing installed.
 *
 * Stored format (single text column, self-describing):
 *
 *   scrypt$N$r$p$<salt-b64url>$<hash-b64url>
 *
 * The cost parameters travel WITH each hash rather than living in a
 * constant somewhere. That's what lets them be raised later — an old
 * row still verifies against the parameters it was written with,
 * instead of every existing password breaking the day the constant
 * changes.
 */

const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);

// N=16384 (2^14), r=8, p=1 — the parameters Node documents as a
// sensible interactive-login baseline. maxmem has to be raised
// explicitly because Node's 32MB default is below what N=16384/r=8
// actually needs and would otherwise throw.
const PARAMS = { N: 16384, r: 8, p: 1 };
const KEY_LENGTH = 64;
const SALT_BYTES = 16;
const MAXMEM = 64 * 1024 * 1024;

async function hashPassword(plaintext) {
  assertUsablePassword(plaintext);
  const salt = crypto.randomBytes(SALT_BYTES);
  const derived = await scrypt(plaintext, salt, KEY_LENGTH, { ...PARAMS, maxmem: MAXMEM });
  return [
    'scrypt',
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString('base64url'),
    derived.toString('base64url'),
  ].join('$');
}

/**
 * Verify a plaintext against a stored hash. Returns a boolean and
 * never throws on malformed/unknown stored values — a corrupt row
 * should read as "wrong password", not as a 500 that tells an
 * attacker they found something interesting.
 */
async function verifyPassword(plaintext, stored) {
  if (typeof plaintext !== 'string' || typeof stored !== 'string') return false;

  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

  try {
    const salt = Buffer.from(parts[4], 'base64url');
    const expected = Buffer.from(parts[5], 'base64url');
    const derived = await scrypt(plaintext, salt, expected.length, { N, r, p, maxmem: MAXMEM });
    // Length is already equal by construction (we derived exactly
    // expected.length bytes), but timingSafeEqual throws rather than
    // returning false on a mismatch, so the guard stays.
    if (derived.length !== expected.length) return false;
    return crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

const MIN_PASSWORD_LENGTH = 8;
// scrypt itself has no input limit, but an unbounded password is a
// free CPU-burn vector: every login attempt would hash whatever
// megabyte-sized string was posted.
const MAX_PASSWORD_LENGTH = 200;

function assertUsablePassword(plaintext) {
  const problem = describePasswordProblem(plaintext);
  if (problem) throw new Error(problem);
}

/** Returns a human-readable problem string, or null if the password is acceptable. */
function describePasswordProblem(plaintext) {
  if (typeof plaintext !== 'string') return 'password must be a string';
  if (plaintext.length < MIN_PASSWORD_LENGTH) return `password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  if (plaintext.length > MAX_PASSWORD_LENGTH) return `password must be at most ${MAX_PASSWORD_LENGTH} characters`;
  return null;
}

module.exports = {
  hashPassword,
  verifyPassword,
  describePasswordProblem,
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_LENGTH,
};
