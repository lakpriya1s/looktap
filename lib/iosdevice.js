// Physical iPhone/iPad driver. The simulator path (lib/ios.js) installs nothing; a real device has no such
// back door, so here looktap installs its own XCUITest runner (native/ios-device) on first use and talks
// to it over usbmuxd. Reading the screen, tapping, typing and screenshots go through the runner; installing
// apps goes through `xcrun devicectl`. Commands the device can't support say so.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { unsupported } from './capabilities.js';
import { Helper } from './helper.js';
import { Ios } from './ios.js';
import { muxConnect } from './usbmux.js';
import { HOME, UsageError, readJson, run, shotPath, sleep } from './util.js';

const PORT = 22087;
const PROJECT_DIR = new URL('../native/ios-device/', import.meta.url).pathname;
const PROJECT = join(PROJECT_DIR, 'LooktapRunner.xcodeproj');
const SOURCES = ['LooktapRunner/Runner.swift', 'LooktapRunner.xcodeproj/project.pbxproj'];

let runnerHash;
/** The runner's version is its sources' hash: an edited runner is rebuilt and replaces one still running. */
const runnerVersion = () =>
  (runnerHash ??= createHash('sha1').update(SOURCES.map((f) => readFileSync(join(PROJECT_DIR, f))).join('\0')).digest('hex').slice(0, 12));

/** devicectl's JSON for a subcommand, or null. */
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

/** Paired iPhones and iPads that are reachable now: { id (hardware UDID), name, os }. */
export function physicalDevices() {
  const r = devicectl(['list', 'devices'], { timeout: 10000 });
  return (r?.result?.devices || [])
    .filter((d) => d.hardwareProperties?.reality === 'physical' && d.hardwareProperties?.platform === 'iOS')
    .filter((d) => d.connectionProperties?.pairingState === 'paired' && d.connectionProperties?.tunnelState !== 'unavailable')
    .map((d) => ({ id: d.hardwareProperties.udid, name: d.deviceProperties?.name || 'iPhone', os: d.deviceProperties?.osVersionNumber }));
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

  async hello() {
    try {
      const h = new Helper(await muxConnect(this.udid, PORT, 2000));
      const r = await h.call('hello', {}, { timeout: 3000 });
      if (r.version === runnerVersion()) return h;
      await h.call('stop').catch(() => {});
      h.close();
      this.stopXcodebuild();
      await sleep(1000);
    } catch {}
    return null;
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

  /** Build the runner for this device and team, once per version. Returns its .xctestrun file. */
  build(team) {
    const derived = join(this.dir, `build-${runnerVersion()}-${team}`);
    const find = () => {
      const products = join(derived, 'Build', 'Products');
      const f = existsSync(products) && readdirSync(products).find((x) => x.endsWith('.xctestrun'));
      return f ? join(products, f) : null;
    };
    const have = find();
    // A free team's signing lasts 7 days, a paid team's a year: rebuild before it lapses, not after.
    if (have && profileExpires(join(derived, 'Build', 'Products')) > Date.now() + 3600e3) return have;
    this.clearBuilds();
    console.error('looktap: building the XCUITest runner for this device (once per looktap version, about a minute)…');
    const out = run('xcodebuild', ['build-for-testing', '-project', PROJECT, '-scheme', 'LooktapRunner', '-destination', `id=${this.udid}`,
      '-derivedDataPath', derived, '-allowProvisioningUpdates', `DEVELOPMENT_TEAM=${team}`, `PRODUCT_BUNDLE_IDENTIFIER=dev.looktap.runner.${team}`],
      { allowFail: true, timeout: 600000 });
    const built = find();
    if (!built) {
      const why = out.split('\n').filter((l) => /error:/.test(l)).slice(0, 3).join('\n  ') || out.trim().split('\n').slice(-3).join('\n  ');
      throw new UsageError(`could not build the runner (team ${team}):\n  ${why}`);
    }
    return built;
  }

  /** The runner, started (and installed) if needed. */
  async helper() {
    if (this._helper) return this._helper;
    let h = await this.hello();
    if (!h) {
      const team = this.signingTeam();
      mkdirSync(this.dir, { recursive: true });
      try {
        h = await this.start(this.build(team));
      } catch (e) {
        // A runner whose signing lapsed (a free team's lasts 7 days) or was revoked: sign it afresh, once.
        if (!(e instanceof SigningError)) throw e;
        console.error('looktap: the runner\'s signing is no longer valid — building it again');
        this.clearBuilds();
        h = await this.start(this.build(team));
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
    let said = false;
    for (let i = 0; i < 180; i++) {
      await sleep(1000);
      const h = await this.hello();
      if (h) return h;
      const text = readFileSync(this.log, 'utf8');
      if (/Unlock .* to Continue|device is locked/i.test(text) && !said) {
        console.error('looktap: unlock the device — the runner starts once it is unlocked');
        said = true;
      }
      const fail = /(not been explicitly trusted|Untrusted Developer|invalid code signature|TEST EXECUTE FAILED|Testing failed:[^\n]*\n[^\n]*)/i.exec(text);
      if (fail || !this.xcodebuildAlive()) {
        this.stopXcodebuild();
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
    throw new UsageError(`the runner did not answer within 3 minutes (log: ${this.log})`);
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
    if (pid && run('ps', ['-p', String(pid), '-o', 'command='], { allowFail: true }).includes('xcodebuild')) {
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

  // ── commands ────────────────────────────────────────────────────────────

  async setup() {
    await this.helper();
    console.log(`looktap runner ready on ${this.udid}`);
  }

  async teardown() {
    const h = await this.hello();
    if (h) await h.call('stop').catch(() => {});
    this.stopXcodebuild();
    console.log('device runner stopped');
  }

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

  async launch(app) {
    await this.call('launch', { app }, { timeout: 60000 });
  }

  /** Terminate the app. Returns the pid it had, or 0 when it wasn't running. */
  async stop(app) {
    const installed = devicectl(['device', 'info', 'apps', '--device', this.udid, '--include-all-apps', '--bundle-id', app], { timeout: 30000 })?.result?.apps?.length;
    if (!installed) throw new UsageError(`${app} is not installed on this device`);
    const pid = await this.pidOf(app);
    // XCUIApplication.terminate, which waits until the app is gone: iOS ignores SIGTERM (devicectl's) from the app in front.
    if (pid) await this.call('terminate', { app }, { timeout: 30000 });
    return pid;
  }

  /** Install a device build (.app signed for devices, or .ipa). Returns its bundle id. */
  async install(path) {
    if (!/\.(app|ipa)\/?$/.test(path) || !existsSync(path)) throw new UsageError(`${path} is not an .app or .ipa built for devices`);
    const r = devicectl(['device', 'install', 'app', '--device', this.udid, path], { timeout: 300000 });
    const app = r?.result?.installedApplications?.[0];
    if (!app) throw new UsageError(`install failed — is ${path} built for devices and signed for this one?`);
    rmSync(join(this.dir, 'apps.json'), { force: true });
    return app.bundleID || null;
  }

  async uninstall(app) {
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
      const r = devicectl(['device', 'info', 'apps', '--device', this.udid, '--include-all-apps'], { timeout: 30000 });
      ids = (r?.result?.apps || []).map((a) => a.bundleIdentifier).filter(Boolean);
      writeFileSync(cache, JSON.stringify(ids));
    }
    if (this.app && !ids.includes(this.app)) ids.unshift(this.app);
    if (ids.length) await this.call('apps', { ids });
  }

  async pidOf(app) {
    const apps = devicectl(['device', 'info', 'apps', '--device', this.udid, '--include-all-apps', '--bundle-id', app], { timeout: 30000 })?.result?.apps || [];
    const url = apps[0]?.url;
    if (!url) return 0;
    const procs = devicectl(['device', 'info', 'processes', '--device', this.udid], { timeout: 30000 })?.result?.runningProcesses || [];
    const dir = decodeURI(url.replace(/^file:\/\//, '')).replace(/\/$/, '');
    return procs.find((p) => decodeURI(String(p.executable || '').replace(/^file:\/\//, '')).startsWith(dir + '/'))?.processIdentifier || 0;
  }

  // ── what a device can't do from the outside ─────────────────────────────

  // The reasons live in lib/capabilities.js, with every other device's.
  async reset() { unsupported(this.kind, 'reset'); }
  async permission() { unsupported(this.kind, 'permission'); }
  async location() { unsupported(this.kind, 'location'); }
  async clearLocation() { unsupported(this.kind, 'location clear'); }
  async recordStart() { unsupported(this.kind, 'record'); }
  async recordStop() { unsupported(this.kind, 'record'); }
  async network() { unsupported(this.kind, 'network'); }
  async textSize() { unsupported(this.kind, 'textsize'); }
  async push() { unsupported(this.kind, 'push'); }
  async statusBar() { unsupported(this.kind, 'statusbar'); }
  async bio() { unsupported(this.kind, 'bio'); }
  async readLogs() { unsupported(this.kind, 'logs'); }
  async readCrashes() { unsupported(this.kind, 'crashes'); }
  executable() { unsupported(this.kind, 'this command'); }
}
