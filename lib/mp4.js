// Just enough MP4 to mark a video as turned: the video track header's display matrix, which players apply
// when showing it (phones record sideways video the same way). The file is patched in place, same size.
import { closeSync, fstatSync, openSync, readSync, writeSync } from 'node:fs';

/** Boxes in buf[start, end): { type, start, body, end }. */
function boxes(buf, start, end) {
  const out = [];
  for (let pos = start; pos + 8 <= end; ) {
    let size = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    let body = pos + 8;
    if (size === 1) (size = Number(buf.readBigUInt64BE(pos + 8))), (body += 8);
    else if (size === 0) size = end - pos;
    if (size < 8 || pos + size > end) break;
    out.push({ type, start: pos, body, end: pos + size });
    pos += size;
  }
  return out;
}

const ONE = 0x10000, MINUS_ONE = 0xffff0000, W = 0x40000000;
/** Display matrices (a b u c d v x y w) for a clockwise turn of 0/90/180/270 degrees. */
const MATRIX = {
  0: [ONE, 0, 0, 0, ONE, 0, 0, 0, W],
  90: [0, ONE, 0, MINUS_ONE, 0, 0, 0, 0, W],
  180: [MINUS_ONE, 0, 0, 0, MINUS_ONE, 0, 0, 0, W],
  270: [0, MINUS_ONE, 0, ONE, 0, 0, 0, 0, W],
};

/** Where the video track's display matrix sits in `buf` (an MP4's moov box loaded in full), or -1. */
export function matrixOffset(buf) {
  for (const moov of boxes(buf, 0, buf.length).filter((b) => b.type === 'moov'))
    for (const trak of boxes(buf, moov.body, moov.end).filter((b) => b.type === 'trak')) {
      const kids = boxes(buf, trak.body, trak.end);
      const tkhd = kids.find((b) => b.type === 'tkhd');
      const mdia = kids.find((b) => b.type === 'mdia');
      const hdlr = mdia && boxes(buf, mdia.body, mdia.end).find((b) => b.type === 'hdlr');
      // hdlr: version/flags (4), pre_defined (4), handler type (4)
      if (!tkhd || !hdlr || buf.toString('latin1', hdlr.body + 8, hdlr.body + 12) !== 'vide') continue;
      // tkhd v0: times and ids take 20 bytes, v1 32; then reserved 8, layer, group, volume, reserved (8)
      return tkhd.body + 4 + (buf[tkhd.body] === 1 ? 32 : 20) + 16;
    }
  return -1;
}

/** Mark the video at `path` to be shown turned `degrees` clockwise (0, 90, 180, 270). False if no video track. */
export function setRotation(path, degrees) {
  const m = MATRIX[degrees];
  if (!m) throw new Error(`rotation must be 0, 90, 180 or 270, not ${degrees}`);
  const fd = openSync(path, 'r+');
  try {
    // Find moov by walking the top-level box headers; mdat (the bulk) is skipped, not read.
    const size = fstatSync(fd).size;
    const head = Buffer.alloc(16);
    for (let pos = 0; pos + 8 <= size; ) {
      readSync(fd, head, 0, 16, pos);
      let len = head.readUInt32BE(0);
      if (len === 1) len = Number(head.readBigUInt64BE(8));
      else if (len === 0) len = size - pos;
      if (len < 8) return false;
      if (head.toString('latin1', 4, 8) === 'moov') {
        const moov = Buffer.alloc(len);
        readSync(fd, moov, 0, len, pos);
        const at = matrixOffset(moov);
        if (at < 0) return false;
        const bytes = Buffer.alloc(36);
        m.forEach((v, i) => bytes.writeUInt32BE(v, i * 4));
        writeSync(fd, bytes, 0, 36, pos + at);
        return true;
      }
      pos += len;
    }
    return false;
  } finally {
    closeSync(fd);
  }
}
