'use strict';

/**
 * app.js
 * ─────────────────────────────────────────────────────────────
 * The Express app itself, with no process lifecycle attached
 * (no app.listen, no signal handlers). Extracted out of server.js
 * so the exact same app can be:
 *   - booted by server.js for local dev / Docker / a traditional
 *     always-on host (Render, Railway, Fly), or
 *   - wrapped with serverless-http and invoked per-request by
 *     netlify/functions/api.js, with no listener of its own.
 */

const express = require('express');
const { buildQueueRouter } = require('./routes');
const { buildAuthRouter } = require('./authRoutes');
const { buildVenueRouter } = require('./venueRoutes');
const { buildBillingRouter } = require('./billingRoutes');
const { buildFeedbackRouter } = require('./feedbackRoutes');
const { attachUser } = require('./auth');

/**
 * CORS — only needed if the frontend is served from a DIFFERENT origin
 * than this API. For same-origin deployments (frontend and API behind
 * one domain — e.g. Netlify serving both the static site and
 * /api/* via a Function, which is the recommended setup) leave
 * CORS_ORIGINS unset and no CORS headers are sent at all.
 *
 * Deliberately an explicit allowlist rather than `*`. This API mutates
 * queue state — calling customers, dropping them, overriding slots —
 * so any origin being able to call it from a user's browser session is
 * not acceptable. `*` is also incompatible with credentialed requests
 * anyway, so it would break auth the moment it's added.
 */
function corsMiddleware() {
  const allowedOrigins = (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  return (req, res, next) => {
    if (allowedOrigins.length > 0) {
      const origin = req.headers.origin;
      if (origin && allowedOrigins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin'); // so caches don't serve one origin's headers to another
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Access-Control-Max-Age', '86400');
      }
      if (req.method === 'OPTIONS') return res.sendStatus(204);
    }
    next();
  };
}

function createApp(pool) {
  const app = express();

  // Behind a load balancer / platform proxy (Netlify, Render, Fly,
  // Railway, an nginx ingress), this makes req.ip and req.protocol
  // reflect the real client rather than the proxy. Set here rather
  // than in server.js so the serverless path gets it too — without
  // it, rate limiting by IP would bucket every caller behind the
  // platform's own address into a single shared counter.
  if (process.env.TRUST_PROXY) app.set('trust proxy', 1);

  // The `verify` callback stashes the exact bytes of every request body
  // on req.rawBody BEFORE they're parsed into req.body. Needed for
  // exactly one thing — billingRoutes.js's PayMongo webhook handler,
  // which has to HMAC-verify the raw byte sequence PayMongo signed, not
  // a re-serialization of the parsed object (key order and whitespace
  // would never match). Cheap enough to do unconditionally for every
  // route rather than special-casing the webhook path's middleware order.
  app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
  app.use(corsMiddleware());

  app.get('/health', (req, res) => res.json({ ok: true }));

  // Resolves `req.user` from a Bearer token for every /api route.
  // Mounted once, before the routers, so no individual route can
  // forget it — the routers then declare what they *require* via
  // requireAuth / requireVenueRole.
  app.use('/api', attachUser(pool));
  app.use('/api', buildAuthRouter(pool));
  // Venue routes before queue routes: '/venues/mine' has to be
  // matched before anything that would treat 'mine' as a :venueId.
  app.use('/api', buildVenueRouter(pool));
  app.use('/api', buildQueueRouter(pool));
  app.use('/api', buildBillingRouter(pool));
  app.use('/api', buildFeedbackRouter(pool));

  // Centralized error handler — keep internals out of the response body.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: 'internal_server_error' });
  });

  return app;
}

module.exports = { createApp };
