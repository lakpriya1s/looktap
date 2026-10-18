import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { inflateSync } from 'node:zlib';

import { helperNodes } from '../lib/android.js';
import { grpcFramer, parseImage, pbFields } from '../lib/emulator.js';
import { replyParser } from '../lib/helper.js';
import { encodePng } from '../lib/png.js';

/** Feed `buf` to `push` in pieces of `size` bytes. */
const feed = (push, buf, size) => {
  for (let i = 0; i < buf.length; i += size) push(buf.subarray(i, i + size));
};

test('replyParser splits JSON lines and binary bodies across arbitrary chunking', () => {
  const body = Buffer.from([0, 10, 255, 10, 1]); // contains newlines on purpose
  const stream = Buffer.concat([
    Buffer.from('{"ok":true,"a":1}\n'),
    Buffer.from(`{"ok":true,"bytes":${body.length}}\n`),
    body,
    Buffer.from('{"frame":1,"bytes":2}\n'),
    Buffer.from([7, 8]),
    Buffer.from('{"ok":true,"done":true}\n'),
  ]);
  for (const size of [1, 3, 7, stream.length]) {
    const got = [];
    feed(replyParser((h, b) => got.push([h, b && [...b]])), stream, size);
    assert.deepEqual(got, [
      [{ ok: true, a: 1 }, null],
      [{ ok: true, bytes: 5 }, [0, 10, 255, 10, 1]],
      [{ frame: 1, bytes: 2 }, [7, 8]],
      [{ ok: true, done: true }, null],
    ]);
  }
});

const varint = (n) => {
  const out = [];
  do {
    out.push((n & 0x7f) | (n > 0x7f ? 0x80 : 0));
    n = Math.floor(n / 128);
  } while (n);
  return out;
};
const field = (num, bytes) => Buffer.from([...varint(num * 8 + 2), ...varint(bytes.length), ...bytes]);
const uint = (num, v) => Buffer.from([...varint(num * 8), ...varint(v)]);

test('parseImage reads the size from ImageFormat and the pixel bytes', () => {
  const fmt = Buffer.concat([uint(1, 2), uint(3, 2), uint(4, 1)]);
  const pixels = Buffer.from([1, 2, 3, 4, 5, 6]);
  const msg = Buffer.concat([field(1, fmt), field(4, pixels), uint(5, 300)]);
  const img = parseImage(msg);
  assert.equal(img.width, 2);
  assert.equal(img.height, 1);
  assert.equal(img.seq, 300);
  assert.deepEqual([...img.pixels], [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(pbFields(uint(3, 1080))[3], 1080);
});

test('grpcFramer reassembles length-prefixed messages', () => {
  const frame = (payload) => Buffer.concat([Buffer.from([0]), Buffer.from(new Uint8Array(new Uint32Array([0]).buffer)), payload]);
  const msg = (p) => {
    const f = frame(p);
    f.writeUInt32BE(p.length, 1);
    return f;
  };
  const stream = Buffer.concat([msg(Buffer.from('hello')), msg(Buffer.alloc(0)), msg(Buffer.alloc(3000, 9))]);
  for (const size of [1, 4, 6, 1000, stream.length]) {
    const got = [];
    feed(grpcFramer((m) => got.push(m.length)), stream, size);
    assert.deepEqual(got, [5, 0, 3000]);
  }
});

test('encodePng writes a valid RGB PNG whose IDAT inflates to filtered rows', () => {
  const px = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 9, 9, 9]); // 2×2 RGB
  const png = encodePng(2, 2, px, 3);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.readUInt32BE(16), 2); // IHDR width
  assert.equal(png.readUInt32BE(20), 2); // IHDR height
  assert.equal(png[25], 2); // colour type RGB
  const idatAt = png.indexOf('IDAT');
  const len = png.readUInt32BE(idatAt - 4);
  const raw = inflateSync(png.subarray(idatAt + 4, idatAt + 4 + len));
  assert.deepEqual([...raw], [0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 255, 9, 9, 9]);
  assert.throws(() => encodePng(2, 2, px.subarray(0, 6), 3));
});

test('helperNodes converts helper px bounds to dp nodes', () => {
  const [n] = helperNodes([{ l: 'Wi‑Fi', c: 'android.widget.TextView', b: [42, 105, 168, 210], f: true }], 2.625);
  assert.deepEqual(n, { label: 'Wi‑Fi', x1: 16, y1: 40, x2: 64, y2: 80, cls: 'android.widget.TextView', focused: true });
  const [s] = helperNodes([{ l: '', c: 'android.widget.Switch', b: [0, 0, 10, 10], v: '1' }], 1);
  assert.equal(s.value, '1');
});

test('a helper call that times out closes its connection, so the process can exit', () => {
  // A helper that accepts the connection and never answers (a loaded device): the command must still end.
  const script = `
    import { createServer } from 'node:net';
    import { Helper } from ${JSON.stringify(new URL('../lib/helper.js', import.meta.url).href)};
    const srv = createServer(() => {}).listen(0, async () => {
      srv.unref();
      const h = await Helper.open(srv.address().port);
      await h.call('key', {}, { timeout: 100 }).catch((e) => console.log(e.message));
    });`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 5000 });
  assert.equal(r.error?.code, undefined, 'the process did not exit after the timed-out call');
  assert.match(r.stdout, /helper timed out on key/);
});
