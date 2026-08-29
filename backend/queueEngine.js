'use strict';

/**
 * queueEngine.js
 * ─────────────────────────────────────────────────────────────
 * The database-facing half of the queue engine. Every exported
 * function here:
 *   1. Opens a transaction and SELECTs the relevant rows FOR UPDATE
 *      (row-level locks), so two attendants tapping buttons at the
 *      same moment — or automation firing while an attendant drags
 *      a row — can never race each other into a corrupt order.
 *   2. Hands the plain-JS row data to the pure functions in
 *      queueCore.js to decide *what* should change.
 *   3. Persists the result with a single-row UPDATE and commits.
 *
 * No sorting/threshold/tier logic lives in this file — that's the
 * whole point of keeping queueCore.js pure and separately tested.
 */

const {
  evaluateTwoSlotPrior,
  computeReinstate,
  computeMove,
  GAP,
} = require('./queueCore');

const ACTIVE_STATUSES = ['waiting', 'serving'];

/** Fetch the live, ordered queue for a venue: serving row (if any) first, then waiting rows by weight. Read-only, no lock. */
async function getLiveQueue(db, venueId) {
  const { rows } = await db.query(
    `SELECT * FROM queue_entries
      WHERE venue_id = $1 AND status = ANY($2::queue_status[])
      ORDER BY (status = 'serving') DESC, order_weight ASC`,
    [venueId, ACTIVE_STATUSES]
  );
  return rows;
}

/**
 * Attendant calls the next customer. This is the single entry point
 * for the whole "call next" operation — on purpose. Completing the
 * previous serving row, promoting the target to 'serving', AND
 * firing the two-slot-prior automation trigger all happen inside
 * ONE transaction under ONE set of row locks. An earlier version of
 * this function only did the trigger evaluation and expected the
 * caller to flip the status first in a separate transaction — that
 * left a window between the two transactions where a concurrent
 * action could interleave. Collapsing it into one call removes that
 * window entirely, and also removes an easy way for a caller to get
 * the sequencing wrong.
 */
async function callNextCustomer(db, venueId, entryId) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const venueRes = await client.query(`SELECT is_automation_enabled FROM venues WHERE id = $1 FOR SHARE`, [venueId]);
    if (!venueRes.rows[0]) {
      await client.query('ROLLBACK');
      return { mutated: false, reason: 'venue_not_found' };
    }
    const automationEnabled = Boolean(venueRes.rows[0].is_automation_enabled);

    // Lock the entire active line so nothing can reorder underneath us.
    const { rows: queue } = await client.query(
      `SELECT * FROM queue_entries
        WHERE venue_id = $1 AND status = ANY($2::queue_status[])
        ORDER BY (status = 'serving') DESC, order_weight ASC
        FOR UPDATE`,
      [venueId, ACTIVE_STATUSES]
    );

    const target = queue.find((r) => r.id === entryId);
    if (!target) {
      await client.query('ROLLBACK');
      return { mutated: false, reason: 'entry_not_found' };
    }

    const previouslyServing = queue.find((r) => r.status === 'serving' && r.id !== entryId);
    if (previouslyServing) {
      await client.query(`UPDATE queue_entries SET status = 'served' WHERE id = $1`, [previouslyServing.id]);
    }
    await client.query(`UPDATE queue_entries SET status = 'serving' WHERE id = $1`, [entryId]);

    // Reconstruct the post-promotion ordering in memory — target
    // first, then everyone still waiting, sorted by weight — so
    // evaluateTwoSlotPrior sees the real post-call line without a
    // second round trip inside the same lock.
    target.status = 'serving';
    const stillWaiting = queue
      .filter((r) => r.id !== entryId && r.id !== previouslyServing?.id && r.status === 'waiting')
      .sort((a, b) => a.order_weight - b.order_weight);
    const sorted = [target, ...stillWaiting];

    const result = evaluateTwoSlotPrior(sorted, entryId, { automationEnabled, now: Date.now() });
    if (result.mutated) {
      await applyPatch(client, result.targetId, result.patch);
    }

    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Customer joins the line. Locked under the same active-queue FOR
 * UPDATE as every other mutation here, so a join racing a concurrent
 * join (or a rebalance) can't compute a stale MAX(order_weight) and
 * collide on the same slot. expected_slot_at is a rough estimate —
 * "however many people are ahead of you, times the venue's average
 * service time" — good enough to seed isAtRisk() until real ETA pings
 * start arriving; it is never treated as a promise elsewhere in the
 * system.
 */
async function joinQueue(db, venueId, { customerName, customerPhone, paymentTier, userId = null }) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const venueRes = await client.query(`SELECT avg_service_minutes FROM venues WHERE id = $1 FOR SHARE`, [venueId]);
    if (!venueRes.rows[0]) {
      await client.query('ROLLBACK');
      return { mutated: false, reason: 'venue_not_found' };
    }
    const avgServiceMinutes = venueRes.rows[0].avg_service_minutes;

    const { rows: active } = await client.query(
      `SELECT order_weight FROM queue_entries
        WHERE venue_id = $1 AND status = ANY($2::queue_status[])
        FOR UPDATE`,
      [venueId, ACTIVE_STATUSES]
    );

    const newWeight = active.length ? Math.max(...active.map((r) => r.order_weight)) + GAP : GAP;
    const expectedSlotMinutes = active.length * avgServiceMinutes;

    let rows;
    try {
      ({ rows } = await client.query(
        `INSERT INTO queue_entries (venue_id, user_id, customer_name, customer_phone, payment_tier, order_weight, expected_slot_at)
         VALUES ($1, $2, $3, $4, $5, $6, now() + $7 * interval '1 minute')
         RETURNING *`,
        [venueId, userId, customerName, customerPhone ?? null, paymentTier, newWeight, expectedSlotMinutes]
      ));
    } catch (err) {
      // 23505 on idx_one_active_entry_per_user_per_venue: this
      // registered customer already holds a live ticket here. Two
      // staff phones scanning the same QR at the same moment both
      // reach this line; the database picks a winner and the loser
      // gets a clean "already in line" instead of a 500.
      if (err.code === '23505') {
        await client.query('ROLLBACK');
        return { mutated: false, reason: 'already_in_queue' };
      }
      throw err;
    }

    await client.query('COMMIT');
    return { mutated: true, reason: 'joined', entry: rows[0] };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Attendant "Lock-Back" override — rescue a customer whose GPS
 * likely misfired (e.g. indoor degradation inside a mall). Places
 * them between the currently-serving customer and next-in-line, and
 * locks them out of future automated evaluation.
 */
async function reinstateSlot(db, venueId, entryId) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: queue } = await client.query(
      `SELECT * FROM queue_entries
        WHERE venue_id = $1 AND status = ANY($2::queue_status[])
        ORDER BY (status = 'serving') DESC, order_weight ASC
        FOR UPDATE`,
      [venueId, ACTIVE_STATUSES]
    );

    const result = computeReinstate(queue, entryId);
    if (result.mutated) {
      await applyPatch(client, result.targetId, result.patch);
    }

    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Manual reorder — attendant nudges a waiting row up or down one
 * slot. Available any time, but this is the primary tool once
 * automation is toggled off.
 */
async function moveOneSlot(db, venueId, entryId, direction) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: waiting } = await client.query(
      `SELECT * FROM queue_entries
        WHERE venue_id = $1 AND status = 'waiting'
        ORDER BY order_weight ASC
        FOR UPDATE`,
      [venueId]
    );

    const result = computeMove(waiting, entryId, direction);
    if (result.mutated) {
      await applyPatch(client, result.targetId, result.patch);
    }

    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Small helper: persist a `{order_weight?, is_override_locked?, last_automation_flag?}` patch as one UPDATE. */
async function applyPatch(client, entryId, patch) {
  const fields = Object.keys(patch);
  const setClause = fields.map((f, i) => `${f} = $${i + 2}`).join(', ');
  const values = fields.map((f) => patch[f]);
  await client.query(`UPDATE queue_entries SET ${setClause} WHERE id = $1`, [entryId, ...values]);
}

/**
 * Maintenance: rebalance all active weights back to clean, evenly
 * spaced integers. Floating-point midpoint splitting can, after many
 * thousands of consecutive reorders on the same gap, approach the
 * precision limit of DOUBLE PRECISION (~15-17 significant digits).
 * Run this on a schedule (e.g. nightly per venue, during a lull) or
 * lazily whenever two adjacent weights differ by less than
 * REBALANCE_EPSILON. It never changes relative order — only spacing.
 */
const REBALANCE_EPSILON = 1e-9;

async function rebalanceIfNeeded(db, venueId) {
  const queue = await getLiveQueue(db, venueId);
  const needsRebalance = queue.some(
    (r, i) => i > 0 && Math.abs(r.order_weight - queue[i - 1].order_weight) < REBALANCE_EPSILON
  );
  if (!needsRebalance) return { rebalanced: false };

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    for (let i = 0; i < queue.length; i++) {
      await client.query(`UPDATE queue_entries SET order_weight = $1 WHERE id = $2`, [(i + 1) * GAP, queue[i].id]);
    }
    await client.query('COMMIT');
    return { rebalanced: true, rows: queue.length };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  getLiveQueue,
  joinQueue,
  callNextCustomer,
  reinstateSlot,
  moveOneSlot,
  rebalanceIfNeeded,
};
