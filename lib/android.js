// Android emulator/device driver: plain adb + uiautomator. No Appium.
// Coordinates are dp (pixels ÷ density/160), so the same numbers work across screen densities.
import { mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NotFound, UsageError, pickMatch, run, shotPath, sleep, waitFor } from './util.js';

export function adbDevices() {
  const out = run('adb', ['devices'], { allowFail: true, timeout: 10000 });
  return out
    .split('\n')
    .slice(1)
    .map((l) => l.trim().split(/\s+/))
    .filter(([id, state]) => id && state === 'device')
    .map(([id]) => ({ id, name: id }));
}

/** `wm density` prints "Physical density: 420" and, when overridden, "Override density: 480". */
export function parseDensity(text) {
  const o = /Override density:\s*(\d+)/.exec(text);
  const p = /Physical density:\s*(\d+)/.exec(text);
  const d = Number((o || p)?.[1]);
  return d > 0 ? d / 160 : 1;
}

/** Escape text for `adb shell input text`: spaces become %s and shell metacharacters are backslashed. */
export function escapeInput(text) {
  return text.replace(/ /g, '%s').replace(/([\\'"`<>|;&()$*?#~![\]{}])/g, '\\$1');
}

/** uiautomator XML → flat node list, bounds converted to dp. */
export function parseNodes(xml, scale) {
  const out = [];
  for (const m of xml.matchAll(/<node\b([^>]*?)\/?>/g)) {
    const attrs = {};
    for (const a of m[1].matchAll(/([\w-]+)="([^"]*)"/g)) attrs[a[1]] = decode(a[2]);
    const b = (attrs.bounds || '').match(/\d+/g);
    if (!b || b.length !== 4) continue;
    const [x1, y1, x2, y2] = b.map((v) => Math.trunc(Number(v) / scale));
    out.push({
      label: attrs['content-desc'] || attrs.text || '',
      x1, y1, x2, y2,
      cls: attrs.class || '',
      focused: attrs.focused === 'true',
    });
  }
  return out;
}

const decode = (s) =>
  s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#10;/g, '\n').replace(/&amp;/g, '&');

const center = (n) => [Math.trunc((n.x1 + n.x2) / 2), Math.trunc((n.y1 + n.y2) / 2)];

export class Android {
  constructor(serial, { out, app, wait = 0 }) {
    this.serial = serial;
    this.wait = wait;
    this.out = out;
    this.app = app;
    this._scale = process.env.SIMDRIVE_SCALE ? Number(process.env.SIMDRIVE_SCALE) : null;
  }

  adb(args, opts) {
    return run('adb', ['-s', this.serial, ...args], { timeout: 20000, ...opts });
  }

  get scale() {
    if (this._scale == null) this._scale = parseDensity(this.adb(['shell', 'wm', 'density'], { allowFail: true }));
    return this._scale;
  }

  async nodes() {
    for (let i = 0; i < 3; i++) {
      const raw = this.adb(['exec-out', 'uiautomator', 'dump', '/dev/tty'], { allowFail: true, timeout: 10000 });
      const start = raw.indexOf('<?xml');
      if (start >= 0) return parseNodes(raw.slice(start, raw.lastIndexOf('>') + 1), this.scale);
      await sleep(500);
    }
    throw new Error(
      'uiautomator dump failed — if an Appium session ran earlier, free UiAutomation with: adb shell am force-stop io.appium.uiautomator2.server',
    );
  }

  async find(label, opts) {
    return pickMatch((await this.nodes()).filter((n) => n.x2 > n.x1), label, opts);
  }

  keyboardShown() {
    return this.adb(['shell', 'dumpsys', 'input_method'], { allowFail: true }).includes('mInputShown=true');
  }

  key(...codes) {
    this.adb(['shell', 'input', 'keyevent', ...codes]);
  }

  // ── commands ────────────────────────────────────────────────────────────

  async setup() {
    // Metro on the host is not the emulator's localhost.
    this.adb(['reverse', 'tcp:8081', 'tcp:8081'], { allowFail: true });
    console.log(`adb ${this.serial} ready · scale ${this.scale} (dp = px ÷ ${this.scale}) · reverse tcp:8081`);
  }

  async teardown() {
    this.adb(['reverse', '--remove-all'], { allowFail: true });
    console.log('removed adb reverse rules');
  }

  async ls({ all = false } = {}) {
    const seen = new Set();
    const rows = [];
    for (const n of await this.nodes()) {
      if (!all && (!n.label || seen.has(n.label))) continue;
      seen.add(n.label);
      rows.push(`${String(n.x1).padStart(4)},${String(n.y1).padStart(4)} ${n.x2 - n.x1}x${n.y2 - n.y1}  ${n.cls.split('.').pop().padEnd(12)} ${n.label.slice(0, 90)}`);
    }
    console.log(rows.join('\n'));
  }

  async tap(label, opts) {
    const n = await waitFor(() => this.find(label, opts), this.wait);
    const [x, y] = center(n);
    await this.tapxy(x, y);
    console.log(`tapped ${JSON.stringify(n.label)} at ${x},${y}`);
  }

  async tapxy(x, y) {
    this.adb(['shell', 'input', 'tap', String(Math.trunc(x * this.scale)), String(Math.trunc(y * this.scale))]);
  }

  async type(text) {
    this.adb(['shell', 'input', 'text', escapeInput(text)]);
  }

  async fill(label, text, opts) {
    // One screen dump per attempt: the field itself, or the first field at/below its label
    // (an EditText's own label is its current text, so the label node is usually separate).
    const hit = await waitFor(async () => {
      const ns = await this.nodes();
      const edits = ns.filter((n) => n.cls.includes('EditText'));
      const own = edits.find((n) => n.label === label);
      if (own) return own;
      const lab = pickMatch(ns.filter((n) => n.x2 > n.x1), label, opts);
      return edits.filter((n) => n.y1 >= lab.y1 - 5).sort((a, b) => a.y1 - b.y1)[0] || lab;
    }, this.wait);
    await this.tapxy(...center(hit));
    await sleep(300);
    this.key('KEYCODE_MOVE_END');
    this.key(...Array(60).fill('KEYCODE_DEL'));
    if (text) await this.type(text);
    // RN TextInput only blurs (and shows validation) on Enter or focus change — Back just hides the keyboard.
    this.key('KEYCODE_ENTER');
    await sleep(300);
    if (this.keyboardShown()) this.key('KEYCODE_BACK');
  }

  async hidekb() {
    if (!this.keyboardShown()) return console.log('no keyboard');
    this.key('KEYCODE_BACK');
    await sleep(300);
    if (this.keyboardShown()) throw new UsageError('keyboard is still up after Back');
    console.log('keyboard hidden');
  }

  async swipe(x1, y1, x2, y2, ms = 300) {
    const px = [x1, y1, x2, y2].map((v) => String(Math.trunc(v * this.scale)));
    this.adb(['shell', 'input', 'swipe', ...px, String(ms)]);
  }

  async back() {
    this.key('KEYCODE_BACK');
  }

  /**
   * Emulators: ask the emulator for the frame, which ignores FLAG_SECURE (screencap would be black).
   * Physical devices, or --plain: screencap.
   */
  async shot(name, { plain = false } = {}) {
    const p = shotPath(this.out, name);
    if (!plain && this.serial.startsWith('emulator-')) {
      const dir = mkdtempSync(join(tmpdir(), 'simdrive-'));
      this.adb(['emu', 'screenrecord', 'screenshot', dir]);
      let f;
      for (let i = 0; i < 30 && !f; i++) {
        await sleep(200);
        f = readdirSync(dir).find((x) => x.endsWith('.png'));
      }
      if (!f) throw new Error('emulator screenshot timed out');
      await sleep(200); // let the emulator finish writing
      renameSync(join(dir, f), p);
      rmSync(dir, { recursive: true, force: true });
    } else {
      this.frame(p);
    }
    console.log(p);
  }

  /** Fast frame grab for bursts (screencap — black on FLAG_SECURE screens). */
  frame(path) {
    const buf = this.adb(['exec-out', 'screencap', '-p'], { binary: true, allowFail: true });
    if (buf.length) writeFileSync(path, buf);
  }

  async open(link) {
    this.adb(['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', link, ...(this.app ? [this.app] : [])]);
  }

  async launch(app) {
    this.adb(['shell', 'am', 'force-stop', app], { allowFail: true });
    // `monkey` exits non-zero on some images even when it launched, so resolve the launcher activity instead.
    const resolved = this.adb(['shell', 'cmd', 'package', 'resolve-activity', '--brief', '-c', 'android.intent.category.LAUNCHER', app], {
      allowFail: true,
    });
    const component = resolved.trim().split('\n').pop()?.trim();
    if (!component?.includes('/')) throw new UsageError(`no launchable activity for ${app} — is it installed?`);
    this.adb(['shell', 'am', 'start', '-n', component]);
  }

  async bio(result) {
    // Finger 1 is the one enrolled in Settings; any other id is an unrecognised finger.
    this.adb(['emu', 'finger', 'touch', result === 'match' ? '1' : '9']);
  }
}

