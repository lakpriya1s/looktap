import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const bin = new URL('../bin/looktap.js', import.meta.url).pathname;
const looktap = (...args) =>
  spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', timeout: 5000, env: { ...process.env, LOOKTAP_HOME: mkdtempSync(join(tmpdir(), 'looktap-test-')) } });

test('an unknown option is a usage error naming the command, before any device is looked for', () => {
  const r = looktap('swipe', '192', '600', '192', '300', '--bogus-flag');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown option --bogus-flag for swipe; usage: swipe <x1> <y1> <x2> <y2> \[ms\]/);
  assert.equal(looktap('ls', '-x').status, 2);
});

test('--duration goes with swipe and longpress only, and takes milliseconds', () => {
  assert.match(looktap('tap', 'OK', '--duration', '500').stderr, /--duration goes with swipe and longpress, not tap/);
  assert.match(looktap('swipe', '1', '2', '3', '4', '--duration', 'slow').stderr, /milliseconds/);
});
