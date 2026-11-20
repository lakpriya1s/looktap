// A stuck adb link, an unauthorized phone, a hung adb server, a stale log: each is classified and named, every call
// returns within its timeout, and no child process is left behind. Driven by test/fake/adb (see FAKE_ADB_MODE there).
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const FAKE = new URL('./fake/', import.meta.url).pathname;
process.env.PATH = `${FAKE.replace(/\/$/, "")}:${process.env.PATH}`;
process.env.LOOKTAP_HOME = mkdtempSync(join(tmpdir(), 'looktap-stuck-'));
process.env.LOOKTAP_ADB_TIMEOUT = '2';
delete process.env.ANDROID_HOME;

const { ADB, StuckError } = await import('../lib/util.js');
const health = await import('../lib/health.js');
const { Android } = await import('../lib/android.js');

const mode = (m, extra = {}) => Object.assign(process.env, { FAKE_ADB_MODE: m, ...extra });
const timed = (fn) => {
  const t = Date.now();
  let value, error;
  try {
    value = fn();
  } catch (e) {
    error = e;
  }
  return { value, error, ms: Date.now() - t };
};
/** Fake adb processes still running (other than `except`). */
const leftovers = (except = []) =>
  spawnSync('pgrep', ['-f', `${FAKE}adb`], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean).map(Number).filter((p) => !except.includes(p));

test('looktap uses the fake adb', () => {
  assert.equal(ADB, `${FAKE}adb`);
});

test('a device that never answers: unresponsive, within the timeout, nothing left running', () => {
  mode('hang');
  const r = timed(() => health.probe('FAKE123', { fresh: true }));
  assert.equal(r.value.state, 'unresponsive');
  assert.ok(r.ms < 4000, `took ${r.ms} ms`);
  assert.match(health.explain('unresponsive', 'FAKE123').text, /did not answer in 2 s \(adb link stuck\); run looktap doctor -d FAKE123/);
  assert.deepEqual(leftovers(), []);
});

test('a stuck device is never "not installed": every adb call throws what is wrong, in time', () => {
  mode('hang');
  const d = new Android('FAKE123', {});
  const r = timed(() => d.uidOf('com.example.app'));
  assert.ok(r.error instanceof StuckError, r.error?.message);
  assert.doesNotMatch(r.error.message, /not installed/);
  assert.match(r.error.message, /did not answer in 2 s \(adb link stuck\); run looktap doctor -d FAKE123 \(it was running: adb shell cmd package list/);
  assert.equal(r.error.layer, 'usb');
  assert.ok(r.ms < 6000, `took ${r.ms} ms`);
  assert.deepEqual(leftovers(), []);
});

test('a device that answers in 4 s: slow, with the latency', () => {
  mode('slow', { FAKE_ADB_DELAY: '3500', LOOKTAP_ADB_TIMEOUT: '2' });
  // The probe's own timeout here is the default (min of the device timeout and 10 s): give it room.
  const r = timed(() => health.probe('FAKE123', { fresh: true, timeout: 6000 }));
  assert.equal(r.value.state, 'slow');
  assert.ok(r.value.latency >= 3500 && r.value.latency < 6000);
  assert.match(health.explain('slow', 'FAKE123', { latency: r.value.latency }).text, /answers, but slowly \(3\.\d s for a round trip\)/);
});

test('an unauthorized phone: says to accept the prompt', () => {
  mode('unauthorized');
  const p = health.probe('FAKE123', { fresh: true });
  assert.equal(p.state, 'unauthorized');
  const e = timed(() => health.assertHealthy('FAKE123')).error;
  assert.ok(e instanceof StuckError);
  assert.match(e.message, /Allow USB debugging\?/);
  assert.equal(e.layer, 'device');
});

test('adb devices hangs while an open stream keeps going: adb-server-hung, and the stream is untouched', async () => {
  mode('server-hung');
  const stream = spawn(ADB, ['-s', 'FAKE123', 'logcat', '-v', 'year'], { stdio: ['ignore', 'pipe', 'ignore'] });
  let lines = 0;
  stream.stdout.on('data', (c) => (lines += String(c).split('\n').length - 1));
  await new Promise((r) => setTimeout(r, 300));
  const r = timed(() => health.probe('FAKE123', { fresh: true }));
  assert.equal(r.value.state, 'adb-server-hung');
  assert.ok(r.ms < 6000, `took ${r.ms} ms`);
  const e = timed(() => health.assertHealthy('FAKE123')).error;
  assert.equal(e.layer, 'adb-server');
  assert.match(e.message, /adb server on this computer did not answer/);
  await new Promise((r) => setTimeout(r, 300));
  const before = lines;
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(lines > before && before > 0, 'the stream kept producing lines');
  assert.deepEqual(leftovers([stream.pid]), []);
  stream.kill();
});

test('the device list itself hanging is a stuck server, not "no device"', async () => {
  mode('server-hung');
  const { adbDevices } = await import('../lib/android.js');
  const r = timed(() => adbDevices());
  assert.ok(r.error instanceof StuckError);
  assert.equal(r.error.state, 'adb-server-hung');
});

test('a log hours behind the device clock is noticed', () => {
  mode('stale');
  const { now, newest } = new Android('FAKE123', {}).logAge();
  assert.ok(now - newest > 2 * 3600e3);
  mode('ok');
  const fresh = new Android('FAKE123', {}).logAge();
  assert.ok(fresh.now - fresh.newest < 60e3);
});

test('a healthy device: ok, its USB path and the hubs on it', () => {
  mode('ok');
  const p = health.probe('FAKE123', { fresh: true });
  assert.equal(p.state, 'ok');
  assert.equal(p.usb, '2-1.1.1');
  assert.equal(health.hubsOn(p.usb), 2);
  // Cached: a second probe within 10 s doesn't ask adb again (it would hang now).
  mode('hang');
  assert.equal(timed(() => health.probe('FAKE123')).value.state, 'ok');
  health.forget('FAKE123');
  assert.equal(health.probe('FAKE123').state, 'unresponsive');
  assert.deepEqual(leftovers(), []);
});

test('parsers: adb devices -l, hubs, ps times, reverse rules, adb processes', () => {
  assert.deepEqual(health.parseAdbDevices('List of devices attached\nR83Y30R6V6M  device usb:2-1.1.1 product:a06xx model:SM_A065F\nemulator-5554 offline\n* daemon started\n'), [
    { id: 'R83Y30R6V6M', state: 'device', usb: '2-1.1.1', model: 'SM_A065F' },
    { id: 'emulator-5554', state: 'offline', usb: null, model: null },
  ]);
  assert.equal(health.hubsOn('2-1'), 0);
  assert.equal(health.hubsOn('1-3.2'), 1);
  assert.equal(health.hubsOn(null), 0);
  assert.equal(health.etimeSecs('03:48'), 228);
  assert.equal(health.etimeSecs('1-02:03:04'), 93784);
  assert.deepEqual(health.parseReverse('host-3 tcp:8081 tcp:8081\nUsbFfs tcp:9000 tcp:9001\n'), [
    { remote: 'tcp:8081', local: 'tcp:8081' },
    { remote: 'tcp:9000', local: 'tcp:9001' },
  ]);
  assert.equal(health.deviceProcess('adb -L tcp:5037 fork-server server --reply-fd 4'), 'adb server');
  assert.equal(health.deviceProcess('/opt/sdk/platform-tools/adb -s R83 logcat -v time'), 'adb');
  assert.equal(health.deviceProcess('idevicesyslog -u 61dc -p app'), 'idevicesyslog');
  assert.equal(health.deviceProcess('/bin/zsh -c adb logcat'), null);
  assert.equal(health.classify({ devices: null }, 'X'), 'adb-server-hung');
  assert.equal(health.classify({ devices: 'List\nY device\n' }, 'X'), 'missing');
  assert.equal(health.classify({ devices: 'List\nX offline\n' }, 'X'), 'offline');
  assert.equal(health.classify({ devices: 'List\nX device\n', echo: { ms: 40, out: 'ok\n' } }, 'X'), 'ok');
});

test('a log capture cut off (adb restarted) attaches again and reports the gap, with who restarted adb', async () => {
  mode('ok');
  const { notify } = await import('../lib/lease.js');
  const d = new Android('FAKE123', {});
  const lines = [], gaps = [];
  const stop = d.followLogs('com.example.app', Date.now() - 1000, { onLine: (l) => lines.push(l), onEvent: () => {}, onGap: (g) => gaps.push(g) });
  await new Promise((r) => setTimeout(r, 500));
  assert.ok(lines.length > 0);
  // Another looktap restarts adb: it leaves a notice, and every adb client (our stream too) dies.
  notify('FAKE123', 'the adb server is being restarted');
  spawnSync('pkill', ['-9', '-f', `${FAKE}adb -s FAKE123 logcat`]);
  const before = lines.length;
  await new Promise((r) => setTimeout(r, 2000));
  stop();
  assert.ok(lines.length > before, 'lines came again after the restart');
  assert.equal(gaps.length, 1);
  assert.ok(gaps[0].to > gaps[0].from);
  assert.equal(gaps[0].by.text, 'the adb server is being restarted');
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(leftovers(), []);
});
