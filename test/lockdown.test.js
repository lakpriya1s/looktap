import assert from 'node:assert/strict';
import { test } from 'node:test';

import { NSObject, UID, archive, buildBplist, nsURL, nsUUID, parseBplist, unarchive } from '../lib/bplist.js';
import { formatDevice, lockdownEntry } from '../lib/devices.js';
import { I32, I64, buildAux, parseAux } from '../lib/dtx.js';
import { patchMachO } from '../lib/runnerpatch.js';
import { fromPlist, toPlist } from '../lib/usbmux.js';

test('binary plist round trip: nesting, unicode, big and negative numbers, data, UIDs', () => {
  const v = { a: 1, s: 'héllo ✓', list: [true, false, null, 3.5, 70000, -2, 2 ** 40, Array.from({ length: 20 }, (_, i) => i)], data: Buffer.from('xyz'), long: 'x'.repeat(40), ref: new UID(300) };
  const back = parseBplist(buildBplist(v));
  assert.deepEqual({ ...back, ref: back.ref.UID }, { ...v, ref: 300 });
});

test('XML plists carry nested dicts, arrays, booleans and data (installation_proxy, the image mounter)', () => {
  const msg = { Command: 'ReceiveBytes', ImageSize: 12, ImageSignature: Buffer.from('sig'), ClientOptions: { ReturnAttributes: ['Path', 'Container'], Any: true } };
  const back = fromPlist(toPlist(msg));
  assert.equal(back.ImageSignature, Buffer.from('sig').toString('base64'));
  assert.deepEqual(back.ClientOptions, msg.ClientOptions);
});

test('NSKeyedArchiver: objects with inline numbers, booleans and bytes; dictionaries; UUIDs and URLs', () => {
  const session = '12345678-1234-1234-1234-1234567890AB';
  const cfg = new NSObject('XCTestConfiguration', { testBundleURL: nsURL('file:///a/PlugIns/T.xctest'), sessionIdentifier: nsUUID(session), reportActivities: true, formatVersion: 2, testsToRun: null, caps: { 'XCTIssue capability': true } });
  const raw = parseBplist(archive(cfg));
  const root = raw.$objects[1];
  assert.equal(root.reportActivities, true); // inline, as encodeBool writes it
  assert.equal(root.formatVersion, 2);
  assert.ok(Buffer.isBuffer(raw.$objects[root.sessionIdentifier.UID]['NS.uuidbytes'])); // inline, as NSUUID writes it
  assert.deepEqual(unarchive(archive(cfg)), { $class: 'XCTestConfiguration', testBundleURL: 'file:///a/PlugIns/T.xctest', sessionIdentifier: session, reportActivities: true, formatVersion: 2, testsToRun: null, caps: { 'XCTIssue capability': true } });
  assert.equal(unarchive(archive('_IDE_startExecutingTestPlanWithProtocolVersion:')), '_IDE_startExecutingTestPlanWithProtocolVersion:');
  assert.deepEqual(unarchive(archive([1, 'a', { b: [] }])), [1, 'a', { b: [] }]);
});

test('DTX arguments: primitive integers and archived objects, in order', () => {
  const args = parseAux(buildAux([new I32(7), new I64(2 ** 40), 'com.example.app', { KEY: 'v' }, null]));
  assert.deepEqual(args, [7, 2 ** 40, 'com.example.app', { KEY: 'v' }, null]);
  assert.deepEqual(parseAux(Buffer.alloc(0)), []);
});

/** A minimal arm64 Mach-O: LC_BUILD_VERSION (minos 17.0), two dylibs, chained fixups with one import from each. */
function machO() {
  const cmds = [];
  const build = Buffer.alloc(24);
  build.writeUInt32LE(0x32, 0), build.writeUInt32LE(24, 4), build.writeUInt32LE(2, 8), build.writeUInt32LE(0x110000, 12), build.writeUInt32LE(0x1b0000, 16);
  cmds.push(build);
  const dylib = (path) => {
    const name = Buffer.from(`${path}\0`);
    const size = Math.ceil((24 + name.length) / 8) * 8;
    const b = Buffer.alloc(size);
    b.writeUInt32LE(0xc, 0), b.writeUInt32LE(size, 4), b.writeUInt32LE(24, 8);
    name.copy(b, 24);
    return b;
  };
  cmds.push(dylib('/usr/lib/libSystem.B.dylib'), dylib('@rpath/XCTest.framework/XCTest'));
  const fixupsCmd = Buffer.alloc(16);
  fixupsCmd.writeUInt32LE(0x80000034, 0), fixupsCmd.writeUInt32LE(16, 4);
  cmds.push(fixupsCmd);
  const headerSize = 32 + cmds.reduce((n, c) => n + c.length, 0);
  fixupsCmd.writeUInt32LE(headerSize, 8);
  const symbols = Buffer.from('\0_malloc\0_OBJC_CLASS_$_XCTCommandLineToolHelper\0');
  const fixups = Buffer.alloc(28 + 8);
  fixups.writeUInt32LE(28, 8), fixups.writeUInt32LE(36, 12), fixups.writeUInt32LE(2, 16), fixups.writeUInt32LE(1, 20);
  fixups.writeUInt32LE(1 | (1 << 9), 28); // libSystem, "_malloc"
  fixups.writeUInt32LE(2 | (9 << 9), 32); // XCTest, the class
  const head = Buffer.alloc(32);
  head.writeUInt32LE(0xfeedfacf, 0), head.writeUInt32LE(cmds.length, 16);
  return Buffer.concat([head, ...cmds, fixups, symbols]);
}

test('the runner host patch lowers the minimum OS and weakens only XCTest imports', () => {
  const bin = machO();
  const r = patchMachO(bin, { minos: '16.0' });
  assert.deepEqual(r, { minos: true, weakened: ['_OBJC_CLASS_$_XCTCommandLineToolHelper'] });
  const fixups = bin.length - 48 - 36;
  assert.equal(bin.readUInt32LE(fixups + 28) & 0x100, 0);
  assert.equal(bin.readUInt32LE(fixups + 32) & 0x100, 0x100);
  assert.equal(bin.readUInt32LE(32 + 12), 0x100000);
  // Patching again changes nothing.
  assert.deepEqual(patchMachO(bin, { minos: '16.0' }), { minos: false, weakened: [] });
});

test('a phone only lockdown reaches is listed as ready, with its iOS', () => {
  const d = lockdownEntry({ id: '61dc2ee1129a62f5981e3dcc5d7891b9d3fa7094', name: 'iPhone X', os: '16.7.12', model: 'iPhone10,3', connection: 'USB' });
  assert.equal(d.ready, true);
  assert.match(formatDevice(d), /iPhone X \(iPhone10,3\) · device · iOS 16\.7\.12 \(through lockdown\) · USB$/);
});
