'use strict';

/**
 * push.js
 * ─────────────────────────────────────────────────────────────
 * Web Push notifications — the channel DEPLOYMENT.md (§4) recommends in
 * place of trusting a phone's last stored location once its screen
 * locks: "pull, don't push." Rather than passively reading a possibly
 * stale GPS fix, the queue engine sends a notification at the exact
 * moment it matters (your turn is close; you were skipped), and the
 * customer's tap on it is itself a fresh presence signal.
 *
 * No-op by design when VAPID keys aren't configured — the same fallback
 * pattern distanceMatrixClient.js uses for GOOGLE_MAPS_API_KEY. Local
 * dev, tests, and CI never need real push credentials, and a queue
 * mutation (call next, step back, reinstate) must never fail just
 * because a push provider is unconfigured or unreachable.
 */

const webpush = require('web-push');

let configured = false;

function ensureConfigured() {
  if (configured) return true;
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return false;
  webpush.setVapidDetails(VAPID_SUBJECT || 'mailto:support@qpinoy.example', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  configured = true;
  return true;
}

/** Whether push is usable at all right now — the vapid-public-key route uses this to tell the frontend whether to offer the feature. */
function isConfigured() {
  return ensureConfigured();
}

/**
 * Send one notification to every device a user has subscribed on.
 *
 * Never throws. A delivery failure — or push being unconfigured
 * entirely — must never fail the queue mutation that triggered it, the
 * same "fail open" principle rateLimit.js uses for a counter outage.
 * A subscription the push service reports as gone (404/410 — the
 * browser unsubscribed, or the device hasn't been seen in a long time)
 * is deleted here, the same way an expired session just quietly stops
 * being usable rather than needing manual cleanup.
 */
async function sendPushToUser(db, userId, payload) {
  if (!userId || !ensureConfigured()) return;

  let rows;
  try {
    ({ rows } = await db.query(`SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1`, [userId]));
  } catch (err) {
    console.error('[push] could not load subscriptions', err);
    return;
  }
  if (!rows.length) return;

  const body = JSON.stringify(payload);
  await Promise.all(
    rows.map(async (row) => {
      try {
        await webpush.sendNotification({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }, body);
      } catch (err) {
        if (err && (err.statusCode === 404 || err.statusCode === 410)) {
          await db.query(`DELETE FROM push_subscriptions WHERE id = $1`, [row.id]).catch(() => {});
        } else {
          console.error('[push] delivery failed', err?.statusCode || err?.message || err);
        }
      }
    })
  );
}

module.exports = { isConfigured, sendPushToUser };
