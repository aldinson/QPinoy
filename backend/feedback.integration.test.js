'use strict';

/**
 * feedback.integration.test.js
 * ─────────────────────────────────────────────────────────────
 * The feedback endpoint over real HTTP against a real Postgres.
 *
 * The behaviour worth pinning down is the storage/email split: the row
 * must be written whether or not mail is configured or working, since
 * that is the whole reason it is written first.
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
  const { _setTransportForTests } = require('./mailer');

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const SUFFIX = '@feedbacktest.qpinoy.local';

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
    await pool.query(`DELETE FROM feedback WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)`, [`%${SUFFIX}`]);
    await pool.query(
      `DELETE FROM venues WHERE id IN (
         SELECT venue_id FROM venue_members WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)
       )`,
      [`%${SUFFIX}`]
    );
    await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`%${SUFFIX}`]);
    await pool.query(`DELETE FROM rate_limits WHERE bucket LIKE 'feedback:%'`);
  }

  test.beforeEach(async () => {
    await cleanup();
    _setTransportForTests(null);
    delete process.env.SMTP_HOST;
  });

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

  function fakeTransport(onSend) {
    return {
      sent: [],
      async sendMail(message) {
        this.sent.push(message);
        if (onSend) return onSend(message);
        return { messageId: 'fake' };
      },
    };
  }

  test('feedback is stored even with no SMTP configured at all', async () => {
    const customer = await register('fbnosmtp');

    const { status, body } = await api('POST', '/api/feedback', {
      token: customer.token,
      body: { rating: 5, comment: 'Loved it.' },
    });
    assert.equal(status, 201);
    assert.equal(body.received, true);

    const { rows } = await pool.query(`SELECT rating, comment, email_sent_at FROM feedback WHERE id = $1`, [body.id]);
    assert.equal(rows[0].rating, 5);
    assert.equal(rows[0].comment, 'Loved it.');
    assert.equal(rows[0].email_sent_at, null, 'nothing was emailed, and the row should say so');
  });

  test('with SMTP configured the mail goes out and email_sent_at is recorded', async () => {
    const customer = await register('fbsmtp');
    process.env.SMTP_HOST = 'smtp.example.com';
    const transport = fakeTransport();
    _setTransportForTests(transport);

    const { status, body } = await api('POST', '/api/feedback', {
      token: customer.token,
      body: { rating: 4, comment: 'Pretty good.' },
    });
    assert.equal(status, 201);

    assert.equal(transport.sent.length, 1);
    assert.ok(transport.sent[0].subject.startsWith('QPinoy User Feedback'));

    const { rows } = await pool.query(`SELECT email_sent_at FROM feedback WHERE id = $1`, [body.id]);
    assert.ok(rows[0].email_sent_at, 'a delivered mail should be recorded');
  });

  test('a broken mail server does not lose the feedback or fail the request', async () => {
    // The reason the row is written before the mail is attempted.
    const customer = await register('fbbroken');
    process.env.SMTP_HOST = 'smtp.example.com';
    _setTransportForTests(
      fakeTransport(() => {
        throw new Error('535 authentication failed');
      })
    );

    const { status, body } = await api('POST', '/api/feedback', {
      token: customer.token,
      body: { rating: 1, comment: 'Something went wrong.' },
    });
    assert.equal(status, 201, 'the customer did their part successfully');

    const { rows } = await pool.query(`SELECT comment, email_sent_at FROM feedback WHERE id = $1`, [body.id]);
    assert.equal(rows[0].comment, 'Something went wrong.');
    assert.equal(rows[0].email_sent_at, null, 'unsent feedback must be findable, not silently marked delivered');
  });

  test('feedback can be attached to a venue, and the email names it', async () => {
    const owner = await register('fbvenueowner', 'business');
    const customer = await register('fbvenuecustomer');
    const { body: venueBody } = await api('POST', '/api/venues', {
      token: owner.token,
      body: { name: 'Feedback Test Venue', geofenceLat: 14.5, geofenceLng: 121.0, geofenceRadiusMeters: 150 },
    });
    process.env.SMTP_HOST = 'smtp.example.com';
    const transport = fakeTransport();
    _setTransportForTests(transport);

    const { status, body } = await api('POST', '/api/feedback', {
      token: customer.token,
      body: { rating: 3, comment: 'Fine.', venueId: venueBody.venue.id },
    });
    assert.equal(status, 201);

    const { rows } = await pool.query(`SELECT venue_id FROM feedback WHERE id = $1`, [body.id]);
    assert.equal(rows[0].venue_id, venueBody.venue.id);
    assert.match(transport.sent[0].text, /Feedback Test Venue/);
  });

  test('a rating outside 1-5, or a non-integer, is refused', async () => {
    const customer = await register('fbbadrating');
    for (const rating of [0, 6, -1, 2.5, '5', null, undefined]) {
      const { status } = await api('POST', '/api/feedback', { token: customer.token, body: { rating } });
      assert.equal(status, 400, `rating ${JSON.stringify(rating)} should be refused`);
    }
  });

  test('an over-long comment is refused rather than silently truncated', async () => {
    const customer = await register('fblongcomment');
    const { status } = await api('POST', '/api/feedback', {
      token: customer.token,
      body: { rating: 5, comment: 'x'.repeat(2001) },
    });
    assert.equal(status, 400);
  });

  test('a comment is optional — a bare star rating is a complete submission', async () => {
    const customer = await register('fbnocomment');
    const { status, body } = await api('POST', '/api/feedback', { token: customer.token, body: { rating: 5 } });
    assert.equal(status, 201);

    const { rows } = await pool.query(`SELECT comment FROM feedback WHERE id = $1`, [body.id]);
    assert.equal(rows[0].comment, null, 'a blank comment should be NULL, not an empty string');
  });

  test('a malformed venueId is a 400, not a database error surfacing as a 500', async () => {
    const customer = await register('fbbadvenue');
    const { status } = await api('POST', '/api/feedback', {
      token: customer.token,
      body: { rating: 5, venueId: 'not-a-uuid' },
    });
    assert.equal(status, 400);
  });

  test('anonymous feedback is refused — the endpoint sends mail, so it needs an account behind it', async () => {
    const { status } = await api('POST', '/api/feedback', { body: { rating: 5 } });
    assert.equal(status, 401);
  });

  test('the hourly cap stops this being an open relay to the operator inbox', async () => {
    const customer = await register('fbratelimit');
    const { LIMITS } = require('./rateLimit');

    for (let i = 0; i < LIMITS.FEEDBACK.limit; i += 1) {
      const { status } = await api('POST', '/api/feedback', { token: customer.token, body: { rating: 5 } });
      assert.equal(status, 201, `submission ${i + 1} should be accepted`);
    }
    const { status, body } = await api('POST', '/api/feedback', { token: customer.token, body: { rating: 5 } });
    assert.equal(status, 429);
    assert.ok(Number(body.retry_after_seconds) > 0);
  });
}
