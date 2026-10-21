// iOS simulator driver. No Appium, no WebDriverAgent, nothing installed on the simulator.
// looktap's host helper (native/ios) reads the screen and injects touches and keys through Apple's
// simulator frameworks; `xcrun simctl` handles deep links, app launch and Face ID.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { constants as osConstants, homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { unsupported } from './capabilities.js';
import { Helper } from './helper.js';
import { setRotation } from './mp4.js';
import { parseFootprint, psTime, screenFrames } from './perf.js';
import { iosService } from './permissions.js';
import { keyboardArea } from './screen.js';
import { HOME, NotFound, UsageError, pickMatch, run, shotPath, sleep, waitFor } from './util.js';

export function bootedSimulators() {
  const out = run('xcrun', ['simctl', 'list', 'devices', 'booted', '-j'], { allowFail: true });
  if (!out) return [];
  const devices = Object.values(JSON.parse(out).devices).flat();
  return devices.filter((d) => d.state === 'Booted').map((d) => ({ id: d.udid, name: d.name }));
}

export const SIM_BIN = new URL('./assets/looktap-sim', import.meta.url).pathname;
const SIM_SRC = new URL('../native/ios/build.sh', import.meta.url).pathname;
let simHash;
/** The helper's version is its binary's hash: a rebuilt helper replaces one still running. */
const simVersion = () => (simHash ??= createHash('sha1').update(readFileSync(SIM_BIN)).digest('hex').slice(0, 12));
/** Apple subsystems whose errors are the simulator's internals, not the app's problems. */
const NOISY = ['com.apple.network', 'com.apple.TextInputUI', 'com.apple.KeyboardArbiter', 'com.apple.UIKit:KeyboardArbiter'];
const TEXT_TYPES = /^(TextField|TextArea|SearchField|SecureTextField|ComboBox)$/;
const DONE_KEYS = ['Done', 'done', 'Return', 'return', 'Hide keyboard', 'hide keyboard'];

/** "1.2 (34)": the version people see, then the build when it says more. */
export const appVersion = (short, build) => (short && build && build !== short ? `${short} (${build})` : short || build || '');

/** `simctl listapps` (as JSON) → { id, name, version, system }, by id. */
export function simApps(list) {
  return Object.entries(list)
    .map(([id, a]) => ({
      id,
      name: a.CFBundleDisplayName || a.CFBundleName || '',
      version: appVersion(a.CFBundleShortVersionString, a.CFBundleVersion),
      system: a.ApplicationType !== 'User',
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export class Ios {
  kind = 'ios-simulator';
  /** fill can paste its text when typing lost some (simctl pbcopy). */
  pastes = true;

  constructor(udid, { out, app, wait = 0 }) {
    this.udid = udid;
    this.wait = wait;
    this.out = out;
    this.app = app;
    // Unix socket paths are capped near 104 bytes: keep it short.
    this.socket = join(HOME, `sim-${udid.slice(0, 8)}.sock`);
    this.log = join(HOME, `sim-${udid.slice(0, 8)}.log`);
    this._helper = undefined;
  }

  async hello() {
    try {
      const h = await Helper.open(this.socket, 500);
      const r = await h.call('hello', {}, { timeout: 1500 });
      if (r.version === simVersion()) return h;
      await h.call('stop').catch(() => {});
      h.close();
    } catch {}
    return null;
  }

  /** The running helper, started if needed. Null (with `startError`) when it cannot run here. */
  async helper() {
    if (this._helper !== undefined) return this._helper;
    this._helper = null;
    if (!existsSync(SIM_BIN)) {
      if (!existsSync(SIM_SRC)) return null;
      run('sh', [SIM_SRC], { allowFail: true, timeout: 120000 });
      if (!existsSync(SIM_BIN)) return null;
    }
    let h = await this.hello();
    if (!h) {
      mkdirSync(HOME, { recursive: true });
      const developerDir = run('xcode-select', ['-p'], { allowFail: true }).trim() || '/Applications/Xcode.app/Contents/Developer';
      const log = openSync(this.log, 'w');
      spawn(SIM_BIN, ['--udid', this.udid, '--socket', this.socket, '--version', simVersion(), '--developer-dir', developerDir], {
        detached: true,
        stdio: ['ignore', log, log],
      }).unref();
      closeSync(log);
      for (let i = 0; i < 40 && !h; i++) {
        await sleep(100);
        h = await this.hello();
        if (!h && /looktap-sim: /.test(readFileSync(this.log, 'utf8'))) break; // it said why it quit
      }
      if (!h) {
        const why = readFileSync(this.log, 'utf8').trim().split('\n').pop();
        this.startError = why || 'the iOS helper did not start';
        return null;
      }
    }
    return (this._helper = h);
  }

  async call(op, args, opts) {
    const h = await this.helper();
    if (!h) throw new UsageError(this.startError || 'the iOS helper is not running');
    return h.call(op, args, opts);
  }

  close() {
    this._helper?.close();
  }

  /** On-screen elements: { label, type, id, value, x, y, w, h } in points. The app's root comes first. */
  async elements({ all = false } = {}) {
    const r = await this.call('tree', { all });
    this.screen = r.screen;
    return r.nodes.map((n) => ({
      label: n.l || n.id || '', type: n.t, id: n.id, value: n.v, x: n.x, y: n.y, w: n.w, h: n.h,
    }));
  }

  async keyboardShown() {
    return (await this.call('keyboard')).shown;
  }

  // ── commands ────────────────────────────────────────────────────────────

  async setup() {
    const h = await this.helper();
    if (!h) throw new UsageError(this.startError);
    console.log(`looktap iOS helper ready on ${this.udid}`);
  }

  async teardown() {
    const h = await this.hello();
    if (h) await h.call('stop').catch(() => {});
    rmSync(this.socket, { force: true });
    console.log('iOS helper stopped');
  }

  /** The screen for the platform-neutral layer (lib/screen.js): { screen: {w, h}, elements } in points. */
  async snapshot({ all = false } = {}) {
    const els = await this.elements({ all });
    const root = els.find((e) => e.type === 'Application');
    return { screen: this.screen || (root ? { w: root.w, h: root.h } : { w: 0, h: 0 }), elements: els.filter((e) => e !== root) };
  }

  async tapxy(x, y) {
    await this.call('tap', { x: +x, y: +y });
  }

  async longpress(x, y, ms) {
    await this.call('tap', { x: +x, y: +y, hold: ms }, { timeout: ms + 10000 });
  }

  /** Two fingers either side of (x, y), from r0 to r1 points apart-from-centre: r1 > r0 zooms in. */
  async pinch(x, y, r0, r1, ms = 400) {
    await this.call('pinch', { x, y, r0, r1, ms });
  }

  /** Typed as hardware key presses; text a US layout cannot type goes through the pasteboard. */
  async type(text) {
    try {
      await this.call('text', { s: text });
    } catch (e) {
      if (!/cannot type/.test(e.message)) throw e;
      await this.paste(text);
    }
  }

  /** Put `text` on the simulator's pasteboard and paste it into the focused field. */
  async paste(text) {
    run('xcrun', ['simctl', 'pbcopy', this.udid], { input: text });
    await this.call('key', { keys: ['paste'] });
  }

  /** The text field labelled `label` (label, identifier or, failing that, the first field at/below a matching label). */
  async fill(label, text, opts) {
    const field = await waitFor(async () => {
      const els = (await this.elements()).filter((e) => e.type !== 'Application');
      const fields = els.filter((e) => TEXT_TYPES.test(e.type));
      const own = fields.find((f) => f.label === label || f.id === label);
      if (own) return own;
      const lab = pickMatch(els, label, opts);
      const below = fields.filter((f) => f.y >= lab.y - 5).sort((a, b) => a.y - b.y)[0];
      if (!below) throw new NotFound(`no text field at or below: ${label}`);
      return below;
    }, this.wait);
    await this.fillAt(Math.round(field.x + field.w / 2), Math.round(field.y + field.h / 2), text);
  }

  /** Focus the field at (x, y) points, select all, delete, type `text`. */
  async fillAt(x, y, text) {
    await this.tapxy(x, y);
    // Focus shows the keyboard; with a hardware keyboard attached it never does (nor, to XCUITest, a third-party
    // one), so don't wait long for it: half a second, however long each check takes (~0.2 s on a real device).
    for (const until = Date.now() + 500; Date.now() < until && !(await this.keyboardShown()); ) await sleep(50);
    await this.call('key', { keys: ['selectall', 'delete'] });
    if (!text) return;
    await this.type(text);
    // A web field drops keys typed while WebKit applies an autocorrection ("sam_kim@…" stays "sam_kim"): when
    // it doesn't hold the text, paste it instead, which nothing corrects, then empty the pasteboard again.
    if (!this.pastes || (await this.holds(x, y, text))) return;
    await this.call('key', { keys: ['selectall', 'delete'] });
    await this.paste(text);
    const ok = await this.holds(x, y, text);
    run('xcrun', ['simctl', 'pbcopy', this.udid], { input: '' });
    if (!ok) console.error(`looktap: warning: the field at ${x},${y} doesn't read back exactly what was typed (expected if it formats its input) — check it with: looktap ls`);
  }

  /**
   Whether the text field at (x, y) reads `text` (a secure field: that many dots), allowing a second for a web
   view to catch up. A field that reports no value isn't held against it; one that can't be found isn't proof
   either way (a read can miss a web page while its autocorrection bubble animates in), so it counts as not.
   */
  async holds(x, y, text) {
    const dots = new RegExp(`^[•●]{${[...text].length}}$`);
    for (const until = Date.now() + 1000; ; await sleep(100)) {
      const field = (await this.elements()).find((e) => TEXT_TYPES.test(e.type) && x >= e.x && x <= e.x + e.w && y >= e.y && y <= e.y + e.h);
      if (field && (field.value == null || field.value === text || dots.test(field.value))) return true;
      if (Date.now() > until) return false;
    }
  }

  /**
   Dismiss the keyboard, trying in order: its own Done/Return key; the ✓ at the end of a web form's
   accessory bar (the row with Previous/Next); a tap on plain text above it, which blurs a web field.
   Checked after each — never reports success while the keyboard is still up.
   */
  async hidekb() {
    if (!(await this.keyboardShown())) return console.log('no keyboard');
    const { elements } = await this.snapshot();
    const kb = keyboardArea(elements);
    const top = kb ? kb.y : Infinity;
    const center = (e) => [Math.round(e.x + e.w / 2), Math.round(e.y + e.h / 2)];
    const attempts = [];
    const key = elements.find((e) => e.type === 'Button' && (DONE_KEYS.includes(e.label) || DONE_KEYS.includes(e.id)));
    if (key) attempts.push(['its Done key', key]);
    const prev = elements.find((e) => e.type === 'Button' && e.label === 'Previous' && e.y < top);
    if (prev) {
      const row = elements.filter((e) => e.type === 'Button' && Math.abs(e.y - prev.y) <= 4 && e.label !== 'Previous' && e.label !== 'Next');
      const done = row.sort((a, b) => b.x - a.x)[0];
      if (done) attempts.push(['the form bar ✓', done]);
    }
    const text = elements
      .filter((e) => /^(StaticText|Heading)$/.test(e.type) && e.label && e.y + e.h < Math.min(top, prev ? prev.y : Infinity) && e.y > 60)
      .sort((a, b) => a.y - b.y)[0];
    if (text) attempts.push([`a tap on "${text.label.slice(0, 30)}"`, text]);
    for (const [how, e] of attempts) {
      await this.tapxy(...center(e));
      for (let i = 0; i < 10 && (await this.keyboardShown()); i++) await sleep(50);
      if (!(await this.keyboardShown())) return console.log(`keyboard hidden (${how})`);
    }
    throw new UsageError(
      "keyboard is still up — it has no Done/Return key and tapping outside the field didn't dismiss it. Tap the screen's cancel/close control",
    );
  }

  /** Named keys: return, escape, delete, tab, space, selectall, paste, home, or a HID usage number. */
  async keys(names) {
    await this.call('key', { keys: names }).catch((e) => {
      const bad = /unknown key: (\S+)/.exec(e.message);
      throw bad ? new UsageError(`unknown key: ${bad[1]} (try return, escape, delete, tab, space, selectall, paste, home)`) : e;
    });
  }

  /** `hold` (ms): stay still before lifting, so the content doesn't coast. True: the screen is still once it returns. */
  async swipe(x1, y1, x2, y2, ms = 150, { hold = 0 } = {}) {
    await this.call('swipe', { x1: +x1, y1: +y1, x2: +x2, y2: +y2, ms: +ms, ...(hold && { hold }) });
    return hold > 0; // the simulator helper's swipe never coasts; the device runner holds
  }

  /**
   iOS has no system back: tap the navigation bar's back button (UIKit tags it "BackButton"), else a
   button labelled Back in the top-left corner — what custom (e.g. React Native) headers draw.
   */
  async back() {
    const b = await waitFor(async () => {
      const { screen, elements } = await this.snapshot();
      const hit =
        elements.find((e) => e.id === 'BackButton') ||
        elements.find((e) => e.type === 'Button' && /^(back|go back|navigate up)$/i.test(e.label) && e.y < screen.h * 0.2 && e.x < screen.w / 2);
      if (!hit) throw new NotFound("no back button on this screen — tap the screen's own close/back control");
      return hit;
    }, this.wait);
    await this.tapxy(Math.round(b.x + b.w / 2), Math.round(b.y + b.h / 2));
  }

  /** `scale` < 1 shrinks the image (fewer image tokens when an agent looks at it). */
  async shot(name, { scale = 1 } = {}) {
    const p = shotPath(this.out, name);
    writeFileSync(p, (await this.call('shot', { scale })).body);
    console.log(p);
  }

  /** Frames whenever the display changes, for `seconds`. */
  async burst(dir, seconds) {
    let distinct = 0;
    const r = await this.call(
      'burst',
      { seconds },
      { onFrame: (_, body) => writeFileSync(shotPath(dir, `b_${String(++distinct).padStart(4, '0')}`), body), timeout: seconds * 1000 + 10000 },
    );
    return { frames: r.frames, distinct };
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
    run('xcrun', ['simctl', 'openurl', this.udid, link]);
  }

  /** Start the app fresh. `startedAt`: just before the start itself, after the old copy has gone. */
  /** `resume`: bring the app forward as it was (simctl launch leaves a running app as it is). */
  async launch(app, { resume = false } = {}) {
    if (resume) return void run('xcrun', ['simctl', 'launch', this.udid, app]);
    run('xcrun', ['simctl', 'terminate', this.udid, app], { allowFail: true });
    const startedAt = Date.now();
    run('xcrun', ['simctl', 'launch', '--terminate-running-process', this.udid, app]);
    return { startedAt };
  }

  /**
   CPU, memory and threads of the running app. A simulator app is a process on the Mac, so the Mac's own tools read
   it: CPU time from ps over `ms`, the memory footprint (what Xcode's gauge shows) and its peak from footprint.
   */
  async perf(app, ms = 500, known = 0) {
    // `known`: the pid from an earlier reading (perf --for), so each reading skips the lookups (~0.6 s).
    if (!known) this.executable(app); // a clear error when it isn't installed
    const pid = known || (await this.pidOf(app));
    if (!pid) throw new UsageError(`${app} isn't running — start it: looktap launch ${app}`);
    const cpuTime = () => psTime(run('ps', ['-o', 'time=', '-p', String(pid)], { allowFail: true }));
    const t0 = Date.now(), c0 = cpuTime();
    await sleep(ms);
    const c1 = cpuTime(), wall = Date.now() - t0;
    if (c0 == null || c1 == null) throw new Error(`${app} stopped while being measured — see: looktap crashes ${app}`);
    const { footprint, peak } = parseFootprint(run('footprint', ['-f', 'bytes', '-p', String(pid)], { allowFail: true }));
    const threads = run('ps', ['-M', '-p', String(pid)], { allowFail: true }).trim().split('\n').length - 1 || null;
    return { pid, ms: wall, cpu: ((c1 - c0) * 1000 * 100) / wall, memory: [['footprint', footprint], ['peak', peak]], threads };
  }

  /**
   Frames as the screen shows them: the helper notes each framebuffer update (the first call starts it), and each
   call reports those since the last one. It's the whole screen, not the app's own rendering, which only Instruments
   sees, and Instruments' Animation Hitches doesn't support the simulator.
   */
  async frames() {
    const r = await this.call('frames');
    return r.started ? { started: true } : screenFrames(r.times || []);
  }

  /** Terminate the app. Returns the pid it had, or 0 when it wasn't running. */
  async stop(app) {
    this.executable(app); // a clear error when it isn't installed
    const pid = await this.pidOf(app);
    if (pid) run('xcrun', ['simctl', 'terminate', this.udid, app], { allowFail: true });
    return pid;
  }

  /** Install a simulator build (.app). Returns its bundle id. */
  async install(path) {
    if (!/\.app\/?$/.test(path) || !existsSync(join(path, 'Info.plist')))
      throw new UsageError(`${path} is not a simulator .app bundle (build for "iOS Simulator"; .ipa files are for devices)`);
    run('xcrun', ['simctl', 'install', this.udid, path], { timeout: 120000 });
    return run('plutil', ['-extract', 'CFBundleIdentifier', 'raw', join(path, 'Info.plist')], { allowFail: true }).trim() || null;
  }

  /** Where the app lives on the Mac: [what, path, note] for its bundle, its data folder and each app group (by id). */
  async paths(app) {
    const container = (kind) => run('xcrun', ['simctl', 'get_app_container', this.udid, app, kind], { allowFail: true }).trim();
    const bundle = container('app');
    if (!bundle) throw new UsageError(`${app} is not installed on this simulator`);
    const groups = container('groups').split('\n').map((l) => l.split('\t')).filter(([id, path]) => id && path);
    return [['bundle', bundle], ['data', container('data')], ...groups.map(([id, path]) => ['group', path, id])].filter(([, path]) => path);
  }

  /** Installed apps: { id, name, version, system }. `all`: Apple's own apps too. */
  async apps({ all = false } = {}) {
    const plist = run('xcrun', ['simctl', 'listapps', this.udid], { timeout: 30000 });
    const json = run('plutil', ['-convert', 'json', '-o', '-', '-'], { input: plist });
    return simApps(JSON.parse(json)).filter((a) => all || !a.system);
  }

  async uninstall(app) {
    this.executable(app); // a clear error when it isn't installed
    run('xcrun', ['simctl', 'uninstall', this.udid, app], { timeout: 60000 });
  }

  /**
   The app as if freshly installed: its own bundle is copied aside, the app uninstalled (data, app groups,
   permissions go with it) and the copy installed again. The keychain survives, as it does on a real iPhone.
   */
  async reset(app) {
    const bundle = run('xcrun', ['simctl', 'get_app_container', this.udid, app], { allowFail: true }).trim();
    if (!bundle) throw new UsageError(`${app} is not installed on this simulator`);
    const tmp = mkdtempSync(join(tmpdir(), 'looktap-'));
    try {
      const copy = join(tmp, bundle.split('/').pop());
      cpSync(bundle, copy, { recursive: true, verbatimSymlinks: true });
      run('xcrun', ['simctl', 'terminate', this.udid, app], { allowFail: true });
      run('xcrun', ['simctl', 'uninstall', this.udid, app], { timeout: 60000 });
      run('xcrun', ['simctl', 'install', this.udid, copy], { timeout: 120000 });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  /** grant | revoke | reset a privacy permission. Some changes terminate the app (simctl's doing). */
  async permission(action, name, app) {
    run('xcrun', ['simctl', 'privacy', this.udid, action, iosService(name), app]);
  }

  async location(lat, lon) {
    run('xcrun', ['simctl', 'location', this.udid, 'set', `${lat},${lon}`]);
  }

  async clearLocation() {
    run('xcrun', ['simctl', 'location', this.udid, 'clear']);
  }

  /**
   Turn the device `turns` quarter turns counter-clockwise from portrait (0–3); without `turns`, just report.
   Resolves to the screen as it then is — an app that doesn't support the orientation stays as it was.
   */
  async rotate(turns) {
    const r = await this.call('rotate', turns != null ? { orientation: [1, 3, 2, 4][turns] } : {});
    return { turns: { 1: 0, 3: 1, 2: 2, 4: 3 }[r.screen.orientation] ?? 0, w: r.screen.w, h: r.screen.h };
  }

  /**
   Start recording the screen to `path` (H.264 .mp4) in a background simctl process. Resolves once frames are
   being written, to what recordStop needs. simctl writes the display unturned; the file is marked to play
   turned the way the screen was when recording started.
   */
  async recordStart(path) {
    const { turns } = await this.rotate();
    mkdirSync(HOME, { recursive: true });
    const log = join(HOME, `rec-${this.udid.slice(0, 8)}.log`);
    const fd = openSync(log, 'w');
    // simctl itself, not xcrun: the stop signal has to reach the process that finishes the file.
    const simctl = run('xcrun', ['-f', 'simctl']).trim();
    const p = spawn(simctl, ['io', this.udid, 'recordVideo', '--codec=h264', '--force', path], { detached: true, stdio: ['ignore', fd, fd] });
    p.unref();
    closeSync(fd);
    for (let i = 0; i < 50; i++) {
      await sleep(100);
      const said = readFileSync(log, 'utf8');
      if (/Recording started/i.test(said)) return { pid: p.pid, turns };
      if (!(await this.alive({ pid: p.pid }))) throw new Error(`recording did not start: ${said.trim().split('\n').pop() || 'simctl exited'}`);
    }
    return { pid: p.pid, turns };
  }

  /** Stop a recordStart(): simctl finishes the file on SIGINT. */
  async recordStop({ pid, path, turns }) {
    // The pid was saved by an earlier command: make sure it is still that simctl before signalling it.
    const command = run('ps', ['-p', String(pid), '-o', 'command='], { allowFail: true });
    if (!command.includes('recordVideo') || !command.includes(this.udid))
      throw new UsageError('the recording had already stopped (simctl exited, or the simulator shut down) — start a new one');
    process.kill(pid, 'SIGINT');
    for (let i = 0; i < 150 && (await this.alive({ pid })); i++) await sleep(100);
    // A quarter turn counter-clockwise (landscape left) plays back turned 270° clockwise.
    if (turns && existsSync(path)) setRotation(path, { 1: 270, 2: 180, 3: 90 }[turns]);
  }

  async network() {
    unsupported(this.kind, 'network');
  }

  /** Light or dark mode; without `mode`, the current one. */
  async appearance(mode) {
    if (mode) run('xcrun', ['simctl', 'ui', this.udid, 'appearance', mode]);
    return run('xcrun', ['simctl', 'ui', this.udid, 'appearance']).trim();
  }

  /** Dynamic Type size (a content-size category); without `size`, the current one. */
  async textSize(size) {
    if (size) run('xcrun', ['simctl', 'ui', this.udid, 'content_size', size]);
    return run('xcrun', ['simctl', 'ui', this.udid, 'content_size']).trim();
  }

  /** Deliver a remote push notification, as APNs would. */
  async push(app, payload) {
    this.executable(app); // simctl reports success even for an app that isn't installed
    try {
      run('xcrun', ['simctl', 'push', this.udid, app, '-'], { input: JSON.stringify(payload) });
    } catch (e) {
      // iOS 27 refuses a push to an app that hasn't been allowed notifications (iOS 26 delivered it anyway).
      if (/Source is not authorized|code=2003/.test(e.message))
        throw new UsageError(`${app} isn't allowed to show notifications, so iOS refuses the push — allow them in its prompt (or in Settings › Notifications) and push again`);
      throw e;
    }
  }

  /** Screenshot-clean status bar (9:41, full battery and signal), or back to live values. */
  async statusBar(clean) {
    if (!clean) return run('xcrun', ['simctl', 'status_bar', this.udid, 'clear']);
    run('xcrun', ['simctl', 'status_bar', this.udid, 'override', '--time', '9:41', '--dataNetwork', 'wifi', '--wifiMode', 'active', '--wifiBars', '3',
      '--cellularMode', 'active', '--cellularBars', '4', '--operatorName', '', '--batteryState', 'charged', '--batteryLevel', '100']);
  }

  /** Running apps: { id, pid } from launchd's UIKitApplication:<bundle id>[…] jobs. */
  runningApps() {
    const out = run('xcrun', ['simctl', 'spawn', this.udid, 'launchctl', 'list'], { allowFail: true });
    return [...out.matchAll(/^(\d+)\s+\S+\s+UIKitApplication:([^[\s]+)/gm)].map((m) => ({ pid: Number(m[1]), id: m[2] }));
  }

  /** The app in front, or null (home screen, or a system sheet with no app behind it). */
  /** A simulator has no lock screen that looktap meets. */
  async locked() {
    return false;
  }

  async foreground() {
    const f = await this.frontApp();
    return f && { id: this.appId(f), pid: f.pid };
  }

  /** The app in front as cheaply as possible — { key, pid, path } from the helper, no lookups — or null. */
  async frontApp() {
    const { pid, path } = await this.call('front');
    return pid ? { key: pid, pid, path } : null;
  }

  /** Simulator apps are host processes, so this is a signal-0 check, not a simctl call. */
  async alive(f) {
    try {
      process.kill(f.pid, 0);
      return true;
    } catch (e) {
      return e.code === 'EPERM';
    }
  }

  /** The bundle id of a frontApp(), from the Info.plist of the .app its executable lives in. */
  appId(f) {
    const app = /^(.*?\.app)\//.exec(f.path || '')?.[1];
    return (app && run('plutil', ['-extract', 'CFBundleIdentifier', 'raw', join(app, 'Info.plist')], { allowFail: true }).trim()) || null;
  }

  async pidOf(app) {
    return this.runningApps().find((a) => a.id === app)?.pid || 0;
  }

  /** The app's executable name, which is what the unified log and crash reports call it. */
  executable(app) {
    const info = run('xcrun', ['simctl', 'appinfo', this.udid, app], { allowFail: true });
    const exe = /CFBundleExecutable = "?([^";]+)"?;/.exec(info)?.[1];
    if (!exe) throw new UsageError(`${app} is not installed on this simulator`);
    return exe;
  }

  /**
   The app's unified-log lines since `since` (ms): what the app's own code logged (anything in its
   bundle), plus errors and faults from anything in the process except the simulator's own noise (low-level
   networking, the keyboard). `errors`: only errors and faults. `all`: everything, Apple frameworks included.
   */
  async readLogs(app, since, { errors = false, all = false } = {}) {
    const exe = this.executable(app);
    const d = new Date(since);
    const p = (n) => String(n).padStart(2, '0');
    const start = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    const bad = '(messageType == error OR messageType == fault)';
    let pred = `process == "${exe}" AND eventType == logEvent`;
    if (errors) pred += ` AND ${bad}`;
    else if (!all) pred += ` AND (senderImagePath CONTAINS ".app/" OR ${bad})`;
    if (!all) pred += ` AND NOT (subsystem IN {${NOISY.map((s) => `"${s}"`).join(', ')}})`;
    const out = run('xcrun', ['simctl', 'spawn', this.udid, 'log', 'show', '--style', 'compact', '--info', '--debug', '--start', start, '--predicate', pred], {
      allowFail: true,
      timeout: 60000,
    });
    const lines = [];
    for (const line of out.split('\n')) {
      const m = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d\.\d{3}) (\w+)\s+\S+?\[\d+:\w+\] (.*)$/.exec(line);
      if (m) {
        const t = Date.parse(`${m[1]}T${m[2]}`);
        const level = { E: 'E', F: 'F', Df: 'D', Db: 'D', I: 'I' }[m[3]] || m[3];
        if (t >= since) lines.push({ t, text: `${m[2]} ${level} ${m[4]}` });
      } else if (line && lines.length && !line.startsWith('Timestamp') && !line.startsWith('getpwuid')) {
        lines[lines.length - 1].text += `\n  ${line}`; // a multi-line message continues
      }
    }
    return lines;
  }

  /** Crash reports this simulator wrote for the app since `since`, each summarised in a few lines. */
  async readCrashes(app, since) {
    const exe = this.executable(app);
    const dir = join(homedir(), 'Library', 'Logs', 'DiagnosticReports');
    const found = [];
    for (const f of existsSync(dir) ? readdirSync(dir) : []) {
      if (!f.startsWith(`${exe}-`) || !f.endsWith('.ips')) continue;
      const path = join(dir, f);
      const t = statSync(path).mtimeMs;
      if (t < since) continue;
      const text = readFileSync(path, 'utf8');
      const nl = text.indexOf('\n');
      let body;
      try {
        body = JSON.parse(text.slice(nl + 1));
      } catch {
        continue;
      }
      if (!String(body.procPath || '').includes(this.udid)) continue; // another simulator, or a Mac app
      found.push({ t, text: summariseIps(body, path) });
    }
    if (!found.length) found.push(...this.exits(app, since));
    return found.sort((a, b) => a.t - b.t);
  }

  /**
   Exits by signal since `since`, from the simulator's own record (runningboardd). The .ips report is
   written up to a minute after a crash; this is there at once, so a fresh crash isn't reported as none.
   */
  exits(app, since) {
    const d = new Date(since);
    const p = (n) => String(n).padStart(2, '0');
    const start = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    const out = run('xcrun', ['simctl', 'spawn', this.udid, 'log', 'show', '--style', 'compact', '--start', start, '--predicate',
      `process == "runningboardd" AND eventMessage CONTAINS "app<${app}(" AND eventMessage CONTAINS "termination reported by launchd"`], { allowFail: true, timeout: 30000 });
    return parseExits(out, app, since);
  }

  async bio(result) {
    const ev = result === 'match' ? 'match' : 'nomatch';
    run('xcrun', ['simctl', 'spawn', this.udid, 'notifyutil', '-p', `com.apple.BiometricKit_Sim.pearl.${ev}`]);
  }
}

/** An .ips crash report → exception, reason, and the crashed thread's top frames. */
export function summariseIps(r, path) {
  const ex = r.exception || {};
  const out = [`${r.procName || 'app'} crashed at ${r.captureTime || '?'} — ${ex.type || '?'}${ex.signal ? ` (${ex.signal})` : ''}`];
  if (r.termination?.indicator) out.push(`  ${r.termination.indicator}`);
  // The uncaught-exception reason (NSException, Swift fatalError) is in the application-specific info.
  for (const msgs of Object.values(r.asi || {})) for (const m of [].concat(msgs)) out.push(`  ${String(m).trim().slice(0, 300)}`);
  const images = r.usedImages || [];
  const thread = (r.threads || [])[r.faultingThread ?? -1] || (r.threads || []).find((t) => t.triggered);
  const frames = r.lastExceptionBacktrace?.length ? r.lastExceptionBacktrace : thread?.frames || [];
  for (const f of frames.slice(0, 12)) {
    const img = images[f.imageIndex]?.name || '?';
    out.push(`  ${img.padEnd(22)} ${f.symbol ? f.symbol + (f.symbolLocation ? ` + ${f.symbolLocation}` : '') : `+${f.imageOffset}`}`);
  }
  out.push(`  report: ${path}`);
  return out.join('\n');
}

const SIGNALS = Object.fromEntries(Object.entries(osConstants.signals).map(([name, n]) => [n, name]));

/**
 runningboardd's "termination reported by launchd (2, <signal>, …)" lines → exits by signal. SIGTERM and
 SIGKILL are left out: that's how apps are stopped on purpose (simctl terminate, a relaunch, an uninstall).
 */
export function parseExits(out, app, since) {
  const found = [];
  for (const m of out.matchAll(/^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d\.\d{3}).*?:(\d+)\] termination reported by launchd \(2, (\d+), \d+\)/gm)) {
    const [, day, time, pid, sig] = m;
    const t = Date.parse(`${day}T${time}`);
    const name = SIGNALS[Number(sig)] || `signal ${sig}`;
    if (t < since || name === 'SIGTERM' || name === 'SIGKILL') continue;
    found.push({ t, text: `${app} (pid ${pid}) crashed at ${time} — ${name}. The full report (exception, stack) is still being written: run looktap crashes again in a minute` });
  }
  return found;
}
