// A chain of looktap commands in one shell call: once an action failed, the later actions and waits from the same
// script are skipped at once with what failed; reading the screen still runs, and other shells are never stopped.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const CLI = new URL('../bin/looktap.js', import.meta.url).pathname;
const FAKE = new URL('./fake', import.meta.url).pathname;
const home = mkdtempSync(join(tmpdir(), 'looktap-chain-'));
const env = { ...process.env, PATH: `${FAKE}:${process.env.PATH}`, LOOKTAP_HOME: home, LOOKTAP_LEASES: join(home, 'leases'), FAKE_ADB_MODE: 'unauthorized', LOOKTAP_ADB_TIMEOUT: '2' };
delete env.LOOKTAP_CONTINUE_AFTER_FAILURE;
// The CLI is this test's child: its parent is this process, as a script's commands share their shell.
const looktap = (args, extra = {}) => spawnSync(process.execPath, [CLI, '-p', 'android', '-d', 'FAKE123', ...args], { env: { ...env, ...extra }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const failed = (ppid, at = Date.now()) => writeFileSync(join(home, 'chain.json'), JSON.stringify({ FAKE123: { ppid, at, step: 'tap Checkout', why: 'not found: Checkout' } }));

test('after a failed action in the same script, the next action is skipped at once, naming what failed', () => {
  failed(process.pid);
  const r = looktap(['tap', 'Pay']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /skipped: an earlier command in this script failed \(looktap tap Checkout: not found: Checkout\).*looktap ls/);
  assert.match(looktap(['wait', 'Done']).stderr, /skipped/);
});

test('reading the screen is not skipped; another shell, an old failure, or the override is not stopped', () => {
  failed(process.pid);
  // ls goes on to the device (the fake one says it is unauthorized): not skipped
  assert.doesNotMatch(looktap(['ls']).stderr, /skipped/);
  failed(process.pid + 1);
  assert.doesNotMatch(looktap(['tap', 'Pay']).stderr, /skipped/);
  failed(process.pid, Date.now() - 11 * 60e3);
  assert.doesNotMatch(looktap(['tap', 'Pay']).stderr, /skipped/);
  failed(process.pid);
  assert.doesNotMatch(looktap(['tap', 'Pay'], { LOOKTAP_CONTINUE_AFTER_FAILURE: '1' }).stderr, /skipped/);
});
