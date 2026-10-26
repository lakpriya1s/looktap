// Binary property lists ("bplist00") and NSKeyedArchiver on top of them: what installation_proxy answers in, and what
// every DTX message (instruments, testmanagerd) carries its arguments and replies as.

/** A reference to another object in a binary plist (NSKeyedArchiver's links between objects). */
export class UID {
  constructor(n) {
    this.UID = n;
  }
}

/** A number to write as a real even when it's whole (a plain JS number that is an integer is written as one). */
export class Real {
  constructor(n) {
    this.value = n;
  }
}

/** A binary plist → a JS value: dicts, arrays, strings, numbers (BigInt past 2^53), booleans, null, Buffers, Dates, UIDs. */
export function parseBplist(buf) {
  if (buf.subarray(0, 8).toString('latin1') !== 'bplist00') throw new Error('not a binary plist');
  const t = buf.length - 32;
  const offSize = buf[t + 6], refSize = buf[t + 7];
  const count = Number(buf.readBigUInt64BE(t + 8)), top = Number(buf.readBigUInt64BE(t + 16)), table = Number(buf.readBigUInt64BE(t + 24));
  const uint = (at, n) => {
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 256 + buf[at + i];
    return v;
  };
  const offsets = Array.from({ length: count }, (_, i) => uint(table + i * offSize, offSize));
  const read = (ref, depth = 0) => {
    if (depth > 512) throw new Error('binary plist nests too deep');
    let at = offsets[ref];
    const marker = buf[at++], kind = marker >> 4;
    let n = marker & 15;
    if (kind === 0) return n === 8 ? false : n === 9 ? true : null;
    if (kind === 1) {
      const size = 1 << n;
      if (size <= 4) return uint(at, size);
      const big = size === 16 ? buf.readBigInt64BE(at + 8) : buf.readBigInt64BE(at);
      return big >= -(2n ** 53n) && big <= 2n ** 53n ? Number(big) : big;
    }
    if (kind === 2) return n === 2 ? buf.readFloatBE(at) : buf.readDoubleBE(at);
    if (kind === 3) return new Date((buf.readDoubleBE(at) + 978307200) * 1000);
    if (kind === 8) return new UID(uint(at, n + 1));
    if (n === 15) {
      const m = buf[at++];
      const size = 1 << (m & 15);
      n = uint(at, size);
      at += size;
    }
    if (kind === 4) return Buffer.from(buf.subarray(at, at + n));
    if (kind === 5) return buf.subarray(at, at + n).toString('latin1');
    if (kind === 6) return Buffer.from(buf.subarray(at, at + 2 * n)).swap16().toString('utf16le');
    if (kind === 10 || kind === 12) return Array.from({ length: n }, (_, i) => read(uint(at + i * refSize, refSize), depth + 1));
    if (kind === 13) {
      const o = {};
      for (let i = 0; i < n; i++) o[read(uint(at + i * refSize, refSize), depth + 1)] = read(uint(at + (n + i) * refSize, refSize), depth + 1);
      return o;
    }
    throw new Error(`binary plist: unknown object type 0x${marker.toString(16)}`);
  };
  return read(top);
}

/** A JS value → a binary plist. Integers are written as integers; wrap a whole number in Real to write a real. */
export function buildBplist(root) {
  const objects = [];
  const add = (v) => {
    const i = objects.length;
    objects.push(null);
    let enc;
    if (v === null || v === undefined) enc = { m: Buffer.from([0x00]) };
    else if (v === false || v === true) enc = { m: Buffer.from([v ? 0x09 : 0x08]) };
    else if (v instanceof UID) enc = { m: uidBytes(v.UID) };
    else if (v instanceof Real || (typeof v === 'number' && !Number.isInteger(v))) {
      const b = Buffer.alloc(9);
      b[0] = 0x23;
      b.writeDoubleBE(v instanceof Real ? v.value : v, 1);
      enc = { m: b };
    } else if (typeof v === 'number' || typeof v === 'bigint') enc = { m: intBytes(BigInt(v)) };
    else if (v instanceof Date) {
      const b = Buffer.alloc(9);
      b[0] = 0x33;
      b.writeDoubleBE(v.getTime() / 1000 - 978307200, 1);
      enc = { m: b };
    } else if (Buffer.isBuffer(v)) enc = { m: Buffer.concat([lenMarker(0x40, v.length), v]) };
    else if (typeof v === 'string') {
      const ascii = /^[\x00-\x7f]*$/.test(v);
      const body = ascii ? Buffer.from(v, 'latin1') : Buffer.from(v, 'utf16le').swap16();
      enc = { m: Buffer.concat([lenMarker(ascii ? 0x50 : 0x60, ascii ? body.length : body.length / 2), body]) };
    } else if (Array.isArray(v) || v instanceof Set) {
      const items = [...v];
      enc = { m: lenMarker(v instanceof Set ? 0xc0 : 0xa0, items.length), refs: items.map(add) };
    } else {
      const entries = Object.entries(v);
      enc = { m: lenMarker(0xd0, entries.length), refs: [...entries.map(([k]) => add(k)), ...entries.map(([, x]) => add(x))] };
    }
    objects[i] = enc;
    return i;
  };
  add(root);
  const refSize = objects.length < 256 ? 1 : objects.length < 65536 ? 2 : 4;
  const parts = [Buffer.from('bplist00', 'latin1')];
  const offsets = [];
  let at = 8;
  for (const o of objects) {
    offsets.push(at);
    const refs = o.refs ? Buffer.alloc(o.refs.length * refSize) : null;
    if (refs) o.refs.forEach((r, k) => refs.writeUIntBE(r, k * refSize, refSize));
    parts.push(o.m);
    at += o.m.length;
    if (refs) parts.push(refs), (at += refs.length);
  }
  const offSize = at < 256 ? 1 : at < 65536 ? 2 : at < 2 ** 24 ? 3 : 4;
  const table = Buffer.alloc(offsets.length * offSize);
  offsets.forEach((o, k) => table.writeUIntBE(o, k * offSize, offSize));
  const trailer = Buffer.alloc(32);
  trailer[6] = offSize;
  trailer[7] = refSize;
  trailer.writeBigUInt64BE(BigInt(objects.length), 8);
  trailer.writeBigUInt64BE(0n, 16);
  trailer.writeBigUInt64BE(BigInt(at), 24);
  return Buffer.concat([...parts, table, trailer]);
}

function intBytes(n) {
  if (n >= 0n && n < 256n) return Buffer.from([0x10, Number(n)]);
  if (n >= 0n && n < 65536n) return Buffer.from([0x11, Number(n >> 8n), Number(n & 255n)]);
  if (n >= 0n && n < 2n ** 32n) {
    const b = Buffer.alloc(5);
    b[0] = 0x12;
    b.writeUInt32BE(Number(n), 1);
    return b;
  }
  const b = Buffer.alloc(9);
  b[0] = 0x13;
  b.writeBigInt64BE(n, 1);
  return b;
}

function uidBytes(n) {
  const size = n < 256 ? 1 : n < 65536 ? 2 : 4;
  const b = Buffer.alloc(1 + size);
  b[0] = 0x80 | (size - 1);
  b.writeUIntBE(n, 1, size);
  return b;
}

/** A type marker with its count: in the low nibble, or as a following integer from 15 on. */
function lenMarker(type, n) {
  return n < 15 ? Buffer.from([type | n]) : Buffer.concat([Buffer.from([type | 15]), intBytes(BigInt(n))]);
}

// ── NSKeyedArchiver ─────────────────────────────────────────────────────────

/**
 An Objective-C object for the archive: its class name and its coded fields. Fields that are numbers or booleans are
 written inline, as encodeInteger/encodeBool would, and Buffers as encodeBytes would; anything else becomes its own
 archived object.
 */
export class NSObject {
  constructor(className, fields = {}) {
    this.className = className;
    this.fields = fields;
  }
}

/** NSUUID from a uuid string. */
export const nsUUID = (uuid) => new NSObject('NSUUID', { 'NS.uuidbytes': Buffer.from(uuid.replace(/-/g, ''), 'hex') });
/** NSURL for an absolute URL. */
export const nsURL = (url) => new NSObject('NSURL', { 'NS.base': null, 'NS.relative': url });

/** A JS value → NSKeyedArchiver data: objects become NSDictionary, arrays NSArray, Sets NSSet, NSObject as itself. */
export function archive(root) {
  const objects = ['$null'];
  const classes = new Map();
  const classRef = (name) => {
    if (!classes.has(name)) {
      classes.set(name, new UID(objects.length));
      objects.push({ $classes: [name], $classname: name });
    }
    return classes.get(name);
  };
  const ref = (v) => {
    if (v === null || v === undefined) return new UID(0);
    const at = objects.length;
    if (typeof v !== 'object' || v instanceof UID || v instanceof Real || Buffer.isBuffer(v)) {
      objects.push(v);
      return new UID(at);
    }
    const o = {};
    objects.push(o);
    if (Array.isArray(v) || v instanceof Set) {
      o['NS.objects'] = [...v].map(ref);
      o.$class = classRef(v instanceof Set ? 'NSSet' : 'NSArray');
    } else if (v instanceof NSObject) {
      for (const [k, x] of Object.entries(v.fields)) o[k] = typeof x === 'number' || typeof x === 'boolean' || Buffer.isBuffer(x) ? x : ref(x);
      o.$class = classRef(v.className);
    } else {
      const entries = Object.entries(v);
      o['NS.keys'] = entries.map(([k]) => ref(k));
      o['NS.objects'] = entries.map(([, x]) => ref(x));
      o.$class = classRef('NSDictionary');
    }
    return new UID(at);
  };
  ref(root);
  return buildBplist({ $version: 100000, $archiver: 'NSKeyedArchiver', $top: { root: new UID(1) }, $objects: objects });
}

/**
 NSKeyedArchiver data → a JS value. Collections, strings, numbers and data become their JS kinds; NSUUID a uuid string;
 NSURL its URL; NSError { domain, code, userInfo }; NSNull null; any other class { $class, ...its fields }.
 */
export function unarchive(buf) {
  const plist = parseBplist(buf);
  const objects = plist.$objects;
  const done = new Map();
  const value = (u, depth = 0) => {
    if (!(u instanceof UID)) return u;
    if (u.UID === 0) return null;
    if (done.has(u.UID)) return done.get(u.UID);
    if (depth > 256) throw new Error('archive nests too deep');
    const o = objects[u.UID];
    if (o === null || typeof o !== 'object' || Buffer.isBuffer(o) || o instanceof Date) return o;
    const cls = objects[o.$class?.UID]?.$classname || '';
    const field = (k) => value(o[k], depth + 1);
    let out;
    if ('NS.keys' in o) {
      out = {};
      done.set(u.UID, out);
      o['NS.keys'].forEach((k, i) => (out[value(k, depth + 1)] = value(o['NS.objects'][i], depth + 1)));
    } else if ('NS.objects' in o) {
      out = [];
      done.set(u.UID, out);
      for (const x of o['NS.objects']) out.push(value(x, depth + 1));
    } else if ('NS.string' in o) out = field('NS.string');
    else if ('NS.bytes' in o) out = field('NS.bytes');
    else if ('NS.data' in o) out = field('NS.data');
    else if ('NS.uuidbytes' in o) out = formatUUID(field('NS.uuidbytes')); // inline, or (some encoders) a reference
    else if ('NS.relative' in o) out = [field('NS.base'), field('NS.relative')].filter(Boolean).join('');
    else if ('NS.time' in o) out = new Date((o['NS.time'] + 978307200) * 1000);
    else if (cls === 'NSNull') out = null;
    else if (cls === 'NSError') out = { domain: field('NSDomain'), code: o.NSCode, userInfo: field('NSUserInfo') };
    else {
      out = { $class: cls };
      done.set(u.UID, out);
      for (const k of Object.keys(o)) if (k !== '$class') out[k] = field(k);
    }
    done.set(u.UID, out);
    return out;
  };
  return value(plist.$top.root);
}

const formatUUID = (b) => {
  const h = Buffer.from(b).toString('hex').toUpperCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};
