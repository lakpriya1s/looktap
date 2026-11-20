// Is the way to an Android device working? A cheap probe before device commands (cached ~10 s), so a stuck adb link
// fails at once with what is wrong, instead of every adb call in a command running into its own timeout and the
// command reporting whatever an empty answer looked like ("not installed"). Also the facts `doctor -d` shows: the adb
// server, every adb process on this Mac, the USB path, reverse rules.
import { join } from 'node:path';

import { ADB, DEVICE_TIMEOUT, HOME, StuckError, TimedOut, readJson, run, writeJson } from './util.js';

const CACHE = join(HOME, 'health.json');
const FRESH_MS = 10e3;
/** A round trip slower than this works, but every command will crawl: worth a warning. */
export const SLOW_MS = 3000;

/**
 `adb devices` (with -l) → [{ id, state, usb, model }]: state is adb's word (device, unauthorized, offline,
 recovery …), usb the port path (2-1.1.1) when it's on USB.
 */
export function parseAdbDevices(text) {
  return text
    .split('\n')
    .slice(1)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [id, state] = l.split(/\s+/);
      return { id, state, usb: /\busb:(\S+)/.exec(l)?.[1] || null, model: /\bmodel:(\S+)/.exec(l)?.[1] || null };
    })
    .filter((d) => d.id && d.state && !d.id.startsWith('*'));
}

/**
 How many hubs a USB port path goes through: `2-1` is a port on the Mac's own bus, every `.n` after it one hub more
 (`2-1.1.1`: two hubs). Hubs, especially nested and unpowered ones, are the usual cause of an adb link that stalls.
 */
export const hubsOn = (usb) => (usb ? (usb.split('-')[1] || '').split('.').length - 1 : 0);

/**
 The probe's result → its state: ok, slow, unresponsive, unauthorized, offline, missing or adb-server-hung.
 `devices`: the `adb devices` text, or null when that timed out. `echo`: { ms, out } or null when it timed out.
 */
export function classify({ devices, state, echo }, serial) {
  if (devices == null) return 'adb-server-hung';
  const row = parseAdbDevices(devices).find((d) => d.id === serial);
  if (!row) return 'missing';
  if (row.state === 'unauthorized') return 'unauthorized';
  if (row.state === 'offline') return 'offline';
  if (row.state !== 'device' && state !== 'device') return row.state;
  if (!echo) return 'unresponsive';
  if (!/\bok\b/.test(echo.out)) return 'unresponsive';
  return echo.ms > SLOW_MS ? 'slow' : 'ok';
}

/** What a state means, and what to do: the line every stuck command prints. */
export function explain(state, serial, { ms = DEVICE_TIMEOUT, latency } = {}) {
  const doctor = `run looktap doctor -d ${serial}`;
  switch (state) {
    case 'adb-server-hung':
      return { layer: 'adb-server', text: `the adb server on this computer did not answer \`adb devices\` in ${Math.round(ms / 1000)} s (the server is stuck, not the phone). ${doctor} (--fix restarts it, after listing who else is using adb)` };
    case 'missing':
      return { layer: 'usb', text: `${serial} isn't connected (adb devices doesn't list it): check the cable, or looktap devices for what is` };
    case 'unauthorized':
      return { layer: 'device', text: `${serial} hasn't allowed this computer: unlock it and accept "Allow USB debugging?" (if no prompt shows, toggle USB debugging off and on)` };
    case 'offline':
      return { layer: 'usb', text: `adb lists ${serial} as offline: the USB link is up but adb can't talk to it. Replug the cable (straight into the computer, not a hub), or ${doctor}` };
    case 'unresponsive':
      return { layer: 'usb', text: `the device did not answer in ${Math.round(ms / 1000)} s (adb link stuck); ${doctor}` };
    case 'slow':
      return { layer: 'usb', text: `${serial} answers, but slowly (${(latency / 1000).toFixed(1)} s for a round trip): commands will crawl. A hub or a worn cable is the usual cause; ${doctor}` };
    default:
      return { layer: 'device', text: `adb reports ${serial} as ${state}; ${doctor}` };
  }
}

/**
 Probe the way to `serial`: `adb devices -l` (is the server alive, is the device listed and in which state), then a
 timed `shell echo ok`. { state, latency, usb, at }. Cached for ~10 s across looktap processes, so a run of
 commands probes once.
 */
export function probe(serial, { fresh = false, timeout = Math.min(DEVICE_TIMEOUT, 10e3) } = {}) {
  const cache = readJson(CACHE, {});
  const hit = cache[serial];
  if (!fresh && hit && Date.now() - hit.at < FRESH_MS && ['ok', 'slow'].includes(hit.state)) return hit;
  let devices = null;
  try {
    devices = run(ADB, ['devices', '-l'], { allowFail: true, strict: true, timeout: Math.min(timeout, 5000) });
  } catch (e) {
    if (!(e instanceof TimedOut)) throw e;
  }
  const row = devices == null ? null : parseAdbDevices(devices).find((d) => d.id === serial);
  let echo = null;
  if (row?.state === 'device') {
    const t = Date.now();
    try {
      echo = { out: run(ADB, ['-s', serial, 'shell', 'echo', 'ok'], { allowFail: true, strict: true, timeout }), ms: Date.now() - t };
    } catch (e) {
      if (!(e instanceof TimedOut)) throw e;
    }
  }
  const result = { state: classify({ devices, echo }, serial), latency: echo?.ms ?? null, usb: row?.usb ?? null, at: Date.now() };
  try {
    writeJson(CACHE, { ...readJson(CACHE, {}), [serial]: result });
  } catch {}
  return result;
}

/** Forget the cached probe (a command just found the device stuck, or adb was restarted). */
export function forget(serial) {
  const cache = readJson(CACHE, {});
  if (!(serial in cache)) return;
  delete cache[serial];
  try {
    writeJson(CACHE, cache);
  } catch {}
}

/**
 Before a device command: probe, and stop at once with what is wrong when the device can't be driven. A slow link
 is let through with a warning. Returns the probe.
 */
export function assertHealthy(serial, { warn = (m) => console.error(`looktap: ${m}`) } = {}) {
  const p = probe(serial);
  if (p.state === 'ok') return p;
  const { layer, text } = explain(p.state, serial, { latency: p.latency });
  if (p.state === 'slow') {
    warn(text);
    return p;
  }
  forget(serial);
  throw new StuckError(text, { layer, state: p.state });
}

/**
 A call that ran out of time, turned into what is wrong: the adb server itself (when `adb devices` doesn't answer
 either) or the link to the device.
 */
export function stuckError(serial, e) {
  forget(serial);
  let server = true;
  try {
    run(ADB, ['devices'], { allowFail: true, strict: true, timeout: 3000 });
  } catch {
    server = false;
  }
  const state = server ? 'unresponsive' : 'adb-server-hung';
  const { layer, text } = explain(state, serial, { ms: e.ms });
  const what = e.args?.filter((a) => a !== '-s' && a !== serial).slice(0, 4).join(' ');
  return new StuckError(`${text}${what ? ` (it was running: adb ${what})` : ''}`, { layer, state });
}

/** `ps -axo pid,ppid,etime,command` → [{ pid, ppid, etime, secs, command }]. */
export function parsePs(text) {
  return text
    .split('\n')
    .slice(1)
    .map((l) => /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(l))
    .filter(Boolean)
    .map(([, pid, ppid, etime, command]) => ({ pid: Number(pid), ppid: Number(ppid), etime, secs: etimeSecs(etime), command }));
}

/** ps's elapsed time ([[dd-]hh:]mm:ss) → seconds. */
export function etimeSecs(etime) {
  const [days, rest] = etime.includes('-') ? etime.split('-') : [0, etime];
  const parts = rest.split(':').map(Number);
  while (parts.length < 3) parts.unshift(0);
  return Number(days) * 86400 + parts[0] * 3600 + parts[1] * 60 + parts[2];
}

/** A process that talks to a device: an adb client or server, or a libimobiledevice tool (idevicesyslog …). */
export function deviceProcess(command) {
  const exe = command.split(/\s+/)[0].split('/').pop();
  if (exe === 'adb') return /\bfork-server\b|\bnodaemon\b/.test(command) ? 'adb server' : 'adb';
  if (/^idevice/.test(exe)) return exe;
  return null;
}

/** Every adb and idevice* process on this computer: { pid, ppid, secs, etime, command, kind }. */
export function deviceProcesses() {
  return parsePs(run('ps', ['-axo', 'pid,ppid,etime,command'], { allowFail: true, timeout: 5000 }))
    .map((p) => ({ ...p, kind: deviceProcess(p.command) }))
    .filter((p) => p.kind && p.pid !== process.pid);
}

/** The adb server: { version, pid } (pid from ps; null when it isn't running). */
export function adbServer() {
  let version = null;
  try {
    version = /Android Debug Bridge version ([\d.]+)/.exec(run(ADB, ['version'], { allowFail: true, strict: true, timeout: 5000 }))?.[1] || null;
  } catch {}
  const server = deviceProcesses().find((p) => p.kind === 'adb server');
  return { version, pid: server?.pid ?? null, secs: server?.secs ?? null };
}

/** `adb reverse --list` → [{ serial?, remote, local }] (adb prints "<serial>? <remote> <local>" or "host-N tcp:8081 tcp:8081"). */
export function parseReverse(text) {
  return text
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .filter((p) => p.length >= 3 && /^tcp:|^localabstract:/.test(p.at(-2)))
    .map((p) => ({ remote: p.at(-2), local: p.at(-1) }));
}
