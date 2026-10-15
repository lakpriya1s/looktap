// Android emulator gRPC control API (EmulatorController), spoken over Node's built-in http2 with a
// hand-rolled protobuf reader — no dependencies. Frames come from the emulator host, not the guest:
// fast, and unaffected by FLAG_SECURE.
import { readFileSync, readdirSync } from 'node:fs';
import http2 from 'node:http2';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';

const RGB888 = 2;
const SERVICE = '/android.emulation.control.EmulatorController';

function runningDirs() {
  const dirs = [join(homedir(), 'Library/Caches/TemporaryItems/avd/running')];
  if (process.env.XDG_RUNTIME_DIR) dirs.push(join(process.env.XDG_RUNTIME_DIR, 'avd/running'));
  if (process.env.LOCALAPPDATA) dirs.push(join(process.env.LOCALAPPDATA, 'Temp/avd/running'));
  dirs.push(join(tmpdir(), `android-${userInfo().username}`, 'avd/running'));
  return dirs;
}

/** gRPC endpoint of a running emulator (`emulator-5554` → console port 5554), or null. */
export function findEmulator(serial) {
  const console = /^emulator-(\d+)$/.exec(serial)?.[1];
  if (!console) return null;
  for (const dir of runningDirs()) {
    let files;
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.ini'));
    } catch {
      continue;
    }
    for (const f of files) {
      let kv;
      try {
        kv = Object.fromEntries(
          readFileSync(join(dir, f), 'utf8')
            .split('\n')
            .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
        );
      } catch {
        continue;
      }
      if (kv['port.serial'] === console && kv['grpc.port']) return { port: Number(kv['grpc.port']), token: kv['grpc.token'] };
    }
  }
  return null;
}

// ── protobuf, just enough for Image ──

function varint(buf, pos) {
  let v = 0, mul = 1, b;
  do {
    b = buf[pos++];
    v += (b & 0x7f) * mul;
    mul *= 128;
  } while (b & 0x80);
  return [v, pos];
}

/** Field number → value (varint as number, length-delimited as Buffer). Last occurrence wins. */
export function pbFields(buf) {
  const out = {};
  let pos = 0;
  while (pos < buf.length) {
    let key;
    [key, pos] = varint(buf, pos);
    const field = Math.floor(key / 8), wire = key & 7;
    if (wire === 0) [out[field], pos] = varint(buf, pos);
    else if (wire === 2) {
      let len;
      [len, pos] = varint(buf, pos);
      out[field] = buf.subarray(pos, pos + len);
      pos += len;
    } else if (wire === 1) pos += 8;
    else if (wire === 5) pos += 4;
    else throw new Error(`unsupported protobuf wire type ${wire}`);
  }
  return out;
}

/** Image { format: ImageFormat{ width=3, height=4 }, image=4, seq=5 } → { width, height, pixels, seq }. */
export function parseImage(msg) {
  const img = pbFields(msg);
  const fmt = img[1] ? pbFields(img[1]) : {};
  return { width: fmt[3] || img[2], height: fmt[4] || img[3], pixels: img[4] || Buffer.alloc(0), seq: img[5] || 0 };
}

/** Split a gRPC body into messages: 1 byte compressed flag, 4 bytes big-endian length, payload. */
export function grpcFramer(onMessage) {
  const chunks = [];
  let have = 0, need = 5; // bytes wanted next: a 5-byte header, or 5 + payload length
  return (chunk) => {
    chunks.push(chunk);
    have += chunk.length;
    while (have >= need) {
      // Join only once enough has arrived — concatenating per chunk is quadratic on multi-MB frames.
      let buf = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, have);
      chunks.length = 0;
      if (need === 5) need = 5 + buf.readUInt32BE(1);
      if (buf.length < need) {
        chunks.push(buf);
        continue;
      }
      onMessage(buf.subarray(5, need));
      buf = buf.subarray(need);
      have = buf.length;
      need = 5;
      if (have) chunks.push(buf);
    }
  };
}

export class Emulator {
  constructor({ port, token }) {
    this.port = port;
    this.token = token;
  }

  session() {
    if (!this.client) {
      this.client = http2.connect(`http://127.0.0.1:${this.port}`);
      this.client.on('error', () => {});
    }
    return this.client;
  }

  close() {
    this.client?.close();
    this.client = null;
  }

  /** Call `method`; onMessage gets each response message. Resolves when the stream ends. */
  call(method, onMessage, { timeout = 15000 } = {}) {
    return new Promise((resolve, reject) => {
      const req = this.session().request({
        ':method': 'POST',
        ':path': `${SERVICE}/${method}`,
        'content-type': 'application/grpc',
        te: 'trailers',
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      });
      const timer = setTimeout(() => req.close(http2.constants.NGHTTP2_CANCEL), timeout);
      let status = null;
      req.on('response', (h) => {
        if (h['grpc-status'] != null) status = h;
      });
      req.on('trailers', (h) => (status = h));
      req.on('data', grpcFramer(onMessage));
      req.on('error', (e) => (clearTimeout(timer), reject(e)));
      req.on('close', () => {
        clearTimeout(timer);
        if (status && status['grpc-status'] !== '0')
          reject(new Error(`emulator gRPC ${method}: ${decodeURIComponent(status['grpc-message'] || status['grpc-status'])}`));
        else resolve();
      });
      // ImageFormat { format = RGB888 }
      req.end(Buffer.from([0, 0, 0, 0, 2, 0x08, RGB888]));
    });
  }

  async screenshot() {
    let img;
    await this.call('getScreenshot', (m) => (img = parseImage(m)));
    if (!img?.pixels.length) throw new Error('emulator returned an empty screenshot');
    return img;
  }

  /** Stream frames for `ms`; the emulator sends one whenever the screen changes. */
  async stream(ms, onImage) {
    await this.call('streamScreenshot', (m) => onImage(parseImage(m)), { timeout: ms }).catch((e) => {
      if (!/CANCEL|cancel/.test(e.message)) throw e;
    });
  }
}
