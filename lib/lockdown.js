// lockdownd: the service broker every iPhone runs on port 62078, reached through usbmuxd. A session (TLS with the
// pairing record) can read the device's values and start its services: the syslog relay, installation_proxy, the
// image mounter, AFC, and the developer image's instruments and testmanagerd. This is how an iPhone on iOS 16 or
// older is driven when Xcode no longer supports it, and the device log on any iPhone.
import { connect as tlsConnect } from 'node:tls';

import { parseBplist } from './bplist.js';
import { fromPlist, muxConnect, pairRecord, toPlist } from './usbmux.js';

const LOCKDOWN = 62078;

/**
 Messages framed as lockdown's services frame them: a 4-byte big-endian length, then an XML plist. `send(msg)`,
 `next()` → the next message (services like installation_proxy answer one request with several), `ask(msg)` → reply.
 */
export function plistChannel(sock) {
  let buf = Buffer.alloc(0);
  const queue = [], waiting = [];
  let closed = null;
  const onData = (c) => {
    buf = Buffer.concat([buf, c]);
    while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) {
      const n = buf.readUInt32BE(0);
      const raw = buf.subarray(4, 4 + n);
      buf = buf.subarray(4 + n);
      // Requests go as XML; some services (installation_proxy) answer in binary.
      const msg = raw.subarray(0, 8).toString('latin1') === 'bplist00' ? parseBplist(raw) : fromPlist(raw.toString('utf8'));
      const w = waiting.shift();
      if (w) w.resolve(msg);
      else queue.push(msg);
    }
  };
  sock.on('data', onData);
  sock.on('close', () => {
    closed = new Error('the device closed the connection');
    waiting.splice(0).forEach((w) => w.reject(closed));
  });
  sock.on('error', () => {});
  const send = (msg) => {
    const body = Buffer.from(toPlist(msg));
    const head = Buffer.alloc(4);
    head.writeUInt32BE(body.length);
    sock.write(Buffer.concat([head, body]));
  };
  const next = (timeout = 0) =>
    queue.length ? Promise.resolve(queue.shift())
    : closed ? Promise.reject(closed)
    : new Promise((resolve, reject) => {
        const w = { resolve, reject };
        waiting.push(w);
        if (timeout) {
          const t = setTimeout(() => (waiting.splice(waiting.indexOf(w), 1), reject(new Error('the device did not answer'))), timeout);
          w.resolve = (m) => (clearTimeout(t), resolve(m));
        }
      });
  const ask = (msg, timeout) => (send(msg), next(timeout));
  /** Stop reading: the socket goes on to carry something else (TLS, raw bytes). */
  const detach = () => sock.removeListener('data', onData);
  return { sock, send, next, ask, detach, close: () => sock.destroy() };
}

/** TLS over an open socket with the Mac's host certificate from the pairing record (lockdown asks for it). */
function secure(sock, record) {
  const pem = (b64) => Buffer.from(b64, 'base64').toString('utf8');
  return new Promise((resolve, reject) => {
    // The device's certificate is self-signed by the pairing, and lockdown speaks TLS 1.2 with older ciphers.
    const t = tlsConnect({ socket: sock, cert: pem(record.HostCertificate), key: pem(record.HostPrivateKey), rejectUnauthorized: false, ciphers: 'DEFAULT:@SECLEVEL=0' });
    t.once('secureConnect', () => (t.removeAllListeners('error'), resolve(t)));
    t.once('error', reject);
  });
}

/** What a lockdown error means for the person holding the phone. */
function lockdownError(service, error) {
  const why = {
    PasswordProtected: ' (unlock it)',
    InvalidService: ' (this service needs the developer image: looktap setup mounts it)',
    InvalidHostID: ' (the pairing is gone: unplug it, plug it in again and tap Trust)',
  }[error] || '';
  return new Error(`the device didn't start ${service}: ${error}${why}`);
}

/** A lockdown session: { values(key?, domain?), start(service), close() }. */
export async function lockdown(udid, timeout = 5000) {
  const record = await pairRecord(udid);
  const raw = await muxConnect(udid, LOCKDOWN, timeout);
  try {
    let ch = plistChannel(raw);
    const session = await ch.ask({ Label: 'looktap', Request: 'StartSession', HostID: record.HostID, SystemBUID: record.SystemBUID }, timeout);
    if (session.Error) throw new Error(`lockdown refused a session: ${session.Error}${session.Error === 'InvalidHostID' ? ' (unplug it, plug it in again and tap Trust)' : ''}`);
    if (session.EnableSessionSSL) {
      ch.detach();
      ch = plistChannel(await secure(raw, record));
    }
    return {
      async values(key, domain) {
        const r = await ch.ask({ Label: 'looktap', Request: 'GetValue', ...(key && { Key: key }), ...(domain && { Domain: domain }) }, timeout);
        if (r.Error) throw new Error(`lockdown GetValue ${domain ? `${domain} ` : ''}${key || ''}: ${r.Error}`);
        return r.Value;
      },
      async setValue(key, value, domain) {
        const r = await ch.ask({ Label: 'looktap', Request: 'SetValue', Key: key, Value: value, ...(domain && { Domain: domain }) }, timeout);
        if (r.Error) throw new Error(`lockdown SetValue ${key}: ${r.Error}`);
      },
      /** A socket to the service, TLS when the service wants it. */
      async start(service) {
        const started = await ch.ask({ Label: 'looktap', Request: 'StartService', Service: service }, timeout);
        if (started.Error) throw lockdownError(service, started.Error);
        const conn = await muxConnect(udid, started.Port, timeout);
        return started.EnableServiceSSL ? await secure(conn, record) : conn;
      },
      close: () => ch.close(),
    };
  } catch (e) {
    raw.destroy();
    throw e;
  }
}

/** A socket to a lockdown service on the device (`com.apple.syslog_relay`, …), TLS when the service wants it. */
export async function lockdownService(udid, service, timeout = 5000) {
  const l = await lockdown(udid, timeout);
  try {
    return await l.start(service);
  } finally {
    l.close();
  }
}

/** A lockdown service that speaks length-framed plists, as a plistChannel. */
export async function plistService(udid, service, timeout) {
  return plistChannel(await lockdownService(udid, service, timeout));
}

/** The device's basic values without a session (ProductVersion, DeviceName, ProductType, UniqueDeviceID…). */
export async function deviceValues(udid, timeout = 3000) {
  const sock = await muxConnect(udid, LOCKDOWN, timeout);
  try {
    const r = await plistChannel(sock).ask({ Label: 'looktap', Request: 'GetValue' }, timeout);
    return r.Value || {};
  } finally {
    sock.destroy();
  }
}
