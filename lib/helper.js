// Client for simdrive's native helpers: one JSON request per line; each reply is one JSON line,
// followed by `bytes` raw bytes when it carries a "bytes" field.
import { connect } from 'node:net';

export class HelperError extends Error {}

/** Incremental parser for the reply stream. Calls onReply(head, body) per complete reply. */
export function replyParser(onReply) {
  const chunks = [];
  let have = 0;
  let head = null;
  const take = () => {
    const buf = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, have);
    chunks.length = 0;
    return buf;
  };
  return (chunk) => {
    chunks.push(chunk);
    have += chunk.length;
    for (;;) {
      if (head) {
        // Join a body only once all of it has arrived — joining per chunk is quadratic on big frames.
        if (have < head.bytes) return;
        const buf = take();
        const h = head;
        head = null;
        chunks.push(buf.subarray(h.bytes));
        have = buf.length - h.bytes;
        onReply(h, buf.subarray(0, h.bytes));
        continue;
      }
      if (chunks.at(-1).indexOf(10) < 0) return;
      const buf = take();
      const nl = buf.indexOf(10);
      const h = JSON.parse(buf.subarray(0, nl).toString('utf8'));
      chunks.push(buf.subarray(nl + 1));
      have = buf.length - nl - 1;
      if (h.bytes) head = h;
      else onReply(h, null);
    }
  };
}

export class Helper {
  /** `target` is a TCP port on 127.0.0.1 or a unix socket path. Rejects if nothing answers within `timeout`. */
  static open(target, timeout = 1000) {
    return new Promise((resolve, reject) => {
      const sock = typeof target === 'number' ? connect(target, '127.0.0.1') : connect(target);
      const timer = setTimeout(() => (sock.destroy(), reject(new HelperError('helper did not answer'))), timeout);
      sock.once('error', (e) => (clearTimeout(timer), reject(new HelperError(e.message))));
      sock.once('connect', () => {
        clearTimeout(timer);
        sock.removeAllListeners('error');
        resolve(new Helper(sock));
      });
    });
  }

  constructor(sock) {
    this.sock = sock;
    this.pending = null; // { resolve, reject, onFrame }
    sock.on(
      'data',
      replyParser((head, body) => {
        const p = this.pending;
        if (!p) return;
        if (head.frame != null) return p.onFrame?.(head, body);
        this.pending = null;
        if (head.ok) p.resolve({ ...head, body });
        else p.reject(new Error(head.error || 'helper error'));
      }),
    );
    const fail = (e) => {
      const p = this.pending;
      this.pending = null;
      p?.reject(new HelperError(e?.message || 'helper connection closed'));
    };
    sock.on('error', fail);
    sock.on('close', () => fail());
    sock.unref();
  }

  /** Send one request. `onFrame(head, body)` receives streamed frames (burst) before the final reply. */
  call(op, args = {}, { onFrame, timeout = 30000 } = {}) {
    if (this.pending) return Promise.reject(new Error('helper is busy'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null;
        reject(new HelperError(`helper timed out on ${op}`));
      }, timeout);
      this.sock.ref();
      const done = (fn) => (v) => {
        clearTimeout(timer);
        this.sock.unref();
        fn(v);
      };
      this.pending = { resolve: done(resolve), reject: done(reject), onFrame };
      this.sock.write(JSON.stringify({ op, ...args }) + '\n');
    });
  }

  close() {
    this.sock.destroy();
  }
}
