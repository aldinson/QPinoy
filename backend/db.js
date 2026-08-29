'use strict';

/**
 * db.js
 * ─────────────────────────────────────────────────────────────
 * Single place that knows how to build a pg Pool. Shared by
 * server.js (long-running process) and netlify/functions/api.js
 * (one Lambda invocation at a time) so connection/SSL behaviour
 * never drifts between the two deployment shapes.
 */

const { Pool } = require('pg');

/**
 * Managed Postgres providers (Neon, Supabase, Render) all require TLS
 * and issue certificates that aren't in Lambda's/Node's default trust
 * store chain the way a well-known public CA would be, so we relax
 * certificate verification rather than ship a CA bundle. localhost
 * (Docker/native dev) never uses TLS. Set DATABASE_SSL=false to force
 * plain TCP (e.g. a self-hosted Postgres with its own network-level
 * TLS termination), or DATABASE_SSL=true to force it on regardless of
 * hostname.
 */
function resolveSsl(connectionString) {
  if (process.env.DATABASE_SSL === 'false') return undefined;
  if (process.env.DATABASE_SSL === 'true') return { rejectUnauthorized: false };
  const isLocal = /(^|@)(localhost|127\.0\.0\.1)/.test(connectionString || '');
  return isLocal ? undefined : { rejectUnauthorized: false };
}

/**
 * `max`: a traditional server (server.js) keeps one pool alive for its
 * whole lifetime and can afford a real pool size. A serverless function
 * gets a fresh, tightly-limited execution environment and typically
 * handles one request per warm container at a time — a large pool
 * there just opens connections that sit idle until the container is
 * recycled, and managed Postgres free tiers cap total connections low
 * enough that this adds up fast across concurrent invocations.
 */
function createPool({ isServerless = false } = {}) {
  const connectionString = process.env.DATABASE_URL;
  return new Pool({
    connectionString,
    ssl: resolveSsl(connectionString),
    max: isServerless ? 1 : 10,
  });
}

module.exports = { createPool };
