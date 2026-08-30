'use strict';

/**
 * paymongo.js
 * ─────────────────────────────────────────────────────────────
 * PayMongo adapter — GCash, PayMaya (Maya), and card payments through
 * ONE Checkout Session. PayMongo's hosted checkout page lets the payer
 * pick whichever of the three they want at payment time, so this file
 * never needs separate code paths per payment method — that choice is
 * entirely PayMongo's UI, not ours.
 *
 * No-op by design when PAYMONGO_SECRET_KEY isn't configured — same
 * fallback pattern as distanceMatrixClient.js (GOOGLE_MAPS_API_KEY) and
 * push.js (VAPID keys): local dev, tests, and CI never need real
 * PayMongo credentials, and billingRoutes.js is expected to check
 * isConfigured() before offering this as a payment option at all.
 *
 * Amounts are always in CENTAVOS (PHP's smallest unit — ₱999.00 is
 * 99900), matching PayMongo's own API convention and subscriptions.js's
 * PLAN.priceCentavos, so there is never a float-pesos rounding step
 * anywhere in this path.
 */

const crypto = require('crypto');

const API_BASE = 'https://api.paymongo.com/v2';

function isConfigured() {
  return Boolean(process.env.PAYMONGO_SECRET_KEY);
}

function authHeader() {
  // HTTP Basic auth: secret key as username, empty password. Same
  // convention as most REST payment APIs built on top of Basic auth
  // (Stripe included) — the secret key IS the credential, there's
  // nothing else to supply.
  const token = Buffer.from(`${process.env.PAYMONGO_SECRET_KEY}:`).toString('base64');
  return `Basic ${token}`;
}

/**
 * Create a Checkout Session for one subscription payment.
 *
 * @param {object} params
 * @param {string} params.referenceNumber  Our own subscription_payments.id
 *   — the correlation key a webhook hands back so we know which pending
 *   payment just succeeded, without trusting anything else in the
 *   payload. Also mirrored into `metadata` as a second, independent way
 *   to find it (see billingRoutes.js's webhook handler) in case this
 *   integration's understanding of exactly where PayMongo echoes
 *   reference_number back ends up being wrong — cheap insurance against
 *   a documentation gap, not a sign either field is unreliable on its own.
 * @param {number} params.amountCentavos
 * @param {string} params.description
 * @param {string} params.successUrl
 * @param {string} params.cancelUrl
 * @returns {Promise<{ id: string, checkoutUrl: string }>}
 */
async function createCheckoutSession({ referenceNumber, amountCentavos, description, successUrl, cancelUrl }) {
  if (!isConfigured()) throw new Error('PAYMONGO_SECRET_KEY is not configured');

  const response = await fetch(`${API_BASE}/checkout_sessions`, {
    method: 'POST',
    headers: {
      Authorization: authHeader(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      data: {
        attributes: {
          line_items: [
            {
              amount: amountCentavos,
              currency: 'PHP',
              name: description,
              quantity: 1,
            },
          ],
          payment_method_types: ['gcash', 'paymaya', 'card'],
          reference_number: referenceNumber,
          description,
          send_email_receipt: false,
          metadata: { subscription_payment_id: referenceNumber },
          success_url: successUrl,
          cancel_url: cancelUrl,
        },
      },
    }),
  });

  const json = await response.json().catch(() => null);
  if (!response.ok) {
    const message = json?.errors?.[0]?.detail || `PayMongo checkout session request failed: ${response.status}`;
    throw new Error(message);
  }

  return {
    id: json.data.id,
    checkoutUrl: json.data.attributes.checkout_url,
  };
}

/**
 * Verify a PayMongo webhook's `Paymongo-Signature` header.
 *
 * Header shape: `t=<unix timestamp>,te=<test-mode hex signature>,li=<live-mode hex signature>`.
 * The signed string is `${timestamp}.${rawBody}`, HMAC-SHA256'd with the
 * webhook's own signing secret (shown once in the PayMongo dashboard
 * when the webhook endpoint is created — NOT the same as the API secret
 * key). Which of `te`/`li` to check is decided by which secret you
 * were handed: a webhook created against a test-mode secret key only
 * ever signs with `te`, live only ever signs with `li`.
 *
 * `rawBody` MUST be the exact bytes PayMongo sent, before any JSON
 * parsing — see app.js's `express.json({ verify })` for how that's
 * preserved. Re-serializing a parsed object never reproduces the exact
 * byte sequence that was actually signed (key order, whitespace).
 */
function verifyWebhookSignature(rawBody, signatureHeader) {
  const secret = process.env.PAYMONGO_WEBHOOK_SECRET;
  if (!secret) return false;
  if (typeof signatureHeader !== 'string' || !signatureHeader) return false;

  const parts = Object.fromEntries(
    signatureHeader.split(',').map((kv) => {
      const [k, v] = kv.split('=');
      return [k, v];
    })
  );
  const { t: timestamp, te: testSig, li: liveSig } = parts;
  const providedSig = testSig || liveSig;
  if (!timestamp || !providedSig) return false;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');

  const a = Buffer.from(providedSig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false; // timingSafeEqual throws on length mismatch
  return crypto.timingSafeEqual(a, b);
}

module.exports = { isConfigured, createCheckoutSession, verifyWebhookSignature };
