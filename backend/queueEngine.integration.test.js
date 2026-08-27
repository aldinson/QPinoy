'use strict';

/**
 * queueEngine.integration.test.js
 * ─────────────────────────────────────────────────────────────
 * Exercises the real SQL transaction layer (row locks, dynamic
 * UPDATE patches, ANY(::queue_status[]) filtering) against an
 * actual Postgres instance — not a mock. queueCore.test.js already
 * covers every branch of the algorithm itself with zero
 * infrastructure; this file's job is only to prove the DB plumbing
 * around that algorithm is wired correctly.
 *
 * Requires:
 *   - schema.sql already applied to the target database
 *   - DATABASE_URL env var pointing at it
 *
 * Skips itself (rather than failing) if DATABASE_URL isn't set, so
 * `npm test` stays green in environments without a live database.
 *
 * Run: DATABASE_URL=postgres://user:pass@host/db node --test queueEngine.integration.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

if (!process.env.DATABASE_URL) {
  test('skipped: DATABASE_URL not set', { skip: true }, () => {});
} else {
  const { Pool } = require('pg');
  const { getLiveQueue, callNextCustomer, reinstateSlot, moveOneSlot } = require('./queueEngine');

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const VENUE_ID = '00000000-0000-0000-0000-000000000097'; // deliberately NOT the demo seed's venue — running tests must not wipe local demo data
  const CUSTOMER = {
    alice: '19000000-0000-0000-0000-000000000001',
    bob: '19000000-0000-0000-0000-000000000002',
    charlie: '19000000-0000-0000-0000-000000000003',
    dana: '19000000-0000-0000-0000-000000000004',
    ethan: '19000000-0000-0000-0000-000000000005',
    fiona: '19000000-0000-0000-0000-000000000006',
  };

  // These 5 tests are intentionally sequential and stateful — each one
  // builds on the previous test's mutations, mirroring a real attendant
  // shift. That only works from a known-clean starting point, so this
  // suite seeds its own fixture (delete, then reinsert) rather than
  // assuming a human ran a seed script by hand beforehand. Running this
  // file twice in a row without that used to fail on the second run —
  // reason enough to fix it here instead of documenting a manual step.
  test.before(async () => {
    await pool.query(`DELETE FROM queue_entries WHERE venue_id = $1`, [VENUE_ID]);
    await pool.query(`DELETE FROM venues WHERE id = $1`, [VENUE_ID]);
    await pool.query(
      `INSERT INTO venues (id, name, geofence_lat, geofence_lng, is_automation_enabled)
       VALUES ($1, 'Riverside Dermatology', 40.7128, -74.0060, TRUE)`,
      [VENUE_ID]
    );
    await pool.query(
      `INSERT INTO queue_entries (id, venue_id, customer_name, status, payment_tier, order_weight, is_checked_in, live_eta_minutes, expected_slot_at)
       VALUES
         ($1,  $7, 'Alice Chen',     'waiting', 'premium_secured', 10, TRUE,  2,  now() + interval '0 minutes'),
         ($2,  $7, 'Bob Martinez',   'waiting', 'standard_free',   20, TRUE,  3,  now() + interval '6 minutes'),
         ($3,  $7, 'Charlie Nguyen', 'waiting', 'standard_free',   30, TRUE,  2,  now() + interval '12 minutes'),
         ($4,  $7, 'Dana Osei',      'waiting', 'premium_secured', 40, FALSE, 25, now() + interval '18 minutes'),
         ($5,  $7, 'Ethan Brooks',   'waiting', 'standard_free',   50, FALSE, 20, now() + interval '24 minutes'),
         ($6,  $7, 'Fiona Alvarez',  'waiting', 'standard_free',   60, TRUE,  4,  now() + interval '30 minutes')`,
      [CUSTOMER.alice, CUSTOMER.bob, CUSTOMER.charlie, CUSTOMER.dana, CUSTOMER.ethan, CUSTOMER.fiona, VENUE_ID]
    );
  });

  test('live queue starts in seeded order: Alice, Bob, Charlie, Dana, Ethan, Fiona', async () => {
    const queue = await getLiveQueue(pool, VENUE_ID);
    assert.deepEqual(
      queue.map((r) => r.customer_name),
      ['Alice Chen', 'Bob Martinez', 'Charlie Nguyen', 'Dana Osei', 'Ethan Brooks', 'Fiona Alvarez']
    );
  });

  test('calling Alice to serving: Charlie (2 slots back, checked in) is left on track', async () => {
    const result = await callNextCustomer(pool, VENUE_ID, CUSTOMER.alice);
    assert.equal(result.reason, 'on_track');
    const queue = await getLiveQueue(pool, VENUE_ID);
    assert.equal(queue[0].customer_name, 'Alice Chen');
    assert.equal(queue[0].status, 'serving');
  });

  test('calling Bob next: Alice is auto-completed and Dana (2 slots back, premium + late) steps back one slot', async () => {
    const result = await callNextCustomer(pool, VENUE_ID, CUSTOMER.bob);
    assert.equal(result.reason, 'stepped_back');
    assert.equal(result.targetId, CUSTOMER.dana);

    const { rows } = await pool.query(`SELECT status FROM queue_entries WHERE id = $1`, [CUSTOMER.alice]);
    assert.equal(rows[0].status, 'served'); // Alice was auto-completed by the same call

    const queue = await getLiveQueue(pool, VENUE_ID);
    const names = queue.map((r) => r.customer_name);
    // Dana should now sort AFTER Ethan (she cascaded down exactly one slot).
    assert.ok(names.indexOf('Ethan Brooks') < names.indexOf('Dana Osei'));
  });

  test('attendant reinstates Dana: she is now guaranteed next-in-line and locked', async () => {
    const result = await reinstateSlot(pool, VENUE_ID, CUSTOMER.dana);
    assert.equal(result.reason, 'reinstated');

    const queue = await getLiveQueue(pool, VENUE_ID);
    assert.equal(queue[0].status, 'serving'); // Bob
    assert.equal(queue[1].customer_name, 'Dana Osei'); // reinstated to next-in-line
    assert.equal(queue[1].is_override_locked, true);
  });

  test('manual move: nudging Fiona up one slot changes only her row', async () => {
    const before = await getLiveQueue(pool, VENUE_ID);
    const fionaBefore = before.find((r) => r.customer_name === 'Fiona Alvarez');
    const result = await moveOneSlot(pool, VENUE_ID, fionaBefore.id, 'up');
    assert.equal(result.reason, 'moved_up');

    const after = await getLiveQueue(pool, VENUE_ID);
    const namesAfter = after.map((r) => r.customer_name);
    const fionaIdxAfter = namesAfter.indexOf('Fiona Alvarez');
    const fionaIdxBefore = before.map((r) => r.customer_name).indexOf('Fiona Alvarez');
    assert.ok(fionaIdxAfter < fionaIdxBefore);
  });

  test.after(async () => {
    await pool.query(`DELETE FROM queue_entries WHERE venue_id = $1`, [VENUE_ID]);
    await pool.query(`DELETE FROM venues WHERE id = $1`, [VENUE_ID]);
    await pool.end();
  });
}
