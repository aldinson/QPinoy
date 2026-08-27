'use strict';

/**
 * queueCore.js
 * ─────────────────────────────────────────────────────────────
 * Pure, framework- and database-agnostic queue ordering logic for
 * the "Presence vs Payment" engine. Nothing in this file talks to
 * Postgres, Express, or does anything that isn't a plain function
 * of its inputs — that's what makes it possible to unit-test the
 * exact rules (step-back math, drop math, reinstate math, manual
 * reorder math) with zero infrastructure, and to reuse the *same*
 * algorithm on the frontend for the live simulator.
 *
 * queueEngine.js wraps these functions with real SQL transactions
 * and row locks. QueueSimulator.jsx mirrors this same algorithm in
 * the browser (in camelCase, since it has no server to call) so the
 * interactive demo reflects the real backend rules, not a toy
 * simplification of them.
 *
 * Entry shape expected by these functions (subset of the
 * queue_entries table row — see schema.sql):
 *   {
 *     id: string,
 *     status: 'waiting' | 'serving',
 *     payment_tier: 'premium_secured' | 'standard_free',
 *     order_weight: number,
 *     is_checked_in: boolean,
 *     live_eta_minutes: number | null,
 *     expected_slot_at: string | Date | null,
 *     is_override_locked: boolean,
 *   }
 */

const GAP = 10; // default spacing used when appending to the end / seeding

function midpoint(a, b) {
  return (a + b) / 2;
}

/** Sort a list of active entries: the serving row (if any) first, then waiting rows by weight ascending. */
function sortActiveQueue(queue) {
  const serving = queue.filter((e) => e.status === 'serving');
  const waiting = queue
    .filter((e) => e.status === 'waiting')
    .slice()
    .sort((a, b) => a.order_weight - b.order_weight);
  return [...serving, ...waiting];
}

/**
 * Will this customer plausibly miss their slot window?
 * True only when they are NOT physically checked in (geofenced) AND
 * their live traffic ETA would land them after their expected slot
 * time. Missing ETA data is treated as "not at risk" (fail safe —
 * we never punish a customer for a stale/missing signal).
 */
function isAtRisk(entry, now = Date.now()) {
  if (entry.is_checked_in) return false;
  if (entry.live_eta_minutes == null || entry.expected_slot_at == null) return false;
  const predictedArrival = now + entry.live_eta_minutes * 60000;
  const expected = new Date(entry.expected_slot_at).getTime();
  return predictedArrival > expected;
}

/**
 * Two-Slot-Prior Automation Trigger.
 * Given the full active queue (serving row first, then waiting rows
 * sorted by weight) and the id of the row that JUST became
 * 'serving', decide whether the customer sitting exactly two slots
 * behind them needs to be stepped back (premium/secured tier) or
 * dropped (standard/free tier).
 *
 * This function never mutates its input and never touches the
 * network or a clock beyond the `now` you pass it. It returns a
 * plain description of what should change; callers persist `patch`
 * (a partial row update) if `mutated` is true.
 */
function evaluateTwoSlotPrior(sortedQueue, servingId, options = {}) {
  const { automationEnabled = true, now = Date.now() } = options;

  if (!automationEnabled) {
    return { mutated: false, reason: 'automation_disabled' };
  }

  const servingIdx = sortedQueue.findIndex((e) => e.id === servingId);
  if (servingIdx === -1) {
    return { mutated: false, reason: 'serving_row_not_found' };
  }

  const targetIdx = servingIdx + 2;
  const target = sortedQueue[targetIdx];
  if (!target) {
    return { mutated: false, reason: 'no_customer_two_slots_back' };
  }

  if (target.is_override_locked) {
    return { mutated: false, reason: 'override_locked', targetId: target.id };
  }

  if (!isAtRisk(target, now)) {
    return { mutated: false, reason: 'on_track', targetId: target.id };
  }

  if (target.payment_tier === 'premium_secured') {
    return applyStepBack(sortedQueue, targetIdx);
  }
  return applyDrop(sortedQueue, targetIdx);
}

/**
 * Premium/secured safety net: cascade down exactly ONE slot.
 * Implemented as a single-row weight update — we recompute only the
 * target's own weight, as the midpoint between whoever will now be
 * directly ahead of them and whoever will be directly behind them.
 * No other row is touched, so this is O(1) regardless of queue size.
 */
function applyStepBack(sortedQueue, targetIdx) {
  const target = sortedQueue[targetIdx];
  const below = sortedQueue[targetIdx + 1];

  if (!below) {
    // Already at the very back of the line — nowhere to step back into.
    return { mutated: false, reason: 'already_last_in_line', targetId: target.id };
  }

  const belowBelow = sortedQueue[targetIdx + 2];
  const newWeight = belowBelow ? midpoint(below.order_weight, belowBelow.order_weight) : below.order_weight + GAP;

  return {
    mutated: true,
    reason: 'stepped_back',
    targetId: target.id,
    patch: { order_weight: newWeight, last_automation_flag: 'stepped_back' },
  };
}

/**
 * Standard/free tier: instantly drop to the back of the active line.
 * Single-row update: order_weight = MAX(active order_weight) + GAP.
 */
function applyDrop(sortedQueue, targetIdx) {
  const target = sortedQueue[targetIdx];
  const maxWeight = Math.max(...sortedQueue.map((e) => e.order_weight));
  const newWeight = maxWeight + GAP;

  return {
    mutated: true,
    reason: 'dropped',
    targetId: target.id,
    patch: { order_weight: newWeight, last_automation_flag: 'dropped' },
  };
}

/**
 * Attendant "Lock-Back" override. Places `entryId` exactly halfway
 * between whoever is currently serving and whoever is currently
 * first in the waiting line (excluding the entry itself) — so
 * they're guaranteed to be served next — then marks them
 * override-locked so the automation engine leaves them alone from
 * now on, even if they still show up as "not checked in."
 */
function computeReinstate(sortedQueue, entryId) {
  const target = sortedQueue.find((e) => e.id === entryId);
  if (!target) return { mutated: false, reason: 'not_found' };
  if (target.status === 'serving') return { mutated: false, reason: 'already_serving' };

  const serving = sortedQueue.find((e) => e.status === 'serving');
  const nextInLine = sortedQueue.find((e) => e.status === 'waiting' && e.id !== entryId);

  let newWeight;
  if (serving && nextInLine) newWeight = midpoint(serving.order_weight, nextInLine.order_weight);
  else if (nextInLine) newWeight = nextInLine.order_weight / 2;
  else if (serving) newWeight = serving.order_weight + GAP / 2;
  else newWeight = GAP;

  return {
    mutated: true,
    reason: 'reinstated',
    targetId: entryId,
    patch: { order_weight: newWeight, is_override_locked: true, last_automation_flag: 'reinstated' },
  };
}

/**
 * Manual attendant reorder — move one waiting row exactly one slot
 * up or down. This is what the dashboard falls back to when
 * automation is paused (or any time an attendant wants to
 * hand-correct the line). Same midpoint math as everything else in
 * this file: only the moved row's weight ever changes.
 */
function computeMove(sortedWaitingQueue, entryId, direction) {
  const idx = sortedWaitingQueue.findIndex((e) => e.id === entryId);
  if (idx === -1) return { mutated: false, reason: 'not_found' };

  if (direction === 'up') {
    if (idx === 0) return { mutated: false, reason: 'already_at_front' };
    const above = sortedWaitingQueue[idx - 1];
    const aboveAbove = sortedWaitingQueue[idx - 2];
    const newWeight = aboveAbove ? midpoint(aboveAbove.order_weight, above.order_weight) : above.order_weight / 2;
    return { mutated: true, reason: 'moved_up', targetId: entryId, patch: { order_weight: newWeight } };
  }

  if (direction === 'down') {
    if (idx === sortedWaitingQueue.length - 1) return { mutated: false, reason: 'already_at_back' };
    const below = sortedWaitingQueue[idx + 1];
    const belowBelow = sortedWaitingQueue[idx + 2];
    const newWeight = belowBelow ? midpoint(below.order_weight, belowBelow.order_weight) : below.order_weight + GAP;
    return { mutated: true, reason: 'moved_down', targetId: entryId, patch: { order_weight: newWeight } };
  }

  return { mutated: false, reason: 'invalid_direction' };
}

module.exports = {
  GAP,
  midpoint,
  sortActiveQueue,
  isAtRisk,
  evaluateTwoSlotPrior,
  applyStepBack,
  applyDrop,
  computeReinstate,
  computeMove,
};
