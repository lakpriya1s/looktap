// Boot and shut down simulators and emulators: `looktap boot "iPhone 16"`, `looktap boot Pixel_9a`, `looktap shutdown`.
// Booted means ready to drive: the simulator finished booting (simctl bootstatus), the emulator's Android finished
// starting (sys.boot_completed), not just that a process was started.
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { ADB, HOME, UsageError, has, run, sleep } from './util.js';

/** iOS simulators the installed Xcode can boot, newest runtime first: { id, name, os, booted }. */
export function simulators() {
  const out = run('xcrun', ['simctl', 'list', 'devices', 'available', '-j'], { allowFail: true });
  if (!out) return [];
  const list = [];
  for (const [runtime, devices] of Object.entries(JSON.parse(out).devices)) {
    const m = /SimRuntime\.iOS-(\d+)-(\d+)/.exec(runtime);
    if (!m) continue; // watchOS, tvOS, visionOS: looktap drives iPhones and iPads
    for (const d of devices) list.push({ id: d.udid, name: d.name, os: `iOS ${m[1]}.${m[2]}`, version: Number(m[1]) * 100 + Number(m[2]), booted: d.state === 'Booted' });
  }
  return list.sort((a, b) => b.version - a.version || a.name.localeCompare(b.name));
}

/** The Android emulator binary: next to adb's SDK, else ANDROID_HOME / ANDROID_SDK_ROOT / the default SDK, else PATH. */
export function emulatorBin() {
  const sdks = [dirname(dirname(ADB)), process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT, join(homedir(), 'Library', 'Android', 'sdk'), join(homedir(), 'Android', 'Sdk')];
  for (const sdk of sdks.filter(Boolean)) {
    const p = join(sdk, 'emulator', 'emulator');
    if (existsSync(p)) return p;
  }
  return has('emulator') ? 'emulator' : null;
}

/** Running emulators: serial → AVD name. */
export function runningEmulators() {
  const out = run(ADB, ['devices'], { allowFail: true, timeout: 10000 });
  const serials = [...out.matchAll(/^(emulator-\d+)\s+device$/gm)].map((m) => m[1]);
  // The emulator sets its AVD's name as a property; older ones only answer on the console.
  const name = (s) =>
    run(ADB, ['-s', s, 'shell', 'getprop', 'ro.boot.qemu.avd_name'], { allowFail: true, timeout: 10000 }).trim() ||
    run(ADB, ['-s', s, 'emu', 'avd', 'name'], { allowFail: true, timeout: 10000 }).split(/\r?\n/)[0].trim();
  return new Map(serials.map((s) => [s, name(s)]));
}

/** Android virtual devices: { name, serial (when running) }. */
export function avds() {
  const bin = emulatorBin();
  if (!bin) return [];
  const running = [...runningEmulators()];
  return run(bin, ['-list-avds'], { allowFail: true })
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^(INFO|WARNING|ERROR)\b/.test(l))
    .map((name) => ({ name, serial: running.find(([, avd]) => avd === name)?.[0] || null }));
}

/** The one item `query` names: an exact id or name, else a unique prefix, else a unique substring. */
export function pick(items, query, what) {
  const q = query.toLowerCase();
  const tiers = [
    items.filter((i) => i.id?.toLowerCase() === q || i.name.toLowerCase() === q),
    items.filter((i) => i.name.toLowerCase().startsWith(q)),
    items.filter((i) => i.name.toLowerCase().includes(q)),
  ];
  for (const hits of tiers) {
    if (!hits.length) continue;
    // The same model under several iOS versions: the newest (simulators() lists it first).
    const names = new Set(hits.map((h) => h.name));
    if (names.size === 1) return hits[0];
    throw new UsageError(`"${query}" matches several ${what}: ${[...names].slice(0, 8).join(', ')}${names.size > 8 ? ', …' : ''}`);
  }
  return null;
}

/** Everything `boot` can start, for one platform or both. */
function candidates(platform) {
  return [
    ...(platform === 'android' ? [] : simulators().map((s) => ({ ...s, platform: 'ios' }))),
    ...(platform === 'ios' ? [] : avds().map((a) => ({ ...a, id: a.name, platform: 'android', booted: Boolean(a.serial) }))),
  ];
}

/**
 Boot the simulator or emulator `query` names (no query: the only one there is), and wait until it's ready.
 Returns { platform, id, name, os?, already }.
 */
export async function boot(query, { platform, headless = false } = {}) {
  const all = candidates(platform);
  if (!all.length) throw new UsageError(`nothing to boot${platform ? ` for ${platform}` : ''}: no iOS simulators (Xcode → Settings → Components) or Android AVDs (Android Studio → Device Manager)`);
  let target;
  if (query) {
    target = pick(all, query, 'devices');
    if (!target) throw new UsageError(`no simulator or emulator called "${query}" — looktap devices --all lists them`);
  } else {
    const off = all.filter((c) => !c.booted);
    if (all.length === 1) target = all[0];
    else if (new Set(off.map((c) => c.name)).size === 1) target = off[0];
    else throw new UsageError(`name the device to boot, e.g. looktap boot "${off[0]?.name || all[0].name}" — looktap devices --all lists them`);
  }
  return target.platform === 'ios' ? bootSimulator(target, headless) : bootEmulator(target, headless);
}

async function bootSimulator(sim, headless) {
  const already = sim.booted;
  if (!already) run('xcrun', ['simctl', 'boot', sim.id], { timeout: 120000 });
  run('xcrun', ['simctl', 'bootstatus', sim.id, '-b'], { timeout: 300000 }); // until the home screen is up
  if (!headless) run('open', ['-a', 'Simulator', '--args', '-CurrentDeviceUDID', sim.id], { allowFail: true });
  return { platform: 'ios', id: sim.id, name: sim.name, os: sim.os, already };
}

async function bootEmulator(avd, headless) {
  if (avd.serial) return { platform: 'android', id: avd.serial, name: avd.name, already: true };
  const bin = emulatorBin();
  if (!bin) throw new UsageError("the Android emulator isn't installed (Android Studio → SDK Manager → Android Emulator)");
  mkdirSync(HOME, { recursive: true });
  const logPath = join(HOME, `emulator-${avd.name}.log`);
  const log = openSync(logPath, 'w');
  // Detached: the emulator outlives this command, as it would started by hand.
  const p = spawn(bin, ['-avd', avd.name, ...(headless ? ['-no-window', '-no-audio'] : [])], { detached: true, stdio: ['ignore', log, log] });
  p.unref();
  closeSync(log);
  let exited = null;
  p.on('exit', (code) => (exited = code));
  const until = Date.now() + 300000; // a cold boot can take minutes
  let serial = null;
  while (Date.now() < until) {
    await sleep(2000);
    if (exited !== null) throw new UsageError(`the emulator quit while starting (exit ${exited}) — see ${logPath}`);
    serial ??= [...runningEmulators()].find(([, name]) => name === avd.name)?.[0] || null;
    if (serial && run(ADB, ['-s', serial, 'shell', 'getprop', 'sys.boot_completed'], { allowFail: true, timeout: 10000 }).trim() === '1')
      return { platform: 'android', id: serial, name: avd.name, already: false };
  }
  throw new UsageError(`${avd.name} didn't finish booting within 5 minutes — see ${logPath}`);
}

/** Shut down a simulator (UDID or name) or an emulator (serial or AVD name). Returns { platform, id, name }. */
export async function shutdown(query, { platform } = {}) {
  const on = candidates(platform).filter((c) => c.booted);
  if (!on.length) throw new UsageError('no simulator or emulator is running');
  let target;
  if (query) target = on.find((c) => c.serial === query) || pick(on, query, 'running devices');
  else if (on.length === 1) target = on[0];
  else throw new UsageError(`several are running — name one: ${on.map((c) => c.serial || c.name).join(', ')}`);
  if (!target) throw new UsageError(`no running simulator or emulator called "${query}" (real devices can't be shut down from here)`);
  if (target.platform === 'ios') {
    run('xcrun', ['simctl', 'shutdown', target.id], { timeout: 120000 });
    return { platform: 'ios', id: target.id, name: target.name };
  }
  run(ADB, ['-s', target.serial, 'emu', 'kill'], { allowFail: true });
  for (let i = 0; i < 60 && runningEmulators().has(target.serial); i++) await sleep(500);
  if (runningEmulators().has(target.serial)) throw new Error(`${target.name} (${target.serial}) is still running after the shutdown`);
  return { platform: 'android', id: target.serial, name: target.name };
}
