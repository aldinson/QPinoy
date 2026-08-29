'use strict';

/**
 * auth.js
 * ─────────────────────────────────────────────────────────────
 * Express middleware for authentication (who are you?) and per-venue
 * authorization (what are you allowed to do *here*?).
 *
 * The authorization model in one line: **a user's powers at a venue
 * come from their `venue_members` row for that venue, and nothing
 * else.** `users.account_type` decides which home screen you land on
 * after login; it is never consulted for a permission decision. That
 * separation is what lets the same person be a customer at the barber
 * downstairs and an attendant at their own shop, on one account.
 */

const { verifySessionToken, TokenError } = require('./tokens');

// Role capabilities, kept as data rather than scattered if-statements
// so "who can do what" is auditable in one place.
const ROLE_RANK = { attendant: 1, manager: 2, owner: 3 };

/** Roles allowed to run the line: call next, reorder, enroll customers, toggle automation. */
const STAFF_ROLES = ['attendant', 'manager', 'owner'];
/** Roles allowed to change who else works here. Attendants deliberately excluded. */
const STAFF_MANAGER_ROLES = ['manager', 'owner'];

/**
 * Populates `req.user` from a Bearer token when one is present and
 * valid, and leaves it null otherwise — this one never rejects.
 * Routes that require a user use `requireAuth` below; routes that
 * merely *behave differently* when signed in (none yet, but the
 * customer-facing queue view is the obvious future case) can read
 * `req.user` directly.
 */
function attachUser(pool) {
  return async (req, res, next) => {
    req.user = null;
    const header = req.headers.authorization || '';
    const match = /^Bearer (.+)$/i.exec(header.trim());
    if (!match) return next();

    let claims;
    try {
      claims = verifySessionToken(match[1]);
    } catch (err) {
      // An invalid/expired token is treated as "not signed in" here.
      // requireAuth turns that into a 401 for protected routes, which
      // keeps the "why" in one place instead of two.
      if (err instanceof TokenError) return next();
      return next(err);
    }

    try {
      const { rows } = await pool.query(
        `SELECT id, email, full_name, phone, account_type FROM users WHERE id = $1`,
        [claims.sub]
      );
      // A token whose user has since been deleted is not a session.
      req.user = rows[0] || null;
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** 401 unless a valid session token identified a real, existing user. */
function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'authentication required' });
  next();
}

/**
 * Require that the signed-in user holds one of `allowedRoles` at the
 * venue named by `:venueId`, and stash the row on `req.venueRole`.
 *
 * Returns 404 rather than 403 when the user has no membership at all.
 * A venue's existence is not public information: answering 403 would
 * confirm "this venue ID is real, you're just not staff", which is a
 * free enumeration oracle over every venue in the system.
 */
function requireVenueRole(pool, allowedRoles = STAFF_ROLES) {
  return async (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'authentication required' });
    try {
      const { rows } = await pool.query(
        `SELECT role FROM venue_members WHERE venue_id = $1 AND user_id = $2`,
        [req.params.venueId, req.user.id]
      );
      const role = rows[0]?.role;
      if (!role) return res.status(404).json({ error: 'venue not found' });
      if (!allowedRoles.includes(role)) {
        return res.status(403).json({ error: 'your role at this venue does not permit this action' });
      }
      req.venueRole = role;
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** True if `role` is at least as privileged as `minimum`. */
function roleAtLeast(role, minimum) {
  return (ROLE_RANK[role] || 0) >= (ROLE_RANK[minimum] || 0);
}

/**
 * Malformed UUIDs would otherwise reach Postgres and come back as a
 * 500 (`invalid input syntax for type uuid`). A bad path parameter is
 * a client error, so it gets a 400 before any query runs.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireUuidParams(...names) {
  return (req, res, next) => {
    for (const name of names) {
      const value = req.params[name];
      if (value !== undefined && !UUID_RE.test(value)) {
        return res.status(400).json({ error: `${name} must be a UUID` });
      }
    }
    next();
  };
}

module.exports = {
  attachUser,
  requireAuth,
  requireVenueRole,
  requireUuidParams,
  roleAtLeast,
  isUuid: (v) => typeof v === 'string' && UUID_RE.test(v),
  STAFF_ROLES,
  STAFF_MANAGER_ROLES,
};
