import assert from 'node:assert/strict';
import { test } from 'node:test';

import { IosDevice } from '../lib/iosdevice.js';
import { UsageError } from '../lib/util.js';

const REFUSED = 'Error Domain=XCTDaemonErrorDomain Code=41 "Not authorized for performing UI testing actions."';

/** An unlocked IosDevice whose runner answers with `answers` in turn (an Error is thrown), counting restarts. */
function device(...answers) {
  const d = new IosDevice('00008120-0000000000000000', { out: '/tmp' });
  d.restarts = 0;
  d.locked = async () => false;
  d.helper = async () => ({ call: async () => { const a = answers.shift(); if (a instanceof Error) throw a; return a; } });
  d.restartRunner = async () => { d.restarts++; };
  return d;
}

test('a runner that lost permission to drive the UI is restarted once, and the call retried', async () => {
  const d = device(new Error(REFUSED), { ok: true });
  assert.deepEqual(await d.call('front'), { ok: true });
  assert.equal(d.restarts, 1);
});

test('refused again after a restart: a usage error that says what to check', async () => {
  const d = device(new Error(REFUSED), new Error(REFUSED));
  await assert.rejects(d.call('front'), (e) => e instanceof UsageError && /unlock it.*Enable UI Automation/.test(e.message));
  assert.equal(d.restarts, 1);
});

test('other runner errors are not retried', async () => {
  const d = device(new Error('helper timed out on swipe'));
  await assert.rejects(d.call('swipe'), /timed out/);
  assert.equal(d.restarts, 0);
});

test('a locked device says so, without restarting the runner', async () => {
  const d = device(new Error(REFUSED));
  d.locked = async () => true;
  await assert.rejects(d.call('front'), (e) => e instanceof UsageError && /device is locked: unlock it/.test(e.message));
  assert.equal(d.restarts, 0);
});
