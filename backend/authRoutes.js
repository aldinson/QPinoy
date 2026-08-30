'use strict';

/**
 * authRoutes.js
 * ─────────────────────────────────────────────────────────────
 * Registration, login, and the endpoints a signed-in user needs for
 * themselves: their profile, their rotating enrollment QR token, and
 * their own live place in line.
 */

const express = require('express');
const { hashPassword, verifyPassword, describePasswordProblem } = require('./password');
const { normalisePhone, describePhoneProblem } = require('./phone');
const { createSessionToken, createEnrollmentToken, ENROLLMENT_TTL_SECONDS } = require('./tokens');
const { requireAuth, isUuid } = require('./auth');
const { isConfigured: isPushConfigured } = require('./push');
const { LIMITS, bucketKey, clientIp, peek, record, reset, maybePurge, tooManyRequests } = require('./rateLimit');
const { getLiveQueue } = require('./queueEngine');
const { maskCustomerName } = require('./names');

// Deliberately permissive: one @, no whitespace, a dot in the domain.
// Anything stricter starts rejecting valid real-world addresses, and
// the only thing this check needs to accomplish is catching typos
// before they become a row nobody can log in as.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normaliseEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/** The user shape sent to clients. Never includes password_hash. */
function publicUser(row) {
  return {
    id: row.id,
    email: row.email,
    full_name: row.full_name,
    phone: row.phone,
    account_type: row.account_type,
  };
}

function buildAuthRouter(pool) {
  const router = express.Router();

  /**
   * Self-service registration, for customers and business owners
   * alike. `accountType` only decides where the app sends you next —
   * a 'business' account has no powers until it creates a venue (or
   * is added to one), because permissions live in venue_members.
   */
  router.post('/auth/register', async (req, res, next) => {
    const { email, password, fullName, phone, accountType } = req.body || {};

    const normalisedEmail = normaliseEmail(email);
    if (!EMAIL_RE.test(normalisedEmail)) {
      return res.status(400).json({ error: 'a valid email address is required' });
    }
    const passwordProblem = describePasswordProblem(password);
    if (passwordProblem) return res.status(400).json({ error: passwordProblem });

    if (typeof fullName !== 'string' || !fullName.trim()) {
      return res.status(400).json({ error: 'fullName is required' });
    }
    // Both an email address and a mobile number are mandatory: they
    // are the two channels a venue has for reaching a customer whose
    // turn is coming up, and a queue that cannot contact people is
    // most of the way to being useless.
    const phoneProblem = describePhoneProblem(phone);
    if (phoneProblem) return res.status(400).json({ error: phoneProblem });

    if (accountType !== undefined && accountType !== 'customer' && accountType !== 'business') {
      return res.status(400).json({ error: "accountType must be 'customer' or 'business'" });
    }

    try {
      const passwordHash = await hashPassword(password);
      const { rows } = await pool.query(
        `INSERT INTO users (email, password_hash, full_name, phone, account_type)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, email, full_name, phone, account_type`,
        // Stored in E.164 rather than as typed — see phone.js.
        [normalisedEmail, passwordHash, fullName.trim(), normalisePhone(phone), accountType || 'customer']
      );
      const user = rows[0];
      res.status(201).json({ token: createSessionToken(user.id), user: publicUser(user) });
    } catch (err) {
      // 23505 = unique_violation on the email index. Handled here
      // rather than with a pre-flight SELECT, which would still race
      // two simultaneous signups for the same address.
      if (err.code === '23505') {
        return res.status(409).json({ error: 'an account with that email already exists' });
      }
      next(err);
    }
  });

  /**
   * Login, throttled on two independent dimensions.
   *
   * Only FAILED attempts are counted. Guessing consumes budget;
   * knowing the password does not.
   *
   * The account counter is keyed on the (email, IP) PAIR, not the
   * email alone — see the LIMITS block in rateLimit.js for why that
   * distinction is the difference between a brute-force defence and a
   * tool for locking strangers out of their own accounts.
   *
   * The two dimensions catch different attacks and neither subsumes
   * the other: the account counter stops many guesses against one
   * login, the IP counter stops one guess against many logins.
   */
  router.post('/auth/login', async (req, res, next) => {
    const normalisedEmail = normaliseEmail(req.body?.email);
    const { password } = req.body || {};
    if (!normalisedEmail || typeof password !== 'string') {
      return res.status(400).json({ error: 'email and password are required' });
    }

    const ip = clientIp(req);
    const accountBucket = bucketKey('login', 'account', `${normalisedEmail}|${ip}`);
    const ipBucket = bucketKey('login', 'ip', ip);

    try {
      // Checked before doing any password work, so a blocked caller
      // never gets to spend the server's scrypt cycles either.
      for (const [bucket, policy] of [
        [accountBucket, LIMITS.LOGIN_ACCOUNT],
        [ipBucket, LIMITS.LOGIN_IP],
      ]) {
        const { hits, retryAfter } = await peek(pool, bucket, policy.windowSeconds);
        if (hits >= policy.limit) {
          return tooManyRequests(res, retryAfter, 'too many failed sign-in attempts — please wait and try again');
        }
      }
    } catch (err) {
      // Fail open: a counter outage must not lock everyone out.
      console.error('[rateLimit] login check unavailable, allowing attempt', err);
    }

    try {
      const { rows } = await pool.query(
        `SELECT id, email, password_hash, full_name, phone, account_type FROM users WHERE email = $1`,
        [normalisedEmail]
      );
      const user = rows[0];

      // Same generic message whether the email is unknown or the
      // password is wrong: a distinct "no such account" reply turns
      // this endpoint into a way to enumerate who has signed up.
      const ok = user && (await verifyPassword(password, user.password_hash));

      if (!ok) {
        // Counted for unknown addresses too — otherwise the *rate* of
        // limiting would itself reveal which emails have accounts.
        await Promise.all([
          record(pool, accountBucket, LIMITS.LOGIN_ACCOUNT.windowSeconds),
          record(pool, ipBucket, LIMITS.LOGIN_IP.windowSeconds),
        ]).catch((err) => console.error('[rateLimit] could not record failed login', err));
        maybePurge(pool);
        return res.status(401).json({ error: 'invalid email or password' });
      }

      // Only the (account, IP) counter is cleared. The broad per-IP
      // counter is deliberately left to decay on time alone: an
      // attacker who owns one valid account would otherwise be able
      // to reset their spraying budget at will, simply by logging
      // into their own account whenever they hit the ceiling.
      await reset(pool, accountBucket).catch((err) =>
        console.error('[rateLimit] could not clear login counter', err)
      );

      res.json({ token: createSessionToken(user.id), user: publicUser(user) });
    } catch (err) {
      next(err);
    }
  });

  /**
   * Current user plus every venue they staff. The frontend uses the
   * memberships to decide whether to show the staff console at all,
   * and which venue to open by default.
   */
  router.get('/auth/me', requireAuth, async (req, res, next) => {
    try {
      const { rows: memberships } = await pool.query(
        `SELECT m.venue_id, m.role, v.name AS venue_name
           FROM venue_members m
           JOIN venues v ON v.id = m.venue_id
          WHERE m.user_id = $1
          ORDER BY v.name ASC`,
        [req.user.id]
      );
      res.json({ user: publicUser(req.user), memberships });
    } catch (err) {
      next(err);
    }
  });

  /**
   * The QR payload a customer's phone displays for staff to scan.
   *
   * This is a short-lived signed token, not the user's ID. A static
   * identifier printed on a screen in a waiting room can be
   * photographed once and reused indefinitely by anyone; this expires
   * after a bounded window and the customer's screen quietly re-fetches
   * a new one before then. `expiresInSeconds` is returned so the client
   * can schedule that refresh from the server's clock rather than
   * hardcoding a number that could drift out of sync with this file.
   *
   * Optional `?venueId=` — the enrollment token itself stays
   * venue-agnostic (any venue's staff can scan it; identity comes from
   * the signature, not from anything venue-specific), but a customer
   * who's specifically checking in at a known venue right now gets a
   * QR sized to THAT venue's configured validity window
   * (`venues.enrollment_qr_ttl_seconds`, owner/manager-configurable —
   * see `PATCH .../enrollment-qr-ttl` in venueRoutes.js) instead of the
   * system-wide default. No relationship to the venue is required to
   * request this — it only affects how long the token lasts, not what
   * it proves, so there's nothing to authorize beyond "this venue
   * exists."
   */
  router.get('/me/enrollment-token', requireAuth, async (req, res, next) => {
    const { venueId } = req.query;
    let ttlSeconds = ENROLLMENT_TTL_SECONDS;

    if (venueId !== undefined) {
      if (!isUuid(venueId)) return res.status(400).json({ error: 'venueId must be a UUID' });
      try {
        const { rows } = await pool.query(`SELECT enrollment_qr_ttl_seconds FROM venues WHERE id = $1`, [venueId]);
        if (!rows[0]) return res.status(404).json({ error: 'venue not found' });
        ttlSeconds = rows[0].enrollment_qr_ttl_seconds;
      } catch (err) {
        return next(err);
      }
    }

    res.json({
      enrollmentToken: createEnrollmentToken(req.user.id, ttlSeconds),
      expiresInSeconds: ttlSeconds,
    });
  });

  /**
   * Every live ticket this customer holds, with their real position
   * worked out server-side, plus a `roster` of the venue's whole line
   * in serve order so the queue actually looks like a queue rather than
   * a single floating number.
   *
   * The roster is never the raw line, though: every OTHER customer's
   * name is masked with maskCustomerName (their own is not — that's
   * what lets them find themselves in the list). Nothing else about
   * anyone else — phone, check-in state, exact ETA — is included, which
   * stays staff-only via the real GET /venues/:venueId/queue.
   */
  router.get('/me/queue', requireAuth, async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        `SELECT e.id, e.venue_id, e.status, e.payment_tier, e.is_checked_in,
                e.live_eta_minutes, e.expected_slot_at, e.is_override_locked,
                e.last_automation_flag, e.joined_at,
                v.name AS venue_name, v.address AS venue_address,
                (SELECT count(*)
                   FROM queue_entries ahead
                  WHERE ahead.venue_id = e.venue_id
                    AND ahead.status IN ('waiting', 'serving')
                    AND (ahead.status = 'serving' OR ahead.order_weight < e.order_weight)
                    AND ahead.id <> e.id
                )::int AS people_ahead
           FROM queue_entries e
           JOIN venues v ON v.id = e.venue_id
          WHERE e.user_id = $1 AND e.status IN ('waiting', 'serving')
          ORDER BY e.joined_at ASC`,
        [req.user.id]
      );

      const entries = await Promise.all(
        rows.map(async (entry) => {
          const venueQueue = await getLiveQueue(pool, entry.venue_id);
          const roster = venueQueue.map((row, i) => ({
            position: i + 1,
            name: row.id === entry.id ? row.customer_name : maskCustomerName(row.customer_name),
            isMe: row.id === entry.id,
          }));
          return { ...entry, roster };
        })
      );

      res.json({ entries });
    } catch (err) {
      next(err);
    }
  });

  /**
   * The server's own VAPID public key, so a browser can create a real
   * PushSubscription. Not a secret — asymmetric VAPID keys are designed
   * to be handed to every subscriber — but serving it from here (rather
   * than baking it into the frontend build) means rotating it needs no
   * rebuild, and it doubles as the frontend's signal for whether to
   * offer the "enable notifications" feature at all: `null` when the
   * server has no VAPID keys configured (self-hosted/local dev without
   * them), same fallback shape as the Maps API key.
   */
  router.get('/push/vapid-public-key', (req, res) => {
    res.json({ publicKey: isPushConfigured() ? process.env.VAPID_PUBLIC_KEY : null });
  });

  /**
   * Register (or refresh) this device's push subscription for the
   * signed-in user. Upserted by endpoint: a browser re-subscribing with
   * the same endpoint (its own periodic refresh, or the user granting
   * permission again) replaces the stored keys rather than creating a
   * duplicate row that would get double-notified.
   */
  router.post('/me/push-subscription', requireAuth, async (req, res, next) => {
    const { endpoint, keys } = req.body || {};
    if (typeof endpoint !== 'string' || !endpoint) {
      return res.status(400).json({ error: 'endpoint is required' });
    }
    if (!keys || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string') {
      return res.status(400).json({ error: 'keys.p256dh and keys.auth are required' });
    }
    try {
      await pool.query(
        `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (endpoint) DO UPDATE
           SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
        [req.user.id, endpoint, keys.p256dh, keys.auth]
      );
      res.status(201).json({ subscribed: true });
    } catch (err) {
      next(err);
    }
  });

  /** Turn notifications off for this device. */
  router.delete('/me/push-subscription', requireAuth, async (req, res, next) => {
    const { endpoint } = req.body || {};
    if (typeof endpoint !== 'string' || !endpoint) {
      return res.status(400).json({ error: 'endpoint is required' });
    }
    try {
      // Scoped by user_id too: a subscription can only be removed by the
      // account it belongs to, same discipline as every other per-user row.
      await pool.query(`DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2`, [endpoint, req.user.id]);
      res.json({ subscribed: false });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { buildAuthRouter, publicUser, normaliseEmail, EMAIL_RE };
