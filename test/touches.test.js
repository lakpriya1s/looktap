import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { capability } from '../lib/capabilities.js';
import { decodePng, encodePng } from '../lib/png.js';
import { POINTER, TOUCHES_DYLIB, TOUCHES_SOURCE, drawPointer, hasInsert, placeDylib, withInsert, withoutInsert } from '../lib/touches.js';

const OURS = '/Users/me/.looktap/touches/abc123/looktap-touches.dylib';

test('touches: our dylib joins what is already inserted, once', () => {
  assert.equal(withInsert('', OURS), OURS);
  assert.equal(withInsert(undefined, OURS), OURS);
  assert.equal(withInsert('/tools/agent.dylib', OURS), `/tools/agent.dylib:${OURS}`);
  // An older build's copy is replaced, not kept beside the new one.
  assert.equal(withInsert(`/Users/me/.looktap/touches/old/looktap-touches.dylib:/tools/agent.dylib`, OURS), `/tools/agent.dylib:${OURS}`);
  assert.equal(withInsert(OURS, OURS), OURS);
});

test('touches: switching off leaves other tools’ inserts alone', () => {
  assert.equal(withoutInsert(OURS), '');
  assert.equal(withoutInsert(`/tools/agent.dylib:${OURS}`), '/tools/agent.dylib');
  assert.equal(withoutInsert('/tools/agent.dylib'), '/tools/agent.dylib');
  assert.equal(withoutInsert(''), '');
});

test('touches: a process started with the dylib is told from one without, in ps output', () => {
  assert.ok(hasInsert(OURS));
  assert.ok(hasInsert(`/path/Settings SIMULATOR_UDID=1 DYLD_INSERT_LIBRARIES=${OURS} HOME=/x`));
  assert.ok(hasInsert(`DYLD_INSERT_LIBRARIES=/tools/agent.dylib:${OURS}`));
  assert.ok(!hasInsert('/path/Settings SIMULATOR_UDID=1 HOME=/x'));
  assert.ok(!hasInsert('DYLD_INSERT_LIBRARIES=/tools/not-looktap-touches.dylib.bak'));
  assert.ok(!hasInsert(''));
});

test('touches: the dylib is placed under a folder named by its content, and never rewritten', () => {
  const home = mkdtempSync(join(tmpdir(), 'looktap-touches-'));
  const source = join(home, 'src.dylib');
  writeFileSync(source, 'one');
  const first = placeDylib(home, source);
  assert.match(first, /\/touches\/[0-9a-f]{12}\/looktap-touches\.dylib$/);
  assert.equal(readFileSync(first, 'utf8'), 'one');
  const inode = statSync(first).ino;
  assert.equal(placeDylib(home, source), first);
  assert.equal(statSync(first).ino, inode); // the same file: a loaded library must not change under a process
  writeFileSync(source, 'two');
  const second = placeDylib(home, source);
  assert.notEqual(second, first);
  assert.equal(readFileSync(first, 'utf8'), 'one');
});

test('touches: the shipped dylib links Foundation only, for both simulator CPUs', { skip: process.platform !== 'darwin' }, async () => {
  assert.ok(existsSync(TOUCHES_DYLIB) && existsSync(TOUCHES_SOURCE));
  const { execFileSync } = await import('node:child_process');
  let libs;
  try {
    libs = execFileSync('xcrun', ['otool', '-L', TOUCHES_DYLIB], { encoding: 'utf8' });
  } catch {
    return; // no Xcode here
  }
  assert.match(libs, /architecture arm64/);
  assert.match(libs, /architecture x86_64/);
  // Inserted simulator-wide, it reaches processes that never load UIKit: it must not pull UIKit into them.
  assert.doesNotMatch(libs, /UIKit|QuartzCore|CoreGraphics/);
});

test('touches: the pointer on a screenshot is the accent, ringed, and stays within its halo', () => {
  const w = 120, h = 120, scale = 2;
  for (const [channels, grey] of [[3, 128], [4, 128], [3, 255], [3, 0]]) {
    const px = Buffer.alloc(w * h * channels, grey);
    drawPointer(px, w, h, channels, 60, 60, scale);
    const at = (x, y, c = 0) => px[(y * w + x) * channels + c];
    const r = POINTER.radius * scale;
    if (grey > 0) assert.ok(at(60, 60) < grey, 'the middle is tinted with the accent (little red in it)');
    assert.ok(at(60 + r - 2, 60) < 60 && at(60 + r - 2, 60, 1) > 190 && at(60 + r - 2, 60, 2) > 210, 'the ring is the accent');
    assert.equal(at(1, 1), grey, 'far from the pointer nothing changes');
    assert.equal(at(60 + r + POINTER.halo * scale + 3, 60), grey);
  }
  // On a light screen the halo outside the ring gives it an edge.
  const white = Buffer.alloc(w * h * 3, 255);
  drawPointer(white, w, h, 3, 60, 60, scale);
  assert.ok(white[(60 * w + 60 + POINTER.radius * scale + 1) * 3] < 215);
});

test('touches: a pointer at the edge of the picture is clipped, and the PNG still round-trips', () => {
  const w = 50, h = 40;
  const px = Buffer.alloc(w * h * 4, 200);
  drawPointer(px, w, h, 4, 0, 0, 1);
  drawPointer(px, w, h, 4, w - 1, h - 1, 3);
  const back = decodePng(encodePng(w, h, px, 4));
  assert.equal(back.width, w);
  assert.deepEqual(Buffer.from(back.pixels), px);
});

test('touches: every kind of device says how far it goes', () => {
  assert.equal(capability('android-emulator', 'touches').status, 'conditional');
  assert.equal(capability('android-device', 'touches').status, 'conditional');
  assert.equal(capability('ios-simulator', 'touches').status, 'conditional');
  assert.match(capability('ios-device', 'touches').why, /LooktapTouches\.m/);
  assert.equal(capability('watchos-simulator', 'touches').status, 'unsupported');
});
