// looktap live's dashboard: the activity log, device health, the per-device actions, and a turn of an Android screen.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { follow, parse, recent, record, summary } from '../lib/activity.js';
import { actionValue, actionsFor, kindOf } from '../lib/live-actions.js';
import { parseBattery, parseDf, parseThermal } from '../lib/live-health.js';
import { controlMessage, displayTurns } from '../lib/live.js';
import { brief } from '../lib/live-iphone.js';
import { startable } from '../lib/live-devices.js';

const temp = () => join(mkdtempSync(join(tmpdir(), 'looktap-activity-')), 'activity.jsonl');

test('activity: a command is shown with its arguments, typed text only as a length', () => {
  assert.equal(summary('tap', ['Sign in']), 'tap "Sign in"');
  assert.equal(summary('swipe', ['up']), 'swipe up');
  assert.equal(summary('type', ['hunter2']), 'type (7 characters)');
  assert.equal(summary('type', ['two', 'words']), 'type (9 characters)');
  assert.equal(summary('paste', ['x']), 'paste (1 character)');
  assert.equal(summary('code', ['123456']), 'code (6 characters)');
  // fill <field> <text>: the field is kept, what went in is not.
  assert.equal(summary('fill', ['@3', 'me@example.com']), 'fill @3 (14 characters)');
  assert.equal(summary('open', ['x'.repeat(200)]).length, 120);
});

test('activity: entries are written as JSON lines and read back, the newest last', () => {
  const path = temp();
  record({ device: 'A', cmd: 'tap', args: ['OK'], ok: true, ms: 412.6 }, path);
  record({ device: 'A', cmd: 'type', args: ['secret'], ok: false, ms: 9, error: 'no field has focus\nmore detail', via: 'mcp' }, path);
  record({ cmd: 'tap' }, path); // no device: not written
  const all = recent(10, path);
  assert.equal(all.length, 2);
  assert.deepEqual([all[0].what, all[0].ok, all[0].ms, all[0].via], ['tap OK', true, 413, 'cli']);
  assert.deepEqual([all[1].what, all[1].error, all[1].via], ['type (6 characters)', 'no field has focus', 'mcp']);
  assert.ok(!readFileSync(path, 'utf8').includes('secret'));
});

test('activity: a half-written or broken line is skipped', () => {
  assert.deepEqual(parse('{"t":1,"device":"A","cmd":"ls"}\n{"t":2,"dev\nnot json\n').map((e) => e.cmd), ['ls']);
});

test('activity: the file is cut to its newer half once it grows past 512 KB', () => {
  const path = temp();
  const line = JSON.stringify({ t: 1, device: 'A', cmd: 'ls', what: 'x'.repeat(1000), ok: true, ms: 1, via: 'cli' });
  writeFileSync(path, `${line}\n`.repeat(520));
  record({ device: 'A', cmd: 'home', ok: true, ms: 1 }, path);
  assert.ok(statSync(path).size <= 300 * 1024);
  assert.equal(recent(1, path)[0].cmd, 'home');
  assert.ok(parse(readFileSync(path, 'utf8')).length > 100); // whole lines only
});

test('activity: follow hands over what is written after it started', async () => {
  const path = temp();
  record({ device: 'A', cmd: 'ls', ok: true, ms: 1 }, path);
  const got = [];
  const stop = follow((e) => got.push(e.cmd), { path, every: 20 });
  await new Promise((r) => setTimeout(r, 30));
  record({ device: 'A', cmd: 'tap', args: ['OK'], ok: true, ms: 1 }, path);
  record({ device: 'B', cmd: 'home', ok: true, ms: 1 }, path);
  await new Promise((r) => setTimeout(r, 100));
  stop();
  assert.deepEqual(got, ['tap', 'home']);
});

test('health: Android battery, storage and heat from dumpsys and df', () => {
  const battery = 'Current Battery Service state:\n  AC powered: false\n  USB powered: true\n  status: 2\n  level: 47\n  scale: 100\n  temperature: 312\n';
  assert.deepEqual(parseBattery(battery), { level: 47, charging: true, full: false, temp: 31.2 });
  assert.deepEqual(parseBattery('  USB powered: true\n  status: 5\n  level: 100\n  scale: 100\n'), { level: 100, charging: true, full: true });
  assert.equal(parseBattery('nothing'), null);
  assert.deepEqual(parseDf('Filesystem     1K-blocks    Used Available Use% Mounted on\n/dev/block/dm-48 110663664 25441024 85222640  23% /data\n'), { free: 85222640 * 1024, total: 110663664 * 1024 });
  assert.equal(parseDf('df: /data: Permission denied'), null);
  assert.equal(parseThermal('IsStatusOverride: false\nThermal Status: 0\n'), 'normal');
  assert.equal(parseThermal('Thermal Status: 3'), 'severe');
  assert.equal(parseThermal(''), null);
});

test('actions: each device gets the buttons its kind can do', () => {
  assert.equal(kindOf({ platform: 'ios', kind: 'simulator', name: 'iPhone 16' }), 'ios-simulator');
  assert.equal(kindOf({ platform: 'ios', kind: 'simulator', name: 'Apple Watch Series 10' }), 'watchos-simulator');
  assert.equal(kindOf({ platform: 'ios', kind: 'device', name: 'iPhone' }), 'ios-device');
  assert.equal(kindOf({ platform: 'android', kind: 'emulator', name: 'Pixel_9a' }), 'android-emulator');
  assert.deepEqual(actionsFor({ platform: 'android', kind: 'device', name: 'Pixel' }), ['rotate', 'appearance', 'textsize', 'touches', 'open']);
  // A real iPhone: no text size (set in Settings), and no touches switch (only an app built with LooktapTouches.m).
  assert.deepEqual(actionsFor({ platform: 'ios', kind: 'device', name: 'iPhone' }), ['rotate', 'appearance', 'open']);
  assert.ok(!actionsFor({ platform: 'ios', kind: 'simulator', name: 'Apple Watch Ultra' }).includes('rotate'));
});

test('actions: only known values reach a device', () => {
  assert.equal(actionValue('rotate', 'landscape'), 'landscape');
  assert.equal(actionValue('rotate', 'sideways'), null);
  assert.equal(actionValue('appearance', 'dark'), 'dark');
  assert.equal(actionValue('textsize', 'extra-large'), 'extra-large');
  assert.equal(actionValue('textsize', 'huge'), null);
  assert.equal(actionValue('touches', 'on'), 'on');
  assert.equal(actionValue('open', 'https://example.com/a?b=1'), 'https://example.com/a?b=1');
  assert.equal(actionValue('open', 'myapp://path'), 'myapp://path');
  assert.equal(actionValue('open', 'not a url'), null);
  assert.equal(actionValue('install', 'x'), null);
  assert.deepEqual(controlMessage(JSON.stringify({ id: 'X', type: 'action', name: 'appearance', value: 'dark' })), { id: 'X', type: 'action', name: 'appearance', value: 'dark' });
  assert.equal(controlMessage(JSON.stringify({ id: 'X', type: 'action', name: 'shell', value: 'rm' })), null);
});

test('live: an Android display turn read from dumpsys input', () => {
  assert.equal(displayTurns('  Viewport INTERNAL: displayId=0, uniqueId=local:1, port=0, orientation=1, logicalFrame=[0, 0, 2424, 1080]'), 1);
  assert.equal(displayTurns('    SurfaceOrientation: 3'), 3);
  assert.equal(displayTurns(''), null);
});

test('live: the Start picker offers simulators and emulators that are off, never a phone', () => {
  const list = [
    { platform: 'ios', kind: 'simulator', id: 'A', name: 'iPhone 16 Pro', os: 'iOS 26.0', running: false },
    { platform: 'ios', kind: 'simulator', id: 'B', name: 'iPhone 14', os: 'iOS 26.0', ready: true },
    { platform: 'android', kind: 'emulator', id: 'Pixel_9a', name: 'Pixel_9a', running: false },
    { platform: 'android', kind: 'device', id: 'R8', name: 'Samsung', running: false },
  ];
  assert.deepEqual(startable(list).map((d) => d.id), ['A', 'Pixel_9a']);
  assert.deepEqual(controlMessage(JSON.stringify({ id: 'A', type: 'boot' })), { id: 'A', type: 'boot' });
  assert.deepEqual(controlMessage(JSON.stringify({ id: 'B', type: 'shutdown' })), { id: 'B', type: 'shutdown' });
});

test('live: a phone paused from the runner app says how to resume', () => {
  assert.match(brief('paused on the iPhone: turn Allow control back on in the looktap runner app'), /Allow control/);
});
