// Who is using a device. Several agents (and their background log captures) can drive the same phone; without a
// record of who holds it they type into each other's screens, and one restarting adb cuts off another's capture
// without a word. Each looktap command takes a lease on its device for as long as it runs:
//   exclusive      taps, typing, launch, install, stop, location: one holder at a time; others wait, then fail with who
//                  holds it
//   shared-stream  log streams, screenshots: any number, alongside an exclusive holder; listed so `who` and a restart
//                  can name them
// A lease is a JSON file under ~/.looktap/leases (the exclusive one, <device>.json, created with O_EXCL so two
// processes can't both take it; shared ones, <device>.shared/<pid>-<n>.json, one each so nobody rewrites another's).
// The holder refreshes its heartbeat every 5 s; a lease whose pid is gone, or whose heartbeat is 30 s old, is dead and
// anyone may take it over. A restart of adb (doctor --fix) leaves a notice in <device>.notice.json that holders print.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';

import { HOME, UsageError, run, sleep } from './util.js';

export const LEASES = process.env.LOOKTAP_LEASES || join(HOME, 'leases');
export const HEARTBEAT_MS = 5e3;
export const DEAD_MS = 30e3;

/** Commands that change the device: one at a time. Everything else that touches a device shares it. */
export const EXCLUSIVE = new Set([
  'tap', 'longpress', 'tapxy', 'zoom', 'type', 'key', 'fill', 'paste', 'code', 'hidekb', 'swipe', 'scrollto', 'back', 'home',
  'open', 'launch', 'stop', 'terminate', 'kill', 'background', 'install', 'uninstall', 'reset', 'location',
  'permission', 'appearance', 'textsize', 'statusbar', 'touches', 'runner', 'rotate', 'fold', 'bio', 'push', 'dismiss', 'run', 'test', 'setup', 'teardown',
  'reverse',
]);

/**
 The lease kind a command takes. A route is a stream of fixes (taps during a walk are what it's for), so it shares the
 device, except `route stop`; `network offline|online` changes the device, `network <app>` only watches it.
 */
export function kindOf(cmd, args = []) {
  if (cmd === 'route') return args[0] === 'stop' ? 'exclusive' : 'shared-stream';
  if (cmd === 'network') return ['offline', 'online'].includes(args[0]) ? 'exclusive' : 'shared-stream';
  if (cmd === 'reverse' && (args[0] === '--list' || !args.length)) return 'shared-stream';
  return EXCLUSIVE.has(cmd) ? 'exclusive' : 'shared-stream';
}

const safe = (device) => String(device).replace(/[^\w.-]/g, '_');
const exclusivePath = (device) => join(LEASES, `${safe(device)}.json`);
const sharedDir = (device) => join(LEASES, `${safe(device)}.shared`);
const noticePath = (device) => join(LEASES, `${safe(device)}.notice.json`);

/** Is process `pid` alive (on this computer)? */
export function alive(pid) {
  if (!(pid > 0)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/** A lease no one holds any more: its process is gone, or it stopped beating 30 s ago. */
export const dead = (lease, now = Date.now()) => !lease || !alive(lease.pid) || now - Date.parse(lease.heartbeat_at) > DEAD_MS;

/** Write `value` to `path` whole or not at all: a reader never sees half a file. */
function writeAtomic(path, value) {
  const tmp = `${path}.${process.pid}.tmp`;
  const fd = openSync(tmp, 'w');
  writeSync(fd, JSON.stringify(value, null, 2) + '\n');
  closeSync(fd);
  renameSync(tmp, path);
}

const read = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
};

let owner;
/**
 Who this process is, as `who` shows it: LOOKTAP_OWNER when set (an agent can name its session), else the program
 that started looktap and its pid ("claude (pid 4211)").
 */
export function ownerName() {
  if (owner) return owner;
  if (process.env.LOOKTAP_OWNER) return (owner = process.env.LOOKTAP_OWNER);
  const parent = run('ps', ['-o', 'comm=', '-p', String(process.ppid)], { allowFail: true, timeout: 2000 }).trim().split('/').pop();
  return (owner = `${parent || 'looktap'} (pid ${process.ppid})`);
}

/** "2m14s", "45s", "1h03m". */
export function age(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h${String(Math.floor(s / 60) % 60).padStart(2, '0')}m`;
}

/** The busy message: `device busy: claude (pid 4211) running "tap Settings" for 2m14s`. */
export const busy = (device, lease, now = Date.now()) =>
  `device busy: ${lease.owner} running "${lease.command}" for ${age(now - Date.parse(lease.started_at))} on ${device} (looktap who ${device}; --busy-wait <s> waits longer)`;

export class BusyError extends UsageError {}

let counter = 0;

/**
 Take a lease on `device` for `command`. Exclusive: waits up to `wait` ms for a live holder to finish, taking over a
 dead one, then fails with BusyError naming the holder. Returns { release(), notices() }; the heartbeat runs until
 release (or the process ends).
 */
export async function acquire(device, { kind = 'exclusive', command = '', wait = 10e3, onNotice } = {}) {
  mkdirSync(LEASES, { recursive: true });
  const now = new Date().toISOString();
  const lease = { owner: ownerName(), command, started_at: now, heartbeat_at: now, pid: process.pid, kind };
  let path;
  if (kind === 'exclusive') {
    path = exclusivePath(device);
    const until = Date.now() + wait;
    for (let said = false; ; ) {
      try {
        const fd = openSync(path, 'wx');
        writeSync(fd, JSON.stringify(lease, null, 2) + '\n');
        closeSync(fd);
        break;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }
      const held = read(path);
      // Ours already (a command made of commands, or MCP running one after another in this process): share it.
      if (held?.pid === process.pid) return { release: () => {}, path, nested: true };
      if (!held || dead(held)) {
        // Take over a dead lease: move it aside first, so only one of two waiting processes removes it.
        try {
          renameSync(path, `${path}.${process.pid}.dead`);
          rmSync(`${path}.${process.pid}.dead`, { force: true });
        } catch {}
        continue;
      }
      if (Date.now() >= until) throw new BusyError(busy(device, held));
      if (!said) console.error(`looktap: waiting for ${device}: ${held.owner} is running "${held.command}"`), (said = true);
      await sleep(250);
    }
  } else {
    mkdirSync(sharedDir(device), { recursive: true });
    path = join(sharedDir(device), `${process.pid}-${++counter}.json`);
    writeAtomic(path, lease);
  }
  const started = Date.now();
  const seen = new Set();
  const checkNotice = () => {
    const n = read(noticePath(device));
    if (n && Date.parse(n.at) >= started - 1000 && n.pid !== process.pid && !seen.has(n.at)) {
      seen.add(n.at);
      (onNotice || ((x) => console.error(`looktap: notice from ${x.from}: ${x.text}`)))(n);
    }
  };
  const beat = setInterval(() => {
    const cur = read(path);
    if (!cur || cur.pid !== process.pid) return clearInterval(beat); // taken over (we were thought dead)
    cur.heartbeat_at = new Date().toISOString();
    try {
      writeAtomic(path, cur);
    } catch {}
    checkNotice();
  }, HEARTBEAT_MS);
  beat.unref();
  const release = () => {
    clearInterval(beat);
    if (read(path)?.pid === process.pid) rmSync(path, { force: true });
    process.off('exit', release);
  };
  process.on('exit', release);
  return { release, path, checkNotice };
}

/** Every lease on `device` (or on every device): [{ device, path, ...lease, dead }]. */
export function leases(device = null) {
  if (!existsSync(LEASES)) return [];
  const out = [];
  for (const f of readdirSync(LEASES)) {
    const ex = /^(.+)\.json$/.exec(f);
    if (ex && !f.endsWith('.notice.json') && (!device || ex[1] === safe(device))) {
      const l = read(join(LEASES, f));
      if (l) out.push({ device: ex[1], path: join(LEASES, f), ...l, dead: dead(l) });
    }
    const sh = /^(.+)\.shared$/.exec(f);
    if (sh && (!device || sh[1] === safe(device)))
      for (const g of readdirSync(join(LEASES, f)).filter((x) => x.endsWith('.json'))) {
        const l = read(join(LEASES, f, g));
        if (l) out.push({ device: sh[1], path: join(LEASES, f, g), ...l, dead: dead(l) });
      }
  }
  return out;
}

/** Remove dead leases (all of them, or `device`'s). Returns how many. */
export function sweep(device = null) {
  let n = 0;
  for (const l of leases(device)) if (l.dead) rmSync(l.path, { force: true }), n++;
  return n;
}

/** Remove one lease file (release --force). */
export const drop = (lease) => rmSync(lease.path, { force: true });

/**
 Tell every holder on `device` something is about to cut them off (an adb restart): they print it on their next
 heartbeat, and a log capture records the gap with who caused it.
 */
export function notify(device, text) {
  mkdirSync(LEASES, { recursive: true });
  writeAtomic(noticePath(device), { at: new Date().toISOString(), from: ownerName(), pid: process.pid, text });
}

/** The newest notice on `device` since `since` (ms), or null. */
export function noticeSince(device, since) {
  const n = read(noticePath(device));
  return n && Date.parse(n.at) >= since ? n : null;
}

/** A lease as one line of `who`. */
export function leaseLine(l, now = Date.now()) {
  const beat = Math.round((now - Date.parse(l.heartbeat_at)) / 1000);
  return `${l.kind === 'exclusive' ? 'exclusive' : 'shared   '}  ${l.owner}  "${l.command}"  for ${age(now - Date.parse(l.started_at))}  (heartbeat ${beat}s ago, pid ${l.pid}${l.dead ? ', DEAD: looktap release clears it' : ''})`;
}
