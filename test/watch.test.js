// Watches: the Apple Watch keyboard's key positions, and what each kind of watch reports it can't do.
import assert from 'node:assert/strict';
import test from 'node:test';

import { WATCH_KEYS, watchTaps } from '../lib/ios.js';
import { KINDS, capabilities, capability } from '../lib/capabilities.js';
import { UsageError } from '../lib/util.js';

const kb = { x: 0, y: 45, w: 208, h: 193 }; // a 46 mm watch's keyboard, in points

test('watch keyboard: letters, spaces and capitals become taps where the keys are drawn', () => {
  const taps = watchTaps('Hi q', kb);
  assert.deepEqual(taps.map((t) => t.key), ['shift', 'H', 'i', ' ', 'q']);
  // q is the first key of the top row, p the last; space is the bar at the bottom
  assert.deepEqual(watchTaps('q', kb)[0], { key: 'q', x: 11, y: 113 });
  assert.deepEqual(watchTaps('p', kb)[0], { key: 'p', x: 196, y: 113 });
  assert.deepEqual(watchTaps(' ', kb)[0], { key: ' ', x: 104, y: 214 });
  assert.equal(Object.keys(WATCH_KEYS).filter((k) => k.length === 1 && k !== ' ').length, 26);
  assert.throws(() => watchTaps('a1', kb), (e) => e instanceof UsageError && /has no "1"/.test(e.message));
});

test('watch kinds: their own columns, and the reasons they differ', () => {
  assert.equal(KINDS['watchos-simulator'].title, 'Apple Watch simulator');
  assert.equal(KINDS.wearos.title, 'Wear OS watch');
  // An Apple Watch simulator is an iOS simulator, with the watch's differences on top.
  assert.equal(capability('watchos-simulator', 'network').status, 'unsupported');
  assert.equal(capability('watchos-simulator', 'paste').status, 'unsupported');
  assert.equal(capability('watchos-simulator', 'type').status, 'conditional');
  assert.equal(capability('watchos-simulator', 'tap').status, 'supported');
  assert.equal(capability('ios-simulator', 'paste').status, 'supported');
  // Wear OS: an Android device, plus a watch's own.
  assert.equal(capability('wearos', 'push').status, 'unsupported');
  assert.equal(capability('wearos', 'rotate').status, 'unsupported');
  assert.equal(capability('wearos', 'ls').status, 'conditional');
  assert.ok(Object.keys(capabilities('wearos')).includes('launch'));
});
