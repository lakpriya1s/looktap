// DTX: the RPC Xcode speaks to the developer services on an iPhone (instruments' remote server, testmanagerd).
// Messages travel in fragments; each carries a selector (an archived NSString) with its arguments, or a reply.
// Calls go on channels, opened by name on channel 0. A channel the device opens has a negative code on this side.
import { archive, unarchive } from './bplist.js';
import { lockdown } from './lockdown.js';

const MAGIC = 0x1f3d5b79;
const DISPATCH = 2, OK = 0, OBJECT = 3, ERROR = 4;
const EXPECTS_REPLY = 1;

/** Arguments sent as the primitive integer types DTX has (others go as archived objects). */
export class I32 {
  constructor(n) {
    this.n = n;
  }
}
export class I64 {
  constructor(n) {
    this.n = n;
  }
}

/** Positional arguments → DTX's auxiliary "primitive dictionary" (every key null). */
export function buildAux(args) {
  if (!args.length) return Buffer.alloc(0);
  const parts = [];
  for (const a of args) {
    const key = Buffer.alloc(4);
    key.writeUInt32LE(10); // null key
    parts.push(key);
    if (a instanceof I32) {
      const b = Buffer.alloc(8);
      b.writeUInt32LE(3);
      b.writeInt32LE(a.n, 4);
      parts.push(b);
    } else if (a instanceof I64) {
      const b = Buffer.alloc(12);
      b.writeUInt32LE(6);
      b.writeBigInt64LE(BigInt(a.n), 4);
      parts.push(b);
    } else {
      const body = a == null ? Buffer.alloc(0) : archive(a);
      const b = Buffer.alloc(8);
      b.writeUInt32LE(2);
      b.writeUInt32LE(body.length, 4);
      parts.push(b, body);
    }
  }
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(16);
  head.writeUInt32LE(0x1f0);
  head.writeBigUInt64LE(BigInt(body.length), 8);
  return Buffer.concat([head, body]);
}

/** DTX auxiliary data → the arguments, archived objects decoded. */
export function parseAux(buf) {
  if (!buf.length) return [];
  const end = 16 + Number(buf.readBigUInt64LE(8));
  const out = [];
  let at = 16, isKey = true;
  while (at < end) {
    const type = buf.readUInt32LE(at) & 0xff;
    at += 4;
    let v;
    if (type === 10) v = null;
    else if (type === 1 || type === 2) {
      const n = buf.readUInt32LE(at);
      const raw = buf.subarray(at + 4, at + 4 + n);
      at += 4 + n;
      v = type === 1 ? raw.toString('utf8') : raw.length ? unarchive(raw) : null;
    } else if (type === 3) (v = buf.readInt32LE(at)), (at += 4);
    else if (type === 4 || type === 6) (v = Number(buf.readBigInt64LE(at))), (at += 8);
    else if (type === 9) (v = buf.readDoubleLE(at)), (at += 8);
    else throw new Error(`DTX: unknown argument type ${type}`);
    if (!isKey) out.push(v);
    isKey = !isKey;
  }
  return out;
}

/** One DTX message as bytes: the fragment header, the message header, then aux and payload. */
function frame({ id, conversation, channel, type, aux = Buffer.alloc(0), payload = Buffer.alloc(0), expectsReply = false }) {
  const msg = Buffer.alloc(16);
  msg[0] = type;
  msg.writeUInt32LE(aux.length, 4);
  msg.writeUInt32LE(aux.length + payload.length, 8);
  const head = Buffer.alloc(32);
  head.writeUInt32LE(MAGIC, 0);
  head.writeUInt32LE(32, 4);
  head.writeUInt16LE(0, 8);
  head.writeUInt16LE(1, 10);
  head.writeUInt32LE(16 + aux.length + payload.length, 12);
  head.writeUInt32LE(id, 16);
  head.writeUInt32LE(conversation, 20);
  head.writeInt32LE(channel, 24);
  head.writeUInt32LE(expectsReply ? EXPECTS_REPLY : 0, 28);
  return Buffer.concat([head, msg, aux, payload]);
}

export class DTXError extends Error {}

/**
 A DTX connection over a socket. `call(channel, selector, ...args)` → the reply's object; `handle(selector, fn)` answers
 the device's calls (fn's return value is the reply); `onChannel(fn)` hears of channels the device opens.
 */
export class DTX {
  constructor(sock, { log } = {}) {
    this.sock = sock;
    this.log = log || (() => {});
    this.nextId = 1;
    this.nextChannel = 1;
    this.pending = new Map();
    this.handlers = new Map();
    this.channels = new Map([[0, 'control']]);
    this.channelListeners = [];
    this.closed = null;
    this.closeListeners = [];
    this.parts = new Map();
    let buf = Buffer.alloc(0);
    sock.on('data', (c) => {
      buf = Buffer.concat([buf, c]);
      while (buf.length >= 32) {
        if (buf.readUInt32LE(0) !== MAGIC) return this.fail(new DTXError('DTX: lost the message framing'));
        const headSize = buf.readUInt32LE(4), index = buf.readUInt16LE(8), count = buf.readUInt16LE(10), size = buf.readUInt32LE(12);
        // The first of several fragments only announces the whole message's size; the rest carry its bytes.
        const body = index === 0 && count > 1 ? 0 : size;
        if (buf.length < headSize + body) break;
        const f = { id: buf.readUInt32LE(16), conversation: buf.readUInt32LE(20), channel: buf.readInt32LE(24), flags: buf.readUInt32LE(28) };
        const data = buf.subarray(headSize, headSize + body);
        buf = buf.subarray(headSize + body);
        if (count === 1) this.receive(f, data);
        else {
          const key = `${f.id}.${f.conversation}`;
          const list = this.parts.get(key) || [];
          if (index > 0) list.push(Buffer.from(data));
          this.parts.set(key, list);
          if (index === count - 1) {
            this.parts.delete(key);
            this.receive(f, Buffer.concat(list));
          }
        }
      }
    });
    sock.on('close', () => this.fail(new DTXError('the device closed the connection')));
    sock.on('error', (e) => this.fail(new DTXError(e.message)));
    this.handle('_notifyOfPublishedCapabilities:', (caps) => {
      this.capabilities = caps;
      this.gotCapabilities?.();
    });
    this.handle('_requestChannelWithCode:identifier:', (code, identifier) => {
      this.channels.set(-code, identifier);
      for (const fn of this.channelListeners) fn(-code, identifier);
    });
    this.handle('_channelCanceled:', (code) => this.channels.delete(-code));
  }

  fail(e) {
    if (this.closed) return;
    this.closed = e;
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
    for (const fn of this.closeListeners) fn(e);
    this.sock.destroy();
  }

  receive(f, data) {
    const type = data[0], auxSize = data.readUInt32LE(4), total = data.readUInt32LE(8);
    const aux = data.subarray(16, 16 + auxSize), payload = data.subarray(16 + auxSize, 16 + total);
    // A new request names the channel from the sender's side: the sign flips here. Replies keep it.
    const channel = f.conversation % 2 === 0 ? -f.channel : f.channel;
    if (f.conversation % 2 === 1) {
      const p = this.pending.get(f.id);
      if (!p) return;
      this.pending.delete(f.id);
      try {
        const value = payload.length ? unarchive(payload) : null;
        if (type === ERROR) p.reject(new DTXError(nsErrorText(value)));
        else p.resolve(value);
      } catch (e) {
        p.reject(e);
      }
      return;
    }
    if (type !== DISPATCH) return; // notifications nobody asked for
    let selector, args;
    try {
      selector = unarchive(payload);
      args = parseAux(aux);
    } catch (e) {
      this.log(`dtx: could not read a message on channel ${channel}: ${e.message}`);
      return;
    }
    this.log(`dtx ← ${this.channels.get(channel) || channel} ${selector}`);
    const fn = this.handlers.get(selector);
    const answer = (value, error) => {
      if (!(f.flags & EXPECTS_REPLY) || this.closed) return;
      const reply = error
        ? { type: ERROR, payload: archive({ NSLocalizedDescription: String(error) }) }
        : value === undefined || value === null ? { type: OK } : { type: OBJECT, payload: archive(value) };
      // A reply goes back on the code the request came on.
      this.sock.write(frame({ id: f.id, conversation: f.conversation + 1, channel: f.channel, ...reply }));
    };
    if (!fn) return answer(undefined);
    Promise.resolve()
      .then(() => fn(...args, channel))
      .then((v) => answer(v), (e) => answer(undefined, e.message));
  }

  /** Answer the device's calls of `selector` (on any channel): fn(...args, channel) → the reply. */
  handle(selector, fn) {
    this.handlers.set(selector, fn);
  }

  /** Call `selector` on `channel` with `args`; resolves to the reply's object (null for a plain OK). */
  call(channel, selector, args = [], { reply = true, timeout = 30000 } = {}) {
    if (this.closed) return Promise.reject(this.closed);
    const id = this.nextId++;
    this.log(`dtx → ${this.channels.get(channel) || channel} ${selector}`);
    const bytes = frame({ id, conversation: 0, channel, type: DISPATCH, aux: buildAux(args), payload: archive(selector), expectsReply: reply });
    if (!reply) return this.sock.write(bytes), Promise.resolve(null);
    return new Promise((resolve, reject) => {
      const timer = timeout && setTimeout(() => (this.pending.delete(id), reject(new DTXError(`${selector}: no answer within ${timeout / 1000} s`))), timeout);
      this.pending.set(id, { resolve: (v) => (clearTimeout(timer), resolve(v)), reject: (e) => (clearTimeout(timer), reject(e)) });
      this.sock.write(bytes);
    });
  }

  /** Swap capabilities with the device, as both sides do first. */
  async handshake(timeout = 15000) {
    const got = new Promise((resolve) => (this.gotCapabilities = resolve));
    await this.call(0, '_notifyOfPublishedCapabilities:', [{ 'com.apple.private.DTXBlockCompression': 0, 'com.apple.private.DTXConnection': 1 }], { reply: false });
    let timer;
    try {
      await Promise.race([got, new Promise((_, reject) => (timer = setTimeout(() => reject(new DTXError('the device did not answer the DTX handshake')), timeout)))]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Open a channel to a named service; resolves to its code. */
  async open(identifier) {
    const code = this.nextChannel++;
    await this.call(0, '_requestChannelWithCode:identifier:', [new I32(code), identifier]);
    this.channels.set(code, identifier);
    return code;
  }

  /** Hear of channels the device opens: fn(code, identifier). */
  onChannel(fn) {
    this.channelListeners.push(fn);
  }

  onClose(fn) {
    if (this.closed) fn(this.closed);
    else this.closeListeners.push(fn);
  }

  close() {
    this.fail(new DTXError('closed'));
  }
}

/** The words of an NSError a DTX call failed with. */
function nsErrorText(e) {
  if (!e || typeof e !== 'object') return String(e);
  const u = e.userInfo || {};
  return u.NSLocalizedDescription || u.NSLocalizedFailureReason || `${e.domain || 'error'} ${e.code ?? ''}`.trim();
}

/** A DTX connection to a lockdown service on the device, handshake done. */
export async function dtxService(udid, service, opts) {
  const l = await lockdown(udid);
  let sock;
  try {
    sock = await l.start(service);
  } finally {
    l.close();
  }
  const d = new DTX(sock, opts);
  await d.handshake();
  return d;
}

/** Instruments' remote server (process control, screenshots, location, device info). */
export const INSTRUMENTS = 'com.apple.instruments.remoteserver.DVTSecureSocketProxy';
/** testmanagerd, which runs XCTest sessions. */
export const TESTMANAGERD = 'com.apple.testmanagerd.lockdown.secure';
