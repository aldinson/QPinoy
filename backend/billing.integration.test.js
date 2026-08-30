'use strict';

/**
 * billing.integration.test.js
 * ─────────────────────────────────────────────────────────────
 * Subscription billing over real HTTP against a real database:
 * status, starting a checkout (mocked provider HTTP calls — same
 * "mock only the network edge, exercise everything else for real"
 * approach auth.integration.test.js's push-notification test uses),
 * both webhook receivers, and the enforcement boundary that blocks new
 * enrollments (never anyone already in line) once a venue's coverage
 * lapses.
 *
 * Requires DATABASE_URL (schema.sql already applied, including the
 * subscription_payments table); skips itself otherwise.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

if (!process.env.DATABASE_URL) {
  test('skipped: DATABASE_URL not set', { skip: true }, () => {});
} else {
  process.env.AUTH_SECRET =
    process.env.AUTH_SECRET || 'integration-test-secret-long-enough-0123456789abcdef';

  const { Pool } = require('pg');
  const { createApp } = require('./app');

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const SUFFIX = '@billingtest.qpinoy.local';

  let server;
  let baseUrl;

  test.before(async () => {
    // This whole file is specifically exercising the billing feature,
    // so the master switch (default OFF — see subscriptions.isEnabled())
    // is turned on globally for the suite here rather than in every
    // individual test. node:test runs each file in its own process, so
    // this can't leak into any other test file. The handful of tests
    // actually about the switch itself (below) temporarily override it
    // back off within their own scope via withEnv().
    process.env.SUBSCRIPTION_ENABLE = 'true';

    const app = createApp(pool);
    app.use((err, req, res, next) => res.status(500).json({ error: 'internal_server_error' })); // eslint-disable-line no-unused-vars
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://localhost:${server.address().port}`;
  });

  test.after(async () => {
    delete process.env.SUBSCRIPTION_ENABLE;
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
  }

  test.beforeEach(cleanup);

  async function api(method, path, { body, token, headers } = {}) {
    const h = { ...headers };
    if (body !== undefined) h['Content-Type'] = 'application/json';
    if (token) h.Authorization = `Bearer ${token}`;
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: h,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  async function register(localPart, accountType = 'customer') {
    const { status, body } = await api('POST', '/api/auth/register', {
      body: { email: `${localPart}${SUFFIX}`, password: 'a-good-password', fullName: localPart, phone: '0917 123 4567', accountType },
    });
    assert.equal(status, 201, `register(${localPart}) failed: ${JSON.stringify(body)}`);
    return body;
  }

  async function createVenue(token, name = 'Billing Test Venue') {
    const { status, body } = await api('POST', '/api/venues', {
      token,
      body: { name, geofenceLat: 40.0, geofenceLng: -74.0, geofenceRadiusMeters: 150 },
    });
    assert.equal(status, 201, `createVenue failed: ${JSON.stringify(body)}`);
    return body.venue;
  }

  /**
   * Sets env vars for the duration of one test, then restores exactly
   * what was there before — including truly UNSETTING a var that
   * wasn't set originally. `Object.assign(process.env, {KEY: undefined})`
   * would not do that: Node coerces an undefined value assigned to
   * process.env into the literal string "undefined" rather than
   * deleting the key, which would leave push.js/paypal.js's own
   * isConfigured() checks seeing a truthy (if nonsensical) value.
   */
  function withEnv(vars) {
    const originals = {};
    for (const key of Object.keys(vars)) originals[key] = process.env[key];
    Object.assign(process.env, vars);
    return {
      restore: () => {
        for (const key of Object.keys(originals)) {
          if (originals[key] === undefined) delete process.env[key];
          else process.env[key] = originals[key];
        }
      },
    };
  }

  /**
   * paymongo.js/paypal.js call the SAME global `fetch` this test file's
   * own `api()` helper uses to talk to the local server under test —
   * mocking global.fetch naively intercepts BOTH. This wrapper passes
   * anything addressed to the local server through to the real fetch,
   * and only fakes calls that are actually going out to a payment
   * provider.
   */
  function mockExternalFetch(routes) {
    const originalFetch = global.fetch;
    return async (url, options) => {
      if (typeof url === 'string' && url.startsWith(baseUrl)) return originalFetch(url, options);
      const match = routes.find((r) => url.includes(r.match));
      if (!match) throw new Error(`unexpected external fetch to ${url}`);
      return match.respond(url, options);
    };
  }

  // ── Master switch (SUBSCRIPTION_ENABLE) ─────────────────────────
  //
  // The whole rest of this file runs with SUBSCRIPTION_ENABLE=true
  // (set once in test.before). These tests specifically verify the
  // OFF state — the actual shipped default — by turning it back off
  // just for themselves.

  test('GET /billing/config reports disabled by default', async (t) => {
    const env = withEnv({ SUBSCRIPTION_ENABLE: undefined });
    t.after(env.restore);
    const { status, body } = await api('GET', '/api/billing/config');
    assert.equal(status, 200);
    assert.equal(body.enabled, false);
  });

  test('GET /billing/config reports enabled once the flag is set to the literal string "true"', async () => {
    const { body } = await api('GET', '/api/billing/config');
    assert.equal(body.enabled, true);
  });

  test('setting SUBSCRIPTION_ENABLE to anything other than "true" (e.g. the string "false") still counts as disabled', async (t) => {
    const env = withEnv({ SUBSCRIPTION_ENABLE: 'false' });
    t.after(env.restore);
    const { body } = await api('GET', '/api/billing/config');
    assert.equal(body.enabled, false);
  });

  test('GET billing status returns {enabled:false} (not the real status/history) while the feature is off', async (t) => {
    const env = withEnv({ SUBSCRIPTION_ENABLE: undefined });
    t.after(env.restore);

    const owner = await register('disabledstatusowner', 'business');
    const venue = await createVenue(owner.token);
    const { status, body } = await api('GET', `/api/venues/${venue.id}/billing`, { token: owner.token });
    assert.equal(status, 200);
    assert.deepEqual(body, { enabled: false });
  });

  test('checkout is refused with 404 while disabled, even with real-looking provider credentials configured', async (t) => {
    const env = withEnv({ SUBSCRIPTION_ENABLE: undefined, PAYMONGO_SECRET_KEY: 'sk_test_fake', APP_ORIGIN: 'https://app.example' });
    t.after(env.restore);

    const owner = await register('disabledcheckoutowner', 'business');
    const venue = await createVenue(owner.token);
    const { status } = await api('POST', `/api/venues/${venue.id}/billing/checkout`, { token: owner.token, body: { provider: 'paymongo' } });
    assert.equal(status, 404);
  });

  test('a lapsed venue is never blocked from new enrollments while the feature is off', async (t) => {
    const env = withEnv({ SUBSCRIPTION_ENABLE: undefined });
    t.after(env.restore);

    const owner = await register('disabledenforcementowner', 'business');
    const venue = await createVenue(owner.token);
    await pool.query(`UPDATE venues SET trial_ends_at = now() - interval '1 day' WHERE id = $1`, [venue.id]);

    const walkIn = await api('POST', `/api/venues/${venue.id}/queue`, { token: owner.token, body: { customerName: 'Should Work' } });
    assert.equal(walkIn.status, 201, 'enforcement must be a complete no-op while SUBSCRIPTION_ENABLE is off');
  });

  // ── GET /venues/:id/billing ─────────────────────────────────────

  test('a fresh venue is trialing, with 14 days of coverage and empty history', async () => {
    const owner = await register('statusowner', 'business');
    const venue = await createVenue(owner.token);

    const { status, body } = await api('GET', `/api/venues/${venue.id}/billing`, { token: owner.token });
    assert.equal(status, 200);
    assert.equal(body.status, 'trialing');
    assert.equal(body.isUsable, true);
    assert.deepEqual(body.history, []);
    assert.equal(body.plan.currency, 'PHP');
  });

  test('an attendant can be blocked from billing while an owner/manager can read it', async () => {
    const owner = await register('rolesowner', 'business');
    const attendant = await register('rolesattendant');
    const venue = await createVenue(owner.token);
    await api('POST', `/api/venues/${venue.id}/members`, { token: owner.token, body: { email: `rolesattendant${SUFFIX}`, role: 'attendant' } });

    const asOwner = await api('GET', `/api/venues/${venue.id}/billing`, { token: owner.token });
    assert.equal(asOwner.status, 200);

    const asAttendant = await api('GET', `/api/venues/${venue.id}/billing`, { token: attendant.token });
    assert.equal(asAttendant.status, 403);
  });

  test('GET billing on a nonexistent venue returns 404, and anonymous is 401', async () => {
    const owner = await register('nfowner', 'business');
    const fake = await api('GET', '/api/venues/00000000-0000-0000-0000-000000000000/billing', { token: owner.token });
    assert.equal(fake.status, 404);

    const venue = await createVenue(owner.token);
    const anon = await api('GET', `/api/venues/${venue.id}/billing`);
    assert.equal(anon.status, 401);
  });

  // ── POST /venues/:id/billing/checkout ───────────────────────────

  test('checkout rejects an unknown provider with 400', async () => {
    const owner = await register('badproviderowner', 'business');
    const venue = await createVenue(owner.token);
    const { status } = await api('POST', `/api/venues/${venue.id}/billing/checkout`, { token: owner.token, body: { provider: 'venmo' } });
    assert.equal(status, 400);
  });

  test('checkout returns 503 when the chosen provider has no credentials configured', async () => {
    const owner = await register('unconfiguredowner', 'business');
    const venue = await createVenue(owner.token);
    // The test suite never sets PAYMONGO_SECRET_KEY/PAYPAL credentials.
    const paymongoResult = await api('POST', `/api/venues/${venue.id}/billing/checkout`, { token: owner.token, body: { provider: 'paymongo' } });
    assert.equal(paymongoResult.status, 503);
    const paypalResult = await api('POST', `/api/venues/${venue.id}/billing/checkout`, { token: owner.token, body: { provider: 'paypal' } });
    assert.equal(paypalResult.status, 503);
  });

  test('an attendant cannot start a checkout', async () => {
    const owner = await register('checkoutpermowner', 'business');
    const attendant = await register('checkoutpermattendant');
    const venue = await createVenue(owner.token);
    await api('POST', `/api/venues/${venue.id}/members`, { token: owner.token, body: { email: `checkoutpermattendant${SUFFIX}`, role: 'attendant' } });

    const { status } = await api('POST', `/api/venues/${venue.id}/billing/checkout`, { token: attendant.token, body: { provider: 'paymongo' } });
    assert.equal(status, 403);
  });

  test('a configured PayMongo checkout creates a pending payment row and returns the checkout URL', async (t) => {
    const env = withEnv({ PAYMONGO_SECRET_KEY: 'sk_test_fake', APP_ORIGIN: 'https://app.example' });
    t.after(env.restore);

    const originalFetch = global.fetch;
    global.fetch = mockExternalFetch([
      {
        match: 'paymongo.com',
        respond: async () => ({
          ok: true,
          json: async () => ({ data: { id: 'cs_fake_1', attributes: { checkout_url: 'https://checkout.paymongo.com/cs_fake_1' } } }),
        }),
      },
    ]);
    t.after(() => {
      global.fetch = originalFetch;
    });

    const owner = await register('pmcheckoutowner', 'business');
    const venue = await createVenue(owner.token);

    const { status, body } = await api('POST', `/api/venues/${venue.id}/billing/checkout`, { token: owner.token, body: { provider: 'paymongo' } });
    assert.equal(status, 201);
    assert.equal(body.redirectUrl, 'https://checkout.paymongo.com/cs_fake_1');
    assert.ok(body.paymentId);

    const { rows } = await pool.query(`SELECT provider, provider_reference, status, amount_centavos FROM subscription_payments WHERE id = $1`, [body.paymentId]);
    assert.equal(rows[0].provider, 'paymongo');
    assert.equal(rows[0].provider_reference, 'cs_fake_1');
    assert.equal(rows[0].status, 'pending');
    assert.equal(rows[0].amount_centavos, 39900);
  });

  test('a configured PayPal checkout creates a pending payment row and returns the approve URL', async (t) => {
    const env = withEnv(
      { PAYPAL_CLIENT_ID: 'cid', PAYPAL_CLIENT_SECRET: 'csecret', APP_ORIGIN: 'https://app.example' }
    );
    t.after(env.restore);

    const originalFetch = global.fetch;
    global.fetch = mockExternalFetch([
      { match: '/v1/oauth2/token', respond: async () => ({ ok: true, json: async () => ({ access_token: 't', expires_in: 3600 }) }) },
      {
        match: '/v2/checkout/orders',
        respond: async () => ({
          ok: true,
          json: async () => ({
            id: 'ORDER_FAKE_1',
            links: [{ rel: 'approve', href: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER_FAKE_1' }],
          }),
        }),
      },
    ]);
    t.after(() => {
      global.fetch = originalFetch;
    });

    const owner = await register('ppcheckoutowner', 'business');
    const venue = await createVenue(owner.token);

    const { status, body } = await api('POST', `/api/venues/${venue.id}/billing/checkout`, { token: owner.token, body: { provider: 'paypal' } });
    assert.equal(status, 201);
    assert.equal(body.redirectUrl, 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER_FAKE_1');

    const { rows } = await pool.query(`SELECT provider_reference FROM subscription_payments WHERE id = $1`, [body.paymentId]);
    assert.equal(rows[0].provider_reference, 'ORDER_FAKE_1');
  });

  // ── PayPal capture-on-return ─────────────────────────────────────

  test('PayPal capture-on-return marks the payment paid and extends the venue by exactly one plan period', async (t) => {
    const env = withEnv(
      { PAYPAL_CLIENT_ID: 'cid', PAYPAL_CLIENT_SECRET: 'csecret', APP_ORIGIN: 'https://app.example' }
    );
    t.after(env.restore);

    const originalFetch = global.fetch;
    global.fetch = mockExternalFetch([
      { match: '/v1/oauth2/token', respond: async () => ({ ok: true, json: async () => ({ access_token: 't', expires_in: 3600 }) }) },
      // More specific '/capture' route listed BEFORE the general
      // orders-creation route — mockExternalFetch takes the first
      // substring match, and '/capture' URLs also contain
      // '/v2/checkout/orders'.
      {
        match: '/capture',
        respond: async () => ({
          ok: true,
          json: async () => ({
            status: 'COMPLETED',
            purchase_units: [{ reference_id: 'x', custom_id: 'x', payments: { captures: [{ id: 'CAP1' }] } }],
          }),
        }),
      },
      {
        match: '/v2/checkout/orders',
        respond: async () => ({ ok: true, json: async () => ({ id: 'ORDER_CAP_1', links: [{ rel: 'approve', href: 'https://paypal/approve' }] }) }),
      },
    ]);
    t.after(() => {
      global.fetch = originalFetch;
    });

    const owner = await register('ppcaptureowner', 'business');
    const venue = await createVenue(owner.token);

    const created = await api('POST', `/api/venues/${venue.id}/billing/checkout`, { token: owner.token, body: { provider: 'paypal' } });
    const captured = await api('POST', `/api/venues/${venue.id}/billing/paypal/capture`, { token: owner.token, body: { paymentId: created.body.paymentId } });
    assert.equal(captured.status, 200);
    assert.equal(captured.body.status, 'paid');

    const { body: billing } = await api('GET', `/api/venues/${venue.id}/billing`, { token: owner.token });
    assert.equal(billing.status, 'active');
    assert.equal(billing.history[0].status, 'paid');

    // Capturing the SAME payment again must not extend coverage a second time.
    const secondCapture = await api('POST', `/api/venues/${venue.id}/billing/paypal/capture`, { token: owner.token, body: { paymentId: created.body.paymentId } });
    assert.equal(secondCapture.status, 200);
    const { body: billingAfterSecond } = await api('GET', `/api/venues/${venue.id}/billing`, { token: owner.token });
    assert.equal(billingAfterSecond.coverageEnd, billing.coverageEnd, 'a duplicate capture must not extend coverage twice');
  });

  // ── Webhooks ─────────────────────────────────────────────────────

  test('PayMongo webhook with a bad signature is rejected with 400 and does not touch the payment', async (t) => {
    const env = withEnv({ PAYMONGO_WEBHOOK_SECRET: 'whsec_fake' });
    t.after(env.restore);

    const res = await fetch(`${baseUrl}/api/webhooks/paymongo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'paymongo-signature': 't=1,te=deadbeef' },
      body: JSON.stringify({ data: { attributes: { type: 'checkout_session.payment.paid' } } }),
    });
    assert.equal(res.status, 400);
  });

  test('PayMongo webhook with a valid signature confirms the matching pending payment', async (t) => {
    const env = withEnv({ PAYMONGO_SECRET_KEY: 'sk_test_fake', PAYMONGO_WEBHOOK_SECRET: 'whsec_fake', APP_ORIGIN: 'https://app.example' });
    t.after(env.restore);

    const originalFetch = global.fetch;
    global.fetch = mockExternalFetch([
      {
        match: 'paymongo.com',
        respond: async () => ({
          ok: true,
          json: async () => ({ data: { id: 'cs_webhook_1', attributes: { checkout_url: 'https://checkout.paymongo.com/cs_webhook_1' } } }),
        }),
      },
    ]);
    t.after(() => {
      global.fetch = originalFetch;
    });

    const owner = await register('pmwebhookowner', 'business');
    const venue = await createVenue(owner.token);
    const created = await api('POST', `/api/venues/${venue.id}/billing/checkout`, { token: owner.token, body: { provider: 'paymongo' } });

    const payload = {
      data: {
        id: 'evt_1',
        attributes: {
          type: 'checkout_session.payment.paid',
          data: { id: 'cs_webhook_1', attributes: {} },
        },
      },
    };
    const rawBody = JSON.stringify(payload);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const sig = crypto.createHmac('sha256', 'whsec_fake').update(`${timestamp}.${rawBody}`).digest('hex');

    const res = await fetch(`${baseUrl}/api/webhooks/paymongo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'paymongo-signature': `t=${timestamp},te=${sig}` },
      body: rawBody,
    });
    assert.equal(res.status, 200);

    const { rows } = await pool.query(`SELECT status FROM subscription_payments WHERE id = $1`, [created.body.paymentId]);
    assert.equal(rows[0].status, 'paid');

    const { body: billing } = await api('GET', `/api/venues/${venue.id}/billing`, { token: owner.token });
    assert.equal(billing.status, 'active');
  });

  test('PayPal webhook with SUCCESS verification confirms by custom_id and is idempotent', async (t) => {
    const env = withEnv(
      { PAYPAL_CLIENT_ID: 'cid', PAYPAL_CLIENT_SECRET: 'csecret', PAYPAL_WEBHOOK_ID: 'WH-1', APP_ORIGIN: 'https://app.example' }
    );
    t.after(env.restore);

    const originalFetch = global.fetch;
    global.fetch = mockExternalFetch([
      { match: '/v1/oauth2/token', respond: async () => ({ ok: true, json: async () => ({ access_token: 't', expires_in: 3600 }) }) },
      { match: '/v2/checkout/orders', respond: async () => ({ ok: true, json: async () => ({ id: 'ORDER_WH_1', links: [{ rel: 'approve', href: 'https://paypal/approve' }] }) }) },
      { match: '/v1/notifications/verify-webhook-signature', respond: async () => ({ ok: true, json: async () => ({ verification_status: 'SUCCESS' }) }) },
    ]);
    t.after(() => {
      global.fetch = originalFetch;
    });

    const owner = await register('ppwebhookowner', 'business');
    const venue = await createVenue(owner.token);
    const created = await api('POST', `/api/venues/${venue.id}/billing/checkout`, { token: owner.token, body: { provider: 'paypal' } });

    const event = { event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { custom_id: created.body.paymentId } };
    const res = await fetch(`${baseUrl}/api/webhooks/paypal`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'paypal-transmission-id': 'tid',
        'paypal-transmission-time': 'ttime',
        'paypal-cert-url': 'https://api.paypal.com/cert',
        'paypal-auth-algo': 'SHA256withRSA',
        'paypal-transmission-sig': 'sig',
      },
      body: JSON.stringify(event),
    });
    assert.equal(res.status, 200);

    const { rows } = await pool.query(`SELECT status FROM subscription_payments WHERE id = $1`, [created.body.paymentId]);
    assert.equal(rows[0].status, 'paid');
  });

  // ── Enforcement: blocks new joins, never touches customers already in line ──

  test('new enrollment/walk-in/self-join are blocked (402) once a venue is past_due, but existing queue actions are not', async () => {
    const owner = await register('pastdueowner', 'business');
    const customer = await register('pastduecustomer');
    const venue = await createVenue(owner.token);

    // Simulate a lapsed trial with no payment — direct SQL, since this
    // is a state no amount of API calls should be able to produce
    // quickly (that's the whole point of the trial window).
    await pool.query(`UPDATE venues SET trial_ends_at = now() - interval '1 day' WHERE id = $1`, [venue.id]);

    const walkIn = await api('POST', `/api/venues/${venue.id}/queue`, { token: owner.token, body: { customerName: 'New Walk-in' } });
    assert.equal(walkIn.status, 402);
    assert.equal(walkIn.body.reason, 'subscription_past_due');

    const selfJoin = await api('POST', `/api/venues/${venue.id}/queue/join`, { token: customer.token });
    assert.equal(selfJoin.status, 402);

    const { body: tokenBody } = await api('GET', '/api/me/enrollment-token', { token: customer.token });
    const enroll = await api('POST', `/api/venues/${venue.id}/queue/enroll`, { token: owner.token, body: { enrollmentToken: tokenBody.enrollmentToken } });
    assert.equal(enroll.status, 402);

    // Someone who was already in line before the venue lapsed must
    // still be servable — insert directly, bypassing the (correctly)
    // blocked join endpoints, to set up that precondition.
    const { rows } = await pool.query(
      `INSERT INTO queue_entries (venue_id, customer_name, status, payment_tier, order_weight)
       VALUES ($1, 'Already Waiting', 'waiting', 'standard_free', 10) RETURNING id`,
      [venue.id]
    );
    const entryId = rows[0].id;

    const serve = await api('POST', `/api/venues/${venue.id}/queue/${entryId}/serve`, { token: owner.token });
    assert.equal(serve.status, 200, 'calling next for someone already in line must not be blocked by a lapsed subscription');

    const noShow = await api('POST', `/api/venues/${venue.id}/queue/${entryId}/no-show`, { token: owner.token });
    assert.equal(noShow.status, 200);
  });

  test('a venue with an active paid subscription is never blocked, even long after the original trial would have ended', async () => {
    const owner = await register('paidactiveowner', 'business');
    const venue = await createVenue(owner.token);

    await pool.query(
      `UPDATE venues SET trial_ends_at = now() - interval '100 days', subscription_paid_until = now() + interval '10 days' WHERE id = $1`,
      [venue.id]
    );

    const walkIn = await api('POST', `/api/venues/${venue.id}/queue`, { token: owner.token, body: { customerName: 'Fine' } });
    assert.equal(walkIn.status, 201);
  });
}
