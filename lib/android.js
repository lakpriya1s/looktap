// Android emulator/device driver. No Appium, nothing installed.
// Fast path: simdrive's helper (native/android), a dex jar run with app_process that keeps one UiAutomation
// connection open, and the emulator's gRPC API for frames. Fallback: plain adb + `uiautomator dump`.
// Coordinates are dp (pixels ÷ density/160), so the same numbers work across screen densities.
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Emulator, findEmulator } from './emulator.js';
import { Helper, HelperError } from './helper.js';
import { encodePng, resizePng, scaleRgb } from './png.js';
import { HOME, NotFound, UsageError, pickMatch, readJson, run, shotPath, sleep, waitFor, writeJson } from './util.js';

const HELPER_JAR = new URL('./assets/simdrive-server.jar', import.meta.url).pathname;
let jarHash;
/** The helper's version is its jar's hash: any rebuild replaces a helper still running on the device. */
const helperVersion = () => (jarHash ??= createHash('sha1').update(readFileSync(HELPER_JAR)).digest('hex').slice(0, 12));
const HELPER_REMOTE = '/data/local/tmp/simdrive-server.jar';
const STATE = join(HOME, 'helpers.json');

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

/** Helper tree nodes ({ l, c, b: [x1,y1,x2,y2] px, f }) → the same shape as parseNodes. */
export function helperNodes(nodes, scale) {
  return nodes.map((n) => {
    const [x1, y1, x2, y2] = n.b.map((v) => Math.trunc(v / scale));
    return { label: n.l || '', x1, y1, x2, y2, cls: n.c || '', focused: Boolean(n.f) };
  });
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
    this.useHelper = process.env.SIMDRIVE_ANDROID_HELPER !== '0';
    this._helper = undefined; // undefined: not tried yet · null: unavailable, use adb
  }

  // ── helper lifecycle ──────────────────────────────────────────────────

  async hello(port) {
    try {
      const h = await Helper.open(port, 1000);
      const r = await h.call('hello', {}, { timeout: 1500 });
      if (r.version === helperVersion()) return h;
      await h.call('stop').catch(() => {});
      h.close();
    } catch {}
    return null;
  }

  /** Connect to the running helper, starting it if needed. Null (and adb fallback) if it can't run. */
  async helper() {
    if (this._helper !== undefined) return this._helper;
    this._helper = null;
    if (!this.useHelper) return null;
    const state = readJson(STATE, {});
    const saved = state.android?.[this.serial];
    let h = saved ? await this.hello(saved) : null;
    if (!h) {
      this.removeForwards();
      const port = Number(this.adb(['forward', 'tcp:0', 'localabstract:simdrive'], { allowFail: true }).trim());
      if (!port) return null;
      h = await this.hello(port);
      if (!h) {
        this.adb(['push', HELPER_JAR, HELPER_REMOTE], { allowFail: true });
        this.adb(['shell', `CLASSPATH=${HELPER_REMOTE} nohup app_process / com.simdrive.Server ${helperVersion()} >/dev/null 2>&1 &`], { allowFail: true });
        for (let i = 0; i < 25 && !h; i++) {
          await sleep(200);
          h = await this.hello(port);
        }
        if (!h) {
          console.error('simdrive: Android helper did not start — falling back to uiautomator dump (slower)');
          return null;
        }
      }
      writeJson(STATE, { ...state, android: { ...state.android, [this.serial]: port } });
    }
    return (this._helper = h);
  }

  /** Drop this device's port forwards to the helper (each start makes one). */
  removeForwards() {
    for (const line of this.adb(['forward', '--list'], { allowFail: true }).split('\n')) {
      const [serial, local, remote] = line.trim().split(/\s+/);
      if (serial === this.serial && remote === 'localabstract:simdrive') this.adb(['forward', '--remove', local], { allowFail: true });
    }
  }

  /** Run `fn(helper)`; on a helper connection problem fall back to `fallback()`. Helper-reported errors are thrown. */
  async via(fn, fallback) {
    const h = await this.helper();
    if (h) {
      try {
        return await fn(h);
      } catch (e) {
        if (!(e instanceof HelperError)) throw e;
        this._helper = null;
      }
    }
    return fallback();
  }

  emulator() {
    if (this._emu === undefined) {
      const ep = process.env.SIMDRIVE_EMULATOR_GRPC !== '0' && findEmulator(this.serial);
      this._emu = ep ? new Emulator(ep) : null;
    }
    return this._emu;
  }

  close() {
    this._helper?.close();
    this._emu?.close();
  }

  adb(args, opts) {
    return run('adb', ['-s', this.serial, ...args], { timeout: 20000, ...opts });
  }

  get scale() {
    if (this._scale == null) this._scale = parseDensity(this.adb(['shell', 'wm', 'density'], { allowFail: true }));
    return this._scale;
  }

  async nodes() {
    return this.via(async (h) => helperNodes((await h.call('tree')).nodes, this.scale), () => this.dumpNodes());
  }

  async dumpNodes() {
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

  async keyboardShown() {
    return this.via(
      async (h) => (await h.call('keyboard')).shown,
      () => this.adb(['shell', 'dumpsys', 'input_method'], { allowFail: true }).includes('mInputShown=true'),
    );
  }

  async key(...codes) {
    return this.via(
      (h) => h.call('key', { keys: codes }),
      () => this.adb(['shell', 'input', 'keyevent', ...codes]),
    );
  }

  // ── commands ────────────────────────────────────────────────────────────

  async setup() {
    // Metro on the host is not the emulator's localhost.
    this.adb(['reverse', 'tcp:8081', 'tcp:8081'], { allowFail: true });
    const h = await this.helper();
    const grpc = this.emulator() ? ' · emulator gRPC frames' : '';
    console.log(`adb ${this.serial} ready · scale ${this.scale} (dp = px ÷ ${this.scale}) · reverse tcp:8081 · helper ${h ? 'on' : 'off (uiautomator dump)'}${grpc}`);
  }

  async teardown() {
    this.adb(['reverse', '--remove-all'], { allowFail: true });
    // Stop the helper: it holds the device's only UiAutomation connection (Appium / uiautomator need it).
    const state = readJson(STATE, {});
    const port = state.android?.[this.serial];
    const h = port ? await this.hello(port) : null;
    if (h) await h.call('stop').catch(() => {});
    this.adb(['shell', 'pkill', '-f', 'com.simdrive.Server'], { allowFail: true });
    this.removeForwards();
    if (state.android) delete state.android[this.serial];
    writeJson(STATE, state);
    console.log('removed adb reverse rules · helper stopped');
  }

  /** The screen for the platform-neutral layer (lib/screen.js): { screen: {w, h}, elements } in dp. */
  async snapshot() {
    const nodes = await this.nodes();
    const root = nodes[0];
    const screen = root ? { w: root.x2 - root.x1, h: root.y2 - root.y1 } : { w: 0, h: 0 };
    const elements = nodes.map((n) => ({
      label: n.label, type: n.cls.split('.').pop(), x: n.x1, y: n.y1, w: n.x2 - n.x1, h: n.y2 - n.y1,
    }));
    return { screen, elements };
  }

  async tap(label, opts) {
    const n = await waitFor(() => this.find(label, opts), this.wait);
    const [x, y] = center(n);
    await this.tapxy(x, y);
    console.log(`tapped ${JSON.stringify(n.label)} at ${x},${y}`);
  }

  async tapxy(x, y) {
    const [px, py] = [x, y].map((v) => Math.trunc(v * this.scale));
    return this.via(
      (h) => h.call('tap', { x: px, y: py }),
      () => this.adb(['shell', 'input', 'tap', String(px), String(py)]),
    );
  }

  async type(text) {
    return this.via(
      (h) => h.call('text', { s: text }),
      () => this.adb(['shell', 'input', 'text', escapeInput(text)]),
    );
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
    await this.fillAt(...center(hit), text);
  }

  /** Focus the field at (x, y) dp, clear it, type `text`, then Enter. */
  async fillAt(x, y, text) {
    await this.tapxy(x, y);
    // The helper empties the field once it has focus; otherwise give focus a moment and backspace it clear.
    const cleared = await this.via(async (h) => (await h.call('clear', { wait: 1500 })).cleared, () => false);
    if (!cleared) {
      await sleep(300);
      await this.key('KEYCODE_MOVE_END', ...Array(60).fill('KEYCODE_DEL'));
    }
    if (text) await this.type(text);
    // RN TextInput only blurs (and shows validation) on Enter or focus change — Back just hides the keyboard.
    await this.key('KEYCODE_ENTER');
    await sleep(300);
    if (await this.keyboardShown()) await this.key('KEYCODE_BACK');
  }

  async hidekb() {
    if (!(await this.keyboardShown())) return console.log('no keyboard');
    await this.key('KEYCODE_BACK');
    for (let i = 0; i < 6 && (await this.keyboardShown()); i++) await sleep(100);
    if (await this.keyboardShown()) throw new UsageError('keyboard is still up after Back');
    console.log('keyboard hidden');
  }

  async swipe(x1, y1, x2, y2, ms = 300) {
    const [a, b, c, d] = [x1, y1, x2, y2].map((v) => Math.trunc(v * this.scale));
    return this.via(
      (h) => h.call('swipe', { x1: a, y1: b, x2: c, y2: d, ms }),
      () => this.adb(['shell', 'input', 'swipe', ...[a, b, c, d].map(String), String(ms)]),
    );
  }

  async back() {
    await this.key('KEYCODE_BACK');
  }

  /**
   * Emulators: ask the emulator host for the frame (gRPC, else the console), which ignores FLAG_SECURE.
   * Physical devices, or --plain: the helper's UiAutomation screenshot, else screencap.
   */
  /** `scale` < 1 shrinks the image (fewer image tokens when an agent looks at it). */
  async shot(name, { plain = false, scale = 1 } = {}) {
    const p = shotPath(this.out, name);
    const emu = !plain && this.emulator();
    if (emu) {
      const img = await emu.screenshot().catch(() => null);
      if (img) {
        const s = scaleRgb(img.width, img.height, img.pixels, 3, scale);
        writeFileSync(p, encodePng(s.width, s.height, s.pixels, 3));
        return console.log(p);
      }
    }
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
      resizePng(p, scale);
    } else {
      await this.via(
        async (h) => writeFileSync(p, (await h.call('shot', { scale })).body),
        () => (this.frame(p), resizePng(p, scale)),
      );
    }
    console.log(p);
  }

  /** Fallback frame grab for bursts (screencap — black on FLAG_SECURE screens). */
  frame(path) {
    const buf = this.adb(['exec-out', 'screencap', '-p'], { binary: true, allowFail: true });
    if (buf.length) writeFileSync(path, buf);
  }

  /**
   * Frames whenever the screen changes, for `seconds`: the emulator's frame stream, else the helper's
   * capture loop. Identical frames are dropped. Returns { frames, distinct }, or null when neither is available.
   */
  async burst(dir, seconds) {
    const ms = seconds * 1000;
    let frames = 0, distinct = 0;
    const seen = new Set();
    const keep = (png, rawKey) => {
      frames++;
      const h = createHash('md5').update(rawKey).digest('hex');
      if (seen.has(h)) return;
      seen.add(h);
      writeFileSync(shotPath(dir, `b_${String(++distinct).padStart(4, '0')}`), png());
    };
    const emu = this.emulator();
    if (emu) {
      try {
        await emu.stream(ms, (img) => keep(() => encodePng(img.width, img.height, img.pixels, 3), img.pixels));
        return { frames, distinct };
      } catch {}
    }
    return this.via(
      async (h) => {
        const r = await h.call('burst', { seconds }, { onFrame: (_, body) => keep(() => body, body), timeout: ms + 10000 });
        return { frames: r.frames, distinct };
      },
      () => null,
    );
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

