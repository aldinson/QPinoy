'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { hashPassword, verifyPassword, describePasswordProblem } = require('./password');

test('a correct password verifies against its own hash', async () => {
  const hash = await hashPassword('correct horse battery');
  assert.equal(await verifyPassword('correct horse battery', hash), true);
});

test('a wrong password does not verify', async () => {
  const hash = await hashPassword('correct horse battery');
  assert.equal(await verifyPassword('correct horse batteru', hash), false);
});

test('hashing the same password twice produces different hashes (per-row salt)', async () => {
  const a = await hashPassword('same-password-both-times');
  const b = await hashPassword('same-password-both-times');
  assert.notEqual(a, b, 'identical hashes would mean the salt is not random');
  // ...and both still verify, which is the point of salting.
  assert.equal(await verifyPassword('same-password-both-times', a), true);
  assert.equal(await verifyPassword('same-password-both-times', b), true);
});

test('the stored format carries its own scrypt parameters', async () => {
  const hash = await hashPassword('parameters-please');
  const parts = hash.split('$');
  assert.equal(parts.length, 6);
  assert.equal(parts[0], 'scrypt');
  assert.equal(Number(parts[1]), 16384); // N
  assert.equal(Number(parts[2]), 8); // r
  assert.equal(Number(parts[3]), 1); // p
});

test('a hash written with different (lower) parameters still verifies', async () => {
  // Simulates an old row from before the cost was raised. This is the
  // whole reason the parameters live in the string instead of in a
  // constant — if verification hardcoded today's N, every existing
  // password would break the day it changed.
  const crypto = require('crypto');
  const { promisify } = require('util');
  const scrypt = promisify(crypto.scrypt);
  const salt = crypto.randomBytes(16);
  const derived = await scrypt('legacy-password', salt, 64, { N: 1024, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const legacyHash = ['scrypt', 1024, 8, 1, salt.toString('base64url'), derived.toString('base64url')].join('$');

  assert.equal(await verifyPassword('legacy-password', legacyHash), true);
  assert.equal(await verifyPassword('wrong', legacyHash), false);
});

test('malformed stored hashes read as "wrong password" rather than throwing', async () => {
  // A corrupt row must not 500 — that would tell an attacker probing
  // logins that they found something structurally interesting.
  for (const bad of ['', 'not-a-hash', 'scrypt$only$four$parts', 'bcrypt$16384$8$1$aaaa$bbbb', 'scrypt$x$y$z$aaaa$bbbb']) {
    assert.equal(await verifyPassword('anything', bad), false, `should reject: ${bad}`);
  }
});

test('non-string inputs are rejected, not coerced', async () => {
  const hash = await hashPassword('a-real-password');
  assert.equal(await verifyPassword(undefined, hash), false);
  assert.equal(await verifyPassword(null, hash), false);
  assert.equal(await verifyPassword({}, hash), false);
  assert.equal(await verifyPassword('a-real-password', null), false);
});

test('password policy rejects too-short, too-long, and non-string values', () => {
  assert.ok(describePasswordProblem('short'));
  assert.ok(describePasswordProblem('x'.repeat(201)));
  assert.ok(describePasswordProblem(12345678));
  assert.equal(describePasswordProblem('eight888'), null);
  assert.equal(describePasswordProblem('x'.repeat(200)), null);
});

test('hashPassword refuses to hash a password that fails the policy', async () => {
  await assert.rejects(() => hashPassword('short'), /at least 8/);
});
