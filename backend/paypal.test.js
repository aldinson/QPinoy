'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

function freshPaypal() {
  delete require.cache[require.resolve('./paypal')];
  return require('./paypal');
}

function clearEnv() {
  delete process.env.PAYPAL_CLIENT_ID;
  delete process.env.PAYPAL_CLIENT_SECRET;
  delete process.env.PAYPAL_MODE;
  delete process.env.PAYPAL_WEBHOOK_ID;
}

function setConfigured() {
  process.env.PAYPAL_CLIENT_ID = 'client-id-fake';
  process.env.PAYPAL_CLIENT_SECRET = 'client-secret-fake';
}

/** Routes fetch calls by URL substring so a test can script token vs API responses independently. */
function mockFetchRouter(routes) {
  return async (url, options) => {
    const match = routes.find((r) => url.includes(r.match));
    if (!match) throw new Error(`unexpected fetch to ${url}`);
    match.calls = (match.calls || 0) + 1;
    return match.respond(url, options);
  };
}

test('isConfigured() is false with no PayPal credentials set', () => {
  clearEnv();
  const { isConfigured } = freshPaypal();
  assert.equal(isConfigured(), false);
});

test('getAccessToken throws (no network call) when unconfigured', async (t) => {
  clearEnv();
  const { getAccessToken } = freshPaypal();
  const originalFetch = global.fetch;
  let called = false;
  global.fetch = async () => {
    called = true;
  };
  t.after(() => {
    global.fetch = originalFetch;
  });
  await assert.rejects(() => getAccessToken());
  assert.equal(called, false);
});

test('getAccessToken defaults to the sandbox API host, uses client_credentials, and caches the token', async (t) => {
  setConfigured();
  t.after(clearEnv);
  const { getAccessToken } = freshPaypal();

  const originalFetch = global.fetch;
  const tokenRoute = {
    match: '/v1/oauth2/token',
    respond: async (url, options) => {
      assert.ok(url.startsWith('https://api-m.sandbox.paypal.com'));
      assert.ok(options.headers.Authorization.startsWith('Basic '));
      assert.equal(options.body, 'grant_type=client_credentials');
      return { ok: true, json: async () => ({ access_token: 'tok_1', expires_in: 3600 }) };
    },
  };
  global.fetch = mockFetchRouter([tokenRoute]);
  t.after(() => {
    global.fetch = originalFetch;
  });

  const first = await getAccessToken();
  const second = await getAccessToken();
  assert.equal(first, 'tok_1');
  assert.equal(second, 'tok_1');
  assert.equal(tokenRoute.calls, 1, 'the second call should reuse the cached token, not fetch again');
});

test('getAccessToken uses the live API host when PAYPAL_MODE=live', async (t) => {
  setConfigured();
  process.env.PAYPAL_MODE = 'live';
  t.after(clearEnv);
  const { getAccessToken } = freshPaypal();

  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    assert.ok(url.startsWith('https://api-m.paypal.com'));
    return { ok: true, json: async () => ({ access_token: 'tok_live', expires_in: 3600 }) };
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  assert.equal(await getAccessToken(), 'tok_live');
});

test('createOrder prices in PHP, converts centavos to a decimal string, and returns the approve link', async (t) => {
  setConfigured();
  t.after(clearEnv);
  const { createOrder } = freshPaypal();

  const originalFetch = global.fetch;
  let capturedOrderBody = null;
  global.fetch = mockFetchRouter([
    { match: '/v1/oauth2/token', respond: async () => ({ ok: true, json: async () => ({ access_token: 't', expires_in: 3600 }) }) },
    {
      match: '/v2/checkout/orders',
      respond: async (url, options) => {
        capturedOrderBody = JSON.parse(options.body);
        return {
          ok: true,
          json: async () => ({
            id: 'ORDER123',
            links: [
              { rel: 'self', href: 'https://api/orders/ORDER123' },
              { rel: 'approve', href: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER123' },
            ],
          }),
        };
      },
    },
  ]);
  t.after(() => {
    global.fetch = originalFetch;
  });

  const result = await createOrder({
    referenceId: 'pay-xyz-789',
    amountCentavos: 99900,
    description: 'QPinoy Standard — 30 days',
    returnUrl: 'https://app.example/return',
    cancelUrl: 'https://app.example/cancel',
  });

  assert.equal(result.id, 'ORDER123');
  assert.equal(result.approveUrl, 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER123');

  assert.equal(capturedOrderBody.intent, 'CAPTURE');
  const unit = capturedOrderBody.purchase_units[0];
  assert.equal(unit.amount.currency_code, 'PHP');
  assert.equal(unit.amount.value, '999.00');
  assert.equal(unit.reference_id, 'pay-xyz-789');
  assert.equal(unit.custom_id, 'pay-xyz-789');
  assert.equal(
    capturedOrderBody.payment_source.paypal.experience_context.return_url,
    'https://app.example/return'
  );
});

test('createOrder throws if PayPal responds with no approve/payer-action link', async (t) => {
  setConfigured();
  t.after(clearEnv);
  const { createOrder } = freshPaypal();

  const originalFetch = global.fetch;
  global.fetch = mockFetchRouter([
    { match: '/v1/oauth2/token', respond: async () => ({ ok: true, json: async () => ({ access_token: 't', expires_in: 3600 }) }) },
    { match: '/v2/checkout/orders', respond: async () => ({ ok: true, json: async () => ({ id: 'ORDER1', links: [] }) }) },
  ]);
  t.after(() => {
    global.fetch = originalFetch;
  });

  await assert.rejects(() =>
    createOrder({ referenceId: 'x', amountCentavos: 100, description: 'y', returnUrl: 'a', cancelUrl: 'b' })
  );
});

test('createOrder surfaces PayPal error details on a non-OK response', async (t) => {
  setConfigured();
  t.after(clearEnv);
  const { createOrder } = freshPaypal();

  const originalFetch = global.fetch;
  global.fetch = mockFetchRouter([
    { match: '/v1/oauth2/token', respond: async () => ({ ok: true, json: async () => ({ access_token: 't', expires_in: 3600 }) }) },
    {
      match: '/v2/checkout/orders',
      respond: async () => ({
        ok: false,
        status: 422,
        json: async () => ({ details: [{ description: 'Currency code PHP not supported for this account' }] }),
      }),
    },
  ]);
  t.after(() => {
    global.fetch = originalFetch;
  });

  await assert.rejects(
    () => createOrder({ referenceId: 'x', amountCentavos: 100, description: 'y', returnUrl: 'a', cancelUrl: 'b' }),
    (err) => /Currency code PHP not supported/.test(err.message)
  );
});

test('captureOrder returns COMPLETED status plus the correlation ids', async (t) => {
  setConfigured();
  t.after(clearEnv);
  const { captureOrder } = freshPaypal();

  const originalFetch = global.fetch;
  global.fetch = mockFetchRouter([
    { match: '/v1/oauth2/token', respond: async () => ({ ok: true, json: async () => ({ access_token: 't', expires_in: 3600 }) }) },
    {
      match: '/v2/checkout/orders/ORDER123/capture',
      respond: async () => ({
        ok: true,
        json: async () => ({
          status: 'COMPLETED',
          purchase_units: [
            {
              reference_id: 'pay-xyz-789',
              custom_id: 'pay-xyz-789',
              payments: { captures: [{ id: 'CAP1' }] },
            },
          ],
        }),
      }),
    },
  ]);
  t.after(() => {
    global.fetch = originalFetch;
  });

  const result = await captureOrder('ORDER123');
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.captureId, 'CAP1');
  assert.equal(result.referenceId, 'pay-xyz-789');
});

// ─── verifyWebhookSignature ─────────────────────────────────────────

test('verifyWebhookSignature returns false without throwing when unconfigured', async () => {
  clearEnv();
  const { verifyWebhookSignature } = freshPaypal();
  assert.equal(await verifyWebhookSignature({}, {}), false);
});

test('verifyWebhookSignature returns false when PAYPAL_WEBHOOK_ID is missing, even with credentials set', async () => {
  setConfigured();
  const { verifyWebhookSignature } = freshPaypal();
  assert.equal(await verifyWebhookSignature({}, {}), false);
  clearEnv();
});

test('verifyWebhookSignature posts the transmission headers + webhook_id + event body, and trusts SUCCESS', async (t) => {
  setConfigured();
  process.env.PAYPAL_WEBHOOK_ID = 'WH-123';
  t.after(clearEnv);
  const { verifyWebhookSignature } = freshPaypal();

  const originalFetch = global.fetch;
  let capturedBody = null;
  global.fetch = mockFetchRouter([
    { match: '/v1/oauth2/token', respond: async () => ({ ok: true, json: async () => ({ access_token: 't', expires_in: 3600 }) }) },
    {
      match: '/v1/notifications/verify-webhook-signature',
      respond: async (url, options) => {
        capturedBody = JSON.parse(options.body);
        return { ok: true, json: async () => ({ verification_status: 'SUCCESS' }) };
      },
    },
  ]);
  t.after(() => {
    global.fetch = originalFetch;
  });

  const headers = {
    'paypal-transmission-id': 'tid',
    'paypal-transmission-time': 'ttime',
    'paypal-cert-url': 'https://api.paypal.com/cert',
    'paypal-auth-algo': 'SHA256withRSA',
    'paypal-transmission-sig': 'sig',
  };
  const event = { event_type: 'PAYMENT.CAPTURE.COMPLETED' };
  const ok = await verifyWebhookSignature(headers, event);

  assert.equal(ok, true);
  assert.equal(capturedBody.transmission_id, 'tid');
  assert.equal(capturedBody.webhook_id, 'WH-123');
  assert.deepEqual(capturedBody.webhook_event, event);
});

test('verifyWebhookSignature returns false when PayPal reports FAILURE', async (t) => {
  setConfigured();
  process.env.PAYPAL_WEBHOOK_ID = 'WH-123';
  t.after(clearEnv);
  const { verifyWebhookSignature } = freshPaypal();

  global.fetch = mockFetchRouter([
    { match: '/v1/oauth2/token', respond: async () => ({ ok: true, json: async () => ({ access_token: 't', expires_in: 3600 }) }) },
    { match: '/v1/notifications/verify-webhook-signature', respond: async () => ({ ok: true, json: async () => ({ verification_status: 'FAILURE' }) }) },
  ]);
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });

  assert.equal(await verifyWebhookSignature({}, {}), false);
});

test('verifyWebhookSignature returns false (not throws) if the verification request itself errors', async (t) => {
  setConfigured();
  process.env.PAYPAL_WEBHOOK_ID = 'WH-123';
  t.after(clearEnv);
  const { verifyWebhookSignature } = freshPaypal();

  const originalFetch = global.fetch;
  global.fetch = async () => {
    throw new Error('network down');
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  assert.equal(await verifyWebhookSignature({}, {}), false);
});
