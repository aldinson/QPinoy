'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

/**
 * push.js caches whether VAPID is configured in a module-level flag
 * (mirroring distanceMatrixClient.js's env-var-gated fallback), so each
 * test clears the require cache and re-requires fresh — same technique
 * distanceMatrixClient.test.js uses, for the same reason: process.env
 * has to be read live per test, not once at first require.
 */
function freshPush() {
  delete require.cache[require.resolve('./push')];
  return require('./push');
}

function clearVapidEnv() {
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
  delete process.env.VAPID_SUBJECT;
}

function fakeDb(rows) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/^SELECT/i.test(sql.trim())) return { rows };
      return { rows: [] };
    },
  };
}

test('isConfigured() is false with no VAPID keys set', () => {
  clearVapidEnv();
  const { isConfigured } = freshPush();
  assert.equal(isConfigured(), false);
});

test('sendPushToUser is a no-op (no DB query at all) when VAPID is unconfigured', async () => {
  clearVapidEnv();
  const { sendPushToUser } = freshPush();
  const db = fakeDb([]);
  await sendPushToUser(db, 'some-user-id', { title: 'x', body: 'y' });
  assert.equal(db.calls.length, 0);
});

test('sendPushToUser is a no-op when userId is missing, even if configured', async (t) => {
  process.env.VAPID_PUBLIC_KEY = 'BEzGC0Z6d7ngmYO3rGbDYdDcpCFtJZJTnyKKQITzl-VJiWmXAT4I1npx0lR0re8yeCXsu-miYVS0yRVwwye2jH4';
  process.env.VAPID_PRIVATE_KEY = 'qBNe8-khHyc2u-mCMwu95WFpYuyZ65xw-RENoGqDrPg';
  t.after(clearVapidEnv);
  const { sendPushToUser } = freshPush();
  const db = fakeDb([]);
  await sendPushToUser(db, null, { title: 'x', body: 'y' });
  assert.equal(db.calls.length, 0);
});

test('isConfigured() is true once real-looking VAPID keys are set', (t) => {
  process.env.VAPID_PUBLIC_KEY = 'BEzGC0Z6d7ngmYO3rGbDYdDcpCFtJZJTnyKKQITzl-VJiWmXAT4I1npx0lR0re8yeCXsu-miYVS0yRVwwye2jH4';
  process.env.VAPID_PRIVATE_KEY = 'qBNe8-khHyc2u-mCMwu95WFpYuyZ65xw-RENoGqDrPg';
  t.after(clearVapidEnv);
  const { isConfigured } = freshPush();
  assert.equal(isConfigured(), true);
});

test('sendPushToUser with no stored subscriptions queries but sends nothing', async (t) => {
  process.env.VAPID_PUBLIC_KEY = 'BEzGC0Z6d7ngmYO3rGbDYdDcpCFtJZJTnyKKQITzl-VJiWmXAT4I1npx0lR0re8yeCXsu-miYVS0yRVwwye2jH4';
  process.env.VAPID_PRIVATE_KEY = 'qBNe8-khHyc2u-mCMwu95WFpYuyZ65xw-RENoGqDrPg';
  t.after(clearVapidEnv);
  const { sendPushToUser } = freshPush();

  const webpush = require('web-push');
  const original = webpush.sendNotification;
  let sendCalls = 0;
  webpush.sendNotification = async () => {
    sendCalls++;
  };
  t.after(() => {
    webpush.sendNotification = original;
  });

  const db = fakeDb([]);
  await sendPushToUser(db, 'user-1', { title: 'x', body: 'y' });
  assert.equal(db.calls.length, 1); // the SELECT
  assert.equal(sendCalls, 0);
});

test('sendPushToUser delivers to every stored subscription for that user', async (t) => {
  process.env.VAPID_PUBLIC_KEY = 'BEzGC0Z6d7ngmYO3rGbDYdDcpCFtJZJTnyKKQITzl-VJiWmXAT4I1npx0lR0re8yeCXsu-miYVS0yRVwwye2jH4';
  process.env.VAPID_PRIVATE_KEY = 'qBNe8-khHyc2u-mCMwu95WFpYuyZ65xw-RENoGqDrPg';
  t.after(clearVapidEnv);
  const { sendPushToUser } = freshPush();

  const webpush = require('web-push');
  const original = webpush.sendNotification;
  const delivered = [];
  webpush.sendNotification = async (subscription, body) => {
    delivered.push({ subscription, body });
  };
  t.after(() => {
    webpush.sendNotification = original;
  });

  const rows = [
    { id: 'sub-1', endpoint: 'https://push.example/a', p256dh: 'key-a', auth: 'auth-a' },
    { id: 'sub-2', endpoint: 'https://push.example/b', p256dh: 'key-b', auth: 'auth-b' },
  ];
  const db = fakeDb(rows);
  await sendPushToUser(db, 'user-1', { title: "You're next", body: 'Head back now' });

  assert.equal(delivered.length, 2);
  assert.equal(delivered[0].subscription.endpoint, 'https://push.example/a');
  assert.deepEqual(JSON.parse(delivered[0].body), { title: "You're next", body: 'Head back now' });
});

test('sendPushToUser deletes a subscription the push service reports gone (410), and never throws', async (t) => {
  process.env.VAPID_PUBLIC_KEY = 'BEzGC0Z6d7ngmYO3rGbDYdDcpCFtJZJTnyKKQITzl-VJiWmXAT4I1npx0lR0re8yeCXsu-miYVS0yRVwwye2jH4';
  process.env.VAPID_PRIVATE_KEY = 'qBNe8-khHyc2u-mCMwu95WFpYuyZ65xw-RENoGqDrPg';
  t.after(clearVapidEnv);
  const { sendPushToUser } = freshPush();

  const webpush = require('web-push');
  const original = webpush.sendNotification;
  webpush.sendNotification = async () => {
    const err = new Error('gone');
    err.statusCode = 410;
    throw err;
  };
  t.after(() => {
    webpush.sendNotification = original;
  });

  const rows = [{ id: 'sub-stale', endpoint: 'https://push.example/stale', p256dh: 'k', auth: 'a' }];
  const db = fakeDb(rows);
  await assert.doesNotReject(sendPushToUser(db, 'user-1', { title: 'x', body: 'y' }));

  const deleteCall = db.calls.find((c) => /^DELETE/i.test(c.sql.trim()));
  assert.ok(deleteCall, 'expected the stale subscription to be deleted');
  assert.deepEqual(deleteCall.params, ['sub-stale']);
});

test('sendPushToUser swallows a non-410/404 delivery error rather than throwing or deleting the subscription', async (t) => {
  process.env.VAPID_PUBLIC_KEY = 'BEzGC0Z6d7ngmYO3rGbDYdDcpCFtJZJTnyKKQITzl-VJiWmXAT4I1npx0lR0re8yeCXsu-miYVS0yRVwwye2jH4';
  process.env.VAPID_PRIVATE_KEY = 'qBNe8-khHyc2u-mCMwu95WFpYuyZ65xw-RENoGqDrPg';
  t.after(clearVapidEnv);
  const { sendPushToUser } = freshPush();

  const webpush = require('web-push');
  const original = webpush.sendNotification;
  webpush.sendNotification = async () => {
    const err = new Error('provider unavailable');
    err.statusCode = 500;
    throw err;
  };
  t.after(() => {
    webpush.sendNotification = original;
  });

  const rows = [{ id: 'sub-1', endpoint: 'https://push.example/a', p256dh: 'k', auth: 'a' }];
  const db = fakeDb(rows);
  await assert.doesNotReject(sendPushToUser(db, 'user-1', { title: 'x', body: 'y' }));
  assert.equal(db.calls.some((c) => /^DELETE/i.test(c.sql.trim())), false);
});

test('sendPushToUser never throws even if the subscriptions query itself fails', async (t) => {
  process.env.VAPID_PUBLIC_KEY = 'BEzGC0Z6d7ngmYO3rGbDYdDcpCFtJZJTnyKKQITzl-VJiWmXAT4I1npx0lR0re8yeCXsu-miYVS0yRVwwye2jH4';
  process.env.VAPID_PRIVATE_KEY = 'qBNe8-khHyc2u-mCMwu95WFpYuyZ65xw-RENoGqDrPg';
  t.after(clearVapidEnv);
  const { sendPushToUser } = freshPush();

  const db = { query: async () => { throw new Error('connection lost'); } };
  await assert.doesNotReject(sendPushToUser(db, 'user-1', { title: 'x', body: 'y' }));
});
