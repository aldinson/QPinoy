'use strict';

/**
 * Self-contained end-to-end smoke test.
 * Boots the real Express app in-process, drives it over real HTTP,
 * prints the queue state at each step, then shuts down. No external
 * process management, no orphaned servers.
 */

require('dotenv').config();

const express = require('express');
const { Pool } = require('pg');
const { buildQueueRouter } = require('/home/claude/revalidate/backend/routes.js');

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
const VENUE = '00000000-0000-0000-0000-000000000001';
const ALICE = '10000000-0000-0000-0000-000000000001';
const DANA = '10000000-0000-0000-0000-000000000004';

(async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const app = express();
  app.use(express.json());
  app.use('/api', buildQueueRouter(pool));
  app.get('/health', (req, res) => res.json({ ok: true }));

  // Without this, Express's default handler returns an HTML error page,
  // and every failure shows up downstream as the useless
  // "Unexpected token '<', \"<!DOCTYPE\"" JSON parse error instead of
  // the actual problem.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error('\nAPI error:', err.message);
    res.status(500).json({ error: err.message });
  });

  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://localhost:${server.address().port}`;

  const show = async (label) => {
    const res = await fetch(`${base}/api/venues/${VENUE}/queue`);
    const { queue } = await res.json();
    console.log(`\n${label}`);
    queue.forEach((r, i) =>
      console.log(
        `  ${i + 1}. ${r.customer_name.padEnd(16)} ${r.status.padEnd(8)} w=${String(r.order_weight).padEnd(6)}` +
          `${r.payment_tier === 'premium_secured' ? 'deposit' : 'free   '} ${r.is_checked_in ? 'at-venue' : 'AWAY'}` +
          `${r.is_override_locked ? ' [LOCKED]' : ''}`
      )
    );
  };

  const health = await (await fetch(`${base}/health`)).json();
  console.log('health:', JSON.stringify(health));

  await show('INITIAL LINE');

  console.log('\n> POST /serve Alice  (evaluates the customer 2 slots back = Dana)');
  const serveRes = await (await fetch(`${base}/api/venues/${VENUE}/queue/${ALICE}/serve`, { method: 'POST' })).json();
  console.log('  engine result:', JSON.stringify(serveRes));
  await show('AFTER CALLING ALICE');

  console.log('\n> PATCH /location for Dana with coords INSIDE the geofence');
  const locIn = await (
    await fetch(`${base}/api/venues/${VENUE}/queue/${DANA}/location`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lat: 40.7128, lng: -74.006 }),
    })
  ).json();
  console.log('  server-computed:', JSON.stringify(locIn));

  console.log('\n> PATCH /location for Dana with coords FAR AWAY');
  const locOut = await (
    await fetch(`${base}/api/venues/${VENUE}/queue/${DANA}/location`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lat: 41.5, lng: -75.5 }),
    })
  ).json();
  console.log('  server-computed:', JSON.stringify(locOut));

  console.log('\n> PATCH /location with a spoofed isCheckedIn (should be IGNORED — server decides)');
  const spoof = await (
    await fetch(`${base}/api/venues/${VENUE}/queue/${DANA}/location`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lat: 41.5, lng: -75.5, isCheckedIn: true }),
    })
  ).json();
  console.log('  server-computed:', JSON.stringify(spoof), spoof.is_checked_in === false ? '  <-- spoof correctly ignored' : '  <-- SPOOF SUCCEEDED (BAD)');

  console.log('\n> POST /reinstate Dana (Lock-Back override)');
  const reinstate = await (await fetch(`${base}/api/venues/${VENUE}/queue/${DANA}/reinstate`, { method: 'POST' })).json();
  console.log('  engine result:', JSON.stringify(reinstate));
  await show('AFTER REINSTATE');

  await new Promise((r) => server.close(r));
  await pool.end();
  console.log('\nSmoke test complete — server closed, pool drained.');
})().catch((err) => {
  console.error('SMOKE TEST FAILED:', err);
  process.exit(1);
});
