// Physical iPhone/iPad driver. The simulator path (lib/ios.js) installs nothing; a real device has no such
// back door, so here looktap installs its own XCUITest runner (native/ios-device) on first use and talks
// to it over usbmuxd. Reading the screen, tapping, typing and screenshots go through the runner; installing
// apps goes through `xcrun devicectl`. Commands the device can't support say so.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { unsupported } from './capabilities.js';
import { Helper } from './helper.js';
import { Ios, SIM_BIN, appVersion } from './ios.js';
import { feedFrames, feedSamples, xctraceRows } from './perf.js';
import { muxConnect } from './usbmux.js';
import { HOME, LOCKED, UsageError, readJson, run, shotPath, sleep } from './util.js';

const PORT = 22087;
const PROJECT_DIR = new URL('../native/ios-device/', import.meta.url).pathname;
const PROJECT = join(PROJECT_DIR, 'LooktapRunner.xcodeproj');
const SOURCES = ['LooktapRunner/Runner.swift', 'LooktapRunner.xcodeproj/project.pbxproj'];

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
/** Every device devicectl knows: paired, connected, or seen before. */
export function devicectlList() {
  return devicectl(['list', 'devices'], { timeout: 10000 })?.result?.devices || [];
}

export function physicalDevices() {
  return devicectlList()
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
      // A runner can't start on a locked device: say so now, rather than wait for an unlock for minutes.
      if (await this.locked()) throw new UsageError(LOCKED);
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
    let lockedSince = 0;
    for (let i = 0; i < 180; i++) {
      await sleep(1000);
      const h = await this.hello();
      if (h) return h;
      const text = readFileSync(this.log, 'utf8');
      if (/Unlock .* to Continue|device is locked/i.test(text)) {
        if (!lockedSince) {
          console.error('looktap: unlock the device — the runner starts once it is unlocked');
          lockedSince = Date.now();
        } else if (Date.now() - lockedSince > 30000) {
          // Long enough for a person to unlock it; an agent can't, so don't hold it for minutes.
          this.stopXcodebuild();
          throw new UsageError(LOCKED);
        }
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
      if (MAYBE_LOCKED.test(e.message || '') && (await this.locked())) throw new UsageError(LOCKED);
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

  async launch(app, { resume = false } = {}) {
    if (resume) throw new UsageError('launch --resume needs a simulator or Android for now: on a real iPhone, launch restarts the app');
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
    const r = devicectl(['device', 'info', 'apps', '--device', this.udid, ...(all ? ['--include-all-apps'] : [])], { timeout: 30000 });
    if (!r) throw new UsageError(`could not list the apps on ${this.udid} — is it unlocked and connected?`);
    return (r.result?.apps || [])
      .map((a) => ({ id: a.bundleIdentifier, name: a.name || '', version: appVersion(a.version, a.bundleVersion), system: !a.removable }))
      .filter((a) => a.id && (all || !a.system))
      .sort((a, b) => a.id.localeCompare(b.id));
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

  /** The lock screen is up, so a passcode is needed (devicectl: ~1 s, so asked only when something fails). */
  async locked() {
    return devicectl(['device', 'info', 'lockState', '--device', this.udid], { timeout: 30000 })?.result?.passcodeRequired === true;
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
