// Minimal PNG encoder for raw RGB/RGBA frames. Fast deflate: screenshots are written often and read rarely.
import { spawnSync } from 'node:child_process';
import { deflateSync, inflateSync } from 'node:zlib';

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc32(...bufs) {
  let c = 0xffffffff;
  for (const b of bufs) for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const t = Buffer.from(type, 'latin1');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(t, data));
  return [len, t, data, crc];
}

/** `pixels`: rows of `width * channels` bytes, top to bottom, channels 3 (RGB) or 4 (RGBA). */
export function encodePng(width, height, pixels, channels = 3) {
  const row = width * channels;
  if (pixels.length < row * height) throw new Error(`frame is ${pixels.length} bytes, expected ${row * height}`);
  const raw = Buffer.alloc((row + 1) * height); // filter byte 0 (none) per row
  for (let y = 0; y < height; y++) pixels.copy(raw, y * (row + 1) + 1, y * row, (y + 1) * row);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = channels === 4 ? 6 : 2; // colour type: RGBA / RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ...chunk('IHDR', ihdr),
    ...chunk('IDAT', deflateSync(raw, { level: 3 })),
    ...chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Box-filter downscale of raw RGB/RGBA by `scale` (0 < scale ≤ 1); scale 1 returns the frame as is. */
export function scaleRgb(width, height, pixels, channels, scale) {
  if (!(scale > 0 && scale < 1)) return { width, height, pixels };
  const w = Math.max(1, Math.round(width * scale)), h = Math.max(1, Math.round(height * scale));
  const out = Buffer.alloc(w * h * channels);
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor((y * height) / h), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * height) / h));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x * width) / w), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * width) / w));
      const n = (y1 - y0) * (x1 - x0);
      for (let c = 0; c < channels; c++) {
        let sum = 0;
        for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) sum += pixels[(yy * width + xx) * channels + c];
        out[(y * w + x) * channels + c] = Math.round(sum / n);
      }
    }
  }
  return { width: w, height: h, pixels: out };
}

/**
 Turn raw RGB/RGBA by `turns` quarter turns counter-clockwise (0–3): the frame of a display rotated that far
 (Android's rotation) comes out upright. 0 returns the frame as is.
 */
export function rotateRgb(width, height, pixels, channels, turns) {
  turns = ((turns % 4) + 4) % 4;
  if (!turns) return { width, height, pixels };
  const [w, h] = turns === 2 ? [width, height] : [height, width];
  const out = Buffer.alloc(w * h * channels);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Where output (x, y) comes from: a counter-clockwise turn brings the right edge to the top.
      const [sx, sy] = turns === 1 ? [width - 1 - y, x] : turns === 2 ? [width - 1 - x, height - 1 - y] : [y, height - 1 - x];
      const o = (y * w + x) * channels, i = (sy * width + sx) * channels;
      for (let c = 0; c < channels; c++) out[o + c] = pixels[i + c];
    }
  }
  return { width: w, height: h, pixels: out };
}

/** Shrink a PNG file in place by `scale` with macOS `sips` (fallback paths only); a no-op elsewhere. */
export function resizePng(path, scale) {
  if (!(scale > 0 && scale < 1)) return;
  const dims = spawnSync('sips', ['-g', 'pixelWidth', path], { encoding: 'utf8' });
  const w = Number(/pixelWidth:\s*(\d+)/.exec(dims.stdout || '')?.[1]);
  if (!w) return console.error('looktap: --scale needs macOS sips for this screenshot path; saved full size');
  spawnSync('sips', ['--resampleWidth', String(Math.round(w * scale)), path], { stdio: 'ignore' });
}

/**
 A PNG's pixels: { width, height, channels, pixels }, for 8-bit, non-interlaced grey, RGB, grey+alpha or RGBA (what
 every screenshot path here produces). Null for anything else.
 */
export function decodePng(buf) {
  if (buf.length < 33 || buf.toString('latin1', 12, 16) !== 'IHDR') return null;
  const width = buf.readUInt32BE(16), height = buf.readUInt32BE(20);
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[buf[25]];
  if (buf[24] !== 8 || !channels || buf[28] !== 0) return null;
  const idat = [];
  for (let at = 8; at + 8 <= buf.length; ) {
    const len = buf.readUInt32BE(at), type = buf.toString('latin1', at + 4, at + 8);
    if (type === 'IDAT') idat.push(buf.subarray(at + 8, at + 8 + len));
    if (type === 'IEND') break;
    at += 12 + len;
  }
  let raw;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch {
    return null;
  }
  const row = width * channels;
  if (raw.length < (row + 1) * height) return null;
  const pixels = Buffer.alloc(row * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (row + 1)], line = raw.subarray(y * (row + 1) + 1, (y + 1) * (row + 1));
    const out = y * row, up = out - row;
    for (let x = 0; x < row; x++) {
      const a = x >= channels ? pixels[out + x - channels] : 0, b = y ? pixels[up + x] : 0, c = y && x >= channels ? pixels[up + x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      pixels[out + x] = v & 0xff;
    }
  }
  return { width, height, channels, pixels };
}

/**
 How much of the picture changed between two decoded frames: the share of pixels where a colour moved by more than
 24 levels (screenshot noise moves a few). 1 when the sizes differ.
 */
export function pictureChange(a, b) {
  if (!a || !b || a.width !== b.width || a.height !== b.height || a.channels !== b.channels) return 1;
  const n = a.width * a.height, ch = Math.min(a.channels, 3);
  let moved = 0;
  for (let i = 0; i < n; i++) {
    const o = i * a.channels;
    for (let c = 0; c < ch; c++)
      if (Math.abs(a.pixels[o + c] - b.pixels[o + c]) > 24) {
        moved++;
        break;
      }
  }
  return moved / n;
}
