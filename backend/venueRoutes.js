'use strict';

/**
 * venueRoutes.js
 * ─────────────────────────────────────────────────────────────
 * The business side of the account model: creating a venue (which
 * makes you its owner) and managing who else is authorized to work
 * there.
 *
 * The staff list is the feature the brief calls "admin users can add
 * users they authorize to manage other users" — that's the `manager`
 * role. Owners and managers can both edit the staff list; attendants
 * can run the line but not change who else has access.
 */

const express = require('express');
const { requireAuth, requireVenueRole, requireUuidParams, STAFF_ROLES, STAFF_MANAGER_ROLES } = require('./auth');
const { normaliseEmail } = require('./authRoutes');
const { isPlausibleCoordinate } = require('./geofence');

const ASSIGNABLE_ROLES = ['attendant', 'manager'];

// Bounds for venues.enrollment_qr_ttl_seconds (see schema.sql). Short
// enough that a photographed check-in code stops being useful within
// one visit; long enough to actually be a configurable knob rather than
// a cosmetic one.
const MIN_ENROLLMENT_QR_TTL_SECONDS = 60;
const MAX_ENROLLMENT_QR_TTL_SECONDS = 3600;

function buildVenueRouter(pool) {
  const router = express.Router();

  /** Every venue the signed-in user staffs, with their role at each. */
  router.get('/venues/mine', requireAuth, async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        `SELECT v.id, v.name, v.address, v.geofence_lat, v.geofence_lng,
                v.geofence_radius_meters, v.avg_service_minutes,
                v.is_automation_enabled, v.enrollment_qr_ttl_seconds, m.role
           FROM venue_members m
           JOIN venues v ON v.id = m.venue_id
          WHERE m.user_id = $1
          ORDER BY v.name ASC`,
        [req.user.id]
      );
      res.json({ venues: rows });
    } catch (err) {
      next(err);
    }
  });

  /**
   * Create a venue. The creator becomes its owner in the same
   * transaction — a venue with no owner would be unreachable by
   * anyone, including the person who just made it.
   */
  router.post('/venues', requireAuth, async (req, res, next) => {
    const { name, address, geofenceLat, geofenceLng, geofenceRadiusMeters, avgServiceMinutes } = req.body || {};

    if (typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'name is required' });
    }
    // Coordinates are required here (unlike a location ping, where
    // "not shared yet" is a normal state): a venue with no geofence
    // centre would silently make every presence check meaningless.
    if (typeof geofenceLat !== 'number' || !isPlausibleCoordinate(geofenceLat, -90, 90)) {
      return res.status(400).json({ error: 'geofenceLat must be a number between -90 and 90' });
    }
    if (typeof geofenceLng !== 'number' || !isPlausibleCoordinate(geofenceLng, -180, 180)) {
      return res.status(400).json({ error: 'geofenceLng must be a number between -180 and 180' });
    }
    const radius = geofenceRadiusMeters ?? 150;
    if (!Number.isFinite(radius) || radius < 10 || radius > 20000) {
      return res.status(400).json({ error: 'geofenceRadiusMeters must be between 10 and 20000' });
    }
    const avgMinutes = avgServiceMinutes ?? 15;
    if (!Number.isInteger(avgMinutes) || avgMinutes < 1 || avgMinutes > 480) {
      return res.status(400).json({ error: 'avgServiceMinutes must be a whole number between 1 and 480' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `INSERT INTO venues (name, address, geofence_lat, geofence_lng, geofence_radius_meters, avg_service_minutes)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [name.trim(), address?.trim() || null, geofenceLat, geofenceLng, Math.round(radius), avgMinutes]
      );
      const venue = rows[0];
      await client.query(
        `INSERT INTO venue_members (venue_id, user_id, role, granted_by) VALUES ($1, $2, 'owner', $2)`,
        [venue.id, req.user.id]
      );
      // A business account that has now actually set up shop. Purely
      // so the app can stop showing them the "create your venue"
      // onboarding screen on next login.
      await client.query(`UPDATE users SET account_type = 'business' WHERE id = $1`, [req.user.id]);
      await client.query('COMMIT');
      res.status(201).json({ venue: { ...venue, role: 'owner' } });
    } catch (err) {
      await client.query('ROLLBACK');
      next(err);
    } finally {
      client.release();
    }
  });

  /**
   * Public venue info — no auth required. This is what a "join our line
   * remotely" link/QR (e.g. printed at the front desk, or shared on the
   * venue's own site or social page) resolves to before a customer signs
   * in: enough to show them what they're joining and how busy it is, and
   * nothing else. Deliberately excludes the staff roster, the exact
   * geofence coordinates, and anything else that's the staff-only
   * `GET /venues/:venueId` response.
   */
  router.get('/venues/:venueId/public', requireUuidParams('venueId'), async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        `SELECT v.id, v.name, v.address, v.avg_service_minutes,
                (SELECT count(*)::int FROM queue_entries e
                  WHERE e.venue_id = v.id AND e.status IN ('waiting', 'serving')) AS people_in_line
           FROM venues v
          WHERE v.id = $1`,
        [req.params.venueId]
      );
      if (!rows[0]) return res.status(404).json({ error: 'venue not found' });
      res.json({ venue: rows[0] });
    } catch (err) {
      next(err);
    }
  });

  /** Venue detail — any staff member. */
  router.get(
    '/venues/:venueId',
    requireUuidParams('venueId'),
    requireAuth,
    requireVenueRole(pool, STAFF_ROLES),
    async (req, res, next) => {
      try {
        const { rows } = await pool.query(`SELECT * FROM venues WHERE id = $1`, [req.params.venueId]);
        if (!rows[0]) return res.status(404).json({ error: 'venue not found' });
        res.json({ venue: { ...rows[0], role: req.venueRole } });
      } catch (err) {
        next(err);
      }
    }
  );

  /**
   * How long a check-in QR requested FOR this venue stays valid — see
   * the long comment on GET /me/enrollment-token in authRoutes.js for
   * why this is venue-scoped even though the token itself isn't.
   * Owner/manager only, same tier as the automation toggle and the
   * staff list: this is an operational setting for running the line,
   * not something an attendant needs to change mid-shift.
   */
  router.patch(
    '/venues/:venueId/enrollment-qr-ttl',
    requireUuidParams('venueId'),
    requireAuth,
    requireVenueRole(pool, STAFF_MANAGER_ROLES),
    async (req, res, next) => {
      const { ttlSeconds } = req.body || {};
      if (
        !Number.isInteger(ttlSeconds) ||
        ttlSeconds < MIN_ENROLLMENT_QR_TTL_SECONDS ||
        ttlSeconds > MAX_ENROLLMENT_QR_TTL_SECONDS
      ) {
        return res.status(400).json({
          error: `ttlSeconds must be a whole number between ${MIN_ENROLLMENT_QR_TTL_SECONDS} and ${MAX_ENROLLMENT_QR_TTL_SECONDS}`,
        });
      }
      try {
        const { rows } = await pool.query(
          `UPDATE venues SET enrollment_qr_ttl_seconds = $1, updated_at = now() WHERE id = $2 RETURNING enrollment_qr_ttl_seconds`,
          [ttlSeconds, req.params.venueId]
        );
        if (!rows[0]) return res.status(404).json({ error: 'venue not found' });
        res.json({ enrollment_qr_ttl_seconds: rows[0].enrollment_qr_ttl_seconds });
      } catch (err) {
        next(err);
      }
    }
  );

  /** The staff roster. Visible to any staff member — you can see who you work with. */
  router.get(
    '/venues/:venueId/members',
    requireUuidParams('venueId'),
    requireAuth,
    requireVenueRole(pool, STAFF_ROLES),
    async (req, res, next) => {
      try {
        const { rows } = await pool.query(
          `SELECT u.id AS user_id, u.email, u.full_name, u.phone, m.role, m.created_at
             FROM venue_members m
             JOIN users u ON u.id = m.user_id
            WHERE m.venue_id = $1
            ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'manager' THEN 1 ELSE 2 END, u.full_name ASC`,
          [req.params.venueId]
        );
        res.json({ members: rows });
      } catch (err) {
        next(err);
      }
    }
  );

  /**
   * Authorize an existing registered user as staff, by email.
   *
   * Deliberately does NOT create the account: an owner typing a
   * colleague's address should not be able to conjure a login for
   * someone who never agreed to one (and a typo would silently create
   * a ghost account nobody can access). The colleague registers
   * themselves first; this grants them access.
   */
  router.post(
    '/venues/:venueId/members',
    requireUuidParams('venueId'),
    requireAuth,
    requireVenueRole(pool, STAFF_MANAGER_ROLES),
    async (req, res, next) => {
      const email = normaliseEmail(req.body?.email);
      const role = req.body?.role || 'attendant';

      if (!email) return res.status(400).json({ error: 'email is required' });
      if (!ASSIGNABLE_ROLES.includes(role)) {
        return res.status(400).json({ error: "role must be 'attendant' or 'manager'" });
      }

      try {
        const { rows: userRows } = await pool.query(`SELECT id, email, full_name, phone FROM users WHERE email = $1`, [email]);
        const target = userRows[0];
        if (!target) {
          return res.status(404).json({ error: 'no registered user with that email — ask them to sign up first' });
        }

        const { rows } = await pool.query(
          `INSERT INTO venue_members (venue_id, user_id, role, granted_by)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (venue_id, user_id) DO UPDATE
             SET role = EXCLUDED.role, granted_by = EXCLUDED.granted_by, updated_at = now()
           -- An owner's role is never silently rewritten by an
           -- "add staff" action; changing that requires a transfer,
           -- which is out of scope here.
           WHERE venue_members.role <> 'owner'
           RETURNING role`,
          [req.params.venueId, target.id, role, req.user.id]
        );
        if (!rows[0]) {
          return res.status(409).json({ error: 'that user is the owner of this venue' });
        }

        res.status(201).json({
          member: { user_id: target.id, email: target.email, full_name: target.full_name, phone: target.phone, role: rows[0].role },
        });
      } catch (err) {
        next(err);
      }
    }
  );

  /** Revoke staff access. The owner row is protected. */
  router.delete(
    '/venues/:venueId/members/:userId',
    requireUuidParams('venueId', 'userId'),
    requireAuth,
    requireVenueRole(pool, STAFF_MANAGER_ROLES),
    async (req, res, next) => {
      if (req.params.userId === req.user.id) {
        return res.status(400).json({ error: 'you cannot remove your own access' });
      }
      try {
        const { rowCount } = await pool.query(
          `DELETE FROM venue_members WHERE venue_id = $1 AND user_id = $2 AND role <> 'owner'`,
          [req.params.venueId, req.params.userId]
        );
        if (rowCount === 0) {
          return res.status(404).json({ error: 'no removable staff member with that id at this venue' });
        }
        res.json({ removed: true });
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}

module.exports = { buildVenueRouter, ASSIGNABLE_ROLES };
