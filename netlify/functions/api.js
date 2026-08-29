'use strict';

/**
 * netlify/functions/api.js
 * ─────────────────────────────────────────────────────────────
 * Wraps the real Express app (backend/app.js — same code that runs
 * under Docker/Render via backend/server.js) with serverless-http so
 * Netlify can invoke it as a single Function. netlify.toml redirects
 * /api/* here, so the frontend calls /api/... exactly as it does in
 * local dev against the Vite proxy — no CORS, no separate origin.
 *
 * The pool is created ONCE at module scope, not inside the handler.
 * Netlify (like any Lambda-based platform) reuses a warm container
 * across consecutive invocations, so a module-scope pool is reused
 * too instead of opening a fresh Postgres connection on every request.
 *
 * No dotenv here on purpose: Netlify (both `netlify dev` locally and
 * the deployed platform) injects environment variables straight into
 * process.env itself, and dotenv isn't installed in this directory's
 * own node_modules (netlify/functions/package.json ships only
 * serverless-http — backend/app.js and backend/db.js resolve express
 * and pg from backend/node_modules on their own).
 */

const serverless = require('serverless-http');
const { createApp } = require('../../backend/app');
const { createPool } = require('../../backend/db');

const pool = createPool({ isServerless: true });
const app = createApp(pool);
const serverlessHandler = serverless(app);

/**
 * app.js mounts routes at /api and /health, matching what the Vite
 * dev proxy forwards in local dev. Depending on the exact Netlify
 * redirect/runtime version, the Function may see event.path as either
 * the original browser path ("/api/venues/.../queue") or a path still
 * carrying the "/.netlify/functions/api" invocation prefix. Rather
 * than lock this to one assumption, strip that prefix defensively if
 * present and use the original path otherwise — both converge on the
 * same clean path Express expects.
 */
exports.handler = (event, context) => {
  const rawPath = event.path || event.rawPath || '/';
  const path = rawPath.replace(/^\/\.netlify\/functions\/api/, '') || '/';
  return serverlessHandler({ ...event, path }, context);
};
