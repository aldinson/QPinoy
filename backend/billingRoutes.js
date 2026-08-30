'use strict';

/**
 * billingRoutes.js
 * ─────────────────────────────────────────────────────────────
 * Venue subscription billing: check status, start a checkout (GCash/
 * PayMaya/card via PayMongo, or PayPal), and the two webhook receivers
 * that actually confirm a payment happened.
 *
 * Every route that STARTS a payment or reads billing detail is
 * owner/manager only — same tier as the automation toggle, the staff
 * list, and QR settings (venueRoutes.js). The two webhook routes are
 * deliberately NOT behind requireAuth at all: their security boundary
 * is signature verification (paymongo.js / paypal.js), not a session
 * token, because the caller is PayMongo's/PayPal's own servers.
 */

const crypto = require('crypto');
const express = require('express');
const { requireAuth, requireUuidParams, requireVenueRole, STAFF_MANAGER_ROLES } = require('./auth');
const { PLAN, getSubscriptionState, computeNewPeriodEnd, isEnabled: isSubscriptionEnabled } = require('./subscriptions');
const paymongo = require('./paymongo');
const paypal = require('./paypal');

const PROVIDERS = ['paymongo', 'paypal'];

function providerClient(provider) {
  return provider === 'paymongo' ? paymongo : provider === 'paypal' ? paypal : null;
}

/** Where PayMongo/PayPal send the payer back after checkout. Required for any real checkout to work — see .env.example. */
function appOrigin() {
  return (process.env.APP_ORIGIN || '').replace(/\/$/, '');
}

function buildBillingRouter(pool) {
  const router = express.Router();

  const ownerOrManager = [requireUuidParams('venueId'), requireAuth, requireVenueRole(pool, STAFF_MANAGER_ROLES)];

  /**
   * The feature's master switch, so the frontend knows whether to show
   * billing UI at all — no auth needed, same shape as
   * GET /push/vapid-public-key (a config flag, not a secret).
   */
  router.get('/billing/config', (req, res) => {
    res.json({ enabled: isSubscriptionEnabled() });
  });

  /** Current subscription status, plan info, which payment methods are actually usable, and billing history. */
  router.get('/venues/:venueId/billing', ownerOrManager, async (req, res, next) => {
    if (!isSubscriptionEnabled()) return res.json({ enabled: false });
    try {
      const { rows } = await pool.query(
        `SELECT trial_ends_at, subscription_paid_until FROM venues WHERE id = $1`,
        [req.params.venueId]
      );
      if (!rows[0]) return res.status(404).json({ error: 'venue not found' });
      const state = getSubscriptionState(rows[0]);

      const { rows: history } = await pool.query(
        `SELECT id, provider, status, amount_centavos, period_start, period_end, created_at, paid_at
           FROM subscription_payments
          WHERE venue_id = $1
          ORDER BY created_at DESC
          LIMIT 50`,
        [req.params.venueId]
      );

      res.json({
        enabled: true,
        plan: PLAN,
        status: state.status,
        coverageEnd: state.coverageEnd,
        isUsable: state.isUsable,
        availableProviders: { paymongo: paymongo.isConfigured(), paypal: paypal.isConfigured() },
        history,
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * Start a checkout. Creates the provider-side session/order FIRST,
   * and only writes a subscription_payments row once that succeeds —
   * there is no legitimate row for a checkout that was never actually
   * offered to the payer (see schema.sql's comment on the table).
   *
   * The payment's own id is generated here (crypto.randomUUID(), not
   * the database's gen_random_uuid()) specifically so it can be handed
   * to the provider as the correlation key — reference_number for
   * PayMongo, reference_id/custom_id for PayPal — BEFORE the row exists.
   */
  router.post('/venues/:venueId/billing/checkout', ownerOrManager, async (req, res, next) => {
    // The master switch overrides everything else below, INCLUDING a
    // provider that happens to have real credentials configured — the
    // point of this flag is "nothing real can happen here yet,"
    // full stop, not "unless someone left a key lying around."
    if (!isSubscriptionEnabled()) {
      return res.status(404).json({ error: 'subscription billing is not enabled on this server' });
    }
    const { provider } = req.body || {};
    if (!PROVIDERS.includes(provider)) {
      return res.status(400).json({ error: `provider must be one of: ${PROVIDERS.join(', ')}` });
    }
    const client = providerClient(provider);
    if (!client.isConfigured()) {
      return res.status(503).json({ error: `${provider} is not configured on this server yet` });
    }
    if (!appOrigin()) {
      return res.status(503).json({ error: 'APP_ORIGIN is not configured on this server — checkout return URLs cannot be built' });
    }

    try {
      const { rows } = await pool.query(`SELECT subscription_paid_until FROM venues WHERE id = $1`, [req.params.venueId]);
      if (!rows[0]) return res.status(404).json({ error: 'venue not found' });

      const paymentId = crypto.randomUUID();
      const now = new Date();
      const periodEnd = computeNewPeriodEnd(rows[0].subscription_paid_until, now);
      const description = `${PLAN.name} — ${PLAN.periodDays} days`;
      const successUrl = `${appOrigin()}/billing/return?venue=${req.params.venueId}&payment=${paymentId}&provider=${provider}`;
      const cancelUrl = `${appOrigin()}/billing?venue=${req.params.venueId}&cancelled=${paymentId}`;

      let providerReference, redirectUrl;
      if (provider === 'paymongo') {
        const session = await paymongo.createCheckoutSession({
          referenceNumber: paymentId,
          amountCentavos: PLAN.priceCentavos,
          description,
          successUrl,
          cancelUrl,
        });
        providerReference = session.id;
        redirectUrl = session.checkoutUrl;
      } else {
        const order = await paypal.createOrder({
          referenceId: paymentId,
          amountCentavos: PLAN.priceCentavos,
          description,
          returnUrl: successUrl,
          cancelUrl,
        });
        providerReference = order.id;
        redirectUrl = order.approveUrl;
      }

      await pool.query(
        `INSERT INTO subscription_payments (id, venue_id, provider, provider_reference, amount_centavos, status, period_start, period_end)
         VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7)`,
        [paymentId, req.params.venueId, provider, providerReference, PLAN.priceCentavos, now, periodEnd]
      );

      res.status(201).json({ paymentId, redirectUrl });
    } catch (err) {
      next(err);
    }
  });

  /** Poll target for the return page while waiting on a webhook (PayMongo has no synchronous confirmation step). */
  router.get('/venues/:venueId/billing/payments/:paymentId', ownerOrManager, async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        `SELECT id, provider, status, amount_centavos, period_end FROM subscription_payments WHERE id = $1 AND venue_id = $2`,
        [req.params.paymentId, req.params.venueId]
      );
      if (!rows[0]) return res.status(404).json({ error: 'payment not found' });
      res.json({ payment: rows[0] });
    } catch (err) {
      next(err);
    }
  });

  /**
   * PayPal's flow captures synchronously on return, rather than waiting
   * on a webhook — the payer is still sitting on the return page, so
   * there's no reason to make them wait for async confirmation when we
   * can just ask PayPal directly. The webhook handler below still
   * exists as a backstop for the case where the browser never makes it
   * back here (closed tab, crashed network) after approving on PayPal's
   * site.
   */
  router.post('/venues/:venueId/billing/paypal/capture', ownerOrManager, async (req, res, next) => {
    const { paymentId } = req.body || {};
    if (typeof paymentId !== 'string' || !paymentId) {
      return res.status(400).json({ error: 'paymentId is required' });
    }
    try {
      const { rows } = await pool.query(
        `SELECT provider_reference, status FROM subscription_payments WHERE id = $1 AND venue_id = $2 AND provider = 'paypal'`,
        [paymentId, req.params.venueId]
      );
      const payment = rows[0];
      if (!payment) return res.status(404).json({ error: 'payment not found' });
      if (payment.status === 'paid') return res.json({ status: 'paid' }); // idempotent — already confirmed, possibly by the webhook

      const capture = await paypal.captureOrder(payment.provider_reference);
      if (capture.status !== 'COMPLETED') {
        return res.status(409).json({ error: `PayPal capture did not complete (status: ${capture.status})` });
      }

      await confirmPayment(pool, 'paypal', payment.provider_reference);
      res.json({ status: 'paid' });
    } catch (err) {
      next(err);
    }
  });

  /** The payer landed on the cancel URL, or the return page saw no successful capture — mark the attempt as abandoned rather than leaving it 'pending' forever. */
  router.post('/venues/:venueId/billing/payments/:paymentId/cancel', ownerOrManager, async (req, res, next) => {
    try {
      const { rowCount } = await pool.query(
        `UPDATE subscription_payments SET status = 'cancelled'
          WHERE id = $1 AND venue_id = $2 AND status = 'pending'`,
        [req.params.paymentId, req.params.venueId]
      );
      res.json({ cancelled: rowCount > 0 });
    } catch (err) {
      next(err);
    }
  });

  /**
   * PayMongo webhook. No requireAuth — the security boundary is the
   * HMAC signature (paymongo.js's verifyWebhookSignature), checked
   * against the RAW request body (req.rawBody, preserved by app.js's
   * express.json({ verify }) — re-serializing req.body would not
   * reproduce the exact bytes PayMongo signed).
   *
   * NOTE ON PAYLOAD SHAPE: PayMongo's public docs for the exact
   * checkout-session-paid webhook envelope were not reachable while
   * building this (their docs site was mid-restructure). The extraction
   * below tries the checkout session id first (data.attributes.data.id
   * — PayMongo's documented event envelope nests the affected resource
   * there, mirroring their own {id,type,attributes} shape throughout
   * the API) and falls back to the reference_number/metadata field.
   * If this ever fails to match a pending payment in sandbox testing,
   * the full payload is logged specifically so the real shape is one
   * log line away, not a guessing exercise.
   */
  router.post('/webhooks/paymongo', async (req, res, next) => {
    const rawBody = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body);
    const signature = req.headers['paymongo-signature'];

    if (!paymongo.verifyWebhookSignature(rawBody, signature)) {
      return res.status(400).json({ error: 'invalid signature' });
    }

    try {
      const event = req.body;
      const eventType = event?.data?.attributes?.type;
      if (typeof eventType !== 'string' || !eventType.endsWith('.paid')) {
        return res.json({ received: true }); // not a payment-completed event — 200 so PayMongo doesn't keep retrying it
      }

      const checkoutSessionId = event?.data?.attributes?.data?.id || null;
      const referenceNumber =
        event?.data?.attributes?.data?.attributes?.reference_number ||
        event?.data?.attributes?.data?.attributes?.metadata?.subscription_payment_id ||
        null;

      // NOT `||` — confirmPayment resolves to an OBJECT ({found: false}
      // included), which is truthy regardless of .found, so a naive
      // `||` chain would never reach the fallback lookup below.
      let result = checkoutSessionId ? await confirmPayment(pool, 'paymongo', checkoutSessionId) : null;
      if ((!result || !result.found) && referenceNumber) {
        result = await confirmPaymentById(pool, referenceNumber);
      }

      if (!result || !result.found) {
        console.error('[billing] PayMongo webhook: no matching pending payment found', JSON.stringify(event));
      }
      res.json({ received: true });
    } catch (err) {
      next(err);
    }
  });

  /**
   * PayPal webhook — backstop for PAYMENT.CAPTURE.COMPLETED in case the
   * payer's browser never made it back to the synchronous capture
   * route above. Verified via PayPal's own postback endpoint
   * (paypal.js's verifyWebhookSignature), not local signature math.
   */
  router.post('/webhooks/paypal', async (req, res, next) => {
    const verified = await paypal.verifyWebhookSignature(req.headers, req.body);
    if (!verified) return res.status(400).json({ error: 'invalid signature' });

    try {
      const event = req.body;
      if (event?.event_type !== 'PAYMENT.CAPTURE.COMPLETED') {
        return res.json({ received: true });
      }

      // custom_id was set to our own subscription_payments.id at order
      // creation (paypal.js's createOrder) and PayPal propagates it onto
      // the capture resource — a direct id lookup, no provider_reference
      // matching needed for this one.
      const paymentId = event?.resource?.custom_id;
      const result = paymentId ? await confirmPaymentById(pool, paymentId) : null;
      if (!result || !result.found) {
        console.error('[billing] PayPal webhook: no matching pending payment found', JSON.stringify(event));
      }
      res.json({ received: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

/**
 * Confirm a payment and extend the venue's coverage. Idempotent: a
 * payment already 'paid' is a no-op — both providers document webhook
 * delivery as "at least once," and the synchronous PayPal capture route
 * and the PayPal webhook backstop can both legitimately try to confirm
 * the same payment.
 */
async function confirmPaymentWhere(pool, whereClause, param) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT id, venue_id, period_end, status FROM subscription_payments WHERE ${whereClause} FOR UPDATE`,
      param
    );
    const payment = rows[0];
    if (!payment) {
      await client.query('ROLLBACK');
      return { found: false };
    }
    if (payment.status === 'paid') {
      await client.query('ROLLBACK');
      return { found: true, alreadyPaid: true };
    }

    await client.query(`UPDATE subscription_payments SET status = 'paid', paid_at = now() WHERE id = $1`, [payment.id]);
    await client.query(`UPDATE venues SET subscription_paid_until = $1, updated_at = now() WHERE id = $2`, [
      payment.period_end,
      payment.venue_id,
    ]);
    await client.query('COMMIT');
    return { found: true, alreadyPaid: false, venueId: payment.venue_id };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Confirm by (provider, provider_reference) — the primary correlation key, since that's what we ourselves stored at checkout creation. */
function confirmPayment(pool, provider, providerReference) {
  return confirmPaymentWhere(pool, 'provider = $1 AND provider_reference = $2', [provider, providerReference]);
}

/** Confirm by our OWN id — the fallback path both webhook handlers use when the provider's payload doesn't cleanly hand back its own reference. */
function confirmPaymentById(pool, paymentId) {
  return confirmPaymentWhere(pool, 'id = $1', [paymentId]);
}

module.exports = { buildBillingRouter, confirmPayment, confirmPaymentById };
