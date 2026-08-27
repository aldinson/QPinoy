'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { midpoint, isAtRisk, evaluateTwoSlotPrior, computeReinstate, computeMove } = require('./queueCore');

function entry(overrides) {
  return {
    id: 'x',
    status: 'waiting',
    payment_tier: 'standard_free',
    order_weight: 0,
    is_checked_in: false,
    live_eta_minutes: null,
    expected_slot_at: null,
    is_override_locked: false,
    ...overrides,
  };
}

// ─── midpoint ────────────────────────────────────────────────────
test('midpoint returns the arithmetic mean', () => {
  assert.equal(midpoint(10, 20), 15);
  assert.equal(midpoint(0, 1), 0.5);
});

// ─── isAtRisk ────────────────────────────────────────────────────
test('isAtRisk: checked-in customers are never at risk, no matter the ETA', () => {
  const e = entry({ is_checked_in: true, live_eta_minutes: 999, expected_slot_at: new Date(0).toISOString() });
  assert.equal(isAtRisk(e), false);
});

test('isAtRisk: missing ETA/slot data fails safe to "not at risk"', () => {
  const e = entry({ is_checked_in: false, live_eta_minutes: null, expected_slot_at: new Date().toISOString() });
  assert.equal(isAtRisk(e), false);
});

test('isAtRisk: not checked in + ETA lands after the expected slot => at risk', () => {
  const now = 1_000_000;
  const e = entry({ is_checked_in: false, live_eta_minutes: 25, expected_slot_at: new Date(now + 5 * 60000).toISOString() });
  assert.equal(isAtRisk(e, now), true); // 25 min ETA blows past a 5 min window
});

test('isAtRisk: not checked in but ETA still beats the window => not at risk', () => {
  const now = 1_000_000;
  const e = entry({ is_checked_in: false, live_eta_minutes: 3, expected_slot_at: new Date(now + 12 * 60000).toISOString() });
  assert.equal(isAtRisk(e, now), false);
});

// ─── evaluateTwoSlotPrior: guards ────────────────────────────────
test('evaluateTwoSlotPrior: automation disabled short-circuits before anything else', () => {
  const queue = [
    entry({ id: 'a', status: 'serving', order_weight: 10 }),
    entry({ id: 'b', order_weight: 20 }),
    entry({ id: 'c', order_weight: 30, live_eta_minutes: 99, expected_slot_at: new Date(0).toISOString() }),
  ];
  const result = evaluateTwoSlotPrior(queue, 'a', { automationEnabled: false, now: 0 });
  assert.equal(result.mutated, false);
  assert.equal(result.reason, 'automation_disabled');
});

test('evaluateTwoSlotPrior: no customer two slots back => no-op', () => {
  const queue = [entry({ id: 'a', status: 'serving', order_weight: 10 }), entry({ id: 'b', order_weight: 20 })];
  const result = evaluateTwoSlotPrior(queue, 'a', { now: 0 });
  assert.equal(result.mutated, false);
  assert.equal(result.reason, 'no_customer_two_slots_back');
});

test('evaluateTwoSlotPrior: override-locked target is skipped even if genuinely at risk', () => {
  const now = 0;
  const queue = [
    entry({ id: 'a', status: 'serving', order_weight: 10 }),
    entry({ id: 'b', order_weight: 20 }),
    entry({
      id: 'c',
      order_weight: 30,
      is_override_locked: true,
      live_eta_minutes: 99,
      expected_slot_at: new Date(now - 1).toISOString(),
    }),
  ];
  const result = evaluateTwoSlotPrior(queue, 'a', { now });
  assert.equal(result.mutated, false);
  assert.equal(result.reason, 'override_locked');
});

test('evaluateTwoSlotPrior: checked-in target ("on track") is left completely alone', () => {
  const queue = [
    entry({ id: 'a', status: 'serving', order_weight: 10 }),
    entry({ id: 'b', order_weight: 20 }),
    entry({ id: 'c', order_weight: 30, is_checked_in: true }),
  ];
  const result = evaluateTwoSlotPrior(queue, 'a', { now: 0 });
  assert.equal(result.mutated, false);
  assert.equal(result.reason, 'on_track');
});

// ─── evaluateTwoSlotPrior: premium step-back ────────────────────
test('step-back: target with a below AND a below-below neighbour lands on their midpoint', () => {
  const now = 0;
  const queue = [
    entry({ id: 'a', status: 'serving', order_weight: 10 }),
    entry({ id: 'b', order_weight: 20 }),
    entry({
      id: 'c',
      order_weight: 30,
      payment_tier: 'premium_secured',
      live_eta_minutes: 30,
      expected_slot_at: new Date(now - 1).toISOString(),
    }),
    entry({ id: 'd', order_weight: 40 }),
    entry({ id: 'e', order_weight: 200 }),
  ];
  const result = evaluateTwoSlotPrior(queue, 'a', { now });
  assert.equal(result.mutated, true);
  assert.equal(result.reason, 'stepped_back');
  assert.equal(result.targetId, 'c');
  assert.equal(result.patch.order_weight, midpoint(40, 200)); // = 120, between d and e
  assert.equal(result.patch.last_automation_flag, 'stepped_back');
});

test('step-back: target second-from-last (no below-below) uses below + GAP', () => {
  const now = 0;
  const queue = [
    entry({ id: 'a', status: 'serving', order_weight: 10 }),
    entry({ id: 'b', order_weight: 20 }),
    entry({
      id: 'c',
      order_weight: 30,
      payment_tier: 'premium_secured',
      live_eta_minutes: 30,
      expected_slot_at: new Date(now - 1).toISOString(),
    }),
    entry({ id: 'd', order_weight: 100 }),
  ];
  const result = evaluateTwoSlotPrior(queue, 'a', { now });
  assert.equal(result.mutated, true);
  assert.equal(result.patch.order_weight, 110); // 100 + GAP(10)
});

test('step-back: target already the very last row is a safe no-op (nowhere to cascade to)', () => {
  const now = 0;
  const queue = [
    entry({ id: 'a', status: 'serving', order_weight: 10 }),
    entry({ id: 'b', order_weight: 20 }),
    entry({
      id: 'c',
      order_weight: 30,
      payment_tier: 'premium_secured',
      live_eta_minutes: 30,
      expected_slot_at: new Date(now - 1).toISOString(),
    }),
  ];
  const result = evaluateTwoSlotPrior(queue, 'a', { now });
  assert.equal(result.mutated, false);
  assert.equal(result.reason, 'already_last_in_line');
});

// ─── evaluateTwoSlotPrior: free-tier drop ───────────────────────
test('drop: free/standard tier target jumps to MAX(active weight) + GAP', () => {
  const now = 0;
  const queue = [
    entry({ id: 'a', status: 'serving', order_weight: 10 }),
    entry({ id: 'b', order_weight: 20 }),
    entry({
      id: 'c',
      order_weight: 30,
      payment_tier: 'standard_free',
      live_eta_minutes: 30,
      expected_slot_at: new Date(now - 1).toISOString(),
    }),
    entry({ id: 'd', order_weight: 40 }),
  ];
  const result = evaluateTwoSlotPrior(queue, 'a', { now });
  assert.equal(result.mutated, true);
  assert.equal(result.reason, 'dropped');
  assert.equal(result.patch.order_weight, 50); // max(40) + GAP(10)
  assert.equal(result.patch.last_automation_flag, 'dropped');
});

// ─── computeReinstate ────────────────────────────────────────────
test('reinstate: serving + another waiting customer both exist => exact midpoint', () => {
  const queue = [
    entry({ id: 's', status: 'serving', order_weight: 5 }),
    entry({ id: 'n', order_weight: 50 }),
    entry({ id: 'x', order_weight: 999, is_override_locked: false }),
  ];
  const result = computeReinstate(queue, 'x');
  assert.equal(result.mutated, true);
  assert.equal(result.patch.order_weight, midpoint(5, 50));
  assert.equal(result.patch.is_override_locked, true);
  assert.equal(result.patch.last_automation_flag, 'reinstated');
});

test('reinstate: no one currently serving => half of the current front-of-line weight', () => {
  const queue = [entry({ id: 'n', order_weight: 40 }), entry({ id: 'x', order_weight: 999 })];
  const result = computeReinstate(queue, 'x');
  assert.equal(result.patch.order_weight, 20);
});

test('reinstate: target is the only waiting customer, someone is serving => serving + GAP/2', () => {
  const queue = [entry({ id: 's', status: 'serving', order_weight: 10 }), entry({ id: 'x', order_weight: 999 })];
  const result = computeReinstate(queue, 'x');
  assert.equal(result.patch.order_weight, 15); // 10 + GAP(10)/2
});

test('reinstate: target is the only entry in the whole system => default GAP', () => {
  const queue = [entry({ id: 'x', order_weight: 999 })];
  const result = computeReinstate(queue, 'x');
  assert.equal(result.patch.order_weight, 10);
});

test('reinstate: unknown id is rejected', () => {
  const result = computeReinstate([entry({ id: 'a' })], 'ghost');
  assert.equal(result.mutated, false);
  assert.equal(result.reason, 'not_found');
});

test('reinstate: cannot reinstate a customer who is already being served', () => {
  const queue = [entry({ id: 's', status: 'serving', order_weight: 10 })];
  const result = computeReinstate(queue, 's');
  assert.equal(result.mutated, false);
  assert.equal(result.reason, 'already_serving');
});

// ─── computeMove (manual attendant reorder) ─────────────────────
test('move up: middle row with two neighbours above lands on their midpoint', () => {
  const waiting = [entry({ id: 'a', order_weight: 10 }), entry({ id: 'b', order_weight: 20 }), entry({ id: 'c', order_weight: 30 })];
  const result = computeMove(waiting, 'c', 'up');
  assert.equal(result.patch.order_weight, midpoint(10, 20));
});

test('move up: row at index 1 (only one neighbour above) halves that neighbour\'s weight', () => {
  const waiting = [entry({ id: 'a', order_weight: 10 }), entry({ id: 'b', order_weight: 20 })];
  const result = computeMove(waiting, 'b', 'up');
  assert.equal(result.patch.order_weight, 5);
});

test('move up: already at the front is a no-op', () => {
  const waiting = [entry({ id: 'a', order_weight: 10 }), entry({ id: 'b', order_weight: 20 })];
  const result = computeMove(waiting, 'a', 'up');
  assert.equal(result.mutated, false);
  assert.equal(result.reason, 'already_at_front');
});

test('move down: middle row with two neighbours below lands on their midpoint', () => {
  const waiting = [entry({ id: 'a', order_weight: 10 }), entry({ id: 'b', order_weight: 20 }), entry({ id: 'c', order_weight: 30 })];
  const result = computeMove(waiting, 'a', 'down');
  assert.equal(result.patch.order_weight, midpoint(20, 30));
});

test('move down: second-to-last row (no neighbour below-below) uses below + GAP', () => {
  const waiting = [entry({ id: 'a', order_weight: 10 }), entry({ id: 'b', order_weight: 20 })];
  const result = computeMove(waiting, 'a', 'down');
  assert.equal(result.patch.order_weight, 30);
});

test('move down: already at the back is a no-op', () => {
  const waiting = [entry({ id: 'a', order_weight: 10 }), entry({ id: 'b', order_weight: 20 })];
  const result = computeMove(waiting, 'b', 'down');
  assert.equal(result.mutated, false);
  assert.equal(result.reason, 'already_at_back');
});

test('move: unknown id is rejected', () => {
  const result = computeMove([entry({ id: 'a' })], 'ghost', 'up');
  assert.equal(result.mutated, false);
  assert.equal(result.reason, 'not_found');
});
