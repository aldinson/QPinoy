'use strict';

/**
 * paypal.js
 * ─────────────────────────────────────────────────────────────
 * PayPal adapter — Orders v2 API (intent CAPTURE), for payers who'd
 * rather use PayPal than a PH-local method. No-op by design when
 * PAYPAL_CLIENT_ID/PAYPAL_CLIENT_SECRET aren't configured — same
 * fallback pattern as paymongo.js.
 *
 * PAYPAL_MODE selects sandbox vs live (defaults to sandbox — the safer
 * default if someone forgets to set it, the same reasoning db.js uses
 * for defaulting to no-SSL only on an explicit localhost match rather
 * than the other way around).
 *
 * Amounts are priced in PHP throughout (PayPal supports PHP as a
 * transaction currency for a PH-registered business account), matching
 * subscriptions.js's PLAN and keeping one consistent price across every
 * payment method — no FX conversion step anywhere in this app.
 *
 * Webhook verification uses PayPal's OWN "verify-webhook-signature"
 * postback endpoint rather than validating the X.509 cert chain and
 * RSA signature locally. PayPal's docs note self-verification is
 * faster, but it requires fetching and caching PayPal's signing
 * certificate and validating its chain correctly — real PKI work this
 * app has no other need for. The postback call is one extra HTTP
 * request on an async webhook handler, which costs nothing that
 * matters here, in exchange for using PayPal's own verifier instead of
 * a hand-rolled one.
 */

function apiBase() {
  return process.env.PAYPAL_MODE === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
}

function isConfigured() {
  return Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);
}

// Cached in-memory for the life of the process. A fresh token is cheap
// to fetch, but there's no reason to do it on every request — same
// "don't do unnecessary work per-request" instinct as db.js's pool
// sizing. Cleared 60s before actual expiry so a request never straddles
// the token dying mid-flight.
let cachedToken = null; // { accessToken, expiresAt }

async function getAccessToken() {
  if (!isConfigured()) throw new Error('PAYPAL_CLIENT_ID/PAYPAL_CLIENT_SECRET are not configured');
  if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.accessToken;

  const basic = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString('base64');
  const response = await fetch(`${apiBase()}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const json = await response.json().catch(() => null);
  if (!response.ok) throw new Error(json?.error_description || `PayPal OAuth token request failed: ${response.status}`);

  cachedToken = { accessToken: json.access_token, expiresAt: Date.now() + (json.expires_in - 60) * 1000 };
  return cachedToken.accessToken;
}

async function paypalFetch(path, options = {}) {
  const token = await getAccessToken();
  const response = await fetch(`${apiBase()}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  const json = await response.json().catch(() => null);
  if (!response.ok) {
    const message = json?.details?.[0]?.description || json?.message || `PayPal request failed: ${response.status}`;
    throw new Error(message);
  }
  return json;
}

/**
 * Create an order the payer will approve on PayPal's own page.
 *
 * @param {object} params
 * @param {string} params.referenceId  Our subscription_payments.id — set
 *   as BOTH reference_id and custom_id on the purchase unit, since
 *   which one a given PayPal event surfaces isn't something this
 *   integration assumes with full certainty (same defensive-duplication
 *   reasoning as paymongo.js's reference_number + metadata).
 * @param {number} params.amountCentavos
 * @param {string} params.description
 * @param {string} params.returnUrl
 * @param {string} params.cancelUrl
 * @returns {Promise<{ id: string, approveUrl: string }>}
 */
async function createOrder({ referenceId, amountCentavos, description, returnUrl, cancelUrl }) {
  const json = await paypalFetch('/v2/checkout/orders', {
    method: 'POST',
    body: JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [
        {
          reference_id: referenceId,
          custom_id: referenceId,
          description,
          amount: {
            currency_code: 'PHP',
            // PayPal wants a decimal string in whole currency units,
            // unlike PayMongo's centavos — converted here, at the edge,
            // so every OTHER file in this app only ever deals in
            // centavos.
            value: (amountCentavos / 100).toFixed(2),
          },
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            return_url: returnUrl,
            cancel_url: cancelUrl,
            user_action: 'PAY_NOW',
            brand_name: 'QPinoy',
          },
        },
      },
    }),
  });

  const approveLink = json.links?.find((l) => l.rel === 'approve' || l.rel === 'payer-action');
  if (!approveLink) throw new Error('PayPal order response did not include an approval link');

  return { id: json.id, approveUrl: approveLink.href };
}

/** Capture payment for an order the payer has already approved (called from the return-URL handler, not the webhook — see billingRoutes.js). */
async function captureOrder(orderId) {
  const json = await paypalFetch(`/v2/checkout/orders/${orderId}/capture`, { method: 'POST' });
  const capture = json.purchase_units?.[0]?.payments?.captures?.[0];
  return {
    status: json.status, // 'COMPLETED' on success
    captureId: capture?.id,
    referenceId: json.purchase_units?.[0]?.reference_id,
    customId: json.purchase_units?.[0]?.custom_id ?? capture?.custom_id,
  };
}

/**
 * Verify an incoming webhook via PayPal's own postback endpoint.
 * `headers` is the raw incoming request's header object (lowercased
 * keys, as Express/Node give them); `body` is the ALREADY-PARSED
 * webhook_event JSON — unlike PayMongo, PayPal's verification scheme
 * doesn't need the raw byte string, so no raw-body plumbing is needed
 * for this one.
 */
async function verifyWebhookSignature(headers, body) {
  if (!isConfigured() || !process.env.PAYPAL_WEBHOOK_ID) return false;

  try {
    const json = await paypalFetch('/v1/notifications/verify-webhook-signature', {
      method: 'POST',
      body: JSON.stringify({
        transmission_id: headers['paypal-transmission-id'],
        transmission_time: headers['paypal-transmission-time'],
        cert_url: headers['paypal-cert-url'],
        auth_algo: headers['paypal-auth-algo'],
        transmission_sig: headers['paypal-transmission-sig'],
        webhook_id: process.env.PAYPAL_WEBHOOK_ID,
        webhook_event: body,
      }),
    });
    return json.verification_status === 'SUCCESS';
  } catch (err) {
    console.error('[paypal] webhook verification request failed', err.message);
    return false;
  }
}

module.exports = { isConfigured, getAccessToken, createOrder, captureOrder, verifyWebhookSignature };
