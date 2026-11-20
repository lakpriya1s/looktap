// Leases between looktap processes: an exclusive holder makes another wait and then fail with who holds it, `who`
// lists every holder, and a dead holder's lease (its process gone, or its heartbeat 30 s old) is taken over.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.LOOKTAP_LEASES = mkdtempSync(join(tmpdir(), 'looktap-leases-'));
process.env.LOOKTAP_OWNER = 'test runner';
const lease = await import('../lib/lease.js');
const { whoLines, didYouMean, processDevice } = await import('../lib/upkeep.js');
const { COMMANDS } = await import('../lib/capabilities.js');

const LEASE = new URL('../lib/lease.js', import.meta.url).href;

/** Another looktap process holding a lease on `device` until killed. Resolves once it holds it. */
function holder(device, kind, command, owner) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    const { acquire } = await import(${JSON.stringify(LEASE)});
    await acquire(${JSON.stringify(device)}, { kind: ${JSON.stringify(kind)}, command: ${JSON.stringify(command)} });
    console.log('held');
    setInterval(() => {}, 1e6);
  `], { env: { ...process.env, LOOKTAP_OWNER: owner }, stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((resolve) => child.stdout.once('data', () => resolve(child)));
}

test('an exclusive holder: another process waits, then fails naming who holds it and for how long', async () => {
  const a = await holder('dev1', 'exclusive', 'tap Settings', 'agent A');
  try {
    const t = Date.now();
    await assert.rejects(lease.acquire('dev1', { kind: 'exclusive', command: 'type hello', wait: 600 }), (e) => {
      assert.ok(e instanceof lease.BusyError);
      assert.match(e.message, /^device busy: agent A running "tap Settings" for \d+s on dev1/);
      return true;
    });
    assert.ok(Date.now() - t >= 550 && Date.now() - t < 3000);
    // A shared lease (a log stream, a screenshot) goes alongside it.
    const s = await lease.acquire('dev1', { kind: 'shared-stream', command: 'logs --follow' });
    const lines = whoLines('dev1');
    assert.ok(lines.some((l) => /exclusive {2}agent A {2}"tap Settings"/.test(l)), lines.join('\n'));
    assert.ok(lines.some((l) => /shared {5}test runner {2}"logs --follow"/.test(l)), lines.join('\n'));
    s.release();
  } finally {
    a.kill();
  }
});

test('once the holder finishes, the waiting process gets the device', async () => {
  const a = await holder('dev2', 'exclusive', 'launch app', 'agent A');
  setTimeout(() => a.kill(), 300);
  const l = await lease.acquire('dev2', { kind: 'exclusive', command: 'tap OK', wait: 5000 });
  assert.equal(lease.leases('dev2').find((x) => x.kind === 'exclusive').command, 'tap OK');
  l.release();
  assert.equal(lease.leases('dev2').length, 0);
});

test('a dead holder is taken over: its pid gone, or its heartbeat 30 s old', async () => {
  const at = (ms) => new Date(Date.now() - ms).toISOString();
  mkdirSync(lease.LEASES, { recursive: true });
  // Gone: a pid nothing runs as.
  writeFileSync(join(lease.LEASES, 'dev3.json'), JSON.stringify({ owner: 'gone', command: 'tap X', started_at: at(5e3), heartbeat_at: at(1e3), pid: 999999, kind: 'exclusive' }));
  assert.equal(lease.leases('dev3')[0].dead, true);
  const l = await lease.acquire('dev3', { command: 'tap Y', wait: 0 });
  l.release();
  // Alive, but silent for 31 s (a frozen process, or the pid reused).
  const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)']);
  try {
    writeFileSync(join(lease.LEASES, 'dev3.json'), JSON.stringify({ owner: 'frozen', command: 'tap X', started_at: at(60e3), heartbeat_at: at(31e3), pid: sleeper.pid, kind: 'exclusive' }));
    assert.equal(lease.dead(lease.leases('dev3')[0]), true);
    const m = await lease.acquire('dev3', { command: 'tap Z', wait: 0 });
    assert.equal(lease.leases('dev3')[0].owner, 'test runner');
    m.release();
    // Alive and beating: not dead.
    writeFileSync(join(lease.LEASES, 'dev3.json'), JSON.stringify({ owner: 'busy', command: 'tap X', started_at: at(60e3), heartbeat_at: at(2e3), pid: sleeper.pid, kind: 'exclusive' }));
    await assert.rejects(lease.acquire('dev3', { command: 'tap Z', wait: 0 }), /device busy: busy running "tap X" for 1m00s/);
    assert.equal(lease.sweep('dev3'), 0);
  } finally {
    sleeper.kill();
  }
});

test('the same process takes its own lease again (a run script, MCP calls) without waiting', async () => {
  const a = await lease.acquire('dev4', { command: 'run …' });
  const b = await lease.acquire('dev4', { command: 'tap A', wait: 0 });
  assert.equal(b.nested, true);
  b.release();
  assert.equal(lease.leases('dev4').length, 1);
  a.release();
});

test('a notice (an adb restart) reaches holders', async () => {
  let got = null;
  const l = await lease.acquire('dev5', { kind: 'shared-stream', command: 'logs --follow', onNotice: (n) => (got = n) });
  lease.notify('dev5', 'the adb server is being restarted');
  // Written by this same process: ignored by its own holders, so check the record and a foreign view of it.
  assert.equal(got, null);
  assert.equal(lease.noticeSince('dev5', Date.now() - 5000).text, 'the adb server is being restarted');
  assert.equal(lease.noticeSince('dev5', Date.now() + 5000), null);
  l.release();
});

test('which commands take the device to themselves', () => {
  for (const c of ['tap', 'type', 'launch', 'install', 'stop', 'location', 'fill', 'kill']) assert.equal(lease.kindOf(c), 'exclusive', c);
  for (const c of ['logs', 'shot', 'ls', 'record', 'wait', 'ps', 'crashes']) assert.equal(lease.kindOf(c), 'shared-stream', c);
  assert.equal(lease.kindOf('route', ['--from-current']), 'shared-stream');
  assert.equal(lease.kindOf('route', ['stop']), 'exclusive');
  assert.equal(lease.kindOf('network', ['offline']), 'exclusive');
  assert.equal(lease.kindOf('network', ['com.example.app']), 'shared-stream');
  assert.equal(lease.age(134e3), '2m14s');
  assert.equal(lease.age(3780e3), '1h03m');
});

test('did you mean: the command an agent guessed', () => {
  const known = ['doctor', 'who', ...COMMANDS];
  assert.equal(didYouMean('lauch', known), 'launch');
  assert.equal(didYouMean('logcat', known), 'logs');
  assert.equal(didYouMean('screencap', known), 'shot');
  assert.equal(didYouMean('click', known), 'tap');
  assert.equal(didYouMean('zzzzzz', known), null);
  assert.equal(processDevice('adb -s R83Y30R6V6M logcat -v time'), 'R83Y30R6V6M');
  assert.equal(processDevice('idevicesyslog -u 61dc2ee1 -p app'), '61dc2ee1');
  assert.equal(processDevice('adb logcat'), null);
});
