'use strict';

require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const { buildQueueRouter } = require('./routes');

const app = express();
app.use(express.json());

/**
 * CORS — only needed if the frontend is served from a DIFFERENT origin
 * than this API. For same-origin deployments (frontend and API behind
 * one domain, which is the recommended setup) leave CORS_ORIGINS unset
 * and no CORS headers are sent at all.
 *
 * Deliberately an explicit allowlist rather than `*`. This API mutates
 * queue state — calling customers, dropping them, overriding slots —
 * so any origin being able to call it from a user's browser session is
 * not acceptable. `*` is also incompatible with credentialed requests
 * anyway, so it would break auth the moment it's added.
 *
 * Example: CORS_ORIGINS=https://app.qpinoy.com,https://admin.qpinoy.com
 */
const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

if (ALLOWED_ORIGINS.length > 0) {
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && ALLOWED_ORIGINS.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin'); // so caches don't serve one origin's headers to another
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Max-Age', '86400');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
}

// Behind a load balancer / platform proxy (Render, Fly, Railway, an
// nginx ingress), this makes req.protocol and req.ip reflect the real
// client rather than the proxy — needed for correct rate limiting and
// for any HTTPS redirect logic.
if (process.env.TRUST_PROXY) app.set('trust proxy', 1);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

app.get('/health', (req, res) => res.json({ ok: true }));
app.use('/api', buildQueueRouter(pool));

// Centralized error handler — keep internals out of the response body.
app.use((err, req, res, next) => {
  // eslint-disable-next-line no-console
  console.error(err);
  res.status(500).json({ error: 'internal_server_error' });
});

const PORT = process.env.PORT || 4000;
const server = app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`QPinoy API listening on :${PORT}`);
});

// Graceful shutdown: stop accepting new connections, let in-flight
// requests finish, then close the pg pool. Matters most for zero-
// downtime deploys and for tests/scripts that spin this up and down
// repeatedly without leaking open Postgres connections.
function shutdown(signal) {
  // eslint-disable-next-line no-console
  console.log(`${signal} received, shutting down`);
  server.close(async () => {
    try {
      await pool.end();
    } finally {
      process.exit(0);
    }
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = { app, pool, server };
