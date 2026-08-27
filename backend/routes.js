'use strict';

/**
 * routes.js
 * ─────────────────────────────────────────────────────────────
 * Thin REST layer over queueEngine.js. Kept intentionally dumb:
 * parse the request, call the engine, return its result. All
 * decision-making already happened in queueCore.js / queueEngine.js.
 */

const express = require('express');
const { getLiveQueue, callNextCustomer, reinstateSlot, moveOneSlot, rebalanceIfNeeded } = require('./queueEngine');
const { isWithinGeofence, isPlausibleCoordinate } = require('./geofence');
const { getLiveEtaMinutes } = require('./distanceMatrixClient');

function buildQueueRouter(pool) {
  const router = express.Router();

  // GET the live line for a venue, already in serve order.
  router.get('/venues/:venueId/queue', async (req, res, next) => {
    try {
      const queue = await getLiveQueue(pool, req.params.venueId);
      res.json({ queue });
    } catch (err) {
      next(err);
    }
  });

  // Attendant calls the next customer. Completes whoever was serving
  // before, promotes this row to 'serving', and fires the two-slot-
  // prior automation trigger — all as one atomic operation.
  router.post('/venues/:venueId/queue/:entryId/serve', async (req, res, next) => {
    try {
      const result = await callNextCustomer(pool, req.params.venueId, req.params.entryId);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // Attendant "Lock-Back" override.
  router.post('/venues/:venueId/queue/:entryId/reinstate', async (req, res, next) => {
    try {
      const result = await reinstateSlot(pool, req.params.venueId, req.params.entryId);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // Manual one-slot nudge (used most when automation is paused).
  router.post('/venues/:venueId/queue/:entryId/move', async (req, res, next) => {
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
  router.patch('/venues/:venueId/automation', async (req, res, next) => {
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
  router.patch('/venues/:venueId/queue/:entryId/location', async (req, res, next) => {
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

      await pool.query(
        `UPDATE queue_entries
            SET is_checked_in = $1, live_eta_minutes = $2, last_lat = $3, last_lng = $4, updated_at = now()
          WHERE id = $5`,
        [isCheckedIn, liveEtaMinutes, lat ?? null, lng ?? null, req.params.entryId]
      );
      res.json({ is_checked_in: isCheckedIn, live_eta_minutes: liveEtaMinutes });
    } catch (err) {
      next(err);
    }
  });

  // Maintenance endpoint — wire this to a nightly cron, not a button.
  router.post('/venues/:venueId/rebalance', async (req, res, next) => {
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
