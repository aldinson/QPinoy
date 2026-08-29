'use strict';

require('dotenv').config();
const { createApp } = require('./app');
const { createPool } = require('./db');

// `trust proxy` is handled inside createApp so the serverless entry
// point gets the same treatment — see the comment there.
const pool = createPool();
const app = createApp(pool);

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
