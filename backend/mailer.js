'use strict';

/**
 * mailer.js
 * ─────────────────────────────────────────────────────────────
 * Outbound email over SMTP, currently used only to notify the operator
 * that a customer left feedback (see feedbackRoutes.js).
 *
 * Optional, exactly like push.js's VAPID keys and
 * distanceMatrixClient.js's Maps key: with no SMTP_* configured this
 * module reports itself unconfigured and sends nothing, and the
 * feature that uses it degrades to "stored, not emailed" rather than
 * failing. That matters more here than elsewhere — the feedback row is
 * already committed by the time we get here, so a mail failure must
 * never turn into an error the customer sees for something they did
 * successfully.
 *
 * SMTP rather than a vendor HTTP API on purpose: it works with a Gmail
 * app password, a Mailgun/SendGrid/Postmark relay, or a self-hosted
 * server, without this file knowing which. The one cost is that
 * connections from a cold serverless container are slower than a plain
 * HTTPS call, which is why sendMail is given a short timeout and is
 * never on the critical path of a request's success.
 */

const nodemailer = require('nodemailer');

/** Every mail this app sends is tagged with this, so it filters cleanly in an inbox. */
const SUBJECT_TAG = 'QPinoy User Feedback';

// A cold Lambda dialling SMTP can hang; these bound how long a
// customer's request can be delayed by a mail server that is not
// answering. The feedback is already saved either way.
const SMTP_TIMEOUT_MS = 8000;

let cachedTransport = null;

/**
 * Whether SMTP is usable at all right now. Deliberately checks host
 * only: a relay on a trusted network can legitimately require no
 * credentials, so demanding user/pass here would refuse a valid setup.
 */
function isConfigured() {
  return Boolean(process.env.SMTP_HOST);
}

/** Where feedback notifications go. Overridable per-deployment; falls back to the project owner's address. */
function feedbackRecipient() {
  return process.env.FEEDBACK_EMAIL_TO || 'aldinson@gmail.com';
}

function getTransport() {
  if (cachedTransport) return cachedTransport;
  if (!isConfigured()) return null;

  const port = Number(process.env.SMTP_PORT) || 587;
  cachedTransport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    // 465 is implicit TLS; 587/25 start plaintext and STARTTLS up.
    // Getting this backwards is the single most common SMTP
    // misconfiguration, so it's derived from the port rather than
    // being yet another env var to set wrong.
    secure: port === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    connectionTimeout: SMTP_TIMEOUT_MS,
    greetingTimeout: SMTP_TIMEOUT_MS,
    socketTimeout: SMTP_TIMEOUT_MS,
  });
  return cachedTransport;
}

/** Test seam — lets a test swap in a fake transport without a real SMTP server. */
function _setTransportForTests(transport) {
  cachedTransport = transport;
}

function starBar(rating) {
  return '★'.repeat(rating) + '☆'.repeat(5 - rating);
}

/**
 * Send one feedback notification.
 *
 * Returns true only if the mail actually went out, so the caller can
 * record that fact honestly (feedback.email_sent_at) instead of
 * assuming. Never throws: every failure path — unconfigured, refused
 * connection, bad credentials — resolves false and is logged.
 */
async function sendFeedbackEmail({ rating, comment, fromName, fromEmail, venueName, submittedAt }) {
  const transport = getTransport();
  if (!transport) return false;

  // The tag leads the subject so an inbox filter can match on it
  // without depending on anything that varies per message.
  //
  // Kept to plain ASCII (a hyphen, not an em dash) on purpose: any
  // non-ASCII character forces the whole header into MIME
  // encoded-word form (=?UTF-8?Q?...?=), and while clients decode
  // that before matching, an unencoded header is the one that is
  // unambiguously greppable everywhere — including in a filter rule
  // someone writes by hand. A customer's own name may still be
  // non-ASCII and trigger encoding; the tag comes first precisely so
  // the filterable part never depends on that.
  const subject = `${SUBJECT_TAG} - ${rating}/5 from ${fromName || 'a customer'}`;

  const lines = [
    `Rating:    ${starBar(rating)}  (${rating}/5)`,
    `From:      ${fromName || 'Unknown'}${fromEmail ? ` <${fromEmail}>` : ''}`,
    `About:     ${venueName || 'QPinoy (general app feedback)'}`,
    `Submitted: ${submittedAt.toISOString()}`,
    '',
    'Comment:',
    comment ? comment : '(no comment left)',
    '',
    '—',
    'Sent by QPinoy. Reply directly to reach the customer.',
  ];

  try {
    await transport.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER || 'qpinoy@localhost',
      to: feedbackRecipient(),
      // So hitting Reply in the inbox goes to the customer rather than
      // to the app's own sending address.
      replyTo: fromEmail || undefined,
      subject,
      text: lines.join('\n'),
    });
    return true;
  } catch (err) {
    console.error('[mailer] could not send feedback email', err.message);
    return false;
  }
}

module.exports = { isConfigured, feedbackRecipient, sendFeedbackEmail, SUBJECT_TAG, _setTransportForTests };
