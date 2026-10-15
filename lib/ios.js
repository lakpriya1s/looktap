// iOS simulator driver. No Appium, no WebDriverAgent, nothing installed on the simulator.
// simdrive's host helper (native/ios) reads the screen and injects touches and keys through Apple's
// simulator frameworks; `xcrun simctl` handles deep links, app launch and Face ID.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Helper } from './helper.js';
import { HOME, NotFound, UsageError, pickMatch, run, shotPath, sleep, waitFor } from './util.js';

export function bootedSimulators() {
  const out = run('xcrun', ['simctl', 'list', 'devices', 'booted', '-j'], { allowFail: true });
  if (!out) return [];
  const devices = Object.values(JSON.parse(out).devices).flat();
  return devices.filter((d) => d.state === 'Booted').map((d) => ({ id: d.udid, name: d.name }));
}

const SIM_BIN = new URL('./assets/simdrive-sim', import.meta.url).pathname;
const SIM_SRC = new URL('../native/ios/build.sh', import.meta.url).pathname;
let simHash;
/** The helper's version is its binary's hash: a rebuilt helper replaces one still running. */
const simVersion = () => (simHash ??= createHash('sha1').update(readFileSync(SIM_BIN)).digest('hex').slice(0, 12));
const TEXT_TYPES = /^(TextField|TextArea|SearchField|SecureTextField|ComboBox)$/;
const DONE_KEYS = ['Done', 'done', 'Return', 'return', 'Hide keyboard', 'hide keyboard'];

export class Ios {
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
        if (!h && /simdrive-sim: /.test(readFileSync(this.log, 'utf8'))) break; // it said why it quit
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
    return (await this.call('tree', { all })).nodes.map((n) => ({
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
    console.log(`simdrive iOS helper ready on ${this.udid}`);
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
    return { screen: root ? { w: root.w, h: root.h } : { w: 0, h: 0 }, elements: els.filter((e) => e !== root) };
  }

  async tapxy(x, y) {
    await this.call('tap', { x: +x, y: +y });
  }

  /** Typed as hardware key presses; text a US layout cannot type goes through the pasteboard. */
  async type(text) {
    try {
      await this.call('text', { s: text });
    } catch (e) {
      if (!/cannot type/.test(e.message)) throw e;
      run('xcrun', ['simctl', 'pbcopy', this.udid], { input: text });
      await this.call('key', { keys: ['paste'] });
    }
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
    // Focus shows the keyboard; with a hardware keyboard attached it never does, so don't wait long for it.
    for (let i = 0; i < 10 && !(await this.keyboardShown()); i++) await sleep(50);
    await this.call('key', { keys: ['selectall', 'delete'] });
    if (text) await this.type(text);
  }

  /** Tap the keyboard's own Done/Return key, then check — never report success while it's still up. */
  async hidekb() {
    if (!(await this.keyboardShown())) return console.log('no keyboard');
    const key = (await this.elements()).find((e) => e.type === 'Button' && (DONE_KEYS.includes(e.label) || DONE_KEYS.includes(e.id)));
    if (key) {
      await this.tapxy(Math.round(key.x + key.w / 2), Math.round(key.y + key.h / 2));
      for (let i = 0; i < 10 && (await this.keyboardShown()); i++) await sleep(50);
      if (!(await this.keyboardShown())) return console.log('keyboard hidden');
    }
    throw new UsageError(
      "keyboard is still up — it has no Done/Return key (e.g. a search keyboard). Tap outside the field, or tap the screen's cancel/close control",
    );
  }

  /** Named keys: return, escape, delete, tab, space, selectall, paste, or a HID usage number. */
  async keys(names) {
    await this.call('key', { keys: names }).catch((e) => {
      const bad = /unknown key: (\S+)/.exec(e.message);
      throw bad ? new UsageError(`unknown key: ${bad[1]} (try return, escape, delete, tab, space, selectall, paste)`) : e;
    });
  }

  async swipe(x1, y1, x2, y2, ms = 150) {
    await this.call('swipe', { x1: +x1, y1: +y1, x2: +x2, y2: +y2, ms: +ms });
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

  async open(link) {
    run('xcrun', ['simctl', 'openurl', this.udid, link]);
  }

  async launch(app) {
    run('xcrun', ['simctl', 'launch', '--terminate-running-process', this.udid, app]);
  }

  async bio(result) {
    const ev = result === 'match' ? 'match' : 'nomatch';
    run('xcrun', ['simctl', 'spawn', this.udid, 'notifyutil', '-p', `com.apple.BiometricKit_Sim.pearl.${ev}`]);
  }
}
