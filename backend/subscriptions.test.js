'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { PLAN, TRIAL_DAYS, isEnabled, computeTrialEndsAt, getSubscriptionState, computeNewPeriodEnd } = require('./subscriptions');

const DAY_MS = 24 * 60 * 60 * 1000;

test('PLAN price defaults to ₱399.00 (39900 centavos) when no env override is set', () => {
  assert.equal(PLAN.priceCentavos, 39900);
  assert.equal(PLAN.currency, 'PHP');
});

// ─── isEnabled ──────────────────────────────────────────────────────

test('isEnabled() defaults to false when SUBSCRIPTION_ENABLE is unset', () => {
  delete process.env.SUBSCRIPTION_ENABLE;
  assert.equal(isEnabled(), false);
});

test('isEnabled() is true only for the exact string "true"', () => {
  process.env.SUBSCRIPTION_ENABLE = 'true';
  assert.equal(isEnabled(), true);
  delete process.env.SUBSCRIPTION_ENABLE;
});

test('isEnabled() treats any other value — including the string "false" or "1" — as disabled', () => {
  for (const value of ['false', '1', 'TRUE', 'yes', '']) {
    process.env.SUBSCRIPTION_ENABLE = value;
    assert.equal(isEnabled(), false, `SUBSCRIPTION_ENABLE=${JSON.stringify(value)} should be disabled`);
  }
  delete process.env.SUBSCRIPTION_ENABLE;
});

test('computeTrialEndsAt returns exactly TRIAL_DAYS from the given instant', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  const end = computeTrialEndsAt(now);
  assert.equal(end.getTime() - now.getTime(), TRIAL_DAYS * DAY_MS);
});

// ─── getSubscriptionState ──────────────────────────────────────────

test('a brand-new venue (never paid, trial not yet over) is trialing', () => {
  const now = new Date('2026-01-05T00:00:00Z');
  const venue = { trial_ends_at: '2026-01-15T00:00:00Z', subscription_paid_until: null };
  const state = getSubscriptionState(venue, now);
  assert.equal(state.status, 'trialing');
  assert.equal(state.isUsable, true);
});

test('a venue whose trial has run out, and never paid, is past_due', () => {
  const now = new Date('2026-01-20T00:00:00Z');
  const venue = { trial_ends_at: '2026-01-15T00:00:00Z', subscription_paid_until: null };
  const state = getSubscriptionState(venue, now);
  assert.equal(state.status, 'past_due');
  assert.equal(state.isUsable, false);
});

test('a venue that has paid, with coverage still in the future, is active', () => {
  const now = new Date('2026-02-01T00:00:00Z');
  const venue = { trial_ends_at: '2026-01-01T00:00:00Z', subscription_paid_until: '2026-03-01T00:00:00Z' };
  const state = getSubscriptionState(venue, now);
  assert.equal(state.status, 'active');
  assert.equal(state.isUsable, true);
});

test('a venue that paid once, but whose paid coverage has since run out, is past_due — NOT trialing again', () => {
  // The critical branch: once subscription_paid_until is set, trial_ends_at
  // (even a FUTURE trial_ends_at, which shouldn't happen but let's not
  // trust that) must never be consulted again.
  const now = new Date('2026-04-01T00:00:00Z');
  const venue = { trial_ends_at: '2026-12-31T00:00:00Z', subscription_paid_until: '2026-03-01T00:00:00Z' };
  const state = getSubscriptionState(venue, now);
  assert.equal(state.status, 'past_due');
  assert.equal(state.isUsable, false);
});

test('paying DURING the trial is active immediately, and stays active past the original trial_ends_at', () => {
  const venue = { trial_ends_at: '2026-01-15T00:00:00Z', subscription_paid_until: '2026-02-10T00:00:00Z' };
  const duringTrial = getSubscriptionState(venue, new Date('2026-01-06T00:00:00Z'));
  assert.equal(duringTrial.status, 'active');
  const pastOriginalTrialEnd = getSubscriptionState(venue, new Date('2026-01-20T00:00:00Z'));
  assert.equal(pastOriginalTrialEnd.status, 'active');
});

test('coverage ending EXACTLY now is past_due, not usable — the boundary is exclusive', () => {
  const now = new Date('2026-01-15T00:00:00Z');
  const venue = { trial_ends_at: '2026-01-15T00:00:00Z', subscription_paid_until: null };
  assert.equal(getSubscriptionState(venue, now).status, 'past_due');
});

// ─── computeNewPeriodEnd ────────────────────────────────────────────

test('renewing with no prior coverage (first-ever payment) starts a fresh period from now', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  const end = computeNewPeriodEnd(null, now);
  assert.equal(end.getTime() - now.getTime(), PLAN.periodDays * DAY_MS);
});

test('renewing BEFORE current coverage lapses extends from the existing end date, not from now', () => {
  const now = new Date('2026-01-10T00:00:00Z');
  const currentPaidUntil = new Date('2026-01-20T00:00:00Z'); // 10 days of remaining coverage
  const end = computeNewPeriodEnd(currentPaidUntil, now);
  assert.equal(end.getTime(), currentPaidUntil.getTime() + PLAN.periodDays * DAY_MS);
});

test('renewing AFTER coverage has already lapsed starts fresh from now, not from the stale end date', () => {
  const now = new Date('2026-02-01T00:00:00Z');
  const currentPaidUntil = new Date('2026-01-05T00:00:00Z'); // lapsed weeks ago
  const end = computeNewPeriodEnd(currentPaidUntil, now);
  assert.equal(end.getTime(), now.getTime() + PLAN.periodDays * DAY_MS);
});
