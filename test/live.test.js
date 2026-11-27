import assert from 'node:assert/strict';
import { test } from 'node:test';

import { KIND, allowed, controlMessage, feedFrames, h264Units, isLoopback, lanAddress, packet, recorderProblem, startsWithCode, wsAccept, wsDecode, wsEncode } from '../lib/live.js';
import { appleShape, cornerShare, liveDevices } from '../lib/live-devices.js';
import { brief, gesture, retryAfter } from '../lib/live-iphone.js';

/** A NAL unit: a 4- or 3-byte start code, a header byte whose low 5 bits are its type, then some payload. */
const nal = (type, size = 6, long = true) => Buffer.from([...(long ? [0, 0, 0, 1] : [0, 0, 1]), 0x60 | type, ...Array.from({ length: size }, (_, i) => 0x80 + ((i * 7 + type) % 100))]);
const SPS = nal(7), PPS = nal(8), IDR = nal(5, 40), P1 = nal(1, 12), P2 = nal(1, 9, false);

test('live: a stream packet is its length, its kind, then the payload', () => {
  const p = packet(KIND.jpeg, Buffer.from('abc'));
  assert.equal(p.readUInt32BE(0), 4);
  assert.equal(p[4], KIND.jpeg);
  assert.equal(p.subarray(5).toString(), 'abc');
  assert.equal(packet(KIND.reset).readUInt32BE(0), 1);
  assert.equal(packet(KIND.error, 'no picture').subarray(5).toString(), 'no picture');
});

test('live: H.264 is cut into frames, a key frame carrying its parameter sets', () => {
  const got = [];
  const units = h264Units((u) => got.push(u));
  units.push(Buffer.concat([SPS, PPS, IDR, P1, P2]));
  // The last frame is held back: where it ends isn't known until the next one starts.
  assert.deepEqual(got.map((u) => [u.key, u.data.length]), [[true, SPS.length + PPS.length + IDR.length], [false, P1.length]]);
  assert.deepEqual(got[0].data, Buffer.concat([SPS, PPS, IDR]));
  assert.equal(units.flush(), true);
  assert.deepEqual(got[2], { key: false, data: P2 });
  assert.equal(units.flush(), false);
});

test('live: frames come out the same however the bytes are split on the way', () => {
  const all = Buffer.concat([SPS, PPS, IDR, P1, P2, P1, IDR, P2]);
  const whole = [];
  const a = h264Units((u) => whole.push(u.data.toString('hex')));
  a.push(all);
  a.flush();
  for (const size of [1, 2, 3, 5, 7, 64]) {
    const pieces = [];
    const b = h264Units((u) => pieces.push(u.data.toString('hex')));
    for (let i = 0; i < all.length; i += size) b.push(all.subarray(i, i + size));
    b.flush();
    assert.deepEqual(pieces, whole, `in pieces of ${size}`);
  }
});

test('live: bytes before the first start code are dropped (the recorder\'s shell says its pid first on some adbs)', () => {
  const got = [];
  const units = h264Units((u) => got.push(u));
  units.push(Buffer.concat([Buffer.from('12345\n'), SPS, PPS, IDR, P1]));
  assert.equal(got.length, 1);
  assert.ok(startsWithCode(got[0].data));
});

test('live: a flush that cut a frame in two shows in what comes next', () => {
  assert.ok(startsWithCode(P1) && startsWithCode(P2));
  assert.ok(!startsWithCode(P1.subarray(6)), 'the second half of a frame opens with no start code');
  assert.ok(!startsWithCode(Buffer.from([0, 0])));
});

test('live: WebSocket handshake and frames', () => {
  // RFC 6455's own example
  assert.equal(wsAccept('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  const masked = (text, op = 1) => {
    const body = Buffer.from(text), mask = Buffer.from([1, 2, 3, 4]);
    const head = body.length < 126 ? Buffer.from([0x80 | op, 0x80 | body.length]) : Buffer.from([0x80 | op, 0x80 | 126, body.length >> 8, body.length & 255]);
    return Buffer.concat([head, mask, Buffer.from(body.map((b, i) => b ^ mask[i & 3]))]);
  };
  const long = 'x'.repeat(300);
  const two = Buffer.concat([masked('{"a":1}'), masked(long)]);
  assert.deepEqual(wsDecode(two).messages, ['{"a":1}', long]);
  // Half a frame waits for the rest.
  const half = wsDecode(two.subarray(0, two.length - 10));
  assert.deepEqual(half.messages, ['{"a":1}']);
  assert.deepEqual(wsDecode(Buffer.concat([half.rest, two.subarray(two.length - 10)])).messages, [long]);
  assert.equal(wsDecode(masked('', 8)).closed, true);
  assert.equal(wsDecode(Buffer.from([0x81, 2, 104, 105])).closed, true, 'a client frame must be masked');
  assert.equal(wsEncode('hi').toString('hex'), '81026869');
  assert.equal(wsEncode(long).readUInt16BE(2), 300);
});

test('live: on this computer only, a page from elsewhere is turned away', () => {
  const here = { host: '127.0.0.1', port: 4470 };
  assert.ok(allowed({ host: '127.0.0.1:4470' }, here));
  assert.ok(allowed({ host: 'localhost:4470' }, here));
  // A site that points its own name at 127.0.0.1 (DNS rebinding) names itself in Host.
  assert.ok(!allowed({ host: 'evil.example:4470' }, here));
  assert.ok(!allowed({ host: '127.0.0.1:9999' }, here));
  assert.ok(!allowed({}, here));
  // Control must come from the page itself.
  assert.ok(allowed({ host: '127.0.0.1:4470', origin: 'http://127.0.0.1:4470' }, { ...here, sameOrigin: true }));
  assert.ok(!allowed({ host: '127.0.0.1:4470', origin: 'https://evil.example' }, { ...here, sameOrigin: true }));
  assert.ok(!allowed({ host: '127.0.0.1:4470' }, { ...here, sameOrigin: true }));
  // Shared on the network, any name it is reached by is fine, but control still needs the page's own origin.
  const shared = { host: '0.0.0.0', port: 4470 };
  assert.ok(allowed({ host: '192.168.1.20:4470' }, shared));
  assert.ok(!allowed({ host: '192.168.1.20:4470', origin: 'http://evil.example' }, { ...shared, sameOrigin: true }));
  assert.ok(isLoopback('127.0.0.1') && isLoopback('localhost') && !isLoopback('0.0.0.0'));
});

test('live: control messages are taken only in the shapes the page sends', () => {
  assert.deepEqual(controlMessage('{"id":"emulator-5554","type":"touch","phase":"down","x":0.5,"y":0.25,"extra":1}'), { id: 'emulator-5554', type: 'touch', phase: 'down', x: 0.5, y: 0.25 });
  assert.deepEqual(controlMessage('{"id":"a","type":"key","key":"return"}'), { id: 'a', type: 'key', key: 'return' });
  assert.deepEqual(controlMessage('{"id":"a","type":"text","text":"hi"}'), { id: 'a', type: 'text', text: 'hi' });
  assert.deepEqual(controlMessage('{"id":"a","type":"button","name":"home"}'), { id: 'a', type: 'button', name: 'home' });
  for (const bad of [
    'not json', 'null', '{"type":"touch","phase":"down","x":0,"y":0}', '{"id":"a","type":"touch","phase":"down","x":1.5,"y":0}',
    '{"id":"a","type":"touch","phase":"fling","x":0,"y":0}', '{"id":"a","type":"key","key":"KEYCODE_POWER"}', '{"id":"a","type":"text","text":""}',
    '{"id":"a","type":"button","name":"reboot"}', '{"id":"a","type":"shell","cmd":"rm -rf /"}', `{"id":"a","type":"text","text":"${'x'.repeat(2001)}"}`,
  ])
    assert.equal(controlMessage(bad), null, bad);
});

test('live: why a recorder gave no picture', () => {
  assert.match(recorderProblem('4242\n/system/bin/sh: screenrecord: inaccessible or not found\n', 300), /no screenrecord/);
  assert.match(recorderProblem('4242\n', 800), /stopped after 0\.8 s without a picture \(a locked or sleeping screen/);
  assert.match(recorderProblem('4242\nUnable to get display info\n', 500), /: Unable to get display info$/);
});

test('live: which devices can be shown, and their shape', () => {
  const list = liveDevices(
    [
      { platform: 'ios', kind: 'simulator', id: 'SIM', name: 'iPhone 17 Pro', os: 'iOS 27.0', ready: true },
      { platform: 'ios', kind: 'simulator', id: 'OFF', name: 'iPhone 14', running: false },
      { platform: 'android', kind: 'device', id: 'R1', name: 'Galaxy', os: 'Android 16', ready: true },
      { platform: 'android', kind: 'device', id: 'R1-wifi', name: 'Galaxy', ready: true, samePhoneAs: 'R1' },
      { platform: 'android', kind: 'device', id: 'R2', name: 'Pixel', ready: false, problem: 'unauthorized' },
      { platform: 'ios', kind: 'device', id: 'PHONE', name: 'Sam’s iPhone', model: 'iPhone 14 Pro', ready: true, connection: 'Wi-Fi' },
      { platform: 'ios', kind: 'device', id: 'CABLED', name: 'iPhone X', model: 'iPhone X', ready: true, connection: 'USB' },
    ],
    (id) => (id === 'R1' ? 0.09 : 0.5),
  );
  assert.deepEqual(list.map((d) => [d.id, d.live]), [['SIM', true], ['R1', true], ['R2', false], ['PHONE', true], ['CABLED', true]]);
  // On a cable a real iPhone has video (the screen feed); on Wi-Fi, screenshots.
  assert.deepEqual([list[3].wired, list[4].wired, list[4].slow, list[4].cutout], [undefined, true, true, 'notch']);
  assert.deepEqual([list[0].corner, list[0].cutout], [0.12, 'island']);
  assert.equal(list[1].corner, 0.09);
  assert.equal(list[2].why, 'unauthorized');
  // A real iPhone is shown, as screenshots, and its shape comes from its model, not the name its owner gave it.
  assert.deepEqual([list[3].slow, list[3].cutout, list[0].slow], [true, 'island', undefined]);
});

test('live: an Apple device\'s corners and cutout, from its name', () => {
  assert.equal(appleShape('iPhone 14').cutout, 'notch');
  assert.equal(appleShape('iPhone 14 Pro').cutout, 'island');
  assert.equal(appleShape('iPhone 16').cutout, 'island');
  assert.equal(appleShape('iPhone X').cutout, 'notch');
  assert.deepEqual(appleShape('iPhone SE (3rd generation)'), { corner: 0 });
  assert.equal(appleShape('iPad Pro 13-inch (M4)').cutout, undefined);
  assert.equal(appleShape('Apple Watch Series 10 (46mm)').corner, 0.2);
});

test('live: an Android screen\'s corner radius as a share of its width', () => {
  const display = 'roundedCorners RoundedCorners{[RoundedCorner{position=TopLeft, radius=68, center=Point(68, 68)}, RoundedCorner{position=TopRight, radius=68';
  assert.ok(Math.abs(cornerShare(display, 'Physical size: 720x1600\n') - 68 / 720) < 1e-9);
  assert.equal(cornerShare('no corners here', 'Physical size: 720x1600'), 0);
  assert.equal(cornerShare(display, ''), 0);
});

test('live: the address others on the network can use', () => {
  assert.equal(lanAddress({ lo0: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }], en0: [{ family: 'IPv6', internal: false, address: 'fe80::1' }, { family: 'IPv4', internal: false, address: '192.168.1.20' }] }), '192.168.1.20');
  assert.equal(lanAddress({ lo0: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }] }), null);
});

test('live: a press on a real iPhone\'s picture becomes a tap, a long press or a swipe', () => {
  const screen = { w: 393, h: 852 };
  assert.deepEqual(gesture({ x: 0.5, y: 0.5 }, { x: 0.505, y: 0.5 }, 90, screen), { op: 'tapxy', args: [197, 426] });
  assert.deepEqual(gesture({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }, 900, screen), { op: 'longpress', args: [197, 426, 900] });
  assert.deepEqual(gesture({ x: 0.5, y: 0.8 }, { x: 0.5, y: 0.3 }, 420, screen), { op: 'swipe', args: [197, 682, 197, 256, 420] });
  // A flick is given time to register, and a slow drag doesn't hold the runner for ever.
  assert.equal(gesture({ x: 0.5, y: 0.8 }, { x: 0.5, y: 0.3 }, 20, screen).args[4], 100);
  assert.equal(gesture({ x: 0.5, y: 0.8 }, { x: 0.5, y: 0.3 }, 9000, screen).args[4], 1500);
});

test('live: a real iPhone that can\'t be reached is asked again less and less often', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 9].map(retryAfter), [4000, 8000, 16000, 32000, 60000, 60000]);
});

test('live: why a phone has no picture, in a line', () => {
  const xcode = "could not build the runner (team ABCDE12345):\n  /Users/me/looktap/native/ios-device/LooktapRunner.xcodeproj: error: No Accounts: Add a new account in Accounts settings. (in target 'LooktapRunner' from project 'LooktapRunner')";
  assert.equal(brief(xcode), 'Xcode has no Apple account. Sign in at Xcode → Settings → Accounts.');
  assert.match(brief("could not build the runner (team X):\n  a.xcodeproj: error: No profiles for 'dev.looktap.runner' were found"), /couldn't sign/);
  assert.equal(brief('the device is locked: unlock it, then run the command again'), 'Unlock the phone.');
  assert.match(brief('Launching LooktapRunner Finished with error: The application could not be launched because the Developer App Certificate is not trusted.'), /trust the developer app/);
  assert.match(brief('helper timed out on shot'), /isn't answering/);
  assert.ok(brief(`something else went wrong ${'x'.repeat(200)}`).length <= 90);
});

test('live: the screen feed\'s pictures come out whole however its bytes arrive', () => {
  const frame = (text) => { const b = Buffer.from(text), h = Buffer.alloc(4); h.writeUInt32BE(b.length); return Buffer.concat([h, b]); };
  const all = Buffer.concat([frame('first picture'), frame('2'), frame('the third, a longer one')]);
  for (const size of [1, 3, 4, 5, 100]) {
    const got = [];
    const take = feedFrames((f) => got.push(f.toString()));
    for (let i = 0; i < all.length; i += size) take(all.subarray(i, i + size));
    assert.deepEqual(got, ['first picture', '2', 'the third, a longer one'], `in pieces of ${size}`);
  }
});
