// Physical iPhone/iPad driver. The simulator path (lib/ios.js) installs nothing; a real device has no such
// back door, so here looktap installs its own XCUITest runner (native/ios-device) on first use and talks
// to it over usbmuxd. Reading the screen, tapping, typing and screenshots go through the runner; installing
// apps goes through `xcrun devicectl`. Commands the device can't support say so.
//
// An iPhone older than CoreDevice (iOS 16 and before) is one Xcode 27 no longer drives: for it ("lockdown" mode)
// looktap does Xcode's part itself through lockdown's services (lib/devservices.js): it mounts the developer disk
// image, installs apps, and starts the runner over testmanagerd (lib/xctest.js) instead of xcodebuild.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { unsupported } from './capabilities.js';
import { collectorStatus, readCollected } from './devicelog.js';
import { COREDEVICE_FROM, amfi, crashReports, ddiMounted, developerMode, enableDeveloperMode, installApp, installedApps, mountDDI, processes, readCrashReport, simulateLocation, uninstallApp } from './devservices.js';
import { Helper } from './helper.js';
import { Ios, SIM_BIN, appVersion, summariseIps } from './ios.js';
import { deviceValues } from './lockdown.js';
import { feedFrames, feedSamples, xctraceRows } from './perf.js';
import { patchRunnerHost } from './runnerpatch.js';
import { muxDevices, muxOpen } from './usbmux.js';
import { HOME, LockedError, UsageError, readJson, run, shotPath, sleep } from './util.js';

const PORT = 22087;
const PROJECT_DIR = new URL('../native/ios-device/', import.meta.url).pathname;
const PROJECT = join(PROJECT_DIR, 'LooktapRunner.xcodeproj');
/** Holds a lockdown phone's test session, as xcodebuild does for the others. */
const XCTEST = new URL('./xctest.js', import.meta.url).pathname;
// runnerpatch.js finishes the built app (icon, name, older iOS), so it counts as a source too.
const SOURCES = ['LooktapRunner/Runner.swift', 'LooktapRunner.xcodeproj/project.pbxproj', '../../lib/runnerpatch.js', ...readdirSync(join(PROJECT_DIR, 'LooktapRunner/Icon')).map((f) => `LooktapRunner/Icon/${f}`)];

let runnerHash;
/** The runner's version is its sources' hash: an edited runner is rebuilt and replaces one still running. */
const runnerVersion = () =>
  (runnerHash ??= createHash('sha1').update(SOURCES.map((f) => readFileSync(join(PROJECT_DIR, f))).join('\0')).digest('hex').slice(0, 12));

let userTemp;
/** The raw traces Instruments has left in the user's temp folder (the one xctrace writes to, not TMPDIR's). */
function ktraces() {
  userTemp ??= run('getconf', ['DARWIN_USER_TEMP_DIR'], { allowFail: true }).trim() || tmpdir();
  try {
    return new Set(readdirSync(userTemp).filter((f) => /^instruments\w*\.ktrace$/.test(f)).map((f) => join(userTemp, f)));
  } catch {
    return new Set();
  }
}

/** devicectl's JSON for a subcommand (also when it fails: then it carries `error`), or null. */
function devicectl(args, { timeout = 30000 } = {}) {
  const out = join(tmpdir(), `looktap-devicectl-${process.pid}-${Date.now()}.json`);
  try {
    run('xcrun', ['devicectl', ...args, '--json-output', out, '-q'], { allowFail: true, timeout });
    return existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : null;
  } catch {
    return null;
  } finally {
    rmSync(out, { force: true });
  }
}

/**
 What went wrong, from devicectl's JSON: each error in the chain from the outside in (the innermost is the cause,
 e.g. "not enough storage"), with the last recovery suggestion. Empty when there's no error.
 */
export function devicectlError(r) {
  const said = [];
  let advice = '';
  for (let e = r?.error; e; e = e.userInfo?.NSUnderlyingError?.error) {
    const u = e.userInfo || {};
    for (const k of ['NSLocalizedDescription', 'NSLocalizedFailureReason']) {
      const text = u[k]?.string?.trim();
      if (text && !said.includes(text)) said.push(text);
    }
    advice = u.NSLocalizedRecoverySuggestion?.string?.trim() || advice;
  }
  // The outermost description only restates the command ("Failed to install the app on the device."): keep it only alone.
  const why = said.length > 1 ? said.slice(1) : said;
  return [...why, advice].filter(Boolean).join(' ');
}

/** Every device devicectl knows: paired, connected, or seen before. */
export function devicectlList() {
  return devicectl(['list', 'devices'], { timeout: 10000 })?.result?.devices || [];
}

/** Real iPhones a command can drive: CoreDevice's, then the older ones only lockdown reaches (lockdown: true). */
export function physicalDevices() {
  const list = devicectlList()
    .filter((d) => d.hardwareProperties?.reality === 'physical' && d.hardwareProperties?.platform === 'iOS')
    .filter((d) => d.connectionProperties?.pairingState === 'paired' && d.connectionProperties?.tunnelState !== 'unavailable')
    .map((d) => ({ id: d.hardwareProperties.udid, name: d.deviceProperties?.name || 'iPhone', os: d.deviceProperties?.osVersionNumber }));
  for (const p of lockdownPhones()) if (!list.some((d) => d.id === p.id)) list.push({ ...p, lockdown: true });
  return list;
}

/**
 iPhones older than CoreDevice that usbmuxd reaches (lib/devservices.js): [{ id, name, os, model, connection }].
 Asked of a child process, since choosing a device can't wait on a socket (~0.1 s).
 */
export function lockdownPhones() {
  const script = new URL('./devservices.js', import.meta.url).pathname;
  try {
    return JSON.parse(run(process.execPath, [script, '--phones'], { allowFail: true, timeout: 15000 }) || '[]');
  } catch {
    return [];
  }
}

/** The phone shows its lock screen (a passcode is needed); null when devicectl can't tell (~1 s). */
export function deviceLocked(udid) {
  const r = devicectl(['device', 'info', 'lockState', '--device', udid], { timeout: 15000 })?.result;
  return r ? r.passcodeRequired === true : null;
}

/** Xcode's major version (27), or 0. */
function xcodeMajor() {
  return Number(/Xcode (\d+)/.exec(run('xcodebuild', ['-version'], { allowFail: true }))?.[1] || 0);
}

/** Teams signed in to Xcode: [{ id, name, free }]. */
function xcodeTeams() {
  const out = run('defaults', ['read', 'com.apple.dt.Xcode', 'IDEProvisioningTeamByIdentifier'], { allowFail: true });
  const teams = new Map();
  for (const m of out.matchAll(/isFreeProvisioningTeam = (\d);[\s\S]*?teamID = (\w+);\s*teamName = "?([^";\n]+)"?;/g))
    teams.set(m[2], { id: m[2], name: m[3], free: m[1] === '1' });
  return [...teams.values()];
}

/** xcodebuild's words for a runner iOS won't launch because of its signing or profile. */
const SIGNING_FAILURE = /profile (has )?expired|provisioning profile|no longer valid|invalid code signature|code signature|0xe8008012|0xe800801c|0xe8008016|A valid provisioning profile/i;

class SigningError extends UsageError {}

/** XCTest's answer once a test session may no longer drive the UI (XCTDaemonErrorDomain 41). */
const NOT_AUTHORIZED = /Not authorized for performing UI testing actions|XCTDaemonErrorDomain Code=41/;
/** Runner errors a locked device gives: worth checking the lock before anything else. */
const MAYBE_LOCKED = /Not authorized for performing UI testing actions|XCTDaemonErrorDomain Code=41|Lost connection to the application|timed out/;

/** When the built runner's provisioning profile expires (ms), or 0 when it can't be read. */
export function profileExpires(products) {
  const app = existsSync(products) && readdirSync(products, { recursive: true }).find((f) => String(f).endsWith('-Runner.app/embedded.mobileprovision'));
  if (!app) return 0;
  const xml = run('security', ['cms', '-D', '-i', join(products, String(app))], { allowFail: true });
  return expiryOf(xml);
}

/** The ExpirationDate of a decoded provisioning profile (XML plist), in ms; 0 when absent. */
export function expiryOf(xml) {
  const m = /<key>ExpirationDate<\/key>\s*<date>([^<]+)<\/date>/.exec(xml || '');
  return m ? Date.parse(m[1]) || 0 : 0;
}

/** A TCP socket to `host`:`port`; rejects when it can't connect within `timeout`. */
function tcpOpen(host, port, timeout) {
  return new Promise((resolve, reject) => {
    const sock = connect({ host, port });
    const timer = setTimeout(() => (sock.destroy(), reject(new Error('timed out'))), timeout);
    sock.once('error', (e) => (clearTimeout(timer), reject(new Error(e.code || e.message))));
    sock.once('connect', () => (clearTimeout(timer), sock.removeAllListeners('error'), resolve(sock)));
  });
}

/** XCTest's line once the runner's test method runs, so its server is listening; and once it's over. */
const RUNNER_UP = /Test Case '-\[\S+ testServe\]' started/;
const RUNNER_DONE = /Test Case '-\[\S+ testServe\]' (passed|failed)/;

/** How long a runner that is up may go unreached before looktap says why, instead of waiting minutes. */
const REACH_MS = 20000;

export class IosDevice extends Ios {
  kind = 'ios-device';

  constructor(udid, { out, app, wait = 0, team }) {
    super(udid, { out, app, wait });
    this.physical = true;
    this.team = team;
    this.dir = join(HOME, 'device', udid);
    this.log = join(this.dir, 'runner.log');
    this.pidFile = join(this.dir, 'xcodebuild.pid');
  }

  /** The iOS version when the phone is older than CoreDevice, so looktap drives it through lockdown; else null. */
  async lockdownOs() {
    if (this._lockdownOs === undefined) {
      const v = await deviceValues(this.udid).catch(() => null);
      this._lockdownOs = v?.ProductVersion && parseInt(v.ProductVersion, 10) < COREDEVICE_FROM ? v.ProductVersion : null;
    }
    return this._lockdownOs;
  }

  /** The runner's bundle id on the device, as built for `team`. */
  runnerId(team) {
    return `dev.looktap.runner.${team}.xctrunner`;
  }

  /**
   The ways to the runner's port, best first: usbmuxd over USB when the cable is in; the CoreDevice tunnel, which is
   how Xcode itself reaches a phone on Wi-Fi (and what started the runner); usbmuxd's own Wi-Fi route, which a network
   can block while the tunnel works. Each is { route, via, open(timeout) }.
   */
  async routes() {
    const mux = await muxDevices().then((l) => l.filter((d) => d.udid === this.udid), () => []);
    const list = mux.filter((d) => d.via === 'USB').map((d) => ({ route: 'USB', via: 'USB', open: (t) => muxOpen(d, PORT, t) }));
    const cp = devicectlList().find((x) => x.hardwareProperties?.udid === this.udid)?.connectionProperties;
    if (cp?.tunnelState === 'connected' && cp.tunnelIPAddress) {
      const via = cp.transportType === 'wired' ? 'USB' : 'Wi-Fi';
      list.push({ route: `CoreDevice tunnel (${via})`, via, open: (t) => tcpOpen(cp.tunnelIPAddress, PORT, t) });
    }
    for (const d of mux.filter((d) => d.via !== 'USB')) list.push({ route: 'usbmuxd Wi-Fi', via: 'Wi-Fi', open: (t) => muxOpen(d, PORT, t) });
    return list;
  }

  /**
   The runner, if one of this version answers on some route: a Helper with `via` and `route` set, else null. One of
   another version is stopped. `this.unreached` says why each route failed, for the error that follows, and
   `this.connected` whether any route got through to the phone (then the runner is busy or stuck, not out of reach).
   */
  async hello() {
    const tried = [];
    this.connected = false;
    const routes = await this.routes();
    if (!routes.length) tried.push('no way to the phone: it is not on USB, and neither the CoreDevice tunnel nor usbmuxd reaches it over Wi-Fi');
    for (const r of routes) {
      let h;
      try {
        h = Object.assign(new Helper(await r.open(2000)), { via: r.via, route: r.route });
        this.connected = true;
        const v = await h.call('hello', {}, { timeout: 3000 });
        if (v.version === runnerVersion()) return (this.unreached = null), h;
        await h.call('stop').catch(() => {});
        h.close();
        this.stopXcodebuild();
        await sleep(1000);
        return null;
      } catch (e) {
        h?.close();
        tried.push(`${r.route}: ${h ? 'connected, but the runner did not answer' : e.message}`);
      }
    }
    this.unreached = tried;
    return null;
  }

  /** The runner's log says its server is up (and its test hasn't ended). */
  runnerUp() {
    const text = existsSync(this.log) ? readFileSync(this.log, 'utf8') : '';
    return RUNNER_UP.test(text) && !RUNNER_DONE.test(text);
  }

  /** The error for a runner that is up on the phone but that the Mac can't reach: what was tried, and what to do. */
  unreachable() {
    const wifi = !this.unreached?.some((t) => /^USB|\(USB\)/.test(t));
    return new UsageError(
      `the runner is running on the phone (its log shows testServe started), but the Mac can't reach it${wifi ? ' over Wi-Fi' : ''}: ${(this.unreached || []).join('; ') || 'no answer'}. ` +
        (wifi
          ? 'Plug in a USB cable (looktap switches to it by itself), or check that the Mac and the phone are on the same network with no client isolation, VPN or firewall between them'
          : 'Unplug and replug the cable') +
        ', or start it afresh with looktap teardown' +
        ` — looktap doctor -d ${this.udid} checks each way (log: ${this.log})`,
    );
  }

  /** The signing team: --team / LOOKTAP_TEAM / config, else the only team signed in to Xcode. */
  signingTeam() {
    if (this.team) return this.team;
    const teams = xcodeTeams();
    if (teams.length === 1) return teams[0].id;
    const list = teams.map((t) => `${t.id} (${t.name}${t.free ? ', free' : ''})`).join(', ');
    throw new UsageError(
      teams.length
        ? `looktap installs a small XCUITest runner on real devices and needs a team to sign it. Pick one of: ${list} — then pass LOOKTAP_TEAM=<id>, or put {"ios": {"team": "<id>"}} in looktap.config.json`
        : 'looktap installs a small XCUITest runner on real devices and needs a signing team: sign in to Xcode (Settings → Accounts) with your Apple ID',
    );
  }

  /**
   Build the runner for this device and team, once per version. Returns its .xctestrun file, or for a phone driven
   through lockdown (`os`: its iOS version) the runner app, made to start on that iOS (lib/runnerpatch.js).
   */
  build(team, os = null) {
    const derived = join(this.dir, `build-${runnerVersion()}-${team}${os ? `-ios${parseInt(os, 10)}` : ''}`);
    const products = join(derived, 'Build', 'Products');
    const find = () => {
      const f = existsSync(products) && readdirSync(products, { recursive: true }).map(String).find((x) => (os ? x.endsWith('-Runner.app') : x.endsWith('.xctestrun')));
      return f ? join(products, f) : null;
    };
    const have = find();
    // A free team's signing lasts 7 days, a paid team's a year: rebuild before it lapses, not after.
    if (have && profileExpires(products) > Date.now() + 3600e3 && (!os || this.profileHasDevice(have))) return have;
    this.clearBuilds();
    console.error('looktap: building the XCUITest runner for this device (once per looktap version, about a minute)…');
    // Xcode can't name a device it doesn't support, so a lockdown phone's runner is built for any iPhone.
    const out = run('xcodebuild', ['build-for-testing', '-project', PROJECT, '-scheme', 'LooktapRunner', '-destination', os ? 'generic/platform=iOS' : `id=${this.udid}`,
      '-derivedDataPath', derived, '-allowProvisioningUpdates', `DEVELOPMENT_TEAM=${team}`, `PRODUCT_BUNDLE_IDENTIFIER=dev.looktap.runner.${team}`],
      { allowFail: true, timeout: 600000 });
    const built = find();
    if (!built) {
      const why = out.split('\n').filter((l) => /error:/.test(l)).slice(0, 3).join('\n  ') || out.trim().split('\n').slice(-3).join('\n  ');
      throw new UsageError(`could not build the runner (team ${team}):\n  ${why}`);
    }
    if (os && !this.profileHasDevice(built)) throw this.unregistered(team, built);
    // The host app xcodebuild installs sits next to the .xctestrun; a lockdown phone's build is that app itself.
    const host = os ? built : readdirSync(products, { recursive: true }).map(String).find((x) => x.endsWith('-Runner.app'));
    if (host) patchRunnerHost(os ? host : join(products, host), os);
    return built;
  }

  /** The runner app's provisioning profile lists this phone (a development profile must, or iOS won't install it). */
  profileHasDevice(app) {
    const xml = run('security', ['cms', '-D', '-i', join(app, 'embedded.mobileprovision')], { allowFail: true });
    return !/<key>ProvisionedDevices<\/key>/.test(xml) || xml.includes(`<string>${this.udid}</string>`);
  }

  /**
   The error for a runner whose profile leaves this phone out. Xcode registers a phone with the team only when it
   supports it, so a lockdown phone has to be added by hand; and Xcode keeps reusing a cached profile made before
   that, so looktap moves the cached profiles for the runner aside (to ~/.looktap/old-profiles) for the next build.
   */
  unregistered(team, app) {
    const cache = join(homedir(), 'Library/Developer/Xcode/UserData/Provisioning Profiles');
    const aside = join(HOME, 'old-profiles');
    const moved = [];
    for (const f of existsSync(cache) ? readdirSync(cache) : []) {
      if (!f.endsWith('.mobileprovision')) continue;
      const xml = run('security', ['cms', '-D', '-i', join(cache, f)], { allowFail: true });
      const appId = /<key>application-identifier<\/key>\s*<string>([^<]+)<\/string>/.exec(xml)?.[1] || '';
      if (!appId.startsWith(`${team}.`) || !/dev\.looktap\.runner|\*$/.test(appId) || xml.includes(`<string>${this.udid}</string>`)) continue;
      mkdirSync(aside, { recursive: true });
      renameSync(join(cache, f), join(aside, f));
      moved.push(f);
    }
    this.clearBuilds();
    return new UsageError(
      `the runner's provisioning profile doesn't include this iPhone (${this.udid}). Xcode registers a phone with your team only when it supports it, and Xcode ${xcodeMajor() || ''} doesn't support iOS ${this._lockdownOs}: ` +
        `add it by hand at developer.apple.com → Certificates, IDs & Profiles → Devices (team ${team}), then run the command again` +
        (moved.length ? ` (looktap moved ${moved.length} cached profile${moved.length > 1 ? 's' : ''} made before that to ${aside}, so Xcode fetches a new one)` : ''),
    );
  }

  /** The runner, started (and installed) if needed. */
  async helper() {
    if (this._helper && this._helper.via !== 'USB' && Date.now() - (this._usbLook || 0) > 2000) {
      // Over Wi-Fi: once a cable is plugged in, move to it (a session lasts as long as an MCP server or a run script).
      this._usbLook = Date.now();
      if ((await muxDevices().catch(() => [])).some((d) => d.udid === this.udid && d.via === 'USB')) {
        this._helper.close();
        this._helper = null;
      }
    }
    if (this._helper) return this._helper;
    let h = await this.hello();
    // Up on the phone but out of reach: starting another runner wouldn't reach it either. A cable gets used at once.
    // (A route that connects but gets no answer reached the phone: the runner is stuck, and is started afresh below.)
    if (!h && !this.connected && this.xcodebuildAlive() && this.runnerUp() && !(await this.routes()).some((r) => r.via === 'USB')) throw this.unreachable();
    if (!h) {
      // A runner can't start on a locked device: say so now, rather than wait for an unlock for minutes.
      if (await this.locked()) throw new LockedError();
      const team = this.signingTeam();
      mkdirSync(this.dir, { recursive: true });
      const os = await this.lockdownOs();
      if (os) await this.prepare();
      const start = async () => (os ? this.startLockdown(this.build(team, os), team) : this.start(this.build(team)));
      try {
        h = await start();
      } catch (e) {
        // A runner whose signing lapsed (a free team's lasts 7 days) or was revoked: sign it afresh, once.
        if (!(e instanceof SigningError)) throw e;
        console.error('looktap: the runner\'s signing is no longer valid — building it again');
        this.clearBuilds();
        h = await start();
      }
    }
    return (this._helper = h);
  }

  /** Start the built runner under xcodebuild and wait until it answers. */
  async start(xctestrun) {
    this.stopXcodebuild();
    const log = openSync(this.log, 'w');
    // xcodebuild installs the runner and keeps the test session alive for as long as it runs.
    const p = spawn('xcodebuild', ['test-without-building', '-xctestrun', xctestrun, '-destination', `id=${this.udid}`], {
      detached: true,
      stdio: ['ignore', log, log],
      env: { ...process.env, TEST_RUNNER_LOOKTAP_PORT: String(PORT), TEST_RUNNER_LOOKTAP_VERSION: runnerVersion() },
    });
    p.unref();
    closeSync(log);
    writeFileSync(this.pidFile, String(p.pid));
    return this.awaitRunner();
  }

  /**
   A lockdown phone's developer services: Developer Mode on, and the developer disk image mounted. With `enable`
   (setup), a phone without a passcode gets Developer Mode turned on here, restart and all.
   */
  async prepare({ enable = false } = {}) {
    const mode = await developerMode(this.udid);
    if (mode === false) {
      const log = (m) => console.error(`looktap: ${m}`);
      if (enable && (await enableDeveloperMode(this.udid, { log }).catch((e) => { throw new UsageError(e.message); }))) {
        log('Developer Mode is on');
      } else {
        // The switch exists in Settings only once something has prepared the phone, which Xcode no longer does.
        await amfi(this.udid, 'reveal').catch(() => {});
        throw new UsageError(
          enable
            ? 'Developer Mode is off, and the iPhone has a passcode, so only someone at the phone can turn it on: open Settings → Privacy & Security → Developer Mode (looktap just made the switch appear), turn it on, let it restart and tap Turn On, then run the command again'
            : `Developer Mode is off: looktap setup -d ${this.udid} turns it on (the iPhone restarts) when the phone has no passcode; otherwise open Settings → Privacy & Security → Developer Mode on the iPhone (looktap just made the switch appear), turn it on, let it restart and tap Turn On`,
        );
      }
    }
    try {
      if (await mountDDI(this.udid, { log: (m) => console.error(`looktap: ${m}`) })) console.error('looktap: mounted the developer disk image');
    } catch (e) {
      throw new UsageError(`could not mount the developer disk image: ${e.message}`);
    }
  }

  /**
   Install the built runner on a lockdown phone (when this build isn't there yet) and start it over testmanagerd
   (lib/xctest.js, in the background: it holds the test session as xcodebuild would), then wait until it answers.
   */
  async startLockdown(app, team) {
    this.stopXcodebuild();
    const id = this.runnerId(team);
    const stamp = join(this.dir, 'installed.json');
    const build = `${runnerVersion()} ${statSync(join(app, '_CodeSignature', 'CodeResources')).mtimeMs}`;
    if (readJson(stamp, {}).runner !== build || !(await installedApps(this.udid, { ids: [id] })).length) {
      console.error('looktap: installing the runner on the device…');
      try {
        await installApp(this.udid, app);
      } catch (e) {
        if (/Verification|signature|provision|0xe80080/i.test(`${e.code} ${e.message}`)) throw new SigningError(e.message);
        throw new UsageError(`could not install the runner: ${e.message}`);
      }
      writeFileSync(stamp, JSON.stringify({ runner: build }));
    }
    const log = openSync(this.log, 'w');
    const p = spawn(process.execPath, [XCTEST, this.udid, id, `LOOKTAP_PORT=${PORT}`, `LOOKTAP_VERSION=${runnerVersion()}`], { detached: true, stdio: ['ignore', log, log] });
    p.unref();
    closeSync(log);
    writeFileSync(this.pidFile, String(p.pid));
    return this.awaitRunner();
  }

  /** Wait for the runner just started to answer, saying what went wrong when it can't. */
  async awaitRunner() {
    let lockedSince = 0, upSince = 0, automation = false;
    for (let i = 0; i < 180; i++) {
      await sleep(1000);
      const h = await this.hello();
      if (h) return h;
      const text = readFileSync(this.log, 'utf8');
      // The runner is listening on the phone: if the Mac can't reach it soon, say why rather than wait 3 minutes.
      // xcodebuild keeps it running, so a cable plugged in later reaches it without a restart.
      if (RUNNER_UP.test(text) && !this.connected) {
        upSince ||= Date.now();
        if (Date.now() - upSince > REACH_MS) throw this.unreachable();
      }
      if (/Unlock .* to Continue|device is locked/i.test(text)) {
        if (!lockedSince) {
          console.error('looktap: unlock the device — the runner starts once it is unlocked');
          lockedSince = Date.now();
        } else if (Date.now() - lockedSince > 30000) {
          // Long enough for a person to unlock it; an agent can't, so don't hold it for minutes.
          this.stopXcodebuild();
          throw new LockedError();
        }
      }
      // The first session on a phone asks for its passcode to "Enable UI Automation", and gives up after 60 s.
      if (!automation && /enabling automation mode/i.test(text) && !RUNNER_UP.test(text)) {
        automation = true;
        console.error('looktap: if the device asks for its passcode to "Enable UI Automation", enter it (once per device)');
      }
      const fail = /(not been explicitly trusted|Untrusted Developer|invalid code signature|TEST EXECUTE FAILED|Testing failed:[^\n]*\n[^\n]*)/i.exec(text);
      if (fail || !this.xcodebuildAlive()) {
        this.stopXcodebuild();
        if (/Timed out while enabling automation mode/i.test(text))
          throw new UsageError('the device asked for its passcode to "Enable UI Automation" and nobody entered it within a minute: run the command again and enter the passcode on the device when asked (once per device), or turn on Settings → Developer → Enable UI Automation first');
        if (/trusted/i.test(fail?.[0] || ''))
          throw new UsageError('the device does not trust the developer yet: on the device open Settings → General → VPN & Device Management, trust your developer app, then run the command again');
        if (/maximum number of installed apps/i.test(text)) {
          const apps = [...new Set(text.match(/"[A-Z0-9]{10}\.[\w.-]+"/g) || [])].map((s) => s.slice(12, -1));
          throw new UsageError(`a free Apple account can have only 3 of its apps on a device at once, and this one is full${apps.length ? ` (${apps.join(', ')})` : ''}: delete one from the device, then run the command again`);
        }
        if (SIGNING_FAILURE.test(text)) throw new SigningError(text);
        throw new UsageError(`the runner did not start: ${(fail?.[0] || text.trim().split('\n').pop() || 'xcodebuild exited').trim()} (log: ${this.log})`);
      }
    }
    throw new UsageError(`the runner did not answer within 3 minutes${this.unreached?.length ? `: ${this.unreached.join('; ')}` : ''} (log: ${this.log})`);
  }

  clearBuilds() {
    for (const old of existsSync(this.dir) ? readdirSync(this.dir) : []) if (old.startsWith('build-')) rmSync(join(this.dir, old), { recursive: true, force: true });
  }

  xcodebuildAlive() {
    const pid = Number(readJson(this.pidFile, 0));
    if (!pid) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  stopXcodebuild() {
    const pid = Number(readJson(this.pidFile, 0));
    if (pid && /xcodebuild|xctest\.js/.test(run('ps', ['-p', String(pid), '-o', 'command='], { allowFail: true }))) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {}
    }
    rmSync(this.pidFile, { force: true });
  }

  /**
   A runner's test session can lose its right to drive the UI and not get it back (seen after the device sat idle
   for an hour), while still answering hello. Then every call fails: start a fresh session, once, and retry. A
   refused call did nothing, so the retry can't act twice.
   */
  async call(op, args, opts) {
    try {
      return await (await this.helper()).call(op, args, opts);
    } catch (e) {
      if (MAYBE_LOCKED.test(e.message || '') && (await this.locked())) throw new LockedError();
      if (!NOT_AUTHORIZED.test(e.message || '')) throw e;
    }
    console.error('looktap: the runner lost permission to drive the device — starting a fresh one');
    await this.restartRunner();
    try {
      return await (await this.helper()).call(op, args, opts);
    } catch (e) {
      if (!NOT_AUTHORIZED.test(e.message || '')) throw e;
      throw new UsageError("the device won't let the runner drive it: unlock it, and check that Settings → Developer → Enable UI Automation is on");
    }
  }

  /** Stop the running runner and forget it, so the next call starts a new test session. */
  async restartRunner() {
    const h = this._helper || (await this.hello());
    this._helper = null;
    if (h) {
      await h.call('stop').catch(() => {});
      h.close();
    }
    this.stopXcodebuild();
    await sleep(1000);
  }

  /**
   `doctor -d`: each thing a command needs on the way to this phone, as [ok (null: just so you know), what, fix].
   Reads only: a runner of another version is reported, not stopped.
   */
  async diagnose() {
    const os = await this.lockdownOs();
    const rows = os ? await this.lockdownRows(os) : await this.coreDeviceRows();
    if (rows.length === 1 && rows[0][0] === false) return rows;
    let reached = null, connected = false;
    const failed = [];
    for (const r of await this.routes()) {
      let h;
      try {
        h = new Helper(await r.open(2000));
        connected = true;
        const v = await h.call('hello', {}, { timeout: 3000 });
        if (!reached) {
          reached = r;
          const current = v.version === runnerVersion();
          rows.push([current || null, `runner answers over ${r.route}${current ? ': commands go this way' : ', but it is an older version: the next command replaces it'}`]);
        } else rows.push([true, `runner also answers over ${r.route}`]);
      } catch (e) {
        failed.push(`${r.route}: ${h ? 'connected, but the runner did not answer' : e.message}`);
      } finally {
        h?.close();
      }
    }
    if (!reached && connected)
      rows.push([false, `the phone is reachable, but the runner doesn't answer (busy, or stuck in an earlier call): ${failed.join('; ')}`, 'the next command starts a fresh one, or looktap teardown']);
    else if (!reached && this.xcodebuildAlive() && this.runnerUp())
      rows.push([false, `the runner is up on the phone, but no way reaches it: ${failed.join('; ') || 'none to try'}`, 'plug in a USB cable; on Wi-Fi, check for client isolation, a VPN or a firewall between the Mac and the phone']);
    else if (!reached) rows.push([null, `runner: not running (${failed.length ? failed.join('; ') : 'no route to try'}) — the first command starts it, or looktap setup`]);
    else if (failed.length) rows.push([null, `not answering on: ${failed.join('; ')}`]);
    try {
      rows.push([true, `signing team for the runner: ${this.signingTeam()}`]);
    } catch (e) {
      rows.push([false, 'signing team for the runner', e.message]);
    }
    return rows;
  }

  /** doctor's rows for a phone CoreDevice drives: pairing, Developer Mode, the tunnel, usbmuxd, the lock. */
  async coreDeviceRows() {
    const x = devicectlList().find((e) => e.hardwareProperties?.udid === this.udid);
    if (!x) return [[false, 'Xcode (devicectl) has never seen this device', 'connect it with a cable, unlock it and tap Trust']];
    const cp = x.connectionProperties || {}, dp = x.deviceProperties || {};
    const rows = [
      [cp.pairingState === 'paired', `paired with this Mac: ${dp.name || 'iPhone'}${dp.osVersionNumber ? `, iOS ${dp.osVersionNumber}` : ''}`, 'connect it with a cable, unlock it and tap Trust'],
      [dp.developerModeStatus !== 'disabled', 'Developer Mode is on', 'on the phone: Settings → Privacy & Security → Developer Mode'],
      [cp.tunnelState === 'connected', `CoreDevice ${cp.transportType === 'wired' ? 'over USB' : 'over Wi-Fi'}: tunnel ${cp.tunnelState || 'unknown'}${cp.tunnelIPAddress ? ` (${cp.tunnelIPAddress})` : ''}`, 'connect it with a cable, or unlock it on the same Wi-Fi as the Mac'],
    ];
    const mux = (await muxDevices().catch(() => [])).filter((d) => d.udid === this.udid);
    rows.push([mux.length > 0 || null, `usbmuxd: ${mux.map((d) => (d.via === 'USB' ? 'USB' : 'Wi-Fi')).join(' + ') || 'not listed (the CoreDevice tunnel can still reach it)'}`]);
    const locked = deviceLocked(this.udid);
    rows.push([locked === false, locked == null ? "lock state: devicectl couldn't tell" : locked ? 'locked' : 'unlocked', 'unlock it (or pass --wait-unlock 60, so commands wait for that)']);
    return rows;
  }

  /** doctor's rows for a phone driven through lockdown: usbmuxd, Developer Mode, the developer disk image. */
  async lockdownRows(os) {
    const mux = (await muxDevices().catch(() => [])).filter((d) => d.udid === this.udid);
    const v = await deviceValues(this.udid).catch(() => ({}));
    const rows = [
      [null, `iOS ${os}: Xcode ${xcodeMajor() || ''} doesn't support it, so looktap drives it through lockdown (its developer image and testmanagerd) instead of CoreDevice`],
      [true, `paired with this Mac: ${v.DeviceName || 'iPhone'} (${v.ProductType || '?'}) over usbmuxd ${mux.map((d) => (d.via === 'USB' ? 'USB' : 'Wi-Fi')).join(' + ')}`],
    ];
    const mode = await developerMode(this.udid).catch(() => null);
    rows.push([mode !== false, mode === false ? 'Developer Mode is off' : 'Developer Mode is on', `looktap setup -d ${this.udid} turns it on when the phone has no passcode (it restarts); with a passcode it makes the switch appear in Settings → Privacy & Security → Developer Mode`]);
    const ddi = await ddiMounted(this.udid).catch(() => null);
    rows.push([ddi || null, ddi ? 'developer disk image mounted' : 'developer disk image not mounted yet: the first command (or looktap setup) mounts it']);
    return rows;
  }

  // ── commands ────────────────────────────────────────────────────────────

  async setup() {
    // A lockdown phone first needs what Xcode would have set up: Developer Mode and the developer disk image.
    if (await this.lockdownOs()) await this.prepare({ enable: true });
    await this.helper();
    console.log(`looktap runner ready on ${this.udid}`);
  }

  async teardown() {
    const h = await this.hello();
    if (h) await h.call('stop').catch(() => {});
    this.stopXcodebuild();
    const collector = Number(readJson(join(this.dir, 'log', 'collector.pid'), 0));
    if (collector > 0 && run('ps', ['-o', 'command=', '-p', String(collector)], { allowFail: true }).includes('devicelog.js')) process.kill(collector, 'SIGTERM');
    console.log('device runner stopped');
  }

  /** XCUITest types any text and waits for each key, so fill needs no pasteboard fallback. */
  pastes = false;

  /** XCUITest types any text; no pasteboard detour needed. */
  async type(text) {
    await this.call('text', { s: text }, { timeout: 60000 });
  }

  /** No framebuffer stream on a device: screenshots in a loop, repeats dropped. */
  async burst(dir, seconds) {
    const end = Date.now() + seconds * 1000;
    const seen = new Set();
    let frames = 0;
    while (Date.now() < end) {
      const { body } = await this.call('shot', { scale: 1 });
      frames++;
      const h = createHash('md5').update(body).digest('hex');
      if (seen.has(h)) continue;
      seen.add(h);
      writeFileSync(shotPath(dir, `b_${String(seen.size).padStart(4, '0')}`), body);
    }
    return { frames, distinct: seen.size };
  }

  /** The Home button: to the home screen, the app left running. */
  async home() {
    await this.call('home');
  }

  /** The app that is the home screen. */
  async homeScreen() {
    return 'com.apple.springboard';
  }

  async open(link) {
    await this.call('open', { url: link });
  }

  /** `resume`: bring the app forward as it was (XCUIApplication.activate), starting it only if it isn't running. */
  async launch(app, { resume = false } = {}) {
    // XCUITest's launch on a locked phone waits out its whole timeout (60 s) instead of failing: look first (~1 s).
    if (await this.locked()) throw new LockedError();
    this.collectLogs(); // the device keeps no log history: collect from the launch on, for `logs`
    await this.call(resume ? 'activate' : 'launch', { app }, { timeout: 60000 });
  }

  /** Terminate the app. Returns the pid it had, or 0 when it wasn't running. */
  async stop(app) {
    if (!(await this.appInfo(app))) throw new UsageError(`${app} is not installed on this device`);
    const pid = await this.pidOf(app);
    // XCUIApplication.terminate, which waits until the app is gone: iOS ignores SIGTERM (devicectl's) from the app in front.
    if (pid) await this.call('terminate', { app }, { timeout: 30000 });
    return pid;
  }

  /** Install a device build (.app signed for devices, or .ipa). Returns its bundle id. */
  async install(path) {
    if (!/\.(app|ipa)\/?$/.test(path) || !existsSync(path)) throw new UsageError(`${path} is not an .app or .ipa built for devices`);
    if (await this.lockdownOs()) return this.installLockdown(path);
    const r = devicectl(['device', 'install', 'app', '--device', this.udid, path], { timeout: 300000 });
    const app = r?.result?.installedApplications?.[0];
    if (!app) {
      const why = devicectlError(r);
      if (/locked/i.test(why) && (await this.locked())) throw new LockedError();
      throw new UsageError(`install failed: ${why || `no answer from devicectl — is ${path} built for devices and signed for this one?`}`);
    }
    rmSync(join(this.dir, 'apps.json'), { force: true });
    return app.bundleID || null;
  }

  /** install through installation_proxy, for a phone Xcode doesn't support. */
  async installLockdown(path) {
    try {
      await installApp(this.udid, path);
    } catch (e) {
      const why = {
        ApplicationVerificationFailed: `its signature or provisioning profile doesn't allow this device (is ${this.udid} in the profile?)`,
        DeviceOSVersionTooLow: `it needs a newer iOS than this device's ${this._lockdownOs}`,
        MismatchedApplicationIdentifierEntitlement: 'an app with the same bundle id but another signing team is installed: uninstall it first',
        ApplicationVersionDowngrade: 'a newer version is installed: uninstall it first',
      }[e.code];
      throw new UsageError(`install failed: ${why || e.message}`);
    }
    rmSync(join(this.dir, 'apps.json'), { force: true });
    const plist = join(path, 'Info.plist');
    return existsSync(plist) ? run('plutil', ['-extract', 'CFBundleIdentifier', 'raw', plist], { allowFail: true }).trim() || null : null;
  }

  /** installation_proxy's record of an app on a lockdown phone ({ Path, Container, CFBundleExecutable… }), or devicectl's on others; null when not installed. */
  async appInfo(app) {
    if (await this.lockdownOs()) return (await installedApps(this.udid, { ids: [app] }))[0] || null;
    const a = devicectl(['device', 'info', 'apps', '--device', this.udid, '--include-all-apps', '--bundle-id', app], { timeout: 30000 })?.result?.apps?.[0];
    return a ? { Path: decodeURI(String(a.url || '').replace(/^file:\/\//, '')).replace(/\/$/, ''), CFBundleExecutable: null } : null;
  }

  async paths() {
    unsupported(this.kind, 'app --paths');
  }

  /**
   CPU, memory footprint and threads, from Instruments' Activity Monitor (xcrun xctrace, part of Xcode). Each
   recording takes ~4 s, mostly Instruments starting. CPU is the change in the app's CPU time between two samples;
   on iOS 26 the instrument often ends after its first sample ("Device got disconnected"), so a second recording
   supplies the other one, unless an earlier reading (perf --for) left one.
   */
  /**
   Frames as the screen shows them, from its USB screen feed (the capture device QuickTime uses): the helper's
   --capture mode logs each delivered frame and whether it changed. The first call starts it; each later call reads
   the log since the previous one. It stops after 10 minutes without a call, or when the phone goes away.
   */
  async frames() {
    const dir = join(this.dir, 'frames');
    mkdirSync(dir, { recursive: true });
    const log = join(dir, 'feed.log'), asked = join(dir, 'asked'), pidFile = join(dir, 'capture.pid'), state = join(dir, 'read.json');
    writeFileSync(asked, ''); // the capture runs while this keeps being touched
    const pid = Number(readJson(pidFile, 0));
    const running = pid > 0 && run('ps', ['-o', 'command=', '-p', String(pid)], { allowFail: true }).includes('--capture');
    if (!running) {
      // The screen feed exists only over a cable: say so now rather than after the capture gives up. Right after a
      // screen feed closes, the phone's connection re-forms and can read as not wired for a moment: look twice.
      const lookup = () => devicectlList().find((x) => x.hardwareProperties?.udid === this.udid);
      let entry = lookup();
      if (entry && entry.connectionProperties?.transportType !== 'wired') {
        await sleep(1500);
        entry = lookup();
      }
      if (entry && entry.connectionProperties?.transportType !== 'wired')
        throw new UsageError("perf --frames on a real iPhone reads its screen over the USB cable, and it's connected over Wi-Fi now: plug it in (looktap devices shows how it's connected)");
      rmSync(log, { force: true });
      const name = entry?.deviceProperties?.name || '';
      const p = spawn(SIM_BIN, ['--capture', name, log, asked], { detached: true, stdio: 'ignore' });
      p.unref();
      writeFileSync(pidFile, String(p.pid));
      for (let i = 0; i < 120; i++) { // the helper looks for the feed for up to 20 s
        const text = existsSync(log) ? readFileSync(log, 'utf8') : '';
        const error = /^error (.*)$/m.exec(text)?.[1];
        if (error) throw new UsageError(`the iPhone's screen feed: ${error}`);
        if (/^started /m.test(text)) {
          writeFileSync(state, JSON.stringify({ offset: statSync(log).size }));
          return { started: true };
        }
        await sleep(250);
      }
      throw new UsageError("the iPhone's screen feed didn't start within 30 s: unlock the phone, and close QuickTime (or anything else) if it's showing it");
    }
    const { offset = 0 } = readJson(state, {});
    const bytes = readFileSync(log); // an offset in bytes: the log can hold the phone's name
    writeFileSync(state, JSON.stringify({ offset: bytes.length }));
    return feedFrames(feedSamples(bytes.subarray(offset).toString('utf8')));
  }

  async perf(app, ms = 1000, known = 0) {
    if (await this.lockdownOs()) throw new UsageError(`perf reads a real iPhone through Instruments, and this Xcode doesn't support iOS ${this._lockdownOs}: perf --frames works, or use an Xcode that supports it`);
    const pid = known || (await this.pidOf(app));
    if (!pid) throw new UsageError(`${app} isn't running on the device — start it: looktap launch ${app}`);
    // CPU over at least half a second: two samples of one recording can be 0.1 s apart.
    const points = this.lastPerf?.pid === pid && Date.now() - this.lastPerf.t < 60000 ? [this.lastPerf] : [];
    const span = () => (points.length ? points.at(-1).t - points[0].t : 0);
    for (let i = 0; i < 3 && span() < 500; i++) points.push(...this.activitySamples(pid));
    if (!points.length) throw new Error(`${app} stopped while being measured, or Instruments recorded nothing — see: looktap crashes ${app}`);
    if (span() < 500) throw new Error('Instruments gave too few samples to measure CPU: run perf again');
    const [a, b] = [points[0], points.at(-1)];
    this.lastPerf = b;
    return { pid, ms: b.t - a.t, cpu: ((b.cpuNs - a.cpuNs) / 1e6 / (b.t - a.t)) * 100, memory: [['footprint', b.footprint]], threads: b.threads };
  }

  /**
   One short Activity Monitor recording → the samples it took of `pid`: { t (ms since 1970), cpuNs, footprint,
   threads }. A row covers an interval from its start, and its CPU time is the total at the interval's end.
   */
  activitySamples(pid) {
    const dir = mkdtempSync(join(tmpdir(), 'looktap-perf-'));
    const trace = join(dir, 'perf.trace');
    try {
      // Past the timeout it gets Ctrl-C (SIGINT), so it ends its recording on the phone: a killed xctrace leaves the
      // phone's kernel trace session open, and every recording after it fails until that clears.
      // xctrace leaves its raw kernel trace (instruments*.ktrace, 1.5 MB to 1 GB) in the user's temp folder when a
      // recording ends early, as this one usually does, whatever TMPDIR says: the ones it adds are removed below.
      const leftovers = ktraces();
      const r = spawnSync('xcrun', ['xctrace', 'record', '--instrument', 'Activity Monitor', '--device', this.udid, '--all-processes', '--time-limit', '1s', '--output', trace, '--no-prompt'], { encoding: 'utf8', timeout: 90000, killSignal: 'SIGINT' });
      for (const f of ktraces()) if (!leftovers.has(f)) rmSync(f, { force: true });
      const said = `${r.stdout || ''}${r.stderr || ''}`;
      if (/Failed starting ktrace session/i.test(said))
        throw new UsageError("Instruments is busy on the device: an earlier recording didn't end (any app's, or Xcode's). It clears in a few minutes, or reconnect the cable; restarting the phone always clears it");
      if (!existsSync(trace)) return [];
      const toc = run('xcrun', ['xctrace', 'export', '--input', trace, '--toc'], { allowFail: true, timeout: 60000 });
      const t0 = Date.parse(/<start-date>([^<]+)<\/start-date>/.exec(toc)?.[1] || '');
      const xml = run('xcrun', ['xctrace', 'export', '--input', trace, '--xpath', '/trace-toc/run[@number="1"]/data/table[@schema="activity-monitor-process-live"]'], { allowFail: true, timeout: 60000 });
      return xctraceRows(xml)
        .filter((r) => Number(r.pid?.text) === pid && r['cpu-total'])
        .map((r) => ({ pid, t: t0 + (Number(r.start.text) + Number(r.duration?.text || 0)) / 1e6, cpuNs: Number(r['cpu-total'].text), footprint: Number(r['memory-physical-footprint']?.text) || null, threads: Number(r['thread-count']?.text) || null }));
    } finally {
      rmSync(dir, { recursive: true, force: true }); // the trace holds every process on the phone, and xctrace's leftovers
    }
  }

  /** Installed apps: { id, name, version, system }. `all`: Apple's own apps too. */
  async apps({ all = false } = {}) {
    if (await this.lockdownOs())
      return (await installedApps(this.udid, { all }))
        .map((a) => ({ id: a.CFBundleIdentifier, name: a.CFBundleDisplayName || a.CFBundleName || '', version: appVersion(a.CFBundleShortVersionString, a.CFBundleVersion), system: a.ApplicationType === 'System' }))
        .filter((a) => a.id && (all || !a.system))
        .sort((a, b) => a.id.localeCompare(b.id));
    const r = devicectl(['device', 'info', 'apps', '--device', this.udid, ...(all ? ['--include-all-apps'] : [])], { timeout: 30000 });
    if (!r) throw new UsageError(`could not list the apps on ${this.udid} — is it unlocked and connected?`);
    return (r.result?.apps || [])
      .map((a) => ({ id: a.bundleIdentifier, name: a.name || '', version: appVersion(a.version, a.bundleVersion), system: !a.removable }))
      .filter((a) => a.id && (all || !a.system))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async uninstall(app) {
    if (await this.lockdownOs()) {
      if (!(await this.appInfo(app))) throw new UsageError(`could not uninstall ${app} — it isn't installed on this device`);
      await uninstallApp(this.udid, app);
      return rmSync(join(this.dir, 'apps.json'), { force: true });
    }
    const r = devicectl(['device', 'uninstall', 'app', '--device', this.udid, app], { timeout: 120000 });
    if (!r || r.info?.outcome !== 'success') throw new UsageError(`could not uninstall ${app} — is it installed on this device?`);
    rmSync(join(this.dir, 'apps.json'), { force: true });
  }

  async appearance(mode) {
    return (await this.call('appearance', mode ? { mode } : {})).mode;
  }

  /** The app in front: { key, id } — the runner knows bundle ids, not paths. */
  async frontApp() {
    await this.knowApps();
    const { id } = await this.call('front');
    return id ? { key: id, id, pid: 0, path: '' } : null;
  }

  /** The lock screen is up, so a passcode is needed (devicectl: ~1 s, so asked only when something fails). */
  async locked() {
    // A lockdown phone has no lock-state query (that's CoreDevice's): the runner's own errors say it.
    if (await this.lockdownOs()) return false;
    return deviceLocked(this.udid) === true;
  }

  async foreground() {
    const f = await this.frontApp();
    return f && { id: f.id, pid: (await this.pidOf(f.id)) || 0 };
  }

  async alive(f) {
    return Boolean(f.id) && (await this.call('state', { app: f.id })).running;
  }

  appId(f) {
    return f.id || null;
  }

  /** Tell the runner which apps are installed, once per runner session, so it can tell which is in front. */
  async knowApps() {
    if (this._knowApps) return;
    this._knowApps = true;
    const cache = join(this.dir, 'apps.json');
    // Re-read hourly: apps installed from the App Store don't go through looktap.
    let ids = existsSync(cache) && Date.now() - statSync(cache).mtimeMs < 3600e3 ? readJson(cache, null) : null;
    if (!ids) {
      if (await this.lockdownOs()) ids = (await installedApps(this.udid)).map((a) => a.CFBundleIdentifier).filter(Boolean);
      else ids = (devicectl(['device', 'info', 'apps', '--device', this.udid, '--include-all-apps'], { timeout: 30000 })?.result?.apps || []).map((a) => a.bundleIdentifier).filter(Boolean);
      writeFileSync(cache, JSON.stringify(ids));
    }
    if (this.app && !ids.includes(this.app)) ids.unshift(this.app);
    if (ids.length) await this.call('apps', { ids });
  }

  async pidOf(app) {
    if (await this.lockdownOs()) {
      const dir = (await this.appInfo(app))?.Path;
      if (!dir) return 0;
      return (await processes(this.udid)).find((p) => String(p.realAppName || '').replace(/^\/private/, '').startsWith(dir.replace(/^\/private/, '') + '/'))?.pid || 0;
    }
    const apps = devicectl(['device', 'info', 'apps', '--device', this.udid, '--include-all-apps', '--bundle-id', app], { timeout: 30000 })?.result?.apps || [];
    const url = apps[0]?.url;
    if (!url) return 0;
    const procs = devicectl(['device', 'info', 'processes', '--device', this.udid], { timeout: 30000 })?.result?.runningProcesses || [];
    const dir = decodeURI(url.replace(/^file:\/\//, '')).replace(/\/$/, '');
    return procs.find((p) => decodeURI(String(p.executable || '').replace(/^file:\/\//, '')).startsWith(dir + '/'))?.processIdentifier || 0;
  }

  /** The app's executable name, which is what the device's log calls its process. */
  async executable(app) {
    if (await this.lockdownOs()) {
      const a = await this.appInfo(app);
      if (!a) throw new UsageError(`${app} is not installed on this device`);
      return a.CFBundleExecutable;
    }
    const url = devicectl(['device', 'info', 'apps', '--device', this.udid, '--include-all-apps', '--bundle-id', app], { timeout: 30000 })?.result?.apps?.[0]?.url;
    if (!url) throw new UsageError(`${app} is not installed on this device`);
    const dir = decodeURI(url.replace(/^file:\/\//, '')).replace(/\/$/, '');
    const procs = devicectl(['device', 'info', 'processes', '--device', this.udid], { timeout: 30000 })?.result?.runningProcesses || [];
    const exe = procs.map((p) => decodeURI(String(p.executable || '').replace(/^file:\/\//, ''))).find((p) => p.startsWith(dir + '/'));
    // Not running: the bundle's name, which is the executable's unless the app renamed it.
    return (exe || dir).split('/').pop().replace(/\.app$/, '');
  }

  /**
   Start the background log collector if it isn't running (lib/devicelog.js), and keep it going: it stops 30 minutes
   after the last call. Returns true when this call started it.
   */
  collectLogs() {
    const dir = join(this.dir, 'log');
    mkdirSync(dir, { recursive: true });
    const asked = join(dir, 'asked'), pidFile = join(dir, 'collector.pid');
    if (existsSync(asked)) utimesSync(asked, new Date(), new Date());
    else writeFileSync(asked, '');
    const pid = Number(readJson(pidFile, 0));
    if (pid > 0 && run('ps', ['-o', 'command=', '-p', String(pid)], { allowFail: true }).includes('devicelog.js')) return false;
    const script = new URL('./devicelog.js', import.meta.url).pathname;
    const p = spawn(process.execPath, [script, this.udid, join(dir, 'syslog.jsonl'), asked], { detached: true, stdio: 'ignore' });
    p.unref();
    writeFileSync(pidFile, String(p.pid));
    return true;
  }

  /**
   The app's log since `since`, from the collector. The phone keeps no history: the first `logs` (or `launch`) starts
   collecting, so what came before it can't be shown.
   */
  async readLogs(app, since, opts = {}) {
    const file = join(this.dir, 'log', 'syslog.jsonl');
    const exe = await this.executable(app);
    if (this.collectLogs()) {
      for (let i = 0; i < 20 && collectorStatus(file).connected == null; i++) await sleep(250);
      console.error("looktap: an iPhone keeps no log history looktap can read, so it collects the log from now on (in the background, until 30 min after the last logs or launch): reproduce the problem, then run logs again");
    }
    const status = collectorStatus(file);
    if (status.connected === false && status.error) console.error(`looktap: warning: the device log isn't coming in: ${status.error}`);
    return readCollected(file, exe, since, opts);
  }

  // ── what a device can't do from the outside ─────────────────────────────

  // The reasons live in lib/capabilities.js, with every other device's.
  async paste() { unsupported(this.kind, 'paste'); }
  async reset() { unsupported(this.kind, 'reset'); }
  async permission() { unsupported(this.kind, 'permission'); }
  /** On a lockdown phone, through the developer image's simulated location (what Xcode's Simulate Location uses). */
  async location(lat, lon) {
    if (!(await this.lockdownOs())) unsupported(this.kind, 'location');
    await this.prepare();
    await simulateLocation(this.udid, lat, lon);
  }

  async clearLocation() {
    if (!(await this.lockdownOs())) unsupported(this.kind, 'location clear');
    await simulateLocation(this.udid, null);
  }
  async recordStart() { unsupported(this.kind, 'record'); }
  async recordStop() { unsupported(this.kind, 'record'); }
  async network() { unsupported(this.kind, 'network'); }
  async textSize() { unsupported(this.kind, 'textsize'); }
  async push() { unsupported(this.kind, 'push'); }
  async statusBar() { unsupported(this.kind, 'statusbar'); }
  async bio() { unsupported(this.kind, 'bio'); }
  /**
   The app's crash reports since `since`, from the phone's crash report service (as Xcode's Devices window reads
   them), each summarised; the full report is saved under ~/.looktap/device/<udid>/crashes.
   */
  async readCrashes(app, since) {
    if (!(await this.lockdownOs())) unsupported(this.kind, 'crashes');
    const exe = await this.executable(app);
    const dir = join(this.dir, 'crashes');
    const found = [];
    for (const c of await crashReports(this.udid)) {
      if (c.time < since || !c.name.startsWith(`${exe}-`) || !c.name.endsWith('.ips')) continue;
      const text = await readCrashReport(this.udid, c.path);
      mkdirSync(dir, { recursive: true });
      const path = join(dir, c.name);
      writeFileSync(path, text);
      try {
        found.push({ t: c.time, text: summariseIps(JSON.parse(text.slice(text.indexOf('\n') + 1)), path) });
      } catch {
        found.push({ t: c.time, text: `${app} crashed (report: ${path})` });
      }
    }
    return found.sort((a, b) => a.t - b.t);
  }
}
