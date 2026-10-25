import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { installFailure } from '../lib/android.js';
import { parseSyslog, readCollected } from '../lib/devicelog.js';
import { IosDevice, devicectlError } from '../lib/iosdevice.js';
import { decodePng, encodePng, pictureChange } from '../lib/png.js';
import { blankness, logBoxToast, stillScreen } from '../lib/screen.js';

test("devicectl's error chain: the inner cause and the advice, not just 'Failed to install'", () => {
  const r = {
    error: {
      userInfo: {
        NSLocalizedDescription: { string: 'Failed to install the app on the device.' },
        NSUnderlyingError: {
          error: {
            userInfo: {
              NSLocalizedDescription: { string: 'This app needs 182 MB of space, but only 105 MB is available.' },
              NSLocalizedRecoverySuggestion: { string: 'Free up space on the device.' },
            },
          },
        },
      },
    },
  };
  assert.equal(devicectlError(r), 'This app needs 182 MB of space, but only 105 MB is available. Free up space on the device.');
  assert.equal(devicectlError({ error: { userInfo: { NSLocalizedDescription: { string: 'The device is locked.' } } } }), 'The device is locked.');
  assert.equal(devicectlError({ result: {} }), '');
  assert.equal(devicectlError(null), '');
});

test('adb install failures name the code and what to do about it', () => {
  const out = 'Performing Streamed Install\nadb: failed to install app.apk: Failure [INSTALL_FAILED_VERSION_DOWNGRADE: Downgrade detected: Update version code 1 is older than current 2]';
  assert.match(installFailure(out), /^Failure \[INSTALL_FAILED_VERSION_DOWNGRADE: .*\] — .*uninstall it first/);
  assert.match(installFailure('Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: Package com.example signatures do not match]'), /different key/);
  assert.equal(installFailure('Failure [INSTALL_FAILED_SOMETHING_NEW]'), 'Failure [INSTALL_FAILED_SOMETHING_NEW]');
  assert.equal(installFailure(''), 'no output from adb');
});

test('syslog entries: process, the library that logged, pid, level and a multi-line message', () => {
  assert.deepEqual(parseSyslog('Oct 26 01:15:59 Sams-iPhone MyApp(CFNetwork)[812] <Error>: Task failed\n  code -1001\n'), {
    proc: 'MyApp', lib: 'CFNetwork', pid: 812, level: 'Error', msg: 'Task failed\n  code -1001',
  });
  assert.deepEqual(parseSyslog('Oct  6 09:00:00 iPhone kernel[0] <Notice>: hello'), { proc: 'kernel', lib: '', pid: 0, level: 'Notice', msg: 'hello' });
  assert.equal(parseSyslog('garbage'), null);
});

test('collected log: one app, since a time; Apple chatter only with all, errors always', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'looktap-log-')), 'syslog.jsonl');
  const line = (t, l) => JSON.stringify({ t, l });
  writeFileSync(file, [
    JSON.stringify({ status: { connected: true, at: 1 } }),
    line(1000, 'Oct 26 01:00:00 iPhone MyApp[5] <Notice>: before'),
    line(2000, 'Oct 26 01:00:01 iPhone MyApp(Foundation)[5] <Notice>: from NSLog'),
    line(2001, 'Oct 26 01:00:01 iPhone MyApp(XCTAutomationSupport)[5] <Notice>: snapshot'),
    line(2002, 'Oct 26 01:00:01 iPhone MyApp(CFNetwork)[5] <Error>: API_ERROR 500'),
    line(2003, 'Oct 26 01:00:01 iPhone Other[6] <Error>: not mine'),
    '{"t":broken',
  ].join('\n') + '\n');
  const texts = (o) => readCollected(file, 'MyApp', 1500, o).map((l) => l.text.replace(/^\S+ /, ''));
  assert.deepEqual(texts({}), ['D [Foundation] from NSLog', 'E [CFNetwork] API_ERROR 500']);
  assert.deepEqual(texts({ all: true }), ['D [Foundation] from NSLog', 'D [XCTAutomationSupport] snapshot', 'E [CFNetwork] API_ERROR 500']);
  assert.deepEqual(texts({ errors: true }), ['E [CFNetwork] API_ERROR 500']);
});

test('pictureChange: a caret-sized change is tiny, a page change is not; decodePng reads what encodePng wrote', () => {
  const w = 100, h = 200, pixels = Buffer.alloc(w * h * 3, 255);
  const a = decodePng(encodePng(w, h, pixels, 3));
  assert.deepEqual([a.width, a.height, a.channels], [w, h, 3]);
  assert.equal(pictureChange(a, a), 0);
  const caret = Buffer.from(pixels);
  for (let y = 50; y < 60; y++) caret.fill(0, (y * w + 10) * 3, (y * w + 11) * 3);
  assert.ok(pictureChange(a, decodePng(encodePng(w, h, caret, 3))) <= 0.002);
  const page = Buffer.from(pixels).fill(0, 0, (w * h * 3) / 2);
  assert.ok(pictureChange(a, decodePng(encodePng(w, h, page, 3))) > 0.4);
  assert.equal(pictureChange(a, decodePng(encodePng(w, h + 1, Buffer.alloc(w * (h + 1) * 3), 3))), 1);
  assert.equal(decodePng(Buffer.from('not a png')), null);
});

test('logBoxToast finds the toast anywhere on screen, with its × to close it', () => {
  const el = (label, type, x, y, w, h) => ({ label, type, x, y, w, h });
  const root = el('', 'View', 0, 0, 360, 640), card = el('', 'ViewGroup', 10, 543, 340, 48);
  const row = el('!, Open debugger to view warnings.', 'ViewGroup', 10, 557, 340, 22);
  assert.deepEqual(logBoxToast([root, card, row]).close, [336, 567]);
  assert.equal(logBoxToast([root, el('Saved', 'Text', 10, 557, 340, 22)]), null);
});

/** A driver whose screen goes through `frames` (one per read), then stays on the last; picture() follows suit. */
function screens(frames) {
  let i = 0;
  // Half the picture in the frame's shade, half black: content, not a blank page.
  const png = (shade) => encodePng(4, 4, Buffer.concat([Buffer.alloc(24, shade), Buffer.alloc(24, 0)]), 3);
  return {
    snapshot: async () => ({ screen: { w: 4, h: 4 }, elements: [{ label: frames[Math.min(i, frames.length - 1)].label, x: 0, y: 0, w: 1, h: 1 }] }),
    picture: async () => png(frames[Math.min(i++, frames.length - 1)].shade),
  };
}

test('wait --settle waits out a page whose picture changes with no labels to tell, and times out on one that never stops', async () => {
  const loading = Array.from({ length: 4 }, (_, k) => ({ label: 'Web', shade: k * 60 }));
  const ms = await stillScreen(screens([...loading, { label: 'Web', shade: 250 }]), { quiet: 300, timeout: 5000 });
  assert.ok(ms >= 300);
  let turn = 0; // a shade 100 levels on each read: always a visible change
  const spinner = { snapshot: async () => ({ elements: [] }), picture: async () => encodePng(4, 4, Buffer.concat([Buffer.alloc(24, (turn++ * 100) % 256), Buffer.alloc(24, 0)]), 3) };
  await assert.rejects(stillScreen(spinner, { quiet: 300, timeout: 600 }), /still changing after 0.6 s/);
});

test('wait --settle: a blank page (a web view loading) is not settled, however still it holds', async () => {
  const white = { snapshot: async () => ({ elements: [] }), picture: async () => encodePng(4, 4, Buffer.alloc(48, 255), 3) };
  await assert.rejects(stillScreen(white, { quiet: 100, timeout: 500 }), /still blank after 0.5 s \(a page still loading\?\)/);
  const w = 10, h = 10, px = Buffer.alloc(w * h * 3, 255);
  px.fill(0, 0, 3 * 20); // 20% content
  assert.ok(blankness(decodePng(encodePng(w, h, px, 3))) < 0.97);
});

test('a real iPhone: every route is tried in order, and each failure is kept for the error', async () => {
  const d = new IosDevice('00008120-0000000000000000', { out: '/tmp' });
  const tried = [];
  const route = (name, via) => ({ route: name, via, open: async () => { tried.push(name); throw new Error('ECONNREFUSED'); } });
  d.routes = async () => [route('CoreDevice tunnel (Wi-Fi)', 'Wi-Fi'), route('usbmuxd Wi-Fi', 'Wi-Fi')];
  assert.equal(await d.hello(), null);
  assert.deepEqual(tried, ['CoreDevice tunnel (Wi-Fi)', 'usbmuxd Wi-Fi']);
  assert.match(d.unreached.join('; '), /CoreDevice tunnel \(Wi-Fi\): ECONNREFUSED; usbmuxd Wi-Fi: ECONNREFUSED/);
  assert.match(d.unreachable().message, /can't reach it over Wi-Fi: .*Plug in a USB cable/);
});

test('a runner that is up but unreachable over Wi-Fi fails at once with why, without starting another', async () => {
  const d = new IosDevice('00008120-0000000000000000', { out: '/tmp' });
  let built = 0;
  d.hello = async () => ((d.unreached = ['CoreDevice tunnel (Wi-Fi): timed out']), null);
  d.xcodebuildAlive = () => true;
  d.runnerUp = () => true;
  d.routes = async () => [{ route: 'CoreDevice tunnel (Wi-Fi)', via: 'Wi-Fi' }];
  d.build = () => built++;
  await assert.rejects(d.helper(), /the runner is running on the phone .* over Wi-Fi: CoreDevice tunnel \(Wi-Fi\): timed out/);
  assert.equal(built, 0);
});

test('a route that connects but gets no answer means a stuck runner, not one out of reach: it is restarted', async () => {
  const { createServer, connect } = await import('node:net');
  const server = createServer(() => {}).listen(0); // accepts, never answers: a runner stuck in an earlier call
  await new Promise((r) => server.once('listening', r));
  const open = () => new Promise((resolve) => { const s = connect(server.address().port, '127.0.0.1', () => resolve(s)); });
  const d = new IosDevice('00008120-0000000000000000', { out: '/tmp' });
  d.routes = async () => [{ route: 'CoreDevice tunnel (Wi-Fi)', via: 'Wi-Fi', open }];
  try {
    assert.equal(await d.hello(), null);
    assert.equal(d.connected, true);
    assert.match(d.unreached[0], /connected, but the runner did not answer/);
    Object.assign(d, { xcodebuildAlive: () => true, runnerUp: () => true, locked: async () => false, signingTeam: () => 'T', build: () => 'x.xctestrun' });
    let started = 0;
    d.start = async () => (started++, { via: 'Wi-Fi' });
    await d.helper();
    assert.equal(started, 1);
  } finally {
    server.close();
  }
});
