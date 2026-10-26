// What Xcode does to an iPhone through CoreDevice, done through lockdown's own services instead: so looktap can use
// an iPhone Xcode no longer supports (iOS 16 and older on Xcode 27). Developer Mode (AMFI), the developer disk image
// (mobile_image_mounter), apps (installation_proxy), processes, screenshots and location (instruments over DTX, from
// the developer image), and crash reports (crashreportcopymobile).
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afc } from './afc.js';
import { INSTRUMENTS, I32, dtxService } from './dtx.js';
import { deviceValues, lockdown, lockdownService, plistService } from './lockdown.js';
import { muxDevices } from './usbmux.js';
import { HOME, run, sleep } from './util.js';

// ── Developer Mode ─────────────────────────────────────────────────────────

/** Developer Mode: true on, false off (null when the device has none: before iOS 16). */
export async function developerMode(udid) {
  const l = await lockdown(udid);
  try {
    const v = await l.values('DeveloperModeStatus', 'com.apple.security.mac.amfi').catch(() => null);
    return typeof v === 'boolean' ? v : null;
  } finally {
    l.close();
  }
}

/**
 Ask AMFI to `reveal` the Developer Mode switch in Settings (it appears only once something has prepared the phone,
 which Xcode does when it supports the phone), to `enable` it (works only without a passcode; the phone restarts), or to
 `accept` the prompt that follows the restart.
 */
export async function amfi(udid, action) {
  const ch = await plistService(udid, 'com.apple.amfi.lockdown');
  try {
    const r = await ch.ask({ action: { reveal: 0, enable: 1, accept: 2 }[action] }, 20000);
    if (r.Error) throw new Error(`the device refused to ${action} Developer Mode: ${r.Error}`);
    return r;
  } finally {
    ch.close();
  }
}

/**
 Turn Developer Mode on without anyone touching the phone, as Xcode would: AMFI's `enable` sets it and restarts the
 phone, and `accept` (once it's back) answers the "Turn On Developer Mode?" prompt. AMFI allows this only on a phone
 without a passcode; on one with a passcode this returns false having changed nothing, and someone has to flip the
 switch in Settings. True once the mode is on.
 */
export async function enableDeveloperMode(udid, { log = () => {}, timeout = 240000 } = {}) {
  const l = await lockdown(udid);
  let passcode;
  try {
    passcode = await l.values('PasswordProtected').catch(() => null);
  } finally {
    l.close();
  }
  if (passcode !== false) return false;
  log('turning on Developer Mode: the iPhone restarts (about a minute)');
  await amfi(udid, 'enable');
  const until = Date.now() + timeout;
  // Gone from usbmuxd (or lockdown stops answering) while it restarts, then back.
  const down = Date.now() + 30000;
  while (Date.now() < down && (await lockdownUp(udid))) await sleep(1000);
  while (Date.now() < until && !(await lockdownUp(udid))) await sleep(2000);
  // AMFI comes up a little after lockdown: answer the prompt as soon as it takes the answer.
  let last;
  while (Date.now() < until) {
    await amfi(udid, 'accept').catch((e) => (last = e));
    if (await developerMode(udid).catch(() => false)) return true;
    await sleep(2000);
  }
  throw new Error(`the iPhone didn't come back with Developer Mode on${last ? ` (${last.message})` : ''}: on the phone, tap Turn On if it asks, or turn it on in Settings → Privacy & Security → Developer Mode`);
}

/** Whether the phone is on usbmuxd and its lockdown takes a session (false while it restarts). */
async function lockdownUp(udid) {
  if (!(await muxDevices().catch(() => [])).some((d) => d.udid === udid)) return false;
  try {
    (await lockdown(udid, 2000)).close();
    return true;
  } catch {
    return false;
  }
}

// ── developer disk image ───────────────────────────────────────────────────

const DDI_URL = 'https://raw.githubusercontent.com/doronz88/DeveloperDiskImage/main/DeveloperDiskImages';

/** A developer disk image is mounted (the developer services exist only then). */
export async function ddiMounted(udid) {
  const ch = await plistService(udid, 'com.apple.mobile.mobile_image_mounter');
  try {
    const r = await ch.ask({ Command: 'LookupImage', ImageType: 'Developer' }, 10000);
    const sig = r.ImageSignature;
    return Array.isArray(sig) ? sig.length > 0 : Boolean(sig);
  } finally {
    ch.close();
  }
}

/**
 The developer disk image for iOS `version` ("16.7.12"): { image, signature } paths. From Xcode when it still ships one
 (Xcode 14 and older), else from looktap's cache, else downloaded once (the images Xcode shipped, as collected in
 github.com/doronz88/DeveloperDiskImage). Tries the device's minor version first, then older minors.
 */
export async function findDDI(version, { log = () => {} } = {}) {
  const [major, minor = 0] = version.split('.').map(Number);
  const dev = run('xcode-select', ['-p'], { allowFail: true }).trim();
  for (let m = minor; m >= 0; m--) {
    const v = `${major}.${m}`;
    for (const dir of [dev && join(dev, 'Platforms/iPhoneOS.platform/DeviceSupport', v), join(HOME, 'ddi', v)].filter(Boolean)) {
      const image = join(dir, 'DeveloperDiskImage.dmg');
      if (existsSync(image) && existsSync(`${image}.signature`)) return { image, signature: `${image}.signature`, version: v };
    }
  }
  for (let m = minor; m >= 0; m--) {
    const v = `${major}.${m}`;
    const get = async (name) => {
      const r = await fetch(`${DDI_URL}/${v}/${name}`);
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`downloading the iOS ${v} developer disk image failed: HTTP ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    };
    log(`downloading the iOS ${v} developer disk image (once)…`);
    const signature = await get('DeveloperDiskImage.dmg.signature');
    if (!signature) continue;
    const image = await get('DeveloperDiskImage.dmg');
    if (!image) continue;
    const dir = join(HOME, 'ddi', v);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'DeveloperDiskImage.dmg');
    writeFileSync(`${path}.tmp`, image);
    renameSync(`${path}.tmp`, path);
    writeFileSync(`${path}.signature`, signature);
    return { image: path, signature: `${path}.signature`, version: v };
  }
  throw new Error(`no developer disk image for iOS ${major}.x: none in Xcode, ${join(HOME, 'ddi')} or ${DDI_URL}`);
}

/** Mount the developer disk image for the device's iOS, unless one is. Returns false when one already was. */
export async function mountDDI(udid, { log = () => {} } = {}) {
  if (await ddiMounted(udid)) return false;
  const l = await lockdown(udid);
  let version;
  try {
    version = await l.values('ProductVersion');
  } finally {
    l.close();
  }
  if (parseInt(version, 10) >= 17) throw new Error(`iOS ${version} uses a personalized developer image: let Xcode prepare the device (open Xcode → Window → Devices and Simulators)`);
  const ddi = await findDDI(version, { log });
  const image = readFileSync(ddi.image), signature = readFileSync(ddi.signature);
  const ch = await plistService(udid, 'com.apple.mobile.mobile_image_mounter');
  try {
    let r = await ch.ask({ Command: 'ReceiveBytes', ImageType: 'Developer', ImageSize: image.length, ImageSignature: signature }, 20000);
    if (r.Status !== 'ReceiveBytesAck') throw new Error(`the device won't take the developer image: ${r.Error || r.Status}`);
    ch.sock.write(image);
    r = await ch.next(120000);
    if (r.Status !== 'Complete') throw new Error(`the developer image didn't arrive: ${r.Error || r.Status}`);
    r = await ch.ask({ Command: 'MountImage', ImageType: 'Developer', ImageSignature: signature }, 60000);
    if (/Developer mode is not enabled/i.test(r.DetailedError || '')) throw new Error('Developer Mode is off: turn it on first (Settings → Privacy & Security → Developer Mode)');
    if (r.Status !== 'Complete' && !/already mounted/i.test(r.DetailedError || '')) throw new Error(`the device didn't mount the developer image: ${r.DetailedError || r.Error || r.Status}`);
  } finally {
    ch.close();
  }
  return true;
}

// ── apps ───────────────────────────────────────────────────────────────────

const APP_ATTRS = ['CFBundleIdentifier', 'CFBundleExecutable', 'CFBundleDisplayName', 'CFBundleName', 'CFBundleShortVersionString', 'CFBundleVersion', 'Path', 'Container', 'ApplicationType'];

/** Installed apps as installation_proxy lists them (all of them, or `ids`): [{ CFBundleIdentifier, Path, … }]. */
export async function installedApps(udid, { all = true, ids } = {}) {
  const ch = await plistService(udid, 'com.apple.mobile.installation_proxy');
  try {
    const opts = { ApplicationType: all ? 'Any' : 'User', ReturnAttributes: APP_ATTRS, ...(ids && { BundleIDs: ids }) };
    if (ids) {
      const r = await ch.ask({ Command: 'Lookup', ClientOptions: opts }, 30000);
      return Object.values(r.LookupResult || {});
    }
    ch.send({ Command: 'Browse', ClientOptions: opts });
    const apps = [];
    for (;;) {
      const r = await ch.next(30000);
      if (r.CurrentList) apps.push(...r.CurrentList);
      if (r.Error) throw new Error(`listing the apps failed: ${r.Error}`);
      if (r.Status === 'Complete') return apps;
    }
  } finally {
    ch.close();
  }
}

/** Wait out an installation_proxy command's progress messages; throws its error. */
async function finish(ch, what) {
  for (;;) {
    const r = await ch.next(300000);
    if (r.Error) throw Object.assign(new Error(`${what} failed: ${r.ErrorDescription || r.Error}`), { code: r.Error });
    if (r.Status === 'Complete') return;
  }
}

/** Install an .app (signed for this device) or .ipa: uploaded to the phone's staging folder, then installed. */
export async function installApp(udid, path) {
  const name = basename(path.replace(/\/$/, ''));
  const staged = `PublicStaging/${name}`;
  const files = await afc(udid);
  try {
    await files.mkdir('PublicStaging').catch(() => {});
    await files.removeAll(staged);
    if (statSync(path).isDirectory()) await files.upload(path, staged);
    else await files.write(staged, readFileSync(path));
  } finally {
    files.close();
  }
  const ch = await plistService(udid, 'com.apple.mobile.installation_proxy');
  try {
    ch.send({ Command: 'Install', PackagePath: staged, ClientOptions: name.endsWith('.app') ? { PackageType: 'Developer' } : {} });
    await finish(ch, 'install');
  } finally {
    ch.close();
  }
}

export async function uninstallApp(udid, id) {
  const ch = await plistService(udid, 'com.apple.mobile.installation_proxy');
  try {
    ch.send({ Command: 'Uninstall', ApplicationIdentifier: id });
    await finish(ch, `uninstalling ${id}`);
  } finally {
    ch.close();
  }
}

// ── instruments: processes, screenshots ─────────────────────────────────────

/** One call on an instruments service, on a connection of its own. */
async function instruments(udid, service, fn) {
  const d = await dtxService(udid, INSTRUMENTS);
  try {
    return await fn(d, await d.open(service));
  } finally {
    d.close();
  }
}

/** Running processes: [{ pid, name, realAppName (the executable's path), isApplication }]. */
export function processes(udid) {
  return instruments(udid, 'com.apple.instruments.server.services.deviceinfo', (d, ch) => d.call(ch, 'runningProcesses'));
}

/** A screenshot, as PNG. */
export function screenshot(udid) {
  return instruments(udid, 'com.apple.instruments.server.services.screenshot', (d, ch) => d.call(ch, 'takeScreenshot'));
}

export function killProcess(udid, pid) {
  return instruments(udid, 'com.apple.instruments.server.services.processcontrol', (d, ch) => d.call(ch, 'killPid:', [new I32(pid)], { reply: false }));
}

// ── location ──────────────────────────────────────────────────────────────

/** Pretend to be at lat, lon (the phone's apps see it until clearLocation or a restart); null clears it. */
export async function simulateLocation(udid, lat, lon) {
  const sock = await lockdownService(udid, 'com.apple.dt.simulatelocation');
  const u32 = (n) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n);
    return b;
  };
  const str = (s) => Buffer.concat([u32(Buffer.byteLength(s)), Buffer.from(s)]);
  const msg = lat == null ? u32(1) : Buffer.concat([u32(0), str(String(lat)), str(String(lon))]);
  await new Promise((resolve) => sock.end(msg, resolve));
  sock.destroy();
}

// ── crash reports ──────────────────────────────────────────────────────────

/**
 The phone's crash reports: [{ name, path, time (ms) }], newest first. Moves pending reports into place first (the
 crash report mover answers "ping" once it has).
 */
export async function crashReports(udid) {
  const mover = await lockdownService(udid, 'com.apple.crashreportmover');
  await new Promise((resolve) => {
    const t = setTimeout(resolve, 5000);
    mover.once('data', () => (clearTimeout(t), resolve()));
    mover.once('close', () => (clearTimeout(t), resolve()));
  });
  mover.destroy();
  const files = await afc(udid, 'com.apple.crashreportcopymobile');
  try {
    const out = [];
    for (const name of await files.list('/')) {
      if (!/\.(ips|crash)$/.test(name)) continue;
      const info = await files.info(`/${name}`);
      out.push({ name, path: `/${name}`, time: Number(BigInt(info?.st_mtime || 0) / 1000000n) });
    }
    return out.sort((a, b) => b.time - a.time);
  } finally {
    files.close();
  }
}

export async function readCrashReport(udid, path) {
  const files = await afc(udid, 'com.apple.crashreportcopymobile');
  try {
    return (await files.read(path)).toString('utf8');
  } finally {
    files.close();
  }
}


// ── iPhones only lockdown reaches ───────────────────────────────────────────

/** The major iOS version from which Xcode's CoreDevice drives a phone; older ones go through lockdown. */
export const COREDEVICE_FROM = 17;

/**
 iPhones usbmuxd can reach that are older than CoreDevice: [{ id, name, os, model, ecid, connection }], one row per phone
 (USB first). Needs the phone paired (Trust) and unlocked once since it was plugged in.
 */
export async function lockdownPhones() {
  const seen = new Map();
  for (const d of await muxDevices().catch(() => [])) {
    if (!d.udid || seen.has(d.udid)) continue;
    try {
      const v = await deviceValues(d.udid);
      if (!v.ProductVersion || parseInt(v.ProductVersion, 10) >= COREDEVICE_FROM) continue;
      seen.set(d.udid, { id: d.udid, name: v.DeviceName || 'iPhone', os: v.ProductVersion, model: v.ProductType, ecid: v.UniqueChipID, connection: d.via === 'USB' ? 'USB' : 'Wi-Fi' });
    } catch {}
  }
  return [...seen.values()];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv[2] === '--phones') {
  // For callers that can't wait on a promise (choosing a device): node devservices.js --phones → JSON.
  lockdownPhones().then((l) => (console.log(JSON.stringify(l)), process.exit(0)));
}
