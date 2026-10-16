// Physical iPhone/iPad driver. The simulator path (lib/ios.js) installs nothing; a real device has no such
// back door, so here simwright installs its own XCUITest runner (native/ios-device) on first use and talks
// to it over usbmuxd. Reading the screen, tapping, typing and screenshots go through the runner; installing
// apps goes through `xcrun devicectl`. Commands the device can't support say so.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Helper } from './helper.js';
import { Ios } from './ios.js';
import { muxConnect } from './usbmux.js';
import { HOME, UsageError, readJson, run, shotPath, sleep } from './util.js';

const PORT = 22087;
const PROJECT_DIR = new URL('../native/ios-device/', import.meta.url).pathname;
const PROJECT = join(PROJECT_DIR, 'SimwrightRunner.xcodeproj');
const SOURCES = ['SimwrightRunner/Runner.swift', 'SimwrightRunner.xcodeproj/project.pbxproj'];

let runnerHash;
/** The runner's version is its sources' hash: an edited runner is rebuilt and replaces one still running. */
const runnerVersion = () =>
  (runnerHash ??= createHash('sha1').update(SOURCES.map((f) => readFileSync(join(PROJECT_DIR, f))).join('\0')).digest('hex').slice(0, 12));

/** devicectl's JSON for a subcommand, or null. */
function devicectl(args, { timeout = 30000 } = {}) {
  const out = join(tmpdir(), `simwright-devicectl-${process.pid}-${Date.now()}.json`);
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

  /** The signing team: --team / SIMWRIGHT_TEAM / config, else the only team signed in to Xcode. */
  signingTeam() {
    if (this.team) return this.team;
    const teams = xcodeTeams();
    if (teams.length === 1) return teams[0].id;
    const list = teams.map((t) => `${t.id} (${t.name}${t.free ? ', free' : ''})`).join(', ');
    throw new UsageError(
      teams.length
        ? `simwright installs a small XCUITest runner on real devices and needs a team to sign it. Pick one of: ${list} — then pass SIMWRIGHT_TEAM=<id>, or put {"ios": {"team": "<id>"}} in simwright.config.json`
        : 'simwright installs a small XCUITest runner on real devices and needs a signing team: sign in to Xcode (Settings → Accounts) with your Apple ID',
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
    console.error('simwright: building the XCUITest runner for this device (once per simwright version, about a minute)…');
    const out = run('xcodebuild', ['build-for-testing', '-project', PROJECT, '-scheme', 'SimwrightRunner', '-destination', `id=${this.udid}`,
      '-derivedDataPath', derived, '-allowProvisioningUpdates', `DEVELOPMENT_TEAM=${team}`, `PRODUCT_BUNDLE_IDENTIFIER=dev.simwright.runner.${team}`],
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
        console.error('simwright: the runner\'s signing is no longer valid — building it again');
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
      env: { ...process.env, TEST_RUNNER_SIMWRIGHT_PORT: String(PORT), TEST_RUNNER_SIMWRIGHT_VERSION: runnerVersion() },
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
        console.error('simwright: unlock the device — the runner starts once it is unlocked');
        said = true;
      }
      const fail = /(not been explicitly trusted|Untrusted Developer|invalid code signature|TEST EXECUTE FAILED|Testing failed:[^\n]*\n[^\n]*)/i.exec(text);
      if (fail || !this.xcodebuildAlive()) {
        this.stopXcodebuild();
        if (/trusted/i.test(fail?.[0] || ''))
          throw new UsageError('the device does not trust the developer yet: on the device open Settings → General → VPN & Device Management, trust your developer app, then run the command again');
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

  async call(op, args, opts) {
    return (await this.helper()).call(op, args, opts);
  }

  // ── commands ────────────────────────────────────────────────────────────

  async setup() {
    await this.helper();
    console.log(`simwright runner ready on ${this.udid}`);
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

  async open(link) {
    await this.call('open', { url: link });
  }

  async launch(app) {
    await this.call('launch', { app }, { timeout: 60000 });
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
    // Re-read hourly: apps installed from the App Store don't go through simwright.
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

  unsupported(what, hint = '') {
    throw new UsageError(`${what} isn't available on a real device${hint ? ` — ${hint}` : ''}`);
  }
  async reset() { this.unsupported('reset', 'uninstall and install the app again'); }
  async permission() { this.unsupported('permission', 'change it in the Settings app'); }
  async location() { this.unsupported('location', "a real device uses its own GPS; use a simulator to fake one"); }
  async clearLocation() { this.unsupported('location'); }
  async recordStart() { this.unsupported('record', 'use burst for frames, or QuickTime Player for video'); }
  async recordStop() { this.unsupported('record'); }
  async network() { this.unsupported('network', 'turn on Airplane Mode in Control Center'); }
  async textSize() { this.unsupported('textsize', 'change it in Settings → Display & Brightness → Text Size'); }
  async push() { this.unsupported('push', 'send a real push through APNs'); }
  async statusBar() { this.unsupported('statusbar'); }
  async bio() { this.unsupported('bio', 'Face ID needs a real face on a device'); }
  async readLogs() { this.unsupported('logs', 'use Console.app with the device selected'); }
  async readCrashes() { this.unsupported('crashes', 'see Xcode → Window → Devices and Simulators → View Device Logs'); }
  executable() { this.unsupported('this command'); }
}
