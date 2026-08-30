'use strict';

/**
 * rateLimit.js
 * ─────────────────────────────────────────────────────────────
 * Fixed-window rate limiting, counted in Postgres so the limit holds
 * across every serverless instance (see the schema.sql comment on
 * `rate_limits` for why in-memory counting is not an option here).
 *
 * Three shapes, because what deserves to be counted differs by
 * endpoint:
 *
 *   rateLimitMiddleware()  — every request counts. Used for the
 *                            location ping, where the thing being
 *                            limited IS the request volume.
 *
 *   rateLimitGate()        — only SUCCESSES count: the middleware
 *                            checks the budget, the route spends it
 *                            after the work lands. Used for remote
 *                            self-join and feedback, where a refusal
 *                            (already in that line, invalid rating)
 *                            costs nothing and must therefore charge
 *                            nothing — otherwise a few harmless
 *                            mistakes lock someone out of a thing they
 *                            never once did.
 *
 *   peek() / record() / reset()
 *                          — the caller decides what counts. Used for
 *                            login, where only FAILED attempts should
 *                            consume budget and a success wipes the
 *                            slate. Someone who types their password
 *                            correctly must never be locked out
 *                            because of someone else's guessing.
 *
 * Failure policy: if the counter query itself errors, requests are
 * ALLOWED through (fail open) rather than rejected. A database blip
 * must not lock every user out of the product. This is safe in
 * context because the endpoints being limited cannot do anything
 * useful without that same database — a login can't succeed if the
 * users table is unreachable — so failing open widens no real window.
 */

const crypto = require('crypto');

/**
 * Bucket keys hash the identifying part. IP addresses and email
 * addresses are personal data; this table's only job is counting, so
 * it has no business holding the raw values. Hashing also bounds the
 * key length regardless of what a client sends.
 */
function bucketKey(purpose, dimension, identifier) {
  const digest = crypto.createHash('sha256').update(String(identifier)).digest('hex');
  return `${purpose}:${dimension}:${digest}`;
}

/**
 * The client's IP.
 *
 * `x-nf-client-connection-ip` is set by Netlify to the true client
 * address and is preferred where present, because behind
 * serverless-http Express's own socket inspection sees the platform's
 * internal plumbing rather than the caller. `req.ip` (with
 * `trust proxy` set) covers the Render/Docker/local paths.
 */
function clientIp(req) {
  return req.headers['x-nf-client-connection-ip'] || req.ip || req.socket?.remoteAddress || 'unknown';
}

function retryAfterSeconds(windowStart, windowSeconds) {
  const elapsedMs = Date.now() - new Date(windowStart).getTime();
  return Math.max(1, Math.ceil((windowSeconds * 1000 - elapsedMs) / 1000));
}

/**
 * Read the current count for a bucket WITHOUT incrementing it.
 * Returns `{ hits, retryAfter }`, with `hits: 0` when there is no row
 * or the stored window has already elapsed.
 */
async function peek(pool, bucket, windowSeconds) {
  const { rows } = await pool.query(`SELECT window_start, hits FROM rate_limits WHERE bucket = $1`, [bucket]);
  const row = rows[0];
  if (!row) return { hits: 0, retryAfter: 0 };

  const expired = Date.now() - new Date(row.window_start).getTime() >= windowSeconds * 1000;
  if (expired) return { hits: 0, retryAfter: 0 };

  return { hits: row.hits, retryAfter: retryAfterSeconds(row.window_start, windowSeconds) };
}

/**
 * Count one hit against a bucket, returning the new total.
 *
 * The whole read-modify-write is a single statement so that two
 * concurrent requests cannot both read the same count and each write
 * back count+1 — which is exactly the race an attacker running
 * parallel requests would be relying on. The CASE expressions roll
 * the window over in the same breath as the increment.
 */
async function record(pool, bucket, windowSeconds) {
  const { rows } = await pool.query(
    `INSERT INTO rate_limits (bucket, window_start, hits)
     VALUES ($1, now(), 1)
     ON CONFLICT (bucket) DO UPDATE SET
       hits = CASE
                WHEN rate_limits.window_start <= now() - make_interval(secs => $2::float8) THEN 1
                ELSE rate_limits.hits + 1
              END,
       window_start = CASE
                        WHEN rate_limits.window_start <= now() - make_interval(secs => $2::float8) THEN now()
                        ELSE rate_limits.window_start
                      END
     RETURNING hits, window_start`,
    [bucket, windowSeconds]
  );
  const row = rows[0];
  return { hits: row.hits, retryAfter: retryAfterSeconds(row.window_start, windowSeconds) };
}

/** Forget a bucket entirely — used to clear failed-login counts on success. */
async function reset(pool, bucket) {
  await pool.query(`DELETE FROM rate_limits WHERE bucket = $1`, [bucket]);
}

/**
 * Housekeeping. Finished windows are dead weight, and nothing else
 * would ever delete them.
 *
 * Run opportunistically on a small fraction of requests rather than
 * from a cron: this has to work on Netlify Functions, where there is
 * no resident process to schedule anything, and wiring yet another
 * scheduled job for a table this small is not worth the operational
 * surface. The row count stays proportional to *active* traffic
 * rather than to history.
 */
const PURGE_PROBABILITY = 0.01;
const PURGE_AFTER_SECONDS = 24 * 60 * 60;

async function purgeExpired(pool, olderThanSeconds = PURGE_AFTER_SECONDS) {
  const { rowCount } = await pool.query(
    `DELETE FROM rate_limits WHERE window_start < now() - make_interval(secs => $1::float8)`,
    [olderThanSeconds]
  );
  return rowCount;
}

function maybePurge(pool) {
  if (Math.random() >= PURGE_PROBABILITY) return;
  // Deliberately not awaited: housekeeping must never add latency to,
  // or fail, the request that happened to trigger it.
  purgeExpired(pool).catch((err) => console.error('[rateLimit] purge failed', err));
}

function tooManyRequests(res, retryAfter, message) {
  res.setHeader('Retry-After', String(retryAfter));
  return res.status(429).json({ error: message, retry_after_seconds: retryAfter });
}

/**
 * Express middleware that CHECKS the budget without spending it, and
 * hands the route a `req.spendRateLimit()` to call once the work has
 * actually succeeded.
 *
 * Use this wherever the thing being limited is an OUTCOME rather than
 * an attempt — joining a line, sending an email. Counting attempts
 * there charges the user for refusals that achieved nothing (a
 * duplicate join, a validation error), so a handful of harmless
 * mistakes locks out someone who never did the limited thing once.
 * authRoutes.js applies the same split in reverse, counting only
 * FAILED logins.
 *
 * Spend AFTER success, and await it: the gate reads the counter, so a
 * write that lands after the response lets a concurrent burst all read
 * the same stale total and pass together — the exact scripted case
 * these limits exist for.
 *
 * @param {object}   pool
 * @param {object}   options
 * @param {number}   options.limit          max successes per window
 * @param {number}   options.windowSeconds
 * @param {function} options.key            (req) => bucket string, or null to skip limiting
 * @param {string}   options.message        what the client is told on 429
 */
function rateLimitGate(pool, { limit, windowSeconds, key, message }) {
  return async (req, res, next) => {
    let bucket;
    try {
      bucket = key(req);
    } catch {
      bucket = null;
    }
    // Nothing to charge (e.g. anonymous) — let the route's own auth
    // decide, and give it a no-op so it needn't special-case this.
    if (!bucket) {
      req.spendRateLimit = async () => {};
      return next();
    }

    try {
      const { hits, retryAfter } = await peek(pool, bucket, windowSeconds);
      if (hits >= limit) return tooManyRequests(res, retryAfter, message);
      res.setHeader('RateLimit-Limit', String(limit));
      res.setHeader('RateLimit-Remaining', String(Math.max(0, limit - hits)));
      req.spendRateLimit = async () => {
        await record(pool, bucket, windowSeconds).catch((err) =>
          console.error('[rateLimit] could not record a spend', err)
        );
      };
      maybePurge(pool);
      next();
    } catch (err) {
      // Fail open, same reasoning as the file header: a counter outage
      // must not stop people using the app.
      console.error('[rateLimit] counter unavailable, allowing request', err);
      req.spendRateLimit = async () => {};
      next();
    }
  };
}

/**
 * Express middleware: count every request, reject once over the limit.
 *
 * Right when the ATTEMPT itself is the cost being bounded (a location
 * ping is work whether or not it changes anything). When it is the
 * successful outcome that matters, reach for rateLimitGate above.
 *
 * @param {object}   pool
 * @param {object}   options
 * @param {number}   options.limit          max requests per window
 * @param {number}   options.windowSeconds
 * @param {function} options.key            (req) => bucket string, or null to skip limiting
 * @param {string}   options.message        what the client is told on 429
 */
function rateLimitMiddleware(pool, { limit, windowSeconds, key, message }) {
  return async (req, res, next) => {
    let bucket;
    try {
      bucket = key(req);
    } catch {
      bucket = null;
    }
    if (!bucket) return next();

    try {
      const { hits, retryAfter } = await record(pool, bucket, windowSeconds);
      maybePurge(pool);
      if (hits > limit) return tooManyRequests(res, retryAfter, message);
      // Advisory headers so a well-behaved client can back off before
      // it gets refused.
      res.setHeader('RateLimit-Limit', String(limit));
      res.setHeader('RateLimit-Remaining', String(Math.max(0, limit - hits)));
      next();
    } catch (err) {
      console.error('[rateLimit] counter unavailable, allowing request', err);
      next(); // fail open — see the file header
    }
  };
}

/**
 * The actual policy, kept as data in one place so "what is limited,
 * and how hard" is auditable without reading every route.
 *
 *  LOGIN_ACCOUNT — 10 *failed* attempts per (account, IP) pair per
 *                  15 min.
 *
 *      Note the pair. Keying this on the email address ALONE is the
 *      obvious implementation and it is a self-inflicted denial of
 *      service: anyone could burn a stranger's budget with ten wrong
 *      guesses and lock that person out of their own account from
 *      their own phone. The limit is checked before the password is
 *      verified, so "a correct password clears the counter" does not
 *      save the victim — they never get that far. Including the IP
 *      means an attacker can only ever block themselves.
 *
 *      NIST SP 800-63B makes the same point: throttle, don't lock
 *      accounts, precisely because lockout is a weapon.
 *
 *  LOGIN_IP      — 60 failed attempts per IP per 15 min, across all
 *                  accounts. This is the dimension that stops
 *                  credential spraying (one common password tried
 *                  against many accounts). Set well above the
 *                  per-account limit because clinics, offices and
 *                  mobile carriers NAT many legitimate people behind
 *                  one address.
 *
 *  LOCATION      — 30 pings per user per minute. CustomerHome.jsx
 *                  throttles itself to one per 15s (4/min), so this
 *                  is ~7x headroom for retries and clock skew while
 *                  still refusing a tight loop.
 *
 *  SELF_JOIN     — 15 SUCCESSFUL remote joins per user per hour, across
 *                  all venues. The one-active-ticket-per-venue DB
 *                  constraint already stops rejoining the SAME venue
 *                  while a ticket is live; this catches a script
 *                  hitting many DIFFERENT venues' join links back to
 *                  back, which that constraint can't see.
 *
 *      Counted on success only — see selfJoinBudget in routes.js.
 *      Refused attempts (already in that line, venue lapsed, venue
 *      gone) accomplish nothing for an attacker, so charging them to
 *      the budget only ever punished the honest user.
 *
 *      Was 5, which turned out to be below real usage rather than
 *      above it: someone browsing the venue directory and joining a
 *      few lines hit the wall having done nothing wrong. 15 still
 *      bounds the grinding case this exists for, and the actual
 *      backstop there was never the counter anyway — one ticket per
 *      venue per account caps the damage at a single bogus slot, which
 *      staff clear with the no-show button.
 *
 *  FEEDBACK      — 5 submissions per user per hour. This one sends an
 *                  email, so an unbounded endpoint is a free way to
 *                  flood the operator's inbox on demand and to get the
 *                  sending address marked as spam. Five an hour is far
 *                  above anyone with something genuine to say.
 *

 * Known gap, stated rather than papered over: an attacker with many
 * source IPs can still grind one account, since each IP gets its own
 * per-account budget. Closing that needs a CAPTCHA or step-up
 * challenge on repeated failures — worth adding when there is
 * something worth stealing, and noted in DEPLOYMENT.md.
 */
const LIMITS = {
  LOGIN_ACCOUNT: { limit: 10, windowSeconds: 15 * 60 },
  LOGIN_IP: { limit: 60, windowSeconds: 15 * 60 },
  LOCATION: { limit: 30, windowSeconds: 60 },
  SELF_JOIN: { limit: 15, windowSeconds: 60 * 60 },
  FEEDBACK: { limit: 5, windowSeconds: 60 * 60 },
};

module.exports = {
  LIMITS,
  bucketKey,
  clientIp,
  peek,
  record,
  reset,
  purgeExpired,
  maybePurge,
  tooManyRequests,
  rateLimitMiddleware,
  rateLimitGate,
};
