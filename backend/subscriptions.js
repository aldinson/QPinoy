'use strict';

/**
 * subscriptions.js
 * ─────────────────────────────────────────────────────────────
 * Pure subscription-state logic — no DB, no HTTP, no provider SDKs.
 * Same reasoning as queueCore.js: the actual rule ("are you allowed to
 * use this right now, and until when") is a pure function of a few
 * timestamps, so it's fully unit-testable without infrastructure, and
 * nothing else has to guess at the rule's behavior at the edges.
 *
 * Deliberately has NO explicit 'cancelled' status and no background job
 * to "expire" anything. A venue's status is computed fresh from two
 * columns every time it's asked, rather than stored and drifting stale
 * without a cron to keep it honest (this app has none — see
 * queueEngine.js's rebalanceIfNeeded for the same reasoning applied to
 * a different problem). Two timestamps are all that's needed:
 *
 *   trial_ends_at            set once, at venue creation.
 *   subscription_paid_until  NULL until the first successful payment;
 *                            from then on, this alone determines
 *                            coverage — trial_ends_at is never
 *                            consulted again, so paying early during a
 *                            trial doesn't get clobbered when the
 *                            trial's own end date arrives.
 */

// One flat plan for now — see the audit's "Phase 5" note and the
// product decision that shipped this: start simple, layer tiers on
// once real customers tell you what's worth metering.
//
// Price is read from env so it can be tuned without a code change (the
// same reasoning as GOOGLE_MAPS_API_KEY being config, not a constant),
// falling back to a clearly-labeled default. Stored/compared in
// centavos throughout the backend — see paymongo.js and paypal.js —
// so there's never a rounding surprise from float pesos.
const DEFAULT_PLAN_PRICE_PHP_CENTAVOS = 99900; // ₱999.00
const PLAN_PRICE_PHP_CENTAVOS = Number.isInteger(Number(process.env.SUBSCRIPTION_PRICE_PHP_CENTAVOS))
  ? Number(process.env.SUBSCRIPTION_PRICE_PHP_CENTAVOS)
  : DEFAULT_PLAN_PRICE_PHP_CENTAVOS;

const PLAN = {
  name: 'QPinoy Standard',
  priceCentavos: PLAN_PRICE_PHP_CENTAVOS,
  currency: 'PHP',
  periodDays: 30,
};

const TRIAL_DAYS = 14;

/** What a fresh venue's trial_ends_at should be set to — used by venueRoutes.js at creation time. */
function computeTrialEndsAt(now = new Date()) {
  return new Date(now.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * The one function everything else in this file exists to support:
 * given a venue's raw timestamp columns, what's true right now?
 *
 *   trialing  — never paid yet, still inside the trial window.
 *   active    — has paid, and that coverage hasn't run out.
 *   past_due  — coverage (trial or paid) has run out. Not a punitive
 *               state — it just means "time to renew" — see
 *               requireActiveSubscription in routes.js for what it
 *               actually blocks (new enrollments only, never anything
 *               for customers already in line).
 */
function getSubscriptionState(venue, now = new Date()) {
  const hasEverPaid = venue.subscription_paid_until != null;
  const coverageEnd = hasEverPaid ? new Date(venue.subscription_paid_until) : new Date(venue.trial_ends_at);
  const isUsable = now.getTime() < coverageEnd.getTime();

  return {
    status: isUsable ? (hasEverPaid ? 'active' : 'trialing') : 'past_due',
    coverageEnd,
    isUsable,
  };
}

/**
 * Where a fresh payment moves subscription_paid_until to.
 *
 * Renewing before the current coverage runs out extends from the END
 * of that coverage, not from "now" — paying five days early shouldn't
 * cost you those five days. Renewing after lapsing starts fresh from
 * now, for the obvious reason (there's no remaining coverage to stack
 * onto). `currentPaidUntil` may be null (first-ever payment, or a
 * trial-period payment) — treated as "no existing coverage to extend."
 */
function computeNewPeriodEnd(currentPaidUntil, now = new Date()) {
  const base = currentPaidUntil && new Date(currentPaidUntil).getTime() > now.getTime() ? new Date(currentPaidUntil) : now;
  return new Date(base.getTime() + PLAN.periodDays * 24 * 60 * 60 * 1000);
}

/**
 * The master switch for the whole feature — a product decision, not a
 * "missing credentials" fallback (that's what paymongo.js's/paypal.js's
 * own isConfigured() are for). Defaults OFF: until this is explicitly
 * turned on, no venue is ever blocked from taking customers regardless
 * of trial/payment state, and the billing UI stays hidden rather than
 * advertising a feature that isn't ready to sell yet.
 *
 * String-compared against 'true' (mirrors db.js's DATABASE_SSL
 * handling) rather than a truthiness check — an operator setting
 * SUBSCRIPTION_ENABLE=false explicitly should behave identically to
 * leaving it unset, not accidentally enable the feature the way a
 * truthy non-empty-string check would.
 */
function isEnabled() {
  return process.env.SUBSCRIPTION_ENABLE === 'true';
}

module.exports = {
  PLAN,
  TRIAL_DAYS,
  isEnabled,
  computeTrialEndsAt,
  getSubscriptionState,
  computeNewPeriodEnd,
};
