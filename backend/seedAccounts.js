'use strict';

/**
 * seedAccounts.js
 * ─────────────────────────────────────────────────────────────
 * Companion to seed.sql. Passwords have to be hashed with scrypt
 * (see password.js), which SQL can't do, so the demo accounts live
 * here instead of in the .sql file.
 *
 * Creates three logins against the demo venue seed.sql already
 * inserted, one per role, so every permission path can be clicked
 * through by hand:
 *
 *   owner@qpinoy.demo      / demo-password-123   owner
 *   manager@qpinoy.demo    / demo-password-123   manager (can edit staff)
 *   attendant@qpinoy.demo  / demo-password-123   attendant (cannot)
 *   customer@qpinoy.demo   / demo-password-123   customer (no venue role)
 *
 * Idempotent: re-running resets these four accounts and their
 * memberships without touching anything else.
 *
 * Usage: DATABASE_URL=... AUTH_SECRET=... npm run db:seed:accounts
 */

require('dotenv').config();
const { createPool } = require('./db');
const { hashPassword } = require('./password');
const { normalisePhone } = require('./phone');

const VENUE_ID = '00000000-0000-0000-0000-000000000001'; // matches seed.sql
const PASSWORD = 'demo-password-123';

// Numbers are in the 09171234xxx range purely as recognisable demo
// data. They are stored in E.164 like every other account.
const ACCOUNTS = [
  { email: 'owner@qpinoy.demo', fullName: 'Olivia Owner', phone: '0917 123 4001', accountType: 'business', role: 'owner' },
  { email: 'manager@qpinoy.demo', fullName: 'Mia Manager', phone: '0917 123 4002', accountType: 'business', role: 'manager' },
  { email: 'attendant@qpinoy.demo', fullName: 'Andy Attendant', phone: '0917 123 4003', accountType: 'business', role: 'attendant' },
  { email: 'customer@qpinoy.demo', fullName: 'Cara Customer', phone: '0917 123 4004', accountType: 'customer', role: null },
];

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Example:\n  DATABASE_URL=postgres://qpinoy:qpinoy@localhost:5433/qpinoy npm run db:seed:accounts');
    process.exit(1);
  }

  const pool = createPool();
  const client = await pool.connect();
  try {
    const { rows: venueRows } = await client.query(`SELECT id FROM venues WHERE id = $1`, [VENUE_ID]);
    if (!venueRows[0]) {
      console.error(`Demo venue ${VENUE_ID} not found — run "npm run db:seed" first.`);
      process.exit(1);
    }

    await client.query('BEGIN');
    const passwordHash = await hashPassword(PASSWORD);

    for (const account of ACCOUNTS) {
      const { rows } = await client.query(
        `INSERT INTO users (email, password_hash, full_name, phone, account_type)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (email) DO UPDATE
           SET password_hash = EXCLUDED.password_hash,
               full_name     = EXCLUDED.full_name,
               phone         = EXCLUDED.phone,
               account_type  = EXCLUDED.account_type
         RETURNING id`,
        [account.email, passwordHash, account.fullName, normalisePhone(account.phone), account.accountType]
      );
      const userId = rows[0].id;

      if (account.role) {
        await client.query(
          `INSERT INTO venue_members (venue_id, user_id, role)
           VALUES ($1, $2, $3)
           ON CONFLICT (venue_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
          [VENUE_ID, userId, account.role]
        );
      }
    }

    await client.query('COMMIT');

    console.log('\nSeeded demo accounts (all use the password below):\n');
    for (const a of ACCOUNTS) {
      console.log(`  ${a.email.padEnd(24)} ${a.role || 'customer (no venue role)'}`);
    }
    console.log(`\n  password: ${PASSWORD}\n`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Failed to seed accounts:', err.message);
  process.exit(1);
});
