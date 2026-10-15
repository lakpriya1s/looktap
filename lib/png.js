// Minimal PNG encoder for raw RGB/RGBA frames. Fast deflate: screenshots are written often and read rarely.
import { deflateSync } from 'node:zlib';

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
