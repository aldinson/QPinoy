'use strict';

/**
 * auth.integration.test.js
 * ─────────────────────────────────────────────────────────────
 * The full account model over real HTTP against a real database:
 * registration, login, venue creation, staff delegation, and the
 * QR-scan enrollment flow — plus the authorization boundaries that
 * are the entire point of adding accounts in the first place.
 *
 * Requires DATABASE_URL (schema.sql already applied); skips itself
 * otherwise, exactly like the other integration suites.
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
  const { createEnrollmentToken } = require('./tokens');

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  // Every account this suite creates uses this email suffix, so
  // cleanup can remove exactly its own rows and nothing else.
  const SUFFIX = '@authtest.qpinoy.local';

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
    // Venues created by test users cascade to their members and
    // queue entries; the users themselves go last.
    await pool.query(
      `DELETE FROM venues WHERE id IN (
         SELECT venue_id FROM venue_members WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)
       )`,
      [`%${SUFFIX}`]
    );
    await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`%${SUFFIX}`]);
  }

  test.beforeEach(cleanup);

  async function api(method, path, { body, token } = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  /** Register a fresh account and return { token, user }. */
  async function register(localPart, accountType = 'customer') {
    const { status, body } = await api('POST', '/api/auth/register', {
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

  async function createVenue(token, name = 'Test Venue') {
    const { status, body } = await api('POST', '/api/venues', {
      token,
      body: { name, geofenceLat: 40.0, geofenceLng: -74.0, geofenceRadiusMeters: 150 },
    });
    assert.equal(status, 201, `createVenue failed: ${JSON.stringify(body)}`);
    return body.venue;
  }

  // ── Registration & login ──────────────────────────────────────

  test('registration returns a session token and never leaks the password hash', async () => {
    const { status, body } = await api('POST', '/api/auth/register', {
      body: { email: `newbie${SUFFIX}`, password: 'a-good-password', fullName: 'New Bie', phone: '0917 123 4567' },
    });
    assert.equal(status, 201);
    assert.ok(body.token);
    assert.equal(body.user.email, `newbie${SUFFIX}`);
    assert.equal(body.user.account_type, 'customer');
    assert.equal(body.user.password_hash, undefined);
    assert.ok(!JSON.stringify(body).includes('scrypt'), 'response must not contain the stored hash');
  });

  test('email is normalised to lowercase, so casing cannot create a second account', async () => {
    await api('POST', '/api/auth/register', {
      body: { email: `MixedCase${SUFFIX}`, password: 'a-good-password', fullName: 'Mixed', phone: '0917 123 4567' },
    });
    const dupe = await api('POST', '/api/auth/register', {
      body: { email: `mixedcase${SUFFIX}`, password: 'a-good-password', fullName: 'Mixed Again', phone: '0917 123 4567' },
    });
    assert.equal(dupe.status, 409);

    // ...and login works regardless of how the address is typed.
    const login = await api('POST', '/api/auth/login', {
      body: { email: `MIXEDCASE${SUFFIX}`, password: 'a-good-password' },
    });
    assert.equal(login.status, 200);
  });

  test('registration requires a mobile number', async () => {
    // Email and mobile are the two channels a venue has for reaching
    // someone whose turn is coming up, so both are mandatory.
    for (const phone of [undefined, null, '', '   ']) {
      const { status, body } = await api('POST', '/api/auth/register', {
        body: { email: `nophone-${String(phone)}${SUFFIX}`, password: 'a-good-password', fullName: 'No Phone', phone },
      });
      assert.equal(status, 400, `phone ${JSON.stringify(phone)} should be rejected`);
      assert.match(body.error, /mobile number/i);
    }
  });

  test('registration rejects a malformed mobile number with an actionable message', async () => {
    const { status, body } = await api('POST', '/api/auth/register', {
      body: { email: `badphone${SUFFIX}`, password: 'a-good-password', fullName: 'Bad Phone', phone: '12345' },
    });
    assert.equal(status, 400);
    assert.match(body.error, /0917/, 'the error should show a real example, not just say "invalid"');
  });

  test('the mobile number is stored normalised, however it was typed', async () => {
    // Three spellings of one number must produce one stored value, or
    // an SMS gateway cannot use the column and de-duplication is
    // impossible later.
    const written = ['0917 123 4567', '+63 917 123 4567', '9171234567'];
    for (let i = 0; i < written.length; i++) {
      const { status, body } = await api('POST', '/api/auth/register', {
        body: {
          email: `norm${i}${SUFFIX}`,
          password: 'a-good-password',
          fullName: `Norm ${i}`,
          phone: written[i],
        },
      });
      assert.equal(status, 201);
      assert.equal(body.user.phone, '+639171234567', `"${written[i]}" should normalise to E.164`);
    }
  });

  test('registration rejects a weak password and a malformed email', async () => {
    const weak = await api('POST', '/api/auth/register', {
      body: { email: `weak${SUFFIX}`, password: 'short', fullName: 'Weak', phone: '0917 123 4567' },
    });
    assert.equal(weak.status, 400);

    const bad = await api('POST', '/api/auth/register', {
      body: { email: 'not-an-email', password: 'a-good-password', fullName: 'Bad', phone: '0917 123 4567' },
    });
    assert.equal(bad.status, 400);
  });

  test('login with a wrong password and login as an unknown user give the SAME message', async () => {
    // Distinct replies would turn this endpoint into a way to
    // enumerate which email addresses have accounts.
    await register('enum');
    const wrongPassword = await api('POST', '/api/auth/login', {
      body: { email: `enum${SUFFIX}`, password: 'not-the-password' },
    });
    const unknownUser = await api('POST', '/api/auth/login', {
      body: { email: `ghost${SUFFIX}`, password: 'not-the-password' },
    });

    assert.equal(wrongPassword.status, 401);
    assert.equal(unknownUser.status, 401);
    assert.deepEqual(wrongPassword.body, unknownUser.body);
  });

  test('GET /auth/me requires a token and returns the user with their memberships', async () => {
    const anonymous = await api('GET', '/api/auth/me');
    assert.equal(anonymous.status, 401);

    const owner = await register('meowner', 'business');
    const venue = await createVenue(owner.token, 'Me Venue');

    const { status, body } = await api('GET', '/api/auth/me', { token: owner.token });
    assert.equal(status, 200);
    assert.equal(body.user.id, owner.user.id);
    assert.equal(body.memberships.length, 1);
    assert.equal(body.memberships[0].venue_id, venue.id);
    assert.equal(body.memberships[0].role, 'owner');
  });

  test('a garbage or expired Bearer token is treated as signed-out, not a 500', async () => {
    const { status } = await api('GET', '/api/auth/me', { token: 'obviously.not.valid' });
    assert.equal(status, 401);
  });

  // ── Venue creation & staff delegation ─────────────────────────

  test('creating a venue makes the creator its owner', async () => {
    const owner = await register('vowner', 'business');
    const venue = await createVenue(owner.token);
    assert.equal(venue.role, 'owner');

    const { body } = await api('GET', '/api/venues/mine', { token: owner.token });
    assert.equal(body.venues.length, 1);
    assert.equal(body.venues[0].role, 'owner');
  });

  test('an owner can authorize an existing user as staff, by email', async () => {
    const owner = await register('sowner', 'business');
    const staff = await register('sstaff');
    const venue = await createVenue(owner.token);

    const { status, body } = await api('POST', `/api/venues/${venue.id}/members`, {
      token: owner.token,
      body: { email: `sstaff${SUFFIX}`, role: 'attendant' },
    });
    assert.equal(status, 201);
    assert.equal(body.member.user_id, staff.user.id);
    assert.equal(body.member.role, 'attendant');

    // The newly authorized user can now see the venue as theirs.
    const mine = await api('GET', '/api/venues/mine', { token: staff.token });
    assert.equal(mine.body.venues.length, 1);
    assert.equal(mine.body.venues[0].role, 'attendant');
  });

  test('adding staff by an email that has never registered is refused', async () => {
    // Deliberate: an owner must not be able to conjure an account for
    // someone who never signed up (and a typo would create a ghost).
    const owner = await register('gowner', 'business');
    const venue = await createVenue(owner.token);

    const { status } = await api('POST', `/api/venues/${venue.id}/members`, {
      token: owner.token,
      body: { email: `never-signed-up${SUFFIX}`, role: 'attendant' },
    });
    assert.equal(status, 404);
  });

  test('a manager can add further staff; an attendant cannot', async () => {
    // This is the "admin can authorize users to manage other users"
    // requirement: manager is that delegated role.
    const owner = await register('downer', 'business');
    const manager = await register('dmanager');
    const attendant = await register('dattendant');
    await register('dtarget');
    const venue = await createVenue(owner.token);

    await api('POST', `/api/venues/${venue.id}/members`, {
      token: owner.token,
      body: { email: `dmanager${SUFFIX}`, role: 'manager' },
    });
    await api('POST', `/api/venues/${venue.id}/members`, {
      token: owner.token,
      body: { email: `dattendant${SUFFIX}`, role: 'attendant' },
    });

    const byManager = await api('POST', `/api/venues/${venue.id}/members`, {
      token: manager.token,
      body: { email: `dtarget${SUFFIX}`, role: 'attendant' },
    });
    assert.equal(byManager.status, 201, 'a manager should be able to add staff');

    const byAttendant = await api('POST', `/api/venues/${venue.id}/members`, {
      token: attendant.token,
      body: { email: `dtarget${SUFFIX}`, role: 'attendant' },
    });
    assert.equal(byAttendant.status, 403, 'an attendant must NOT be able to change the staff list');
  });

  test('the owner cannot be demoted or removed via the staff endpoints', async () => {
    const owner = await register('powner', 'business');
    const manager = await register('pmanager');
    const venue = await createVenue(owner.token);
    await api('POST', `/api/venues/${venue.id}/members`, {
      token: owner.token,
      body: { email: `pmanager${SUFFIX}`, role: 'manager' },
    });

    const demote = await api('POST', `/api/venues/${venue.id}/members`, {
      token: manager.token,
      body: { email: `powner${SUFFIX}`, role: 'attendant' },
    });
    assert.equal(demote.status, 409);

    const remove = await api('DELETE', `/api/venues/${venue.id}/members/${owner.user.id}`, { token: manager.token });
    assert.equal(remove.status, 404);

    // Owner still owns it.
    const mine = await api('GET', '/api/venues/mine', { token: owner.token });
    assert.equal(mine.body.venues[0].role, 'owner');
  });

  test('removing a staff member revokes their access immediately', async () => {
    const owner = await register('rowner', 'business');
    const staff = await register('rstaff');
    const venue = await createVenue(owner.token);
    await api('POST', `/api/venues/${venue.id}/members`, {
      token: owner.token,
      body: { email: `rstaff${SUFFIX}`, role: 'attendant' },
    });

    assert.equal((await api('GET', `/api/venues/${venue.id}/queue`, { token: staff.token })).status, 200);
    await api('DELETE', `/api/venues/${venue.id}/members/${staff.user.id}`, { token: owner.token });
    assert.equal((await api('GET', `/api/venues/${venue.id}/queue`, { token: staff.token })).status, 404);
  });

  // ── Authorization boundaries on the queue ─────────────────────

  test('SECURITY: queue endpoints reject anonymous callers', async () => {
    const owner = await register('aowner', 'business');
    const venue = await createVenue(owner.token);

    for (const [method, path] of [
      ['GET', `/api/venues/${venue.id}/queue`],
      ['POST', `/api/venues/${venue.id}/queue`],
      ['PATCH', `/api/venues/${venue.id}/automation`],
      ['POST', `/api/venues/${venue.id}/rebalance`],
    ]) {
      const { status } = await api(method, path, { body: method === 'GET' ? undefined : {} });
      assert.equal(status, 401, `${method} ${path} should require authentication`);
    }
  });

  test('SECURITY: a signed-in stranger cannot read or mutate a venue they do not staff', async () => {
    const owner = await register('xowner', 'business');
    const stranger = await register('xstranger');
    const venue = await createVenue(owner.token);

    // 404, not 403: confirming the venue exists would let anyone
    // enumerate every venue ID in the system.
    const read = await api('GET', `/api/venues/${venue.id}/queue`, { token: stranger.token });
    assert.equal(read.status, 404);

    const write = await api('POST', `/api/venues/${venue.id}/queue`, {
      token: stranger.token,
      body: { customerName: 'Intruder' },
    });
    assert.equal(write.status, 404);
  });

  // ── The QR enrollment flow ────────────────────────────────────

  test('staff enroll a customer by scanning their QR token', async () => {
    const owner = await register('qowner', 'business');
    const customer = await register('qcustomer');
    const venue = await createVenue(owner.token);

    // What the customer's phone would be displaying as a QR code.
    const { body: tokenBody } = await api('GET', '/api/me/enrollment-token', { token: customer.token });
    assert.ok(tokenBody.enrollmentToken);
    assert.equal(typeof tokenBody.expiresInSeconds, 'number');

    const { status, body } = await api('POST', `/api/venues/${venue.id}/queue/enroll`, {
      token: owner.token,
      body: { enrollmentToken: tokenBody.enrollmentToken, paymentTier: 'premium_secured' },
    });
    assert.equal(status, 201);
    // Identity comes from the signed token, so the name on the ticket
    // is the customer's real registered name.
    assert.equal(body.entry.customer_name, 'qcustomer');
    assert.equal(body.entry.user_id, customer.user.id);
    assert.equal(body.entry.payment_tier, 'premium_secured');

    // And the customer can now see their own place in line.
    const mine = await api('GET', '/api/me/queue', { token: customer.token });
    assert.equal(mine.body.entries.length, 1);
    assert.equal(mine.body.entries[0].venue_id, venue.id);
    assert.equal(mine.body.entries[0].people_ahead, 0);
  });

  test('enrolling the same customer twice is refused, not silently duplicated', async () => {
    const owner = await register('dupowner', 'business');
    const customer = await register('dupcustomer');
    const venue = await createVenue(owner.token);
    const { body: t } = await api('GET', '/api/me/enrollment-token', { token: customer.token });

    const first = await api('POST', `/api/venues/${venue.id}/queue/enroll`, {
      token: owner.token,
      body: { enrollmentToken: t.enrollmentToken },
    });
    assert.equal(first.status, 201);

    const second = await api('POST', `/api/venues/${venue.id}/queue/enroll`, {
      token: owner.token,
      body: { enrollmentToken: t.enrollmentToken },
    });
    assert.equal(second.status, 409, 'a second scan must not create a second place in line');
  });

  test('an expired QR code is refused with an explanation staff can act on', async () => {
    const owner = await register('exowner', 'business');
    const customer = await register('excustomer');
    const venue = await createVenue(owner.token);

    const { createToken, PURPOSE_ENROLLMENT } = require('./tokens');
    const stale = createToken({ sub: customer.user.id }, PURPOSE_ENROLLMENT, -1);

    const { status, body } = await api('POST', `/api/venues/${venue.id}/queue/enroll`, {
      token: owner.token,
      body: { enrollmentToken: stale },
    });
    assert.equal(status, 400);
    assert.equal(body.reason, 'expired');
    assert.match(body.error, /expired/i);
  });

  test('SECURITY: a session token cannot be scanned as an enrollment QR code', async () => {
    // Someone photographing a phone showing the app should not be
    // able to feed a copied session token into the scanner.
    const owner = await register('swowner', 'business');
    const customer = await register('swcustomer');
    const venue = await createVenue(owner.token);

    const { status } = await api('POST', `/api/venues/${venue.id}/queue/enroll`, {
      token: owner.token,
      body: { enrollmentToken: customer.token },
    });
    assert.equal(status, 400);
  });

  test('SECURITY: enrollment ignores any user id in the body — identity comes from the signature', async () => {
    const owner = await register('fkowner', 'business');
    const victim = await register('fkvictim');
    const attacker = await register('fkattacker');
    const venue = await createVenue(owner.token);

    // A staff member tries to enroll the victim by naming them
    // directly, with the attacker's own (valid) QR token.
    const attackerToken = createEnrollmentToken(attacker.user.id);
    const { status, body } = await api('POST', `/api/venues/${venue.id}/queue/enroll`, {
      token: owner.token,
      body: { enrollmentToken: attackerToken, userId: victim.user.id, customerName: 'Victim' },
    });
    assert.equal(status, 201);
    assert.equal(body.entry.user_id, attacker.user.id, 'the body must not be able to override the signed subject');
    assert.equal(body.entry.customer_name, 'fkattacker');
  });

  // ── Customer-scoped location updates ──────────────────────────

  test('a customer can update the location on their OWN ticket', async () => {
    const owner = await register('locowner', 'business');
    const customer = await register('loccustomer');
    const venue = await createVenue(owner.token);
    const { body: t } = await api('GET', '/api/me/enrollment-token', { token: customer.token });
    const { body: enrolled } = await api('POST', `/api/venues/${venue.id}/queue/enroll`, {
      token: owner.token,
      body: { enrollmentToken: t.enrollmentToken },
    });

    const { status, body } = await api('PATCH', `/api/venues/${venue.id}/queue/${enrolled.entry.id}/location`, {
      token: customer.token,
      body: { lat: 40.0001, lng: -74.0001 },
    });
    assert.equal(status, 200);
    assert.equal(body.is_checked_in, true);
  });

  test('SECURITY: a customer cannot push location into someone ELSE\'s ticket', async () => {
    // This is the hole DEPLOYMENT.md flagged as unbuilt: without a
    // customer-scoped check, any signed-in user could feed
    // coordinates into a stranger's row and shove them down the line.
    const owner = await register('vicowner', 'business');
    const victim = await register('vicvictim');
    const attacker = await register('vicattacker');
    const venue = await createVenue(owner.token);

    const { body: t } = await api('GET', '/api/me/enrollment-token', { token: victim.token });
    const { body: enrolled } = await api('POST', `/api/venues/${venue.id}/queue/enroll`, {
      token: owner.token,
      body: { enrollmentToken: t.enrollmentToken },
    });

    const { status } = await api('PATCH', `/api/venues/${venue.id}/queue/${enrolled.entry.id}/location`, {
      token: attacker.token,
      body: { lat: 1.0, lng: 1.0 },
    });
    assert.equal(status, 403);

    // The victim's row is untouched.
    const { rows } = await pool.query(`SELECT last_lat FROM queue_entries WHERE id = $1`, [enrolled.entry.id]);
    assert.equal(rows[0].last_lat, null);
  });

  test('staff CAN correct the location on any ticket at their own venue', async () => {
    const owner = await register('stlocowner', 'business');
    const venue = await createVenue(owner.token);
    const { body: walkIn } = await api('POST', `/api/venues/${venue.id}/queue`, {
      token: owner.token,
      body: { customerName: 'Walk In' },
    });

    const { status } = await api('PATCH', `/api/venues/${venue.id}/queue/${walkIn.entry.id}/location`, {
      token: owner.token,
      body: { lat: 40.0001, lng: -74.0001 },
    });
    assert.equal(status, 200);
  });

  test('a malformed venue id is a 400, not a database error surfacing as a 500', async () => {
    const user = await register('uuiduser');
    const { status } = await api('GET', '/api/venues/not-a-uuid/queue', { token: user.token });
    assert.equal(status, 400);
  });
}
