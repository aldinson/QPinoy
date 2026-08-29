'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalisePhone, describePhoneProblem } = require('./phone');

const PH = '+639171234567';

test('accepts the local formats people actually type, all landing on one E.164 value', () => {
  // The whole point of normalising: these are the same person, and a
  // stored number is only useful if it can be dialled or texted.
  for (const written of [
    '09171234567',
    '0917 123 4567',
    '0917-123-4567',
    '(0917) 123-4567',
    '+639171234567',
    '+63 917 123 4567',
    '639171234567',
    '63 917 123 4567',
    '9171234567', // leading zero dropped
    '  09171234567  ',
  ]) {
    assert.equal(normalisePhone(written), PH, `failed to normalise: ${written}`);
  }
});

test('accepts other countries in explicit international form', () => {
  // A tourist at a clinic must not be locked out of the product.
  assert.equal(normalisePhone('+14155552671'), '+14155552671');
  assert.equal(normalisePhone('+44 20 7946 0958'), '+442079460958');
  assert.equal(normalisePhone('+81 90 1234 5678'), '+819012345678');
});

test('a PH landline is accepted only in international form', () => {
  // Documented behaviour, not an accident: the field asks for a
  // CELLPHONE, because the reason for collecting it is texting someone
  // that their turn is coming up. The international form stays open as
  // an escape hatch rather than hard-blocking anyone.
  assert.equal(normalisePhone('028123456'), null, 'local landline format should be rejected');
  assert.equal(normalisePhone('+6328123456'), '+6328123456', 'international form is the escape hatch');
});

test('rejects numbers that are the wrong length for a PH mobile', () => {
  assert.equal(normalisePhone('0917123456'), null, 'one digit short');
  assert.equal(normalisePhone('091712345678'), null, 'one digit long');
  assert.equal(normalisePhone('0817123456789'), null, 'not a 9-prefixed mobile');
});

test('rejects junk rather than mangling it into a plausible number', () => {
  for (const junk of [
    '',
    '   ',
    'not a phone',
    '0917 123 4567 ext 12', // letters survive stripping and fail loudly
    '+',
    '+0123456789', // E.164 country codes never start with 0
    '++639171234567',
    '0917abc4567',
    '12345',
    '+12', // too short to be a real number
    '+1234567890123456', // 16 digits, over the E.164 cap
  ]) {
    assert.equal(normalisePhone(junk), null, `should have rejected: "${junk}"`);
  }
});

test('non-string inputs are rejected, not coerced', () => {
  assert.equal(normalisePhone(undefined), null);
  assert.equal(normalisePhone(null), null);
  assert.equal(normalisePhone(9171234567), null);
  assert.equal(normalisePhone({}), null);
});

test('normalising an already-normalised number is a no-op', () => {
  // Re-saving a stored profile must not corrupt the number.
  assert.equal(normalisePhone(normalisePhone('0917 123 4567')), PH);
});

test('describePhoneProblem explains what is wrong, and passes good numbers', () => {
  assert.match(describePhoneProblem(''), /required/);
  assert.match(describePhoneProblem(undefined), /required/);
  assert.match(describePhoneProblem('12345'), /valid mobile number/);
  // The message shows a real example rather than just saying "invalid".
  assert.match(describePhoneProblem('12345'), /0917/);
  assert.equal(describePhoneProblem('0917 123 4567'), null);
  assert.equal(describePhoneProblem('+14155552671'), null);
});
