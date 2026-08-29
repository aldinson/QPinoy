'use strict';

/**
 * rateLimit.integration.test.js
 * ─────────────────────────────────────────────────────────────
 * The limiter over real HTTP against a real Postgres counter.
 *
 * The unit tests cover key derivation; these cover the behaviour that
 * actually matters and that no amount of reasoning can confirm:
 * that the counter really blocks, really rolls over, really isolates
 * one user from another, and — most importantly — that it cannot be
 * turned around and used to lock a legitimate user out.
 *
 * Requires DATABASE_URL; skips itself otherwise.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

if (!process.env.DATABASE_URL) {
  test('skipped: DATABASE_URL not set', { skip: true }, () => {});
} else {
  process.env.AUTH_SECRET =
    process.env.AUTH_SECRET || 'integration-test-secret-long-enough-0123456789abcdef';

  const { Pool } = require('pg');
  const { createApp } = require('./app');
  const { LIMITS, bucketKey, peek, record, reset, purgeExpired } = require('./rateLimit');

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const SUFFIX = '@ratelimit.qpinoy.local';

  let server;
  let baseUrl;

  test.before(async () => {
    const app = createApp(pool);
    app.use((err, req, res, next) => res.status(500).json({ error: 'internal_server_error' })); // eslint-disable-line no-unused-vars
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://localhost:${server.address().port}`;
  });

  test.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await cleanup();
    await pool.end();
  });

  async function cleanup() {
    await pool.query(
      `DELETE FROM venues WHERE id IN (
         SELECT venue_id FROM venue_members WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)
       )`,
      [`%${SUFFIX}`]
    );
    await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`%${SUFFIX}`]);
    // Every bucket prefix this suite writes, including the 'test:'
    // ones used by the primitive tests. Missing one leaves counters
    // behind that make the NEXT run start above zero — the suite has
    // to be re-runnable without a manual database reset.
    await pool.query(
      `DELETE FROM rate_limits WHERE bucket LIKE 'login:%' OR bucket LIKE 'location:%' OR bucket LIKE 'test:%'`
    );
  }

  test.beforeEach(cleanup);

  async function api(method, path, { body, token, ip } = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    // Lets each test present as a distinct client, so the shared
    // per-IP budget doesn't bleed between them.
    if (ip) headers['x-nf-client-connection-ip'] = ip;
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
  }

  async function register(localPart, accountType = 'customer', ip = '203.0.113.1') {
    const { status, body } = await api('POST', '/api/auth/register', {
      ip,
      body: {
        email: `${localPart}${SUFFIX}`,
        password: 'a-good-password',
        fullName: localPart,
        phone: '0917 123 4567',
        accountType,
      },
    });
    assert.equal(status, 201, `register(${localPart}) failed: ${JSON.stringify(body)}`);
    return body;
  }

  // ── The counter primitives ───────────────────────────────────

  test('record() increments and peek() reads without incrementing', async () => {
    const bucket = bucketKey('test', 'bucket', `counter-test${SUFFIX}`);

    assert.equal((await peek(pool, bucket, 60)).hits, 0);
    assert.equal((await record(pool, bucket, 60)).hits, 1);
    assert.equal((await record(pool, bucket, 60)).hits, 2);

    assert.equal((await peek(pool, bucket, 60)).hits, 2);
    assert.equal((await peek(pool, bucket, 60)).hits, 2, 'peek must not consume budget');
  });

  test('concurrent record() calls do not lose increments', async () => {
    // The read-modify-write is a single statement precisely so that
    // parallel requests — what an attacker actually sends — cannot
    // both read N and both write N+1.
    const bucket = bucketKey('test', 'bucket', `race-test${SUFFIX}`);
    const results = await Promise.all(Array.from({ length: 25 }, () => record(pool, bucket, 60)));

    const counts = results.map((r) => r.hits).sort((a, b) => a - b);
    assert.deepEqual(counts, Array.from({ length: 25 }, (_, i) => i + 1), 'every increment must be distinct');
  });

  test('the window rolls over: an elapsed window starts counting from 1 again', async () => {
    const bucket = bucketKey('test', 'bucket', `window-test${SUFFIX}`);
    await record(pool, bucket, 60);
    await record(pool, bucket, 60);

    // Age the stored window rather than sleeping through it.
    await pool.query(`UPDATE rate_limits SET window_start = now() - interval '61 seconds' WHERE bucket = $1`, [bucket]);

    assert.equal((await peek(pool, bucket, 60)).hits, 0, 'an elapsed window should read as empty');
    assert.equal((await record(pool, bucket, 60)).hits, 1, 'the next hit starts a fresh window');
  });

  test('reset() clears a bucket', async () => {
    const bucket = bucketKey('test', 'bucket', `reset-test${SUFFIX}`);
    await record(pool, bucket, 60);
    await reset(pool, bucket);
    assert.equal((await peek(pool, bucket, 60)).hits, 0);
  });

  test('purgeExpired() removes only finished windows', async () => {
    const stale = bucketKey('test', 'bucket', `stale${SUFFIX}`);
    const fresh = bucketKey('test', 'bucket', `fresh${SUFFIX}`);
    await record(pool, stale, 60);
    await record(pool, fresh, 60);
    await pool.query(`UPDATE rate_limits SET window_start = now() - interval '2 days' WHERE bucket = $1`, [stale]);

    await purgeExpired(pool, 24 * 60 * 60);

    const { rows } = await pool.query(`SELECT bucket FROM rate_limits WHERE bucket IN ($1, $2)`, [stale, fresh]);
    assert.deepEqual(rows.map((r) => r.bucket), [fresh], 'only the stale window should be swept');
  });

  // ── Login ─────────────────────────────────────────────────────

  test('repeated failed logins are eventually refused with 429 and a Retry-After', async () => {
    await register('bruteforce');
    const email = `bruteforce${SUFFIX}`;
    const ip = '203.0.113.50';

    let blocked = null;
    for (let i = 0; i < LIMITS.LOGIN_ACCOUNT.limit + 1; i++) {
      const res = await api('POST', '/api/auth/login', { ip, body: { email, password: 'wrong-password' } });
      if (res.status === 429) {
        blocked = res;
        break;
      }
      assert.equal(res.status, 401, `attempt ${i + 1} should be a normal rejection`);
    }

    assert.ok(blocked, `should have been blocked within ${LIMITS.LOGIN_ACCOUNT.limit + 1} attempts`);
    assert.ok(Number(blocked.headers.get('retry-after')) > 0, 'a 429 must tell the client when to come back');
    assert.ok(blocked.body.retry_after_seconds > 0);
  });

  test('SECURITY: a blocked attacker cannot lock the real user out of their own account', async () => {
    // The trap this avoids, and the reason the account counter is
    // keyed on (email, IP) rather than email alone: with an
    // email-only key, ten wrong guesses from anywhere would deny the
    // real owner access from their own device — turning a
    // brute-force defence into a weapon pointed at the victim.
    //
    // Note that "only failures count and a success clears the
    // counter" does NOT save the victim on its own, because the limit
    // is checked before the password is ever verified. Including the
    // IP in the key is what actually fixes it.
    await register('victim');
    const email = `victim${SUFFIX}`;
    const ip = '203.0.113.60';

    for (let i = 0; i < LIMITS.LOGIN_ACCOUNT.limit; i++) {
      await api('POST', '/api/auth/login', { ip, body: { email, password: 'wrong-password' } });
    }
    // The attacker is now blocked...
    const attacker = await api('POST', '/api/auth/login', { ip, body: { email, password: 'wrong-password' } });
    assert.equal(attacker.status, 429);

    // ...but the real user, from their own device, signs in fine.
    const owner = await api('POST', '/api/auth/login', {
      ip: '198.51.100.77',
      body: { email, password: 'a-good-password' },
    });
    assert.equal(owner.status, 200, 'the legitimate owner must not be collateral damage');
    assert.ok(owner.body.token);
  });

  test('a successful login clears the failure counter', async () => {
    await register('clears');
    const email = `clears${SUFFIX}`;
    const ip = '203.0.113.70';

    for (let i = 0; i < LIMITS.LOGIN_ACCOUNT.limit - 1; i++) {
      await api('POST', '/api/auth/login', { ip, body: { email, password: 'wrong-password' } });
    }
    const accountBucket = bucketKey('login', 'account', `${email}|${ip}`);
    assert.ok((await peek(pool, accountBucket, LIMITS.LOGIN_ACCOUNT.windowSeconds)).hits > 0);

    const ok = await api('POST', '/api/auth/login', { ip, body: { email, password: 'a-good-password' } });
    assert.equal(ok.status, 200);
    assert.equal((await peek(pool, accountBucket, LIMITS.LOGIN_ACCOUNT.windowSeconds)).hits, 0);
  });

  test('one account being attacked does not throttle a different account', async () => {
    await register('targeted');
    await register('bystander');
    const ip = '203.0.113.80';

    for (let i = 0; i < LIMITS.LOGIN_ACCOUNT.limit + 1; i++) {
      await api('POST', '/api/auth/login', { ip, body: { email: `targeted${SUFFIX}`, password: 'wrong' } });
    }

    const bystander = await api('POST', '/api/auth/login', {
      ip: '198.51.100.90',
      body: { email: `bystander${SUFFIX}`, password: 'a-good-password' },
    });
    assert.equal(bystander.status, 200);
  });

  test('failed logins against an UNKNOWN email are counted too', async () => {
    // If only known accounts were counted, the presence or absence of
    // throttling would itself reveal which addresses are registered —
    // reintroducing the enumeration leak the generic 401 message
    // exists to close.
    const ip = '203.0.113.85';
    const unknown = `no-such-person${SUFFIX}`;

    for (let i = 0; i < LIMITS.LOGIN_ACCOUNT.limit; i++) {
      const res = await api('POST', '/api/auth/login', { ip, body: { email: unknown, password: 'wrong' } });
      assert.equal(res.status, 401);
    }
    const blocked = await api('POST', '/api/auth/login', { ip, body: { email: unknown, password: 'wrong' } });
    assert.equal(blocked.status, 429);
  });

  test('SECURITY: a successful login does NOT refill the broad per-IP spraying budget', async () => {
    // An attacker who owns one valid account would otherwise have a
    // free reset button: spray until the per-IP ceiling, log into
    // their own account, spray again, forever.
    const ip = '203.0.113.95';
    await register('sprayer', 'customer', ip);
    await register('sprayTarget', 'customer', ip);

    const ipBucket = bucketKey('login', 'ip', ip);
    for (let i = 0; i < 5; i++) {
      await api('POST', '/api/auth/login', { ip, body: { email: `sprayTarget${SUFFIX}`, password: 'wrong' } });
    }
    const before = (await peek(pool, ipBucket, LIMITS.LOGIN_IP.windowSeconds)).hits;
    assert.equal(before, 5);

    const ok = await api('POST', '/api/auth/login', { ip, body: { email: `sprayer${SUFFIX}`, password: 'a-good-password' } });
    assert.equal(ok.status, 200);

    const after = (await peek(pool, ipBucket, LIMITS.LOGIN_IP.windowSeconds)).hits;
    assert.equal(after, before, 'the per-IP counter must decay on time only, never on a successful login');
  });

  // ── Location ──────────────────────────────────────────────────

  test('location pings are throttled per user, and the 429 carries Retry-After', async () => {
    const owner = await register('locowner', 'business', '198.51.100.10');
    const customer = await register('loccustomer', 'customer', '198.51.100.11');

    const venue = await api('POST', '/api/venues', {
      token: owner.token,
      body: { name: 'RL Venue', geofenceLat: 40.0, geofenceLng: -74.0, geofenceRadiusMeters: 150 },
    });
    const { body: tok } = await api('GET', '/api/me/enrollment-token', { token: customer.token });
    const { body: enrolled } = await api('POST', `/api/venues/${venue.body.venue.id}/queue/enroll`, {
      token: owner.token,
      body: { enrollmentToken: tok.enrollmentToken },
    });

    const path = `/api/venues/${venue.body.venue.id}/queue/${enrolled.entry.id}/location`;
    let blocked = null;
    for (let i = 0; i < LIMITS.LOCATION.limit + 1; i++) {
      const res = await api('PATCH', path, { token: customer.token, body: { lat: 40.0001, lng: -74.0001 } });
      if (res.status === 429) {
        blocked = res;
        break;
      }
      assert.equal(res.status, 200, `ping ${i + 1} should succeed`);
    }

    assert.ok(blocked, `should have been throttled within ${LIMITS.LOCATION.limit + 1} pings`);
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);

    // A different user at the same venue is unaffected — the budget
    // is per-user, not per-venue or per-IP.
    const staffPing = await api('PATCH', path, { token: owner.token, body: { lat: 40.0001, lng: -74.0001 } });
    assert.equal(staffPing.status, 200, "one customer's flood must not throttle staff");
  });

  test('location responses advertise the remaining budget', async () => {
    const owner = await register('hdrowner', 'business', '198.51.100.20');
    const customer = await register('hdrcustomer', 'customer', '198.51.100.21');
    const venue = await api('POST', '/api/venues', {
      token: owner.token,
      body: { name: 'RL Headers Venue', geofenceLat: 40.0, geofenceLng: -74.0 },
    });
    const { body: tok } = await api('GET', '/api/me/enrollment-token', { token: customer.token });
    const { body: enrolled } = await api('POST', `/api/venues/${venue.body.venue.id}/queue/enroll`, {
      token: owner.token,
      body: { enrollmentToken: tok.enrollmentToken },
    });

    const res = await api('PATCH', `/api/venues/${venue.body.venue.id}/queue/${enrolled.entry.id}/location`, {
      token: customer.token,
      body: { lat: 40.0001, lng: -74.0001 },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('ratelimit-limit'), String(LIMITS.LOCATION.limit));
    assert.equal(res.headers.get('ratelimit-remaining'), String(LIMITS.LOCATION.limit - 1));
  });

  test('an unauthenticated location call is rejected before any counter is touched', async () => {
    // 401 comes from requireAuth, which runs first — so anonymous
    // traffic can't fill up buckets on a user's behalf.
    const { status } = await api('PATCH', `/api/venues/${'0'.repeat(8)}-0000-0000-0000-000000000000/queue/${'0'.repeat(8)}-0000-0000-0000-000000000000/location`, {
      body: { lat: 1, lng: 1 },
    });
    assert.equal(status, 401);
  });
}
