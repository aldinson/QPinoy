'use strict';

/**
 * Self-contained end-to-end smoke test.
 * Boots the real Express app in-process, drives it over real HTTP,
 * prints the queue state at each step, then shuts down. No external
 * process management, no orphaned servers.
 *
 * Now that every queue route is staff-gated, this walks the whole
 * realistic path: register a business owner, create a venue, register
 * a customer, scan that customer in via their QR enrollment token,
 * and only then exercise the queue engine. That makes it a genuine
 * "is the whole stack wired up" check rather than a queue-only one.
 *
 * It creates and then deletes its own accounts and venue, so it never
 * touches your seeded demo data and is safe to run repeatedly.
 */

require('dotenv').config();

const { Pool } = require('pg');
const { createApp } = require('./app');

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error(
    'DATABASE_URL is not set.\n\n' +
      'Run this the same way you run the server, e.g.\n' +
      '  DATABASE_URL=postgres://qpinoy:qpinoy@localhost:5433/qpinoy npm run smoke\n' +
      'or put it in backend/.env and use `npm run smoke`.'
  );
  process.exit(1);
}

if (!process.env.AUTH_SECRET) {
  console.error(
    'AUTH_SECRET is not set — the app signs sessions and QR codes with it.\n\n' +
      'Generate one with:\n' +
      '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"\n' +
      'then put it in backend/.env.'
  );
  process.exit(1);
}

// Unique per run, so concurrent runs (and leftovers from a crashed
// one) can never collide on the unique email index.
const RUN = Date.now().toString(36);
const OWNER_EMAIL = `smoke-owner-${RUN}@smoke.local`;
const CUSTOMER_EMAIL = `smoke-customer-${RUN}@smoke.local`;

(async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const app = createApp(pool);

  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://localhost:${server.address().port}`;

  const call = async (method, path, { body, token } = {}) => {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, body: json };
  };

  let venueId;

  const show = async (label, token) => {
    const { body } = await call('GET', `/api/venues/${venueId}/queue`, { token });
    console.log(`\n${label}`);
    (body.queue || []).forEach((r, i) =>
      console.log(
        `  ${i + 1}. ${r.customer_name.padEnd(16)} ${r.status.padEnd(8)} w=${String(r.order_weight).padEnd(6)}` +
          `${r.payment_tier === 'premium_secured' ? 'deposit' : 'free   '} ${r.is_checked_in ? 'at-venue' : 'AWAY'}` +
          `${r.is_override_locked ? ' [LOCKED]' : ''}${r.user_id ? '' : ' (walk-in)'}`
      )
    );
  };

  try {
    console.log('health:', JSON.stringify((await call('GET', '/health')).body));

    // ── Accounts ────────────────────────────────────────────────
    console.log('\n> POST /auth/register  (business owner)');
    const owner = await call('POST', '/api/auth/register', {
      body: {
        email: OWNER_EMAIL,
        password: 'smoke-password',
        fullName: 'Smoke Owner',
        phone: '0917 000 0001',
        accountType: 'business',
      },
    });
    console.log('  status:', owner.status, '| account_type:', owner.body.user.account_type);
    const ownerToken = owner.body.token;

    console.log('\n> POST /auth/register  (customer)');
    const customer = await call('POST', '/api/auth/register', {
      body: { email: CUSTOMER_EMAIL, password: 'smoke-password', fullName: 'Smoke Customer', phone: '0917 000 0002' },
    });
    console.log('  status:', customer.status);
    const customerToken = customer.body.token;

    console.log('\n> POST /venues  (creator becomes owner)');
    const venue = await call('POST', '/api/venues', {
      token: ownerToken,
      body: { name: 'Smoke Test Clinic', geofenceLat: 40.7128, geofenceLng: -74.006, geofenceRadiusMeters: 150 },
    });
    venueId = venue.body.venue.id;
    console.log('  status:', venue.status, '| role:', venue.body.venue.role);

    // ── Authorization boundary ──────────────────────────────────
    console.log('\n> GET /queue with NO token  (must be refused)');
    const anon = await call('GET', `/api/venues/${venueId}/queue`);
    console.log('  status:', anon.status, anon.status === 401 ? ' <-- correctly refused' : ' <-- SHOULD BE 401 (BAD)');

    console.log('\n> GET /queue as the CUSTOMER  (not staff here — must be refused)');
    const outsider = await call('GET', `/api/venues/${venueId}/queue`, { token: customerToken });
    console.log(
      '  status:',
      outsider.status,
      outsider.status === 404 ? ' <-- 404, not 403: venue existence is not leaked' : ' <-- SHOULD BE 404 (BAD)'
    );

    // ── The QR enrollment flow ──────────────────────────────────
    console.log('\n> GET /me/enrollment-token  (what the customer\'s phone renders as a QR)');
    const tok = await call('GET', '/api/me/enrollment-token', { token: customerToken });
    console.log('  ttl:', tok.body.expiresInSeconds, 'seconds | token length:', tok.body.enrollmentToken.length);

    console.log('\n> POST /queue/enroll  (staff "scans" that code)');
    const enrolled = await call('POST', `/api/venues/${venueId}/queue/enroll`, {
      token: ownerToken,
      body: { enrollmentToken: tok.body.enrollmentToken, paymentTier: 'premium_secured' },
    });
    console.log('  status:', enrolled.status, '| name from the signed token:', enrolled.body.entry.customer_name);

    console.log('\n> POST /queue/enroll AGAIN with the same code  (must not duplicate)');
    const dupe = await call('POST', `/api/venues/${venueId}/queue/enroll`, {
      token: ownerToken,
      body: { enrollmentToken: tok.body.enrollmentToken },
    });
    console.log('  status:', dupe.status, dupe.status === 409 ? ' <-- correctly refused' : ' <-- SHOULD BE 409 (BAD)');

    console.log('\n> POST /queue/enroll with a SESSION token instead of a QR code');
    const wrongPurpose = await call('POST', `/api/venues/${venueId}/queue/enroll`, {
      token: ownerToken,
      body: { enrollmentToken: customerToken },
    });
    console.log(
      '  status:',
      wrongPurpose.status,
      wrongPurpose.status === 400 ? ' <-- purpose mismatch rejected' : ' <-- SHOULD BE 400 (BAD)'
    );

    // Two walk-ins so the two-slot-prior trigger has someone to act on.
    for (const name of ['Walk-in One', 'Walk-in Two']) {
      await call('POST', `/api/venues/${venueId}/queue`, { token: ownerToken, body: { customerName: name } });
    }
    await show('INITIAL LINE', ownerToken);

    // ── The queue engine ────────────────────────────────────────
    const { body: q } = await call('GET', `/api/venues/${venueId}/queue`, { token: ownerToken });
    const first = q.queue[0];

    console.log(`\n> POST /serve ${first.customer_name}`);
    const served = await call('POST', `/api/venues/${venueId}/queue/${first.id}/serve`, { token: ownerToken });
    console.log('  engine result:', JSON.stringify(served.body));
    await show('AFTER CALLING THE FIRST CUSTOMER', ownerToken);

    // ── Customer-scoped location ────────────────────────────────
    const entryId = enrolled.body.entry.id;

    console.log('\n> PATCH /location as the CUSTOMER, coords INSIDE the geofence');
    const locIn = await call('PATCH', `/api/venues/${venueId}/queue/${entryId}/location`, {
      token: customerToken,
      body: { lat: 40.7128, lng: -74.006 },
    });
    console.log('  server-computed:', JSON.stringify(locIn.body));

    console.log('\n> PATCH /location with a spoofed isCheckedIn  (server decides, not the client)');
    const spoof = await call('PATCH', `/api/venues/${venueId}/queue/${entryId}/location`, {
      token: customerToken,
      body: { lat: 41.5, lng: -75.5, isCheckedIn: true },
    });
    console.log(
      '  server-computed:',
      JSON.stringify(spoof.body),
      spoof.body.is_checked_in === false ? '  <-- spoof correctly ignored' : '  <-- SPOOF SUCCEEDED (BAD)'
    );

    console.log('\n> GET /me/queue  (what the customer sees of their own place)');
    const mine = await call('GET', '/api/me/queue', { token: customerToken });
    const ticket = mine.body.entries[0];
    console.log(`  ${ticket.venue_name}: position #${ticket.people_ahead + 1} (${ticket.people_ahead} ahead)`);

    console.log('\n> POST /reinstate  (Lock-Back override)');
    const reinstate = await call('POST', `/api/venues/${venueId}/queue/${entryId}/reinstate`, { token: ownerToken });
    console.log('  engine result:', JSON.stringify(reinstate.body));
    await show('AFTER REINSTATE', ownerToken);

    console.log('\nSmoke test complete.');
  } finally {
    // Clean up after ourselves: the venue cascades to its members and
    // queue entries, then the two accounts go.
    if (venueId) await pool.query(`DELETE FROM venues WHERE id = $1`, [venueId]);
    await pool.query(`DELETE FROM users WHERE email IN ($1, $2)`, [OWNER_EMAIL, CUSTOMER_EMAIL]);
    await new Promise((r) => server.close(r));
    await pool.end();
    console.log('Cleaned up — server closed, pool drained.');
  }
})().catch((err) => {
  console.error('SMOKE TEST FAILED:', err);
  process.exit(1);
});
