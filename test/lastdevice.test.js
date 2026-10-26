import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.LOOKTAP_HOME = mkdtempSync(join(tmpdir(), 'looktap-test-'));
const { lastDevice, rememberDevice } = await import('../lib/devices.js');

// A real iPhone's UDID: no simulator state file to check, so it's trusted while recent.
const PHONE = '00008120-001A2B3C4D5E6F70';

test('the last device is used again while recent, and only on its own platform', () => {
  rememberDevice('ios', PHONE);
  assert.deepEqual(lastDevice(), { platform: 'ios', device: PHONE });
  assert.deepEqual(lastDevice('ios'), { platform: 'ios', device: PHONE });
  assert.equal(lastDevice('android'), null);
});

test('after 10 minutes it is forgotten', () => {
  writeFileSync(join(process.env.LOOKTAP_HOME, 'last-device.json'), JSON.stringify({ platform: 'ios', id: PHONE, at: Date.now() - 11 * 60 * 1000 }));
  assert.equal(lastDevice(), null);
});
