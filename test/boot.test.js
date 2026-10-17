import assert from 'node:assert/strict';
import { test } from 'node:test';

import { pick } from '../lib/boot.js';
import { UsageError } from '../lib/util.js';

// As simulators() lists them: newest iOS first.
const sims = [
  { id: 'A1', name: 'iPhone 16 Pro', os: 'iOS 26.0' },
  { id: 'A2', name: 'iPhone 16 Pro Max', os: 'iOS 26.0' },
  { id: 'A3', name: 'iPhone 14', os: 'iOS 26.0' },
  { id: 'B3', name: 'iPhone 14', os: 'iOS 18.2' },
  { id: 'Pixel_9a', name: 'Pixel_9a' },
];

test('an exact name or id wins over a longer name it starts', () => {
  assert.equal(pick(sims, 'iPhone 16 Pro', 'devices').id, 'A1');
  assert.equal(pick(sims, 'a2', 'devices').id, 'A2');
  assert.equal(pick(sims, 'pixel_9a', 'devices').id, 'Pixel_9a');
});

test('the same model under several iOS versions: the newest', () => {
  assert.equal(pick(sims, 'iPhone 14', 'devices').id, 'A3');
});

test('a unique prefix or substring names one; an ambiguous one is an error, never a guess', () => {
  assert.equal(pick(sims, 'pixel', 'devices').id, 'Pixel_9a');
  assert.equal(pick(sims, 'max', 'devices').id, 'A2');
  assert.throws(() => pick(sims, 'iPhone 16', 'devices'), (e) => e instanceof UsageError && /iPhone 16 Pro, iPhone 16 Pro Max/.test(e.message));
  assert.equal(pick(sims, 'Galaxy', 'devices'), null);
});
