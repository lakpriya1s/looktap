// `looktap devices`: every device looktap can see, what it is (simulator, emulator, real device), and whether it's
// ready: so an agent knows a real phone is plugged in, and what the user has to do when it isn't usable yet.
import { avds, bootCompleted, emulatorDisplay, runningEmulators, simulatorDisplay, simulators } from './boot.js';
import { deviceLocked, devicectlList } from './iosdevice.js';
import { samePhones } from './android.js';
import { ADB, run } from './util.js';

/** What adb's device states mean for the person holding the phone. */
const ADB_STATES = {
  unauthorized: 'accept "Allow USB debugging?" on the phone (tick "Always allow")',
  offline: 'reconnect it (or run: adb reconnect)',
  'no permissions': "this computer's USB permissions block adb (udev rules)",
  recovery: 'it is in recovery mode',
  sideload: 'it is in sideload mode',
  bootloader: 'it is in the bootloader',
};

const STARTING = 'still starting — looktap boot <name> waits until it is ready';

/** adb's devices, real phones included, with model, Android version and connection. */
function androidDevices() {
  const out = run(ADB, ['devices', '-l'], { allowFail: true, timeout: 10000 });
  const avd = runningEmulators();
  const list = [];
  for (const line of out.split(/\r?\n/).slice(1)) {
    const parsed = parseAdbLine(line);
    if (!parsed) continue;
    const { id, state, rest } = parsed;
    const emulator = id.startsWith('emulator-');
    const d = { platform: 'android', kind: emulator ? 'emulator' : 'device', id, ready: state === 'device' };
    if (!d.ready && emulator && state === 'offline') {
      // An emulator shows offline while it starts, not because a cable came loose.
      d.name = 'emulator';
      d.problem = STARTING;
    } else if (!d.ready) {
      d.name = /model:(\S+)/.exec(rest)?.[1]?.replace(/_/g, ' ') || 'Android phone';
      d.problem = ADB_STATES[state] || state;
    } else if (emulator) {
      d.name = avd.get(id) || 'emulator';
      d.os = `Android ${prop(id, 'ro.build.version.release')}`;
      d.display = emulatorDisplay(d.name) || undefined;
      if (!bootCompleted(id)) Object.assign(d, { ready: false, problem: STARTING });
    } else {
      const [maker, model, version] = run(ADB, ['-s', id, 'shell', 'getprop ro.product.manufacturer; getprop ro.product.model; getprop ro.build.version.release'], { allowFail: true, timeout: 10000 })
        .split(/\r?\n/)
        .map((s) => s.trim());
      d.name = [maker && maker[0].toUpperCase() + maker.slice(1), model].filter(Boolean).join(' ') || 'Android phone';
      d.os = version ? `Android ${version}` : undefined;
    }
    if (d.ready) d.locked = /showing=true/.test(run(ADB, ['-s', id, 'shell', 'dumpsys window policy | grep -m1 showing='], { allowFail: true, timeout: 10000 }));
    if (!emulator) d.connection = /_adb-tls-connect|:\d+$/.test(id) ? 'Wi-Fi' : 'USB';
    list.push(d);
  }
  // A phone on both USB and Wi-Fi is one row: its USB one, which commands pick, with the Wi-Fi id kept for -d.
  const pairs = samePhones(list.filter((d) => d.ready).map((d) => d.id), (id) => prop(id, 'ro.serialno'));
  for (const [wifi, usb] of pairs) {
    const row = list.find((d) => d.id === usb);
    Object.assign(row, { connection: 'USB + Wi-Fi', wifiId: wifi });
  }
  return list.filter((d) => !pairs.has(d.id));
}

/** One line of `adb devices -l`: { id, state, rest }, or null. */
export function parseAdbLine(line) {
  const m = /^(\S+)\s+(device|unauthorized|offline|no permissions|recovery|sideload|bootloader)\b(.*)$/.exec(line.trim());
  return m && { id: m[1], state: m[2], rest: m[3] };
}

const prop = (id, name) => run(ADB, ['-s', id, 'shell', 'getprop', name], { allowFail: true, timeout: 10000 }).trim();

/** Paired or connected iPhones and iPads, ready or not (with what to do), and with `all` the ones out of reach. */
function iosDevices(all) {
  const list = [];
  for (const x of devicectlList()) {
    const d = iosEntry(x);
    if (!d || !(all || d.connection)) continue; // out of reach: every iPhone ever paired with this Mac, so only with --all
    // Locked, a phone takes no commands: say so up front rather than in the middle of a sequence (~1 s per phone).
    if (d.ready) d.locked = deviceLocked(d.id) ?? undefined;
    list.push(d);
  }
  return list;
}

/** One `devicectl list devices` entry as a device, with what to do when it isn't ready; null if not an iPhone/iPad. */
export function iosEntry(x) {
  const hw = x.hardwareProperties || {}, dp = x.deviceProperties || {}, cp = x.connectionProperties || {};
  if (hw.reality !== 'physical' || hw.platform !== 'iOS') return null;
  const reachable = cp.tunnelState !== 'unavailable';
  const problem =
    cp.pairingState !== 'paired' ? 'not paired: connect it with a cable, unlock it and tap Trust'
    : dp.developerModeStatus === 'disabled' ? 'Developer Mode is off: Settings → Privacy & Security → Developer Mode'
    : !reachable ? 'out of reach: connect it with a cable, or unlock it on the same Wi-Fi'
    : null;
  return {
    platform: 'ios', kind: 'device', id: hw.udid, name: dp.name || hw.marketingName || 'iPhone',
    model: hw.marketingName, os: dp.osVersionNumber ? `iOS ${dp.osVersionNumber}` : undefined,
    connection: reachable ? (cp.transportType === 'wired' ? 'USB' : 'Wi-Fi') : undefined,
    ready: !problem, ...(problem && { problem }),
  };
}

/**
 Every device: running simulators and emulators, real phones (ready or with the reason they aren't), and with
 `all`, the simulators and emulators `boot` can start (running: false).
 */
export function inventory({ all = false } = {}) {
  const sims = simulators();
  const list = [
    ...sims.filter((s) => s.booting).map((s) => ({ platform: 'ios', kind: 'simulator', id: s.id, name: s.name, os: s.os, ready: false, problem: STARTING })),
    ...sims.filter((s) => s.booted).map((s) => ({ platform: 'ios', kind: 'simulator', id: s.id, name: s.name, os: s.os, display: simulatorDisplay(), ready: true })),
    ...androidDevices(),
    ...iosDevices(all),
  ];
  if (all) {
    list.push(...sims.filter((s) => !s.booted && !s.booting).map((s) => ({ platform: 'ios', kind: 'simulator', id: s.id, name: s.name, os: s.os, running: false })));
    list.push(...avds().filter((a) => !a.serial).map((a) => ({ platform: 'android', kind: 'emulator', id: a.name, name: a.name, running: false })));
  }
  return list;
}

/** One line: platform, id, then what it is. */
export function formatDevice(d) {
  const what = [d.model && d.model !== d.name ? `${d.name} (${d.model})` : d.name, d.kind, d.os, d.connection, d.display, d.locked && 'locked: unlock it to drive it'].filter(Boolean).join(' · ');
  const state = d.running === false ? '' : d.ready ? '' : `  ✗ not ready: ${d.problem}`;
  return `${d.platform.padEnd(8)} ${d.id}  ${what}${state}`;
}
