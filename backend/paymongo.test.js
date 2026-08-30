'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

function freshPaymongo() {
  delete require.cache[require.resolve('./paymongo')];
  return require('./paymongo');
}

function clearEnv() {
  delete process.env.PAYMONGO_SECRET_KEY;
  delete process.env.PAYMONGO_WEBHOOK_SECRET;
}

// ─── isConfigured / createCheckoutSession without a key ────────────

test('isConfigured() is false with no PAYMONGO_SECRET_KEY set', () => {
  clearEnv();
  const { isConfigured } = freshPaymongo();
  assert.equal(isConfigured(), false);
});

test('createCheckoutSession throws immediately (no network call) when unconfigured', async (t) => {
  clearEnv();
  const { createCheckoutSession } = freshPaymongo();
  const originalFetch = global.fetch;
  let called = false;
  global.fetch = async () => {
    called = true;
    throw new Error('should not be called');
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  await assert.rejects(() =>
    createCheckoutSession({ referenceNumber: 'x', amountCentavos: 100, description: 'y', successUrl: 'a', cancelUrl: 'b' })
  );
  assert.equal(called, false);
});

// ─── createCheckoutSession, configured ──────────────────────────────

test('createCheckoutSession sends centavos, PHP, and all three payment method types, and returns the checkout URL', async (t) => {
  process.env.PAYMONGO_SECRET_KEY = 'sk_test_fake';
  t.after(clearEnv);
  const { createCheckoutSession } = freshPaymongo();

  const originalFetch = global.fetch;
  let capturedRequest = null;
  global.fetch = async (url, options) => {
    capturedRequest = { url, options };
    return {
      ok: true,
      json: async () => ({
        data: { id: 'cs_test_123', attributes: { checkout_url: 'https://checkout.paymongo.com/cs_test_123' } },
      }),
    };
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  const result = await createCheckoutSession({
    referenceNumber: 'pay-abc-123',
    amountCentavos: 99900,
    description: 'QPinoy Standard — 30 days',
    successUrl: 'https://app.example/return',
    cancelUrl: 'https://app.example/cancel',
  });

  assert.equal(result.id, 'cs_test_123');
  assert.equal(result.checkoutUrl, 'https://checkout.paymongo.com/cs_test_123');

  assert.equal(capturedRequest.url, 'https://api.paymongo.com/v2/checkout_sessions');
  assert.equal(capturedRequest.options.method, 'POST');
  assert.ok(capturedRequest.options.headers.Authorization.startsWith('Basic '));

  const body = JSON.parse(capturedRequest.options.body);
  const attrs = body.data.attributes;
  assert.deepEqual(attrs.payment_method_types, ['gcash', 'paymaya', 'card']);
  assert.equal(attrs.line_items[0].amount, 99900);
  assert.equal(attrs.line_items[0].currency, 'PHP');
  assert.equal(attrs.reference_number, 'pay-abc-123');
  assert.equal(attrs.metadata.subscription_payment_id, 'pay-abc-123');
});

test('createCheckoutSession surfaces the PayMongo error detail on a non-OK response', async (t) => {
  process.env.PAYMONGO_SECRET_KEY = 'sk_test_fake';
  t.after(clearEnv);
  const { createCheckoutSession } = freshPaymongo();

  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: false,
    status: 400,
    json: async () => ({ errors: [{ detail: 'line_items amount must be greater than 0' }] }),
  });
  t.after(() => {
    global.fetch = originalFetch;
  });

  await assert.rejects(
    () => createCheckoutSession({ referenceNumber: 'x', amountCentavos: 0, description: 'y', successUrl: 'a', cancelUrl: 'b' }),
    (err) => /amount must be greater than 0/.test(err.message)
  );
});

// ─── verifyWebhookSignature ─────────────────────────────────────────

function sign(secret, timestamp, rawBody) {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

test('verifyWebhookSignature accepts a correctly-signed test-mode payload', () => {
  process.env.PAYMONGO_WEBHOOK_SECRET = 'whsec_test_fake';
  const { verifyWebhookSignature } = freshPaymongo();
  const rawBody = '{"data":{"id":"evt_1"}}';
  const timestamp = '1700000000';
  const sig = sign('whsec_test_fake', timestamp, rawBody);

  assert.equal(verifyWebhookSignature(rawBody, `t=${timestamp},te=${sig},li=deadbeef`), true);
  clearEnv();
});

test('verifyWebhookSignature rejects a tampered body', () => {
  process.env.PAYMONGO_WEBHOOK_SECRET = 'whsec_test_fake';
  const { verifyWebhookSignature } = freshPaymongo();
  const timestamp = '1700000000';
  const sig = sign('whsec_test_fake', timestamp, '{"data":{"id":"evt_1"}}');

  assert.equal(verifyWebhookSignature('{"data":{"id":"evt_TAMPERED"}}', `t=${timestamp},te=${sig}`), false);
  clearEnv();
});

test('verifyWebhookSignature rejects a signature computed with the wrong secret', () => {
  process.env.PAYMONGO_WEBHOOK_SECRET = 'whsec_test_fake';
  const { verifyWebhookSignature } = freshPaymongo();
  const rawBody = '{"data":{"id":"evt_1"}}';
  const timestamp = '1700000000';
  const wrongSig = sign('some-other-secret', timestamp, rawBody);

  assert.equal(verifyWebhookSignature(rawBody, `t=${timestamp},te=${wrongSig}`), false);
  clearEnv();
});

test('verifyWebhookSignature rejects a missing or malformed header without throwing', () => {
  process.env.PAYMONGO_WEBHOOK_SECRET = 'whsec_test_fake';
  const { verifyWebhookSignature } = freshPaymongo();
  assert.equal(verifyWebhookSignature('{}', undefined), false);
  assert.equal(verifyWebhookSignature('{}', ''), false);
  assert.equal(verifyWebhookSignature('{}', 'garbage-not-kv-pairs'), false);
  clearEnv();
});

test('verifyWebhookSignature returns false (not throws) when PAYMONGO_WEBHOOK_SECRET is unset', () => {
  clearEnv();
  const { verifyWebhookSignature } = freshPaymongo();
  assert.equal(verifyWebhookSignature('{}', 't=1,te=whatever'), false);
});
