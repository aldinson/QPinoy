'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { maskCustomerName } = require('./names');

test('masks a two-word name to a first-initial-plus-asterisks first name and a bare initial for the rest', () => {
  assert.equal(maskCustomerName('Alice Chen'), 'A**** C.');
  assert.equal(maskCustomerName('Bob Martinez'), 'B** M.');
});

test('masks a single-word name the same way as a first name, with no trailing initial', () => {
  assert.equal(maskCustomerName('Madonna'), 'M******');
});

test('a middle name collapses to just another initial, same as a last name', () => {
  assert.equal(maskCustomerName('Juan Carlos Dela Cruz'), 'J*** C. D. C.');
});

test('never reveals anything beyond the first letter of any word', () => {
  const masked = maskCustomerName('Christopher Nolan');
  assert.ok(!masked.toLowerCase().includes('hristopher'));
  assert.ok(!masked.toLowerCase().includes('olan'));
});

test('collapses irregular whitespace the same way real names get typed', () => {
  assert.equal(maskCustomerName('  Alice   Chen  '), 'A**** C.');
});

test('a genuinely single-letter word is left as-is rather than masked into nothing useful', () => {
  assert.equal(maskCustomerName('A B'), 'A B.');
});

test('empty or missing input masks to an empty string rather than throwing', () => {
  assert.equal(maskCustomerName(''), '');
  assert.equal(maskCustomerName(null), '');
  assert.equal(maskCustomerName(undefined), '');
});
