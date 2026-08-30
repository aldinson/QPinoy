'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isConfigured, feedbackRecipient, sendFeedbackEmail, SUBJECT_TAG, _setTransportForTests } = require('./mailer');

const ENV_KEYS = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'FEEDBACK_EMAIL_TO'];

function withEnv(values, t) {
  const saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, values);
  t.after(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    _setTransportForTests(null);
  });
}

/** A stand-in for nodemailer's transport that just records what it was asked to send. */
function fakeTransport(onSend) {
  return {
    sent: [],
    async sendMail(message) {
      this.sent.push(message);
      if (onSend) return onSend(message);
      return { messageId: 'fake' };
    },
  };
}

test('isConfigured() is false with no SMTP_HOST, so the feature degrades instead of failing', (t) => {
  withEnv({}, t);
  assert.equal(isConfigured(), false);
});

test('isConfigured() needs only a host — a trusted relay may legitimately want no credentials', (t) => {
  withEnv({ SMTP_HOST: 'smtp.example.com' }, t);
  assert.equal(isConfigured(), true);
});

test('feedbackRecipient() falls back to the project owner and is overridable by env', (t) => {
  withEnv({}, t);
  assert.equal(feedbackRecipient(), 'aldinson@gmail.com');

  process.env.FEEDBACK_EMAIL_TO = 'someone.else@example.com';
  assert.equal(feedbackRecipient(), 'someone.else@example.com');
});

test('sendFeedbackEmail() resolves false and sends nothing when SMTP is unconfigured', async (t) => {
  withEnv({}, t);
  const sent = await sendFeedbackEmail({
    rating: 5,
    comment: 'great',
    fromName: 'Ana',
    fromEmail: 'ana@example.com',
    venueName: null,
    submittedAt: new Date(),
  });
  assert.equal(sent, false);
});

test('the subject leads with the filter tag and carries the rating', async (t) => {
  withEnv({ SMTP_HOST: 'smtp.example.com' }, t);
  const transport = fakeTransport();
  _setTransportForTests(transport);

  const sent = await sendFeedbackEmail({
    rating: 4,
    comment: 'Line moved fast.',
    fromName: 'Ana Reyes',
    fromEmail: 'ana@example.com',
    venueName: 'Serenity Spa',
    submittedAt: new Date('2026-01-02T03:04:05Z'),
  });

  assert.equal(sent, true);
  const [msg] = transport.sent;
  assert.ok(msg.subject.startsWith(SUBJECT_TAG), `subject must start with the tag, got: ${msg.subject}`);
  assert.equal(SUBJECT_TAG, 'QPinoy User Feedback');
  assert.match(msg.subject, /4\/5/);
  assert.match(msg.subject, /Ana Reyes/);
  // Anything non-ASCII here forces the header into MIME encoded-word
  // form, which is exactly what a hand-written inbox filter trips on.
  // eslint-disable-next-line no-control-regex
  assert.match(msg.subject, /^[\x00-\x7F]*$/, `subject should stay plain ASCII, got: ${msg.subject}`);
});

test('the body carries rating, venue, and comment, and Reply goes to the customer', async (t) => {
  withEnv({ SMTP_HOST: 'smtp.example.com', FEEDBACK_EMAIL_TO: 'ops@example.com' }, t);
  const transport = fakeTransport();
  _setTransportForTests(transport);

  await sendFeedbackEmail({
    rating: 2,
    comment: 'Waited too long.',
    fromName: 'Ben Cruz',
    fromEmail: 'ben@example.com',
    venueName: 'Kuya Ben Barbershop',
    submittedAt: new Date('2026-01-02T03:04:05Z'),
  });

  const [msg] = transport.sent;
  assert.equal(msg.to, 'ops@example.com');
  assert.equal(msg.replyTo, 'ben@example.com', 'replying should reach the customer, not the app');
  assert.match(msg.text, /Waited too long\./);
  assert.match(msg.text, /Kuya Ben Barbershop/);
  assert.match(msg.text, /2\/5/);
});

test('a rating with no comment says so rather than sending a blank section', async (t) => {
  withEnv({ SMTP_HOST: 'smtp.example.com' }, t);
  const transport = fakeTransport();
  _setTransportForTests(transport);

  await sendFeedbackEmail({
    rating: 5,
    comment: '',
    fromName: 'Ana',
    fromEmail: 'ana@example.com',
    venueName: null,
    submittedAt: new Date(),
  });

  const [msg] = transport.sent;
  assert.match(msg.text, /\(no comment left\)/);
  // No venue means it's about the app itself, and should say so.
  assert.match(msg.text, /general app feedback/);
});

test('a transport failure resolves false instead of throwing — the feedback is already saved by then', async (t) => {
  withEnv({ SMTP_HOST: 'smtp.example.com' }, t);
  _setTransportForTests(
    fakeTransport(() => {
      throw new Error('535 authentication failed');
    })
  );

  const sent = await sendFeedbackEmail({
    rating: 3,
    comment: 'ok',
    fromName: 'Ana',
    fromEmail: 'ana@example.com',
    venueName: null,
    submittedAt: new Date(),
  });
  assert.equal(sent, false);
});
