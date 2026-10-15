import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { matrixOffset, setRotation } from '../lib/mp4.js';
import { rotateRgb } from '../lib/png.js';

// A 2×1 single-channel frame [a b] makes each turn easy to read.
test('rotateRgb turns frames counter-clockwise by quarter turns', () => {
  const px = Buffer.from([1, 2]);
  assert.deepEqual(rotateRgb(2, 1, px, 1, 0), { width: 2, height: 1, pixels: px });
  // counter-clockwise: the right edge comes to the top
  assert.deepEqual([...rotateRgb(2, 1, px, 1, 1).pixels], [2, 1]);
  assert.equal(rotateRgb(2, 1, px, 1, 1).width, 1);
  assert.deepEqual([...rotateRgb(2, 1, px, 1, 2).pixels], [2, 1]);
  assert.deepEqual([...rotateRgb(2, 1, px, 1, 3).pixels], [1, 2]);
  // channels move together
  assert.deepEqual([...rotateRgb(2, 1, Buffer.from([1, 1, 1, 2, 2, 2]), 3, 1).pixels], [2, 2, 2, 1, 1, 1]);
});

const box = (type, ...parts) => {
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
};

/** ftyp, an mdat, then moov with one track of handler `kind`: a minimal file of the shape simctl writes. */
function mp4(kind) {
  const tkhd = box('tkhd', Buffer.alloc(4 + 20 + 16), Buffer.alloc(36), Buffer.alloc(8));
  const hdlr = box('hdlr', Buffer.alloc(8), Buffer.from(kind, 'latin1'), Buffer.alloc(12));
  return Buffer.concat([box('ftyp', Buffer.from('isom')), box('mdat', Buffer.alloc(64, 7)), box('moov', box('trak', tkhd, box('mdia', hdlr)))]);
}

test('setRotation writes the video track display matrix in place', () => {
  const dir = mkdtempSync(join(tmpdir(), 'simwright-test-'));
  const path = join(dir, 'v.mp4');
  writeFileSync(path, mp4('vide'));
  assert.equal(setRotation(path, 90), true);
  const out = readFileSync(path);
  assert.equal(out.length, mp4('vide').length);
  const moovAt = out.indexOf('moov') - 4;
  const at = moovAt + matrixOffset(out.subarray(moovAt));
  assert.deepEqual([0, 1, 2, 3, 8].map((i) => out.readUInt32BE(at + i * 4)), [0, 0x10000, 0, 0xffff0000, 0x40000000]);
  // a file without a video track is left alone
  writeFileSync(path, mp4('soun'));
  assert.equal(setRotation(path, 90), false);
  assert.deepEqual(readFileSync(path), mp4('soun'));
  assert.throws(() => setRotation(path, 45), /rotation/);
});
