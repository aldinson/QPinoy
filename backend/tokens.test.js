'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

process.env.AUTH_SECRET = 'test-secret-that-is-definitely-long-enough-0123456789';

const {
  createToken,
  verifyToken,
  createSessionToken,
  verifySessionToken,
  createEnrollmentToken,
  verifyEnrollmentToken,
  TokenError,
  PURPOSE_SESSION,
  PURPOSE_ENROLLMENT,
} = require('./tokens');

const USER_ID = '11111111-1111-1111-1111-111111111111';

test('a freshly signed session token verifies and carries its subject', () => {
  const claims = verifySessionToken(createSessionToken(USER_ID));
  assert.equal(claims.sub, USER_ID);
  assert.equal(claims.typ, PURPOSE_SESSION);
});

test('an enrollment token verifies and is scoped to the enrollment purpose', () => {
  const claims = verifyEnrollmentToken(createEnrollmentToken(USER_ID));
  assert.equal(claims.sub, USER_ID);
  assert.equal(claims.typ, PURPOSE_ENROLLMENT);
});

test('SECURITY: an enrollment token cannot be replayed as a login session', () => {
  // The attack this blocks: a QR code is displayed in public and is
  // trivially photographed. If it doubled as a session token, anyone
  // who snapped a picture would be logged in as that customer.
  const qrToken = createEnrollmentToken(USER_ID);
  assert.throws(() => verifySessionToken(qrToken), (err) => err instanceof TokenError && err.reason === 'wrong_purpose');
});

test('SECURITY: a session token cannot be used as an enrollment QR code', () => {
  const session = createSessionToken(USER_ID);
  assert.throws(() => verifyEnrollmentToken(session), (err) => err.reason === 'wrong_purpose');
});

test('SECURITY: a tampered payload is rejected', () => {
  // Re-encode the payload with a different subject, keeping the
  // original signature — the classic "edit the claims" attempt.
  const token = createSessionToken(USER_ID);
  const [header, , signature] = token.split('.');
  const forgedPayload = Buffer.from(
    JSON.stringify({ sub: '99999999-9999-9999-9999-999999999999', typ: PURPOSE_SESSION, iat: 1, exp: 9999999999 })
  ).toString('base64url');

  assert.throws(
    () => verifySessionToken(`${header}.${forgedPayload}.${signature}`),
    (err) => err.reason === 'bad_signature'
  );
});

test('SECURITY: `alg: none` is rejected — the algorithm is never read from the token', () => {
  // The canonical JWT vulnerability: a verifier that trusts the
  // token's own `alg` header can be told not to check the signature
  // at all. This implementation always recomputes HS256, so the
  // forged header simply fails the signature comparison.
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ sub: USER_ID, typ: PURPOSE_SESSION, iat: 1, exp: 9999999999 })
  ).toString('base64url');

  assert.throws(() => verifySessionToken(`${header}.${payload}.`), (err) => err instanceof TokenError);
  assert.throws(() => verifySessionToken(`${header}.${payload}.anything`), (err) => err instanceof TokenError);
});

test('SECURITY: a token signed with a different secret is rejected', () => {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ sub: USER_ID, typ: PURPOSE_SESSION, iat: 1, exp: 9999999999 })
  ).toString('base64url');
  const attackerSig = crypto.createHmac('sha256', 'the-attackers-own-secret-value-here').update(`${header}.${payload}`).digest('base64url');

  assert.throws(() => verifySessionToken(`${header}.${payload}.${attackerSig}`), (err) => err.reason === 'bad_signature');
});

test('an expired token is rejected with a distinguishable reason', () => {
  // Negative TTL => already expired at the moment it was created.
  const expired = createToken({ sub: USER_ID }, PURPOSE_ENROLLMENT, -1);
  assert.throws(() => verifyEnrollmentToken(expired), (err) => err.reason === 'expired');
});

test('a token with no exp claim is rejected rather than treated as eternal', () => {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub: USER_ID, typ: PURPOSE_SESSION })).toString('base64url');
  const sig = crypto
    .createHmac('sha256', process.env.AUTH_SECRET)
    .update(`${header}.${payload}`)
    .digest('base64url');

  assert.throws(() => verifySessionToken(`${header}.${payload}.${sig}`), (err) => err.reason === 'expired');
});

test('structurally malformed tokens are rejected without throwing something unexpected', () => {
  for (const bad of ['', 'not-a-token', 'only.two', 'a.b.c.d', null, undefined, 42]) {
    assert.throws(() => verifySessionToken(bad), (err) => err instanceof TokenError, `should reject: ${String(bad)}`);
  }
});

test('verifyToken refuses to run without an explicit expected purpose', () => {
  // Guards against a future caller writing verifyToken(token) and
  // silently accepting a token of any purpose.
  const token = createSessionToken(USER_ID);
  assert.throws(() => verifyToken(token), /explicit expected purpose/);
});

test('a missing or too-short AUTH_SECRET fails loudly instead of using a default', async (t) => {
  const original = process.env.AUTH_SECRET;
  t.after(() => {
    process.env.AUTH_SECRET = original;
  });

  delete process.env.AUTH_SECRET;
  assert.throws(() => createSessionToken(USER_ID), /AUTH_SECRET is missing or too short/);

  process.env.AUTH_SECRET = 'too-short';
  assert.throws(() => createSessionToken(USER_ID), /AUTH_SECRET is missing or too short/);
});
