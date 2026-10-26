// A real iPhone's log. The device keeps no history looktap can read, so its live log (lockdown's syslog relay,
// reached through usbmuxd over USB or Wi-Fi, as Xcode does) is collected in the background into a file, and
// `logs` reads from that. The collector is this file run as a script; it stops 30 minutes after the last read.
import { closeSync, existsSync, openSync, readFileSync, renameSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { lockdownService } from './lockdown.js';

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
