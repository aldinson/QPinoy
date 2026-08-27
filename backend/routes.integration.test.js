'use strict';

/**
 * routes.integration.test.js
 * ─────────────────────────────────────────────────────────────
 * queueCore.test.js covers the algorithm. queueEngine.integration.test.js
 * covers the SQL transaction layer against a real database. Neither one
 * ever sends an actual HTTP request — so neither would catch a wrong
 * status code, a validation hole, or a response shape bug in routes.js
 * itself. This file closes that gap: it boots a real Express app on an
 * ephemeral port and hits it with real HTTP requests.
 *
 * Requires the same DATABASE_URL as queueEngine.integration.test.js
 * (schema.sql already applied); skips itself otherwise.
 *
 * Run: DATABASE_URL=postgres://user:pass@host/db node --test routes.integration.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

if (!process.env.DATABASE_URL) {
  test('skipped: DATABASE_URL not set', { skip: true }, () => {});
} else {
  const express = require('express');
  const { Pool } = require('pg');
  const { buildQueueRouter } = require('./routes');

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const VENUE_ID = '00000000-0000-0000-0000-000000000099'; // distinct from the other integration test's venue
  const IDS = {
    a: '20000000-0000-0000-0000-000000000001',
    b: '20000000-0000-0000-0000-000000000002',
    c: '20000000-0000-0000-0000-000000000003', // premium + already at risk -> exercises step-back over HTTP
    d: '20000000-0000-0000-0000-000000000004',
  };

  let server;
  let baseUrl;

  test.before(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', buildQueueRouter(pool));
    app.use((err, req, res, next) => res.status(500).json({ error: 'internal_server_error' })); // eslint-disable-line no-unused-vars
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://localhost:${server.address().port}`;
  });

  test.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await pool.query(`DELETE FROM queue_entries WHERE venue_id = $1`, [VENUE_ID]);
    await pool.query(`DELETE FROM venues WHERE id = $1`, [VENUE_ID]);
    await pool.end();
  });

  test.beforeEach(async () => {
    // Full reset before every test so each one is independent regardless
    // of run order — mutating endpoints (serve/reinstate/move) would
    // otherwise leak state between tests.
    await pool.query(`DELETE FROM queue_entries WHERE venue_id = $1`, [VENUE_ID]);
    await pool.query(`DELETE FROM venues WHERE id = $1`, [VENUE_ID]);
    await pool.query(
      `INSERT INTO venues (id, name, geofence_lat, geofence_lng, geofence_radius_meters, is_automation_enabled)
       VALUES ($1, 'HTTP Test Venue', 40.0, -74.0, 150, TRUE)`,
      [VENUE_ID]
    );
    await pool.query(
      `INSERT INTO queue_entries (id, venue_id, customer_name, status, payment_tier, order_weight, is_checked_in, live_eta_minutes, expected_slot_at)
       VALUES
         ($1, $5, 'A', 'waiting', 'standard_free',   10, TRUE,  2,  now() + interval '30 minutes'),
         ($2, $5, 'B', 'waiting', 'standard_free',   20, TRUE,  3,  now() + interval '30 minutes'),
         ($3, $5, 'C', 'waiting', 'premium_secured', 30, FALSE, 30, now() - interval '1 minute'),
         ($4, $5, 'D', 'waiting', 'standard_free',   40, TRUE,  4,  now() + interval '30 minutes')`,
      [IDS.a, IDS.b, IDS.c, IDS.d, VENUE_ID]
    );
  });

  async function api(method, path, body) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, body: json };
  }

  test('GET /queue returns the seeded line in weight order', async () => {
    const { status, body } = await api('GET', `/api/venues/${VENUE_ID}/queue`);
    assert.equal(status, 200);
    assert.deepEqual(body.queue.map((r) => r.customer_name), ['A', 'B', 'C', 'D']);
  });

  test('GET /queue on a venue with no rows returns an empty array, not an error', async () => {
    const emptyVenueId = '00000000-0000-0000-0000-000000000098';
    await pool.query(`INSERT INTO venues (id, name, geofence_lat, geofence_lng) VALUES ($1, 'Empty', 0, 0)`, [emptyVenueId]);
    const { status, body } = await api('GET', `/api/venues/${emptyVenueId}/queue`);
    assert.equal(status, 200);
    assert.deepEqual(body.queue, []);
    await pool.query(`DELETE FROM venues WHERE id = $1`, [emptyVenueId]);
  });

  test('POST /serve calls A next and steps C back (premium + already at risk, 2 slots behind)', async () => {
    const { status, body } = await api('POST', `/api/venues/${VENUE_ID}/queue/${IDS.a}/serve`);
    assert.equal(status, 200);
    assert.equal(body.reason, 'stepped_back');
    assert.equal(body.targetId, IDS.c);

    const { body: queueBody } = await api('GET', `/api/venues/${VENUE_ID}/queue`);
    const names = queueBody.queue.map((r) => r.customer_name);
    assert.equal(names[0], 'A');
    assert.ok(names.indexOf('D') < names.indexOf('C')); // C cascaded behind D
  });

  test('POST /reinstate guarantees next-in-line and locks the row', async () => {
    await api('POST', `/api/venues/${VENUE_ID}/queue/${IDS.a}/serve`); // steps C back first
    const { status, body } = await api('POST', `/api/venues/${VENUE_ID}/queue/${IDS.c}/reinstate`);
    assert.equal(status, 200);
    assert.equal(body.reason, 'reinstated');

    const { rows } = await pool.query(`SELECT is_override_locked FROM queue_entries WHERE id = $1`, [IDS.c]);
    assert.equal(rows[0].is_override_locked, true);
  });

  test('POST /move with a valid direction succeeds', async () => {
    const { status, body } = await api('POST', `/api/venues/${VENUE_ID}/queue/${IDS.b}/move`, { direction: 'up' });
    assert.equal(status, 200);
    assert.equal(body.reason, 'moved_up');
  });

  test('POST /move with an invalid direction is rejected with 400, not silently ignored', async () => {
    const { status, body } = await api('POST', `/api/venues/${VENUE_ID}/queue/${IDS.b}/move`, { direction: 'sideways' });
    assert.equal(status, 400);
    assert.ok(body.error);
  });

  test('PATCH /automation toggles and persists the venue flag', async () => {
    const { status, body } = await api('PATCH', `/api/venues/${VENUE_ID}/automation`, { enabled: false });
    assert.equal(status, 200);
    assert.equal(body.is_automation_enabled, false);

    const { rows } = await pool.query(`SELECT is_automation_enabled FROM venues WHERE id = $1`, [VENUE_ID]);
    assert.equal(rows[0].is_automation_enabled, false);
  });

  test('PATCH /automation rejects a non-boolean enabled value with 400', async () => {
    const { status, body } = await api('PATCH', `/api/venues/${VENUE_ID}/automation`, { enabled: 'yes' });
    assert.equal(status, 400);
    assert.ok(body.error);
  });

  test('PATCH /automation on a nonexistent venue returns 404', async () => {
    const { status } = await api('PATCH', `/api/venues/00000000-0000-0000-0000-000000000000/automation`, { enabled: true });
    assert.equal(status, 404);
  });

  test('PATCH /location with real coordinates inside the geofence computes is_checked_in=true server-side', async () => {
    const { status, body } = await api('PATCH', `/api/venues/${VENUE_ID}/queue/${IDS.d}/location`, { lat: 40.0001, lng: -74.0001 });
    assert.equal(status, 200);
    assert.equal(body.is_checked_in, true);
  });

  test('PATCH /location far outside the geofence computes is_checked_in=false and a positive ETA', async () => {
    const { status, body } = await api('PATCH', `/api/venues/${VENUE_ID}/queue/${IDS.d}/location`, { lat: 41.0, lng: -75.0 });
    assert.equal(status, 200);
    assert.equal(body.is_checked_in, false);
    assert.ok(body.live_eta_minutes > 0);
  });

  test('PATCH /location rejects a garbage lat with 400 instead of silently corrupting geofence math', async () => {
    const { status, body } = await api('PATCH', `/api/venues/${VENUE_ID}/queue/${IDS.d}/location`, { lat: 'not-a-number', lng: -74.0 });
    assert.equal(status, 400);
    assert.ok(body.error);
  });

  test('PATCH /location rejects an out-of-range lat with 400', async () => {
    const { status, body } = await api('PATCH', `/api/venues/${VENUE_ID}/queue/${IDS.d}/location`, { lat: 200, lng: -74.0 });
    assert.equal(status, 400);
    assert.ok(body.error);
  });

  test('PATCH /location on a nonexistent venue returns 404', async () => {
    const { status } = await api('PATCH', `/api/venues/00000000-0000-0000-0000-000000000000/queue/${IDS.d}/location`, { lat: 40, lng: -74 });
    assert.equal(status, 404);
  });

  test('PATCH /location with no coordinates at all is accepted (absence is not garbage) and yields not-checked-in', async () => {
    const { status, body } = await api('PATCH', `/api/venues/${VENUE_ID}/queue/${IDS.d}/location`, {});
    assert.equal(status, 200);
    assert.equal(body.is_checked_in, false);
  });

  test('POST /rebalance runs without error', async () => {
    const { status, body } = await api('POST', `/api/venues/${VENUE_ID}/rebalance`);
    assert.equal(status, 200);
    assert.equal(typeof body.rebalanced, 'boolean');
  });
}
