// Keeping several agents' use of the same devices visible and recoverable: `who`, `release`, the adb part of
// `doctor -d` and its `--fix` (an adb server restart that names who it cuts off first, warns them, and puts the
// reverse rules back), and "did you mean" for a command typed wrong.
import { createInterface } from 'node:readline';
import { join } from 'node:path';

import { adbServer, deviceProcesses, forget, hubsOn, parseAdbDevices, parseReverse } from './health.js';
import { age, drop, leaseLine, leases, notify, sweep } from './lease.js';
import { ADB, HOME, UsageError, readJson, run, sleep, writeJson } from './util.js';

const REVERSES = join(HOME, 'reverse.json');

/** Remember a device's reverse rules, so an adb restart can put them back even when adb can't list them any more. */
export function rememberReverses(serial, rules) {
  try {
    writeJson(REVERSES, { ...readJson(REVERSES, {}), [serial]: rules });
  } catch {}
}

/** Ask y/N on the terminal; false without one (then --yes is the way). */
export async function confirm(question) {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise((r) => rl.question(`${question} [y/N] `, r));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

/** Edit distance, for "did you mean". */
function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

/** Words other tools use for a looktap command. */
const SYNONYMS = {
  screencap: 'shot', capture: 'shot', snapshot: 'ls', click: 'tap', press: 'tap', input: 'type', text: 'type', start: 'launch',
  quit: 'stop', close: 'stop', 'force-stop': 'stop', logcat: 'logs', log: 'logs', syslog: 'logs', pid: 'ps', processes: 'ps',
  forward: 'reverse', clear: 'reset', health: 'doctor', status: 'doctor', list: 'devices', leases: 'who',
};

/** The command meant by a mistyped one, or null. */
export function didYouMean(cmd, known) {
  if (SYNONYMS[cmd] && known.includes(SYNONYMS[cmd])) return SYNONYMS[cmd];
  let best = null;
  for (const k of known) {
    const n = distance(cmd, k);
    if (n <= Math.max(1, Math.floor(k.length / 3)) && (!best || n < best.n)) best = { k, n };
  }
  if (best) return best.k;
  return known.find((k) => k.length >= 3 && (cmd.startsWith(k) || k.startsWith(cmd))) || null;
}

/** The device a process is attached to, from its arguments (-s serial, -u udid), or null (adb's default device). */
export const processDevice = (command) => /\s-(?:s|u)\s+(\S+)/.exec(command)?.[1] || /\s--udid[= ](\S+)/.exec(command)?.[1] || null;

/**
 `who [device]`: the leases (looktap commands running, and their streams) and every adb/idevice process looktap
 didn't start, with how long each has run. Returns the lines.
 */
export function whoLines(device = null, now = Date.now()) {
  const held = leases(device);
  const ours = new Set(held.map((l) => l.pid));
  const procs = deviceProcesses();
  const lines = [];
  const byDevice = new Map();
  for (const l of held) byDevice.set(l.device, [...(byDevice.get(l.device) || []), l]);
  for (const [dev, ls] of byDevice) {
    lines.push(`${dev}`);
    for (const l of ls.sort((a, b) => (a.kind === 'exclusive' ? -1 : 1))) lines.push(`  ${leaseLine(l, now)}`);
  }
  const server = procs.find((p) => p.kind === 'adb server');
  const others = procs.filter((p) => p.kind !== 'adb server' && !ours.has(p.ppid) && !ours.has(p.pid) && (!device || [device, null].includes(processDevice(p.command))));
  if (others.length) {
    lines.push(`not looktap${device ? ` (on ${device}, or on no named device)` : ''}:`);
    for (const p of others) lines.push(`  pid ${p.pid}  for ${age(p.secs * 1000)}  ${p.command.length > 110 ? `${p.command.slice(0, 110)} …` : p.command}`);
  }
  if (server) lines.push(`adb server: pid ${server.pid}, up ${age(server.secs * 1000)}`);
  if (!lines.length) lines.push(device ? `nothing is using ${device}` : 'no looktap commands or device tools are running');
  return lines;
}

/** `release <device> [--force]`: clear dead leases; a live one only with --force, after asking (or --yes). */
export async function release(device, { force = false, yes = false } = {}) {
  if (!device) throw new UsageError('usage: looktap release <device> [--force]');
  const n = sweep(device);
  const live = leases(device).filter((l) => !l.dead && l.pid !== process.pid);
  if (!live.length) return `${n ? `cleared ${n} dead lease${n > 1 ? 's' : ''}` : 'no leases'} on ${device}`;
  if (!force) throw new UsageError(`${live.length} live lease${live.length > 1 ? 's' : ''} on ${device} (their processes are running):\n${live.map((l) => `  ${leaseLine(l)}`).join('\n')}\nlooktap release ${device} --force clears them anyway (the commands keep running)`);
  if (!yes && !(await confirm(`clear ${live.length} live lease${live.length > 1 ? 's' : ''} on ${device}?`))) throw new UsageError('not cleared (pass --yes to clear without asking)');
  live.forEach(drop);
  return `cleared ${live.length} live and ${n} dead lease${live.length + n > 1 ? 's' : ''} on ${device}`;
}

/** The adb part of `doctor -d`: rows of [ok, text, fix], as doctor prints them. */
export function adbRows(serial) {
  const rows = [];
  const s = adbServer();
  rows.push([s.pid ? true : false, `adb server ${s.version || '(version unknown)'}${s.pid ? `, pid ${s.pid}, up ${age(s.secs * 1000)}` : ': not running'}`, 'adb start-server']);
  const clients = deviceProcesses().filter((p) => p.kind === 'adb');
  if (clients.length) {
    rows.push([null, `${clients.length} adb client${clients.length > 1 ? 's' : ''} running:`]);
    for (const p of clients) rows.push([p.secs > 600 && !/logcat|shell\s*$/.test(p.command) ? false : null, `  pid ${p.pid}, for ${age(p.secs * 1000)}: ${p.command.slice(0, 100)}`, 'an adb command running this long without streaming is stuck: kill it']);
  }
  return rows;
}

/** What to do about a stuck phone, safest first. */
export const RECOVERY = [
  'restart the adb server: looktap doctor -d <serial> --fix (it lists who is using adb first, and puts adb reverse rules back)',
  'replug the USB cable straight into the computer (not through a hub)',
  'toggle USB debugging off and on (Settings → Developer options), and accept "Allow USB debugging?" again',
  'reboot the phone',
];

/**
 `doctor --fix`: restart the adb server. First lists every holder and adb process it will cut off, and (unless `yes`)
 asks; warns each device's holders through their lease notice; afterwards puts back the reverse rules it found.
 Returns the lines to print.
 */
export async function restartAdb({ yes = false, say = (m) => console.error(m) } = {}) {
  const held = leases().filter((l) => !l.dead && l.pid !== process.pid);
  const clients = deviceProcesses().filter((p) => p.kind === 'adb');
  if (held.length || clients.length) {
    say('restarting the adb server cuts off:');
    for (const l of held) say(`  ${l.device}: ${leaseLine(l)}`);
    for (const p of clients) say(`  adb pid ${p.pid} (for ${age(p.secs * 1000)}): ${p.command.slice(0, 100)}`);
    say('looktap log captures re-attach by themselves and record the gap; other tools (a plain adb logcat) end.');
  }
  if (!yes && !(await confirm('restart the adb server now?'))) throw new UsageError('adb not restarted (pass --yes to restart without asking)');
  // The rules to put back: asked of adb while it still answers, else the ones looktap last saw.
  const saved = readJson(REVERSES, {});
  let devices = [];
  try {
    devices = parseAdbDevices(run(ADB, ['devices', '-l'], { allowFail: true, strict: true, timeout: 3000 })).filter((d) => d.state === 'device');
    for (const d of devices) {
      try {
        const rules = parseReverse(run(ADB, ['-s', d.id, 'reverse', '--list'], { allowFail: true, strict: true, timeout: 3000 }));
        if (rules.length) saved[d.id] = rules;
      } catch {}
    }
  } catch {}
  for (const dev of new Set([...held.map((l) => l.device), ...devices.map((d) => d.id), ...Object.keys(saved)])) notify(dev, 'the adb server is being restarted (looktap doctor --fix): device commands fail for a few seconds');
  const out = [];
  run(ADB, ['kill-server'], { allowFail: true, timeout: 5000 });
  // A server stuck hard ignores kill-server: end it by its pid (clients go with it).
  const server = deviceProcesses().find((p) => p.kind === 'adb server');
  if (server) {
    try {
      process.kill(server.pid, 'SIGKILL');
      out.push(`the adb server (pid ${server.pid}) didn't stop when asked: killed it`);
    } catch {}
  }
  run(ADB, ['start-server'], { allowFail: true, timeout: 15000 });
  out.push(`adb server restarted${adbServer().pid ? `, pid ${adbServer().pid}` : ' (but it is not running: run adb start-server and read its error)'}`);
  // Devices come back over a few seconds; the rules go back on each as it does.
  const want = Object.entries(saved).filter(([, rules]) => rules.length);
  const until = Date.now() + 15e3;
  const pending = new Map(want);
  while (pending.size && Date.now() < until) {
    const up = new Set(parseAdbDevices(run(ADB, ['devices'], { allowFail: true, timeout: 5000 })).filter((d) => d.state === 'device').map((d) => d.id));
    for (const [id, rules] of pending) {
      if (!up.has(id)) continue;
      for (const r of rules) run(ADB, ['-s', id, 'reverse', r.remote, r.local], { allowFail: true, timeout: 5000 });
      out.push(`${id}: put back adb reverse ${rules.map((r) => `${r.remote}→${r.local}`).join(', ')}`);
      pending.delete(id);
    }
    if (pending.size) await sleep(1000);
  }
  for (const id of pending.keys()) out.push(`${id} didn't come back within 15 s: its reverse rules weren't put back (replug it, then looktap reverse)`);
  for (const id of new Set([...devices.map((d) => d.id), ...Object.keys(saved)])) forget(id);
  return out;
}

export { hubsOn };
