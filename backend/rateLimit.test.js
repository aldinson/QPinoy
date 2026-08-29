'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { bucketKey, clientIp, LIMITS } = require('./rateLimit');

test('bucket keys namespace by purpose and dimension', () => {
  const a = bucketKey('login', 'email', 'someone@example.com');
  const b = bucketKey('login', 'ip', 'someone@example.com');
  const c = bucketKey('location', 'email', 'someone@example.com');

  assert.ok(a.startsWith('login:email:'));
  assert.notEqual(a, b, 'the same identifier in a different dimension must not share a counter');
  assert.notEqual(a, c, 'the same identifier for a different purpose must not share a counter');
});

test('bucket keys are stable for the same identifier', () => {
  assert.equal(bucketKey('login', 'email', 'a@b.com'), bucketKey('login', 'email', 'a@b.com'));
});

test('PRIVACY: the identifier is hashed, never stored in the key verbatim', () => {
  // This table exists only to count. It must not become a second,
  // less-guarded home for email addresses and IPs.
  const key = bucketKey('login', 'email', 'victim@example.com');
  assert.ok(!key.includes('victim'), 'raw email leaked into the bucket key');
  assert.ok(!key.includes('@'), 'raw email leaked into the bucket key');
  assert.match(key, /^login:email:[0-9a-f]{64}$/);
});

test('bucket keys are bounded in length regardless of input size', () => {
  // A client controls the email field; without hashing, a megabyte
  // string would become a megabyte primary key.
  const huge = 'x'.repeat(100000) + '@example.com';
  assert.equal(bucketKey('login', 'email', huge).length, 'login:email:'.length + 64);
});

test('clientIp prefers the platform header over Express socket inspection', () => {
  // Behind serverless-http, req.ip sees the platform's internals
  // rather than the caller, so the Netlify-provided header wins.
  const req = { headers: { 'x-nf-client-connection-ip': '203.0.113.9' }, ip: '10.0.0.1' };
  assert.equal(clientIp(req), '203.0.113.9');
});

test('clientIp falls back to req.ip, then the socket, then a sentinel', () => {
  assert.equal(clientIp({ headers: {}, ip: '198.51.100.4' }), '198.51.100.4');
  assert.equal(clientIp({ headers: {}, socket: { remoteAddress: '198.51.100.7' } }), '198.51.100.7');
  // Never undefined — an unknown IP still needs to land in *some*
  // bucket rather than silently disabling the limit.
  assert.equal(clientIp({ headers: {} }), 'unknown');
});

test('the per-IP login budget is more generous than the per-account one', () => {
  // Offices, clinics and mobile carriers NAT many legitimate people
  // behind one address; the per-account limit is the tight one.
  assert.ok(LIMITS.LOGIN_IP.limit > LIMITS.LOGIN_ACCOUNT.limit);
});

test('SECURITY: the login account bucket includes the IP, so it cannot be used to lock someone out', () => {
  // Keying on the email alone would let anyone burn a stranger's
  // budget and block them from their own account. Two different
  // clients attempting the same address must land in DIFFERENT
  // buckets.
  const victimEmail = 'victim@example.com';
  const attackerBucket = bucketKey('login', 'account', `${victimEmail}|203.0.113.9`);
  const victimBucket = bucketKey('login', 'account', `${victimEmail}|198.51.100.4`);

  assert.notEqual(attackerBucket, victimBucket);
});

test('the location budget leaves real headroom over the client ping rate', () => {
  // CustomerHome.jsx throttles itself to one ping per 15s = 4/min.
  const clientPingsPerMinute = 4;
  const perMinute = LIMITS.LOCATION.limit / (LIMITS.LOCATION.windowSeconds / 60);
  assert.ok(
    perMinute >= clientPingsPerMinute * 5,
    `location limit (${perMinute}/min) leaves too little headroom over the client's ${clientPingsPerMinute}/min`
  );
});
