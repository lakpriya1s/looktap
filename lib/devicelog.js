// A real iPhone's log. The device keeps no history looktap can read, so its live log (lockdown's syslog relay,
// reached through usbmuxd over USB or Wi-Fi, as Xcode does) is collected in the background into a file, and
// `logs` reads from that. The collector is this file run as a script; it stops 30 minutes after the last read.
import { closeSync, existsSync, openSync, readFileSync, renameSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { connect as tlsConnect } from 'node:tls';
import { fileURLToPath } from 'node:url';

import { fromPlist, muxConnect, pairRecord, toPlist } from './usbmux.js';

const LOCKDOWN = 62078;
export const IDLE_MS = 30 * 60e3;
const MAX_BYTES = 64 * 1024 * 1024; // a phone logs ~1.5 MB a minute: about the last half hour

/** Lockdown's messages: a 4-byte big-endian length, then an XML plist. Returns ask(msg) → reply. */
function framed(sock) {
  let buf = Buffer.alloc(0);
  const waiting = [];
  sock.on('data', (c) => {
    buf = Buffer.concat([buf, c]);
    while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) {
      const n = buf.readUInt32BE(0);
      const reply = fromPlist(buf.subarray(4, 4 + n).toString('utf8'));
      buf = buf.subarray(4 + n);
      waiting.shift()?.resolve(reply);
    }
  });
  sock.on('close', () => waiting.splice(0).forEach((w) => w.reject(new Error('the device closed the connection'))));
  return (msg) =>
    new Promise((resolve, reject) => {
      waiting.push({ resolve, reject });
      const body = Buffer.from(toPlist({ Label: 'looktap', ...msg }));
      const head = Buffer.alloc(4);
      head.writeUInt32BE(body.length);
      sock.write(Buffer.concat([head, body]));
    });
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

/** A socket to a lockdown service on the device (`com.apple.syslog_relay`, …), TLS when the service wants it. */
export async function lockdownService(udid, service, timeout = 5000) {
  const record = await pairRecord(udid);
  const sock = await muxConnect(udid, LOCKDOWN, timeout);
  try {
    const ask = framed(sock);
    const session = await ask({ Request: 'StartSession', HostID: record.HostID, SystemBUID: record.SystemBUID });
    if (session.Error) throw new Error(`lockdown refused a session: ${session.Error}`);
    sock.removeAllListeners('data');
    const control = session.EnableSessionSSL ? await secure(sock, record) : sock;
    const started = await framed(control)({ Request: 'StartService', Service: service });
    control.destroy();
    if (started.Error) throw new Error(`the device didn't start ${service}: ${started.Error}${started.Error === 'PasswordProtected' ? ' (unlock it)' : ''}`);
    const conn = await muxConnect(udid, started.Port, timeout);
    return started.EnableServiceSSL ? await secure(conn, record) : conn;
  } catch (e) {
    sock.destroy();
    throw e;
  }
}

/**
 One syslog entry → { proc, lib, pid, level, msg }, or null. "Oct 26 01:15:59 iPhone App(Framework)[pid] <Error>: msg":
 `lib` is the library that logged it (none when the app logged it itself).
 */
export function parseSyslog(entry) {
  const m = /^\w{3} [ \d]\d \d\d:\d\d:\d\d \S+ (.+?)(?:\(([^()]*)\))?\[(\d+)\] <(\w+)>: ([\s\S]*)$/.exec(entry);
  return m && { proc: m[1], lib: m[2] || '', pid: Number(m[3]), level: m[4], msg: m[5].replace(/\n+$/, '') };
}

/** Libraries whose notices are Apple's own chatter, hidden unless --all (their errors are kept). */
const CHATTER = /^(lib\S+\.dylib|XCT\w*|AX\w*|Accessibility\w*|CFNetwork|Network|UIKit\w*|BaseBoard|\w*BoardServices|CoreFoundation|TextInput\w*|CoreUI|CoreAnalytics|Security|CoreTelephony|IOKit|QuartzCore|Metal\w*|AGX\w*|GeoServices|ManagedConfiguration|SystemConfiguration|LaunchServices|CoreServices\w*|UserNotifications|AudioToolbox|AVFAudio|CoreMedia|MediaToolbox|WebKit|CoreText|ProtocolBuffer|CloudKit|BackBoardServices|FrontBoard\w*|SpringBoard\w*|Symptom\w*|CoreMotion)$/;

const LEVEL = { Error: 'E', Fault: 'F', Notice: 'D', Info: 'I', Debug: 'D' };

/**
 The collected entries of process `exe` since `since` (ms), as `logs` prints them: { t, text }. `errors`: only errors
 and faults; otherwise Apple's own libraries' notices are left out unless `all`.
 */
export function readCollected(file, exe, since, { errors = false, all = false } = {}) {
  const lines = [];
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  for (const raw of text.split('\n')) {
    if (!raw.startsWith('{"t":')) continue;
    let t, l;
    try {
      ({ t, l } = JSON.parse(raw));
    } catch {
      continue;
    }
    if (t < since) continue;
    const e = parseSyslog(l || '');
    if (!e || e.proc !== exe) continue;
    const bad = e.level === 'Error' || e.level === 'Fault';
    if (errors ? !bad : !all && !bad && CHATTER.test(e.lib)) continue;
    const time = new Date(t).toTimeString().slice(0, 8) + '.' + String(t % 1000).padStart(3, '0');
    lines.push({ t, text: `${time} ${LEVEL[e.level] || e.level[0]} ${e.lib && e.lib !== exe ? `[${e.lib}] ` : ''}${e.msg}` });
  }
  return lines;
}

/** The collector's own news in its file: { connected, error } from its last status line. */
export function collectorStatus(file) {
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const status = text.split('\n').filter((l) => l.startsWith('{"status":')).at(-1);
  try {
    return status ? JSON.parse(status) : {};
  } catch {
    return {};
  }
}

/**
 Collect `udid`'s log into `file` (JSON lines: { t, l } per entry, { status } when the connection comes or goes) until
 `asked` hasn't been touched for IDLE_MS. Reconnects when the phone goes away and comes back. Past MAX_BYTES the
 oldest half is dropped.
 */
async function collect(udid, file, asked) {
  let fd = openSync(file, 'a');
  let size = statSync(file).size;
  const write = (o) => {
    size += writeSync(fd, JSON.stringify(o) + '\n');
    if (size > MAX_BYTES) {
      closeSync(fd);
      const keep = readFileSync(file).subarray(-MAX_BYTES / 2);
      writeFileSync(`${file}.tmp`, keep.subarray(keep.indexOf(10) + 1));
      renameSync(`${file}.tmp`, file);
      fd = openSync(file, 'a');
      size = statSync(file).size;
    }
  };
  const idle = () => !existsSync(asked) || Date.now() - statSync(asked).mtimeMs > IDLE_MS;
  const quit = setInterval(() => idle() && process.exit(0), 30e3);
  quit.unref();
  while (!idle()) {
    try {
      const sock = await lockdownService(udid, 'com.apple.syslog_relay');
      write({ status: { connected: true, at: Date.now() } });
      await new Promise((resolve) => {
        let rest = '';
        sock.on('data', (c) => {
          const parts = (rest + c.toString('utf8')).split('\0');
          rest = parts.pop();
          const t = Date.now();
          for (const l of parts) if (l.trim()) write({ t, l });
        });
        sock.on('close', resolve);
        sock.on('error', resolve);
      });
      write({ status: { connected: false, at: Date.now(), error: 'the connection to the phone dropped: reconnecting' } });
    } catch (e) {
      write({ status: { connected: false, at: Date.now(), error: e.message } });
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  process.exit(0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [udid, file, asked] = process.argv.slice(2);
  collect(udid, file, asked);
}
