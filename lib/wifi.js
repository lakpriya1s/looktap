// `looktap wifi`, `looktap pair` and `looktap connect`: get an Android device onto adb over Wi-Fi, so the cable can come out.
// wifi: with the phone on USB, turn Wireless debugging on (Android 11+) and wait until adb reaches it over the
// network, else (older Android, or a computer the phone won't take over TLS) `adb tcpip 5555` + `adb connect`.
// pair: no cable at all, the six-digit code from the phone's "Pair device with pairing code" screen.
// connect: no cable and no code, just the address a Wear OS watch's "Debug over Wi-Fi" screen shows.
import { overWifi, samePhones } from './android.js';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { connect as netConnect } from 'node:net';
import { join } from 'node:path';
import { ADB, HOME, UsageError, run, sleep } from './util.js';

const TCPIP_PORT = 5555;
/** looktap's Wi-Fi keeper (native/android-wifi): put on a phone only by `wifi --always`, taken off by `wifi --off`. */
export const KEEPER = 'com.looktap.wifi';
/** Its versionCode (native/android-wifi/AndroidManifest.xml): GitHub Actions publishes it as release keeper-v<this>. */
export const KEEPER_VERSION = 5;
const KEEPER_URL = `https://github.com/lakpriya1s/looktap/releases/download/keeper-v${KEEPER_VERSION}/looktap-wifi.apk`;

/**
 The keeper's APK: LOOKTAP_KEEPER_APK (a local build), else the copy downloaded before, else downloaded now from the
 GitHub release that Actions built and signed. Not in the npm package: nobody gets it who doesn't ask for --always.
 */
async function keeperApk(say) {
  if (process.env.LOOKTAP_KEEPER_APK) return process.env.LOOKTAP_KEEPER_APK;
  const path = join(HOME, `looktap-wifi-${KEEPER_VERSION}.apk`);
  if (existsSync(path)) return path;
  say(`downloading looktap's Wi-Fi keeper (${KEEPER_URL})`);
  let bytes;
  try {
    const r = await fetch(KEEPER_URL, { signal: AbortSignal.timeout(60000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    bytes = Buffer.from(await r.arrayBuffer());
  } catch (e) {
    throw new UsageError(`couldn't download looktap's Wi-Fi keeper (${e.message}) from ${KEEPER_URL} — check the network, or build it (native/android-wifi/build.sh) and set LOOKTAP_KEEPER_APK to it`);
  }
  if (bytes.subarray(0, 2).toString() !== 'PK') throw new UsageError(`what ${KEEPER_URL} sent isn't an APK`);
  mkdirSync(HOME, { recursive: true });
  writeFileSync(`${path}.part`, bytes);
  renameSync(`${path}.part`, path);
  return path;
}

/** `adb devices` → [{ id, state }]. */
function adbList() {
  return run(ADB, ['devices'], { allowFail: true, timeout: 10000 })
    .split(/\r?\n/)
    .slice(1)
    .map((l) => l.trim().split(/\t|\s{2,}/))
    .filter(([id, state]) => id && state)
    .map(([id, state]) => ({ id, state: state.trim() }));
}

/** `adb mdns services` → [{ name, type, address }], e.g. adb-R83Y30R6V6M-qiMEaN · _adb-tls-connect._tcp · 192.168.1.15:40459. */
export function parseMdns(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^(\S+)\s+(_adb[\w-]*\._tcp)\.?\s+(\d{1,3}(?:\.\d{1,3}){3}:\d+)\s*$/.exec(line.trim());
    if (m) out.push({ name: m[1], type: m[2], address: m[3] });
  }
  return out;
}

const mdns = () => parseMdns(run(ADB, ['mdns', 'services'], { allowFail: true, timeout: 5000 }));

/** The phone's own serial from its Wireless debugging mDNS name (adb-<serial>-<suffix>), or null. */
export const mdnsSerial = (name) => /^adb-(.+)-[^-]+$/.exec(name.replace(/\._adb-tls-connect\._tcp\.?$/, ''))?.[1] ?? null;

/** The phone's IPv4 address on Wi-Fi, from `ip addr show wlan0` (or `ip route`), or null. */
export function parseWifiIp(addr, route = '') {
  return /inet (\d{1,3}(?:\.\d{1,3}){3})\//.exec(addr)?.[1] ?? /wlan\d+\s.*\bsrc (\d{1,3}(?:\.\d{1,3}){3})/.exec(route)?.[1] ?? null;
}

const shell = (id, cmd) => run(ADB, ['-s', id, 'shell', cmd], { allowFail: true, timeout: 10000 }).trim();
const serialOf = (id) => shell(id, 'getprop ro.serialno');

/** The ready Wi-Fi id that reaches the phone with this USB serial, or null. */
function wifiIdOf(serial) {
  const ids = adbList().filter((d) => d.state === 'device').map((d) => d.id);
  for (const [wifi, usb] of samePhones(ids, serialOf)) if (usb === serial) return wifi;
  return null;
}

/** The phone `wifi` works on: -d, else the only Android phone on USB. */
function usbPhone(device) {
  const list = adbList();
  if (device) {
    const d = list.find((x) => x.id === device);
    if (!d) throw new UsageError(`${device} isn't connected — looktap devices lists what is`);
    if (d.id.startsWith('emulator-')) throw new UsageError(`${device} is an emulator: it needs no Wi-Fi`);
    if (overWifi(d.id)) throw new UsageError(`${device} is already connected over Wi-Fi`);
    if (d.state !== 'device') throw new UsageError(`${device} isn't ready (${d.state}) — looktap devices says what to do`);
    return d.id;
  }
  const usb = list.filter((d) => d.state === 'device' && !d.id.startsWith('emulator-') && !overWifi(d.id));
  if (usb.length === 1) return usb[0].id;
  if (!usb.length) throw new UsageError('no Android phone on USB — plug it in (USB debugging on), or without a cable: looktap pair <code>');
  throw new UsageError(`${usb.length} Android phones on USB — pass -d one of: ${usb.map((d) => d.id).join(', ')}`);
}

/** The phone `wifi --always` / `--off` work on, by any of its ids (USB or Wi-Fi): -d, else the only Android phone. */
function anyPhone(device) {
  const ready = adbList().filter((d) => d.state === 'device' && !d.id.startsWith('emulator-'));
  if (device) {
    if (ready.some((d) => d.id === device)) return device;
    const twin = wifiIdOf(device);
    if (twin) return twin;
    throw new UsageError(`${device} isn't connected — looktap devices lists what is`);
  }
  // One phone listed twice (USB and Wi-Fi) is one phone: its USB id.
  const pairs = samePhones(ready.map((d) => d.id), serialOf);
  const phones = ready.filter((d) => !pairs.has(d.id));
  if (phones.length === 1) return phones[0].id;
  if (!phones.length) throw new UsageError('no Android phone connected — plug it in (USB debugging on), or without a cable: looktap pair <code>');
  throw new UsageError(`${phones.length} Android phones — pass -d one of: ${phones.map((d) => d.id).join(', ')}`);
}

/** Whether the phone has looktap's Wi-Fi keeper. */
export const hasKeeper = (id) => shell(id, `pm list packages ${KEEPER}`).split(/\r?\n/).includes(`package:${KEEPER}`);

/**
 `wifi --always`: install the keeper and let it switch Wireless debugging on (WRITE_SECURE_SETTINGS, granted over
 adb), keep Android from putting it to sleep, and arm it now. From then on the phone turns Wireless debugging back on
 by itself after a restart and whenever it joins Wi-Fi. Returns the id it worked on.
 */
export async function installKeeper(device = null, { say = () => {} } = {}) {
  const id = anyPhone(device);
  const sdk = Number(shell(id, 'getprop ro.build.version.sdk')) || 0;
  if (sdk < 30) throw new UsageError(`${id} runs Android ${shell(id, 'getprop ro.build.version.release')}: Wireless debugging needs Android 11 or later, and adb tcpip can't outlast a restart — use looktap wifi after each restart`);
  const apk = await keeperApk(say);
  const install = () => {
    let err = '';
    const out = run(ADB, ['-s', id, 'install', '-r', apk], { allowFail: true, timeout: 60000, onStderr: (e) => (err += e) });
    return `${out}\n${err}`;
  };
  let out = install();
  // Built with another signing key (a different looktap build): replace it.
  if (/INSTALL_FAILED_UPDATE_INCOMPATIBLE/.test(out)) run(ADB, ['-s', id, 'uninstall', KEEPER], { allowFail: true, timeout: 30000 }), (out = install());
  if (!/Success/.test(out)) throw new UsageError(`couldn't install looktap's Wi-Fi keeper (adb: ${out.trim().split('\n').pop()})`);
  const denied = shell(id, `pm grant ${KEEPER} android.permission.WRITE_SECURE_SETTINGS 2>&1`);
  if (denied) {
    run(ADB, ['-s', id, 'uninstall', KEEPER], { allowFail: true, timeout: 30000 });
    // Xiaomi and some others want a second switch before adb may grant this.
    throw new UsageError(`the phone wouldn't let looktap's Wi-Fi keeper change Wireless debugging (${denied.split('\n')[0]}) — on Xiaomi phones, turn on Developer options → USB debugging (Security settings), then run this again`);
  }
  // Not put to sleep, not hibernated when nobody opens it (it has no screen to open).
  shell(id, `dumpsys deviceidle whitelist +${KEEPER} >/dev/null; cmd appops set ${KEEPER} RUN_ANY_IN_BACKGROUND allow; cmd appops set ${KEEPER} AUTO_REVOKE_PERMISSIONS_IF_UNUSED ignore`);
  shell(id, `am broadcast -a ${KEEPER}.ARM -n ${KEEPER}/.Receiver`);
  return id;
}

/** `wifi --off`: take the keeper off the phone and turn Wireless debugging off. Returns { id, removed }. */
export function removeKeeper(device = null) {
  const id = anyPhone(device);
  const removed = hasKeeper(id) && /Success/.test(run(ADB, ['-s', id, 'uninstall', KEEPER], { allowFail: true, timeout: 30000 }));
  // Over Wi-Fi this drops looktap's own connection, so it goes last.
  shell(id, 'settings put global adb_wifi_enabled 0');
  return { id, removed };
}

/**
 Connect the USB phone over Wi-Fi as well. Returns { serial, id, address, via, already? }. `tcpip`: skip Wireless
 debugging and use adb tcpip (no TLS, but works on any Android). `say` prints progress lines.
 */
export async function wifi({ device = null, tcpip = false, say = () => {} } = {}) {
  const serial = usbPhone(device);
  const already = wifiIdOf(serial);
  if (already) return { serial, id: already, already: true };
  const ip = parseWifiIp(shell(serial, 'ip -f inet addr show wlan0'), shell(serial, 'ip route'));
  if (!ip) throw new UsageError(`${serial} isn't on Wi-Fi: connect it to the same network as this computer`);
  const sdk = Number(shell(serial, 'getprop ro.build.version.sdk')) || 0;
  if (sdk >= 30 && !tcpip) {
    const r = await wirelessDebugging(serial, ip, say);
    if (r) return r;
    say('Wireless debugging did not connect; trying adb tcpip instead');
  }
  return adbTcpip(serial, ip);
}

/** Android 11+: Wireless debugging on, then the connection adb makes to it by itself (or adb connect). */
async function wirelessDebugging(serial, ip, say) {
  shell(serial, 'settings put global adb_wifi_enabled 1');
  const end = Date.now() + 30000;
  let hinted = false, service = null, connectedAt = 0;
  while (Date.now() < end) {
    const id = wifiIdOf(serial);
    if (id) return dropStale(ip, { serial, id, address: service?.address, via: 'Wireless debugging' });
    const seen = mdns().find((s) => s.type === '_adb-tls-connect._tcp' && mdnsSerial(s.name) === serial && s.address.startsWith(`${ip}:`));
    if (seen && !service) connectedAt = Date.now(); // give adb's own reconnect a few seconds first
    service = seen || service;
    if (!service && !hinted && Date.now() > end - 27000) {
      // On a network it hasn't trusted yet the phone asks first, and switches it back off when told no.
      say('on the phone: accept "Allow wireless debugging on this network?" (tick "Always allow")');
      hinted = true;
    }
    if (hinted && !service && shell(serial, 'settings get global adb_wifi_enabled') !== '1') return null;
    // adb connects to a paired phone's service by itself within seconds; if it hasn't, ask it to.
    if (service && Date.now() - connectedAt > 5000) {
      const out = run(ADB, ['connect', service.address], { allowFail: true, timeout: 10000 });
      if (/failed to authenticate|unauthorized|refused/i.test(out)) return null;
      connectedAt = Date.now();
    }
    await sleep(1000);
  }
  return null;
}

/** Forget the phone's old Wi-Fi connections adb still lists as offline (an earlier port on the same address). */
function dropStale(ip, result) {
  for (const d of adbList()) if (d.state === 'offline' && d.id.startsWith(`${ip}:`)) run(ADB, ['disconnect', d.id], { allowFail: true, timeout: 5000 });
  return result;
}

/** Any Android: adbd listens on TCP 5555 (until the phone restarts), and adb connects to it. */
async function adbTcpip(serial, ip) {
  const address = `${ip}:${TCPIP_PORT}`;
  run(ADB, ['-s', serial, 'tcpip', String(TCPIP_PORT)], { timeout: 15000 });
  const end = Date.now() + 20000;
  let last = '';
  while (Date.now() < end) {
    await sleep(1000);
    last = run(ADB, ['connect', address], { allowFail: true, timeout: 10000 }).trim();
    if (adbList().some((d) => d.id === address && d.state === 'device')) return dropStale(ip, { serial, id: address, address, via: 'adb tcpip' });
  }
  throw new UsageError(`couldn't reach ${serial} at ${address} over Wi-Fi (adb: ${last || 'no answer'}) — is this computer on the same network?`);
}

/**
 Pair with a phone over Wi-Fi alone: Developer options → Wireless debugging → Pair device with pairing code. `address`
 (host:port on that screen) is optional: found over mDNS when left out. Returns { address, id }.
 */
export async function pair(code, address = null, { say = () => {} } = {}) {
  if (!/^\d{6}$/.test(code || '')) throw new UsageError('usage: looktap pair <6-digit code> [host:port] — the code on the phone: Developer options → Wireless debugging → Pair device with pairing code');
  if (address && !/^[\w.-]+:\d+$/.test(address)) throw new UsageError(`${address} isn't host:port, e.g. 192.168.1.15:37199 (shown under the code)`);
  if (!address) {
    const end = Date.now() + 20000;
    let found = [];
    while (Date.now() < end && !found.length) {
      found = mdns().filter((s) => s.type === '_adb-tls-pairing._tcp');
      if (!found.length) await sleep(1000);
    }
    if (!found.length) throw new UsageError("found no phone showing a pairing code on this network: keep the code on screen, or pass the host:port under it");
    if (found.length > 1) throw new UsageError(`${found.length} phones are showing a pairing code — pass the host:port under the code: ${found.map((s) => s.address).join(', ')}`);
    address = found[0].address;
  }
  const before = new Set(adbList().filter((d) => d.state === 'device').map((d) => d.id));
  const out = run(ADB, ['pair', address, code], { allowFail: true, timeout: 30000 }).trim();
  if (!/success/i.test(out)) throw new UsageError(`pairing with ${address} failed (adb: ${out.split('\n').pop() || 'no answer'}) — check the code; it changes each time the screen opens`);
  say(`paired with ${address}`);
  // adb then connects to the phone's Wireless debugging service by itself; if it doesn't, connect to the one on that host.
  const host = address.replace(/:\d+$/, '');
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    const id = adbList().find((d) => d.state === 'device' && overWifi(d.id) && !before.has(d.id))?.id;
    if (id) return { address, id };
    const service = mdns().find((s) => s.type === '_adb-tls-connect._tcp' && s.address.startsWith(`${host}:`));
    if (service) run(ADB, ['connect', service.address], { allowFail: true, timeout: 10000 });
    await sleep(1500);
  }
  return { address, id: null };
}

/** `connect`'s address → the adb id: host:port, port 5555 when left out. Null if it isn't a host. */
export function connectId(address) {
  const m = /^([\w.-]+)(?::(\d{1,5}))?$/.exec(address || '');
  return m ? `${m[1]}:${m[2] || TCPIP_PORT}` : null;
}

/** What `adb connect` printing this means: null when it connected (or is waiting), else what to do. */
export function connectFailure(out, id) {
  if (/no route to host/i.test(out))
    return `this computer reaches ${id}, but adb can't ("No route to host"): on macOS the adb server isn't allowed on the local network. Allow your terminal in System Settings → Privacy & Security → Local Network, then restart adb (adb kill-server) and run looktap connect again`;
  if (/refused/i.test(out)) return `${id} refused the connection: debugging over Wi-Fi is off on the device, or that isn't its port (its debugging screen shows the address)`;
  if (/timed out|unreachable|unknown host|cannot resolve/i.test(out)) return `can't reach ${id}: is the device on the same Wi-Fi as this computer? A watch turns Wi-Fi down while its screen is off: wake it`;
  return null;
}

/** Whether a TCP connection to host:port opens: 'open', 'refused', or 'unreachable' (no answer in `ms`). */
function tcpReach(host, port, ms = 3000) {
  return new Promise((done) => {
    const s = netConnect({ host, port });
    const end = (r) => (s.destroy(), done(r));
    s.setTimeout(ms, () => end('unreachable'));
    s.once('connect', () => end('open'));
    s.once('error', (e) => end(e.code === 'ECONNREFUSED' ? 'refused' : 'unreachable'));
  });
}

/**
 `connect <host[:port]>`: a device whose debugging screen shows an address but no pairing code: a Wear OS watch's
 "Debug over Wi-Fi" (Galaxy Watch 4 and others like it), or a phone after adb tcpip. Port 5555 when left out. Waits
 (up to `wait` ms) for the device to be allowed: "Allow debugging?" on its screen. Returns { id, already }.
 */
export async function connect(address, { say = () => {}, wait = 60000 } = {}) {
  const id = connectId(address);
  if (!id) throw new UsageError('usage: looktap connect <host[:port]> — the address on the device\'s debugging screen (Developer options → Debug over Wi-Fi), e.g. 192.168.1.96:5555');
  const [host, port] = [id.replace(/:\d+$/, ''), Number(id.split(':').pop())];
  const state = () => adbList().find((d) => d.id === id)?.state;
  if (state() === 'device') return { id, already: true };
  // An entry left from before (offline since the device restarted or slept) keeps a fresh connect from starting.
  if (state()) run(ADB, ['disconnect', id], { allowFail: true, timeout: 5000 });
  const reach = await tcpReach(host, port);
  if (reach === 'refused') throw new UsageError(connectFailure('Connection refused', id));
  if (reach !== 'open') throw new UsageError(connectFailure('timed out', id));
  // adb connect waits while the device shows "Allow debugging?", so a timeout here isn't a failure.
  const problem = connectFailure(run(ADB, ['connect', id], { allowFail: true, timeout: 15000 }), id);
  if (problem) throw new UsageError(problem);
  const end = Date.now() + wait;
  let asked = false;
  while (Date.now() < end) {
    const s = state();
    if (s === 'device') return { id, already: false };
    if (!asked) {
      say('accept "Allow debugging?" on the device: wake its screen, tick "Always allow from this computer", tap OK');
      asked = true;
    }
    if (!s) run(ADB, ['connect', id], { allowFail: true, timeout: 15000 });
    await sleep(1000);
  }
  throw new UsageError(
    state() === 'unauthorized'
      ? `${id} is still waiting for "Allow debugging?" on its screen: accept it, then run looktap connect again`
      : `adb didn't finish connecting to ${id}. If adb itself has stalled (looktap devices hangs too), restart it with adb kill-server, then run looktap connect again`,
  );
}
