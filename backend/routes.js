'use strict';

/**
 * routes.js
 * ─────────────────────────────────────────────────────────────
 * Thin REST layer over queueEngine.js. Kept intentionally dumb:
 * parse the request, call the engine, return its result. All
 * decision-making already happened in queueCore.js / queueEngine.js.
 *
 * Every route in this file is staff-only — running a venue's line is
 * not something a customer does to themselves. The one exception is
 * the location ping, which a customer may send for their OWN ticket;
 * see the comment there.
 */

const express = require('express');
const { getLiveQueue, joinQueue, callNextCustomer, reinstateSlot, moveOneSlot, rebalanceIfNeeded } = require('./queueEngine');
const { isWithinGeofence, isPlausibleCoordinate } = require('./geofence');
const { getLiveEtaMinutes } = require('./distanceMatrixClient');
const { requireAuth, requireVenueRole, requireUuidParams, STAFF_ROLES } = require('./auth');
const { verifyEnrollmentToken, TokenError } = require('./tokens');
const { LIMITS, bucketKey, clientIp, rateLimitMiddleware } = require('./rateLimit');

function buildQueueRouter(pool) {
  const router = express.Router();

  // Applied per-route below rather than router-wide, because the
  // location ping needs a different rule than "must be staff here".
  const staffOnly = [requireUuidParams('venueId'), requireAuth, requireVenueRole(pool, STAFF_ROLES)];

  // GET the live line for a venue, already in serve order.
  router.get('/venues/:venueId/queue', staffOnly, async (req, res, next) => {
    try {
      const queue = await getLiveQueue(pool, req.params.venueId);
      res.json({ queue });
    } catch (err) {
      next(err);
    }
  });

  /**
   * Enroll a registered customer by scanning the QR code on their
   * phone. This is the primary way people join a line: the customer
   * signs up on their own, but only staff can put them in a venue's
   * queue, and the QR is what proves the customer was physically
   * present and consented.
   *
   * The scan gives staff a signed enrollment token (see tokens.js).
   * Note what is NOT trusted from the request: the customer's
   * identity comes out of the token's signature, never from a user ID
   * in the body — otherwise any staff member could enroll any user in
   * the system by guessing IDs.
   */
  router.post('/venues/:venueId/queue/enroll', staffOnly, async (req, res, next) => {
    const { enrollmentToken, paymentTier } = req.body || {};
    if (typeof enrollmentToken !== 'string' || !enrollmentToken) {
      return res.status(400).json({ error: 'enrollmentToken is required' });
    }
    if (paymentTier !== undefined && paymentTier !== 'standard_free' && paymentTier !== 'premium_secured') {
      return res.status(400).json({ error: "paymentTier must be 'standard_free' or 'premium_secured'" });
    }

    let claims;
    try {
      claims = verifyEnrollmentToken(enrollmentToken.trim());
    } catch (err) {
      if (err instanceof TokenError) {
        // Expired is by far the most common failure (the customer's
        // screen was showing a stale code), and it is worth telling
        // staff apart from a genuinely bogus scan so they know to
        // just ask for a refresh rather than start troubleshooting.
        const expired = err.reason === 'expired';
        return res.status(400).json({
          error: expired
            ? 'that QR code has expired — ask the customer to show a fresh one'
            : 'that QR code is not a valid QPinoy check-in code',
          reason: err.reason,
        });
      }
      return next(err);
    }

    try {
      const { rows } = await pool.query(`SELECT id, full_name, phone FROM users WHERE id = $1`, [claims.sub]);
      const customer = rows[0];
      if (!customer) return res.status(404).json({ error: 'that account no longer exists' });

      const result = await joinQueue(pool, req.params.venueId, {
        customerName: customer.full_name,
        customerPhone: customer.phone,
        paymentTier: paymentTier || 'standard_free',
        userId: customer.id,
      });

      if (result.reason === 'already_in_queue') {
        return res.status(409).json({ error: `${customer.full_name} is already in this line` });
      }
      if (!result.mutated) return res.status(404).json({ error: 'venue not found' });
      res.status(201).json({ entry: result.entry });
    } catch (err) {
      next(err);
    }
  });

  /**
   * Add a walk-in by name — someone with no QPinoy account at all.
   * Still staff-only, and the resulting row has no `user_id`, so that
   * customer can't later claim it or update their own location. Kept
   * because a real front desk cannot turn away the person who doesn't
   * have the app.
   */
  router.post('/venues/:venueId/queue', staffOnly, async (req, res, next) => {
    const { customerName, customerPhone, paymentTier } = req.body || {};
    if (typeof customerName !== 'string' || !customerName.trim()) {
      return res.status(400).json({ error: 'body.customerName is required' });
    }
    if (paymentTier !== undefined && paymentTier !== 'standard_free' && paymentTier !== 'premium_secured') {
      return res.status(400).json({ error: "body.paymentTier must be 'standard_free' or 'premium_secured'" });
    }
    if (customerPhone !== undefined && customerPhone !== null && typeof customerPhone !== 'string') {
      return res.status(400).json({ error: 'body.customerPhone must be a string' });
    }
    try {
      const result = await joinQueue(pool, req.params.venueId, {
        customerName: customerName.trim(),
        customerPhone: customerPhone ? customerPhone.trim() : null,
        paymentTier: paymentTier || 'standard_free',
      });
      if (!result.mutated) return res.status(404).json({ error: 'venue not found' });
      res.status(201).json({ entry: result.entry });
    } catch (err) {
      next(err);
    }
  });

  // Attendant calls the next customer. Completes whoever was serving
  // before, promotes this row to 'serving', and fires the two-slot-
  // prior automation trigger — all as one atomic operation.
  router.post('/venues/:venueId/queue/:entryId/serve', staffOnly, async (req, res, next) => {
    try {
      const result = await callNextCustomer(pool, req.params.venueId, req.params.entryId);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // Attendant "Lock-Back" override.
  router.post('/venues/:venueId/queue/:entryId/reinstate', staffOnly, async (req, res, next) => {
    try {
      const result = await reinstateSlot(pool, req.params.venueId, req.params.entryId);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // Manual one-slot nudge (used most when automation is paused).
  router.post('/venues/:venueId/queue/:entryId/move', staffOnly, async (req, res, next) => {
    const { direction } = req.body || {};
    if (direction !== 'up' && direction !== 'down') {
      return res.status(400).json({ error: "body.direction must be 'up' or 'down'" });
    }
    try {
      const result = await moveOneSlot(pool, req.params.venueId, req.params.entryId, direction);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // Global automation toggle.
  router.patch('/venues/:venueId/automation', staffOnly, async (req, res, next) => {
    const { enabled } = req.body || {};
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'body.enabled must be a boolean' });
    }
    try {
      const { rows } = await pool.query(
        `UPDATE venues SET is_automation_enabled = $1, updated_at = now() WHERE id = $2 RETURNING is_automation_enabled`,
        [enabled, req.params.venueId]
      );
      if (!rows[0]) return res.status(404).json({ error: 'venue not found' });
      res.json({ is_automation_enabled: rows[0].is_automation_enabled });
    } catch (err) {
      next(err);
    }
  });

  // Geofence/ETA ping. Called by a customer's phone (or a background
  // poller) on a timer, carrying ONLY raw coordinates — never a
  // checked-in verdict. The server is the one that decides whether
  // that counts as "checked in," by measuring it against the venue's
  // actual geofence; a client claiming `isCheckedIn: true` here would
  // let anyone spoof presence. Live ETA is looked up the same way,
  // through the swappable distanceMatrixClient adapter.
  /**
   * Throttles location pings per signed-in user.
   *
   * Keyed by user id rather than IP because this endpoint is
   * authenticated: the user id is the precise actor, and IP would
   * lump every customer on a venue's wifi into one shared budget.
   * Placed after requireAuth (so `req.user` exists) but before the
   * ownership lookup and the geofence/ETA work, so a flood is refused
   * before it costs a query — and before it can reach the Distance
   * Matrix adapter, which on a real API key costs actual money per
   * call.
   */
  const locationRateLimit = rateLimitMiddleware(pool, {
    ...LIMITS.LOCATION,
    key: (req) => (req.user ? bucketKey('location', 'user', req.user.id) : bucketKey('location', 'ip', clientIp(req))),
    message: 'too many location updates — slow down',
  });

  router.patch(
    '/venues/:venueId/queue/:entryId/location',
    requireUuidParams('venueId', 'entryId'),
    requireAuth,
    locationRateLimit,
    /**
     * Unlike every other route here, this one is NOT staff-only.
     *
     * Two callers are legitimate: the customer whose ticket this is
     * (their phone pings as they travel), and staff at the venue
     * (correcting a reading from the front desk). Anyone else must be
     * refused — otherwise any signed-in user could push coordinates
     * into a stranger's ticket and shove them down the queue, which
     * is precisely the "customer-scoped token" hole DEPLOYMENT.md
     * flagged as unbuilt.
     *
     * Ownership is resolved from the entry's own `user_id`, so a
     * walk-in row (user_id NULL) is staff-only by construction.
     */
    async (req, res, next) => {
      try {
        const { rows } = await pool.query(
          `SELECT e.user_id,
                  (SELECT m.role FROM venue_members m
                    WHERE m.venue_id = e.venue_id AND m.user_id = $3) AS viewer_role
             FROM queue_entries e
            WHERE e.id = $1 AND e.venue_id = $2`,
          [req.params.entryId, req.params.venueId, req.user.id]
        );
        const entry = rows[0];
        if (!entry) return res.status(404).json({ error: 'queue entry not found for this venue' });

        const isOwnTicket = entry.user_id && entry.user_id === req.user.id;
        if (!isOwnTicket && !entry.viewer_role) {
          return res.status(403).json({ error: 'you can only update your own place in line' });
        }
        next();
      } catch (err) {
        next(err);
      }
    },
    async (req, res, next) => {
    const { lat, lng } = req.body || {};
    if (!isPlausibleCoordinate(lat, -90, 90)) {
      return res.status(400).json({ error: 'lat must be a finite number between -90 and 90, or omitted' });
    }
    if (!isPlausibleCoordinate(lng, -180, 180)) {
      return res.status(400).json({ error: 'lng must be a finite number between -180 and 180, or omitted' });
    }
    try {
      const { rows: venueRows } = await pool.query(
        `SELECT geofence_lat, geofence_lng, geofence_radius_meters FROM venues WHERE id = $1`,
        [req.params.venueId]
      );
      const venue = venueRows[0];
      if (!venue) return res.status(404).json({ error: 'venue not found' });

      const isCheckedIn = isWithinGeofence(lat ?? null, lng ?? null, venue);
      const liveEtaMinutes = isCheckedIn
        ? 0
        : await getLiveEtaMinutes({
            originLat: lat ?? null,
            originLng: lng ?? null,
            destLat: venue.geofence_lat,
            destLng: venue.geofence_lng,
          });

      // Scoped by BOTH id and venue_id: without the venue_id check, an
      // entryId that actually belongs to a different venue would still
      // match on id alone, silently overwriting that other venue's
      // customer with THIS venue's geofence result. rowCount also has
      // to be checked — an unmatched entryId must 404, not report a
      // fabricated "success".
      const { rowCount } = await pool.query(
        `UPDATE queue_entries
            SET is_checked_in = $1, live_eta_minutes = $2, last_lat = $3, last_lng = $4, updated_at = now()
          WHERE id = $5 AND venue_id = $6`,
        [isCheckedIn, liveEtaMinutes, lat ?? null, lng ?? null, req.params.entryId, req.params.venueId]
      );
      if (rowCount === 0) return res.status(404).json({ error: 'queue entry not found for this venue' });
      res.json({ is_checked_in: isCheckedIn, live_eta_minutes: liveEtaMinutes });
    } catch (err) {
      next(err);
    }
    }
  );

  // Maintenance endpoint — wire this to a nightly cron, not a button.
  router.post('/venues/:venueId/rebalance', staffOnly, async (req, res, next) => {
    try {
      const result = await rebalanceIfNeeded(pool, req.params.venueId);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { buildQueueRouter };
