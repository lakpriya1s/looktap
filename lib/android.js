// Android emulator/device driver. No Appium, nothing installed.
// Fast path: simwright's helper (native/android), a dex jar run with app_process that keeps one UiAutomation
// connection open, and the emulator's gRPC API for frames. Fallback: plain adb + `uiautomator dump`.
// Coordinates are dp (pixels ÷ density/160), so the same numbers work across screen densities.
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Emulator, findEmulator } from './emulator.js';
import { Helper, HelperError } from './helper.js';
import { TEXT_SIZES, sizeForScale } from './conditions.js';
import { androidPermissions } from './permissions.js';
import { encodePng, resizePng, scaleRgb } from './png.js';
import { HOME, UsageError, pickMatch, readJson, run, shotPath, sleep, waitFor, writeJson } from './util.js';

const HELPER_JAR = new URL('./assets/simwright-server.jar', import.meta.url).pathname;
let jarHash;
/** The helper's version is its jar's hash: any rebuild replaces a helper still running on the device. */
const helperVersion = () => (jarHash ??= createHash('sha1').update(readFileSync(HELPER_JAR)).digest('hex').slice(0, 12));
const HELPER_REMOTE = '/data/local/tmp/simwright-server.jar';
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
    this._scale = process.env.SIMWRIGHT_SCALE ? Number(process.env.SIMWRIGHT_SCALE) : null;
    this.useHelper = process.env.SIMWRIGHT_ANDROID_HELPER !== '0';
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
      const port = Number(this.adb(['forward', 'tcp:0', 'localabstract:simwright'], { allowFail: true }).trim());
      if (!port) return null;
      h = await this.hello(port);
      if (!h) {
        this.adb(['push', HELPER_JAR, HELPER_REMOTE], { allowFail: true });
        this.adb(['shell', `CLASSPATH=${HELPER_REMOTE} nohup app_process / com.simwright.Server ${helperVersion()} >/dev/null 2>&1 &`], { allowFail: true });
        for (let i = 0; i < 25 && !h; i++) {
          await sleep(200);
          h = await this.hello(port);
        }
        if (!h) {
          console.error('simwright: Android helper did not start — falling back to uiautomator dump (slower)');
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
      if (serial === this.serial && remote === 'localabstract:simwright') this.adb(['forward', '--remove', local], { allowFail: true });
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
      const ep = process.env.SIMWRIGHT_EMULATOR_GRPC !== '0' && findEmulator(this.serial);
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
    this.adb(['shell', 'pkill', '-f', 'com.simwright.Server'], { allowFail: true });
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
    // RN TextInput only blurs (and shows validation) on Enter or focus change. No Back to hide the
    // keyboard afterwards: if Enter submits and the keyboard closes first, Back leaves the screen
    // (it closed a sign-in tab once). `hidekb` hides it explicitly.
    await this.key('KEYCODE_ENTER');
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

  /** Named keys (return, escape, delete, tab, space, back, home) or any KEYCODE_* name. */
  async keys(names) {
    const named = { return: 'ENTER', enter: 'ENTER', escape: 'ESCAPE', delete: 'DEL', backspace: 'DEL', tab: 'TAB', space: 'SPACE', back: 'BACK', home: 'HOME' };
    await this.key(...names.map((n) => `KEYCODE_${named[n.toLowerCase()] || n.toUpperCase().replace(/^KEYCODE_/, '')}`)).catch((e) => {
      const bad = /unknown key: (\S+)/.exec(e.message);
      throw bad ? new UsageError(`unknown key: ${bad[1]} (try return, escape, delete, tab, space, back, home)`) : e;
    });
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
      const dir = mkdtempSync(join(tmpdir(), 'simwright-'));
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

  /** Install an .apk, replacing an installed copy and keeping its data. `grant`: all runtime permissions. */
  async install(path, { grant = false } = {}) {
    if (!/\.apk$/i.test(path)) throw new UsageError(`${path} is not an .apk`);
    const before = this.packages();
    const out = this.adb(['install', '-r', ...(grant ? ['-g'] : []), path], { timeout: 180000, allowFail: true });
    if (!/Success/.test(out)) throw new UsageError(`install failed: ${out.trim().split('\n').pop() || 'no output from adb'}`);
    // New, or reinstalled: each install gets a fresh /data/app/~~… folder, so its path changes.
    const changed = [...this.packages()].filter(([pkg, apk]) => before.get(pkg) !== apk);
    return changed.length === 1 ? changed[0][0] : null;
  }

  /** Installed packages → their APK path. */
  packages() {
    const out = this.adb(['shell', 'pm', 'list', 'packages', '-f'], { allowFail: true });
    return new Map([...out.matchAll(/^package:(.+)=([\w.]+)\s*$/gm)].map((m) => [m[2], m[1]]));
  }

  async uninstall(app) {
    const out = this.adb(['uninstall', app], { allowFail: true });
    if (!/Success/.test(out)) throw new UsageError(`${app} is not installed on ${this.serial}`);
  }

  /** The app as if freshly installed: data, caches and runtime permissions cleared (pm clear). */
  async reset(app) {
    const out = this.adb(['shell', 'pm', 'clear', app], { allowFail: true });
    if (!/Success/.test(out)) throw new UsageError(`${app} is not installed on ${this.serial}`);
  }

  /** Runtime permissions the app asks for: { name: granted }. */
  runtimePermissions(app) {
    const out = this.adb(['shell', 'dumpsys', 'package', app], { allowFail: true });
    const section = /runtime permissions:\n((?:\s+android\.permission\.\S+: granted=\w+.*\n)+)/.exec(out)?.[1] || '';
    return Object.fromEntries([...section.matchAll(/android\.permission\.(\w+): granted=(\w+)/g)].map((m) => [m[1], m[2] === 'true']));
  }

  /**
   grant | revoke | reset, for the runtime permissions behind `name` that the app asks for. Reset revokes
   and clears the "user set / don't ask again" flags, so the app prompts again.
   */
  async permission(action, name, app) {
    this.uidOf(app); // a clear error when it isn't installed
    const asked = this.runtimePermissions(app);
    const wanted = androidPermissions(name);
    const perms = wanted === 'all' ? Object.keys(asked) : wanted.filter((p) => p in asked);
    if (!perms.length)
      throw new UsageError(`${app} doesn't ask for ${wanted === 'all' ? 'any runtime permission' : wanted.join(' / ')} (it asks for: ${Object.keys(asked).join(', ') || 'none'})`);
    for (const p of perms) {
      const full = `android.permission.${p}`;
      if (action === 'grant') this.adb(['shell', 'pm', 'grant', app, full]);
      else {
        this.adb(['shell', 'pm', 'revoke', app, full]);
        if (action === 'reset') this.adb(['shell', 'pm', 'clear-permission-flags', app, full, 'user-set', 'user-fixed']);
      }
    }
    return perms;
  }

  /** GPS fix through the emulator console. A physical device has no way to set it from outside. */
  async location(lat, lon) {
    if (!this.serial.startsWith('emulator-')) throw new UsageError('location works on emulators only (a device needs a mock-location app)');
    const out = this.adb(['emu', 'geo', 'fix', String(lon), String(lat)], { allowFail: true }); // the console takes longitude first
    if (/KO/.test(out)) throw new Error(`emulator refused the location: ${out.trim()}`);
  }

  async clearLocation() {
    throw new UsageError("the Android emulator keeps its last location; set another with: simwright location <lat> <lon>");
  }

  /** Light or dark (night) mode; without `mode`, the current one. */
  async appearance(mode) {
    if (mode) this.adb(['shell', 'cmd', 'uimode', 'night', mode === 'dark' ? 'yes' : 'no']);
    return / yes/.test(this.adb(['shell', 'cmd', 'uimode', 'night'])) ? 'dark' : 'light';
  }

  /** Font scale for a text-size category; without `size`, the current category (and scale). */
  async textSize(size) {
    if (size) this.adb(['shell', 'settings', 'put', 'system', 'font_scale', String(TEXT_SIZES[size])]);
    const scale = Number(this.adb(['shell', 'settings', 'get', 'system', 'font_scale']).trim()) || 1;
    return `${sizeForScale(scale)} (font scale ${scale})`;
  }

  async push() {
    throw new UsageError('Android pushes come through Firebase (FCM): send one from your backend or the Firebase console — they can\'t be injected from adb');
  }

  /** System UI demo mode: 9:41, full battery, full Wi-Fi, no notification icons — or back to live. */
  async statusBar(clean) {
    const demo = (...extra) => this.adb(['shell', 'am', 'broadcast', '-a', 'com.android.systemui.demo', ...extra], { allowFail: true });
    if (!clean) {
      demo('-e', 'command', 'exit');
      return this.adb(['shell', 'settings', 'put', 'global', 'sysui_tuner_demo_on', '0']);
    }
    // Android 13+ shows demo values only while demo mode is switched on, not just allowed.
    this.adb(['shell', 'settings', 'put', 'global', 'sysui_demo_allowed', '1']);
    this.adb(['shell', 'settings', 'put', 'global', 'sysui_tuner_demo_on', '1']);
    demo('-e', 'command', 'enter');
    demo('-e', 'command', 'clock', '-e', 'hhmm', '0941');
    demo('-e', 'command', 'battery', '-e', 'level', '100', '-e', 'plugged', 'false');
    demo('-e', 'command', 'network', '-e', 'wifi', 'show', '-e', 'level', '4', '-e', 'fully', 'true');
    demo('-e', 'command', 'network', '-e', 'mobile', 'hide');
    demo('-e', 'command', 'notifications', '-e', 'visible', 'false');
  }

  /** The app in front as cheaply as possible: the active window's package, from the helper. Null without it. */
  async frontApp() {
    return this.via(
      async (h) => {
        const { package: pkg, pid } = await h.call('front');
        // The pid is part of the identity: a crashed app is often restarted at once, under a new pid.
        return pkg ? { key: `${pkg}:${pid}`, id: pkg, pid } : null;
      },
      () => null,
    );
  }

  /** Whether that process still runs. Windows with no app process of their own (system dialogs) count as alive. */
  async alive(f) {
    if (!f.pid) return true;
    return this.adb(['shell', 'pidof', f.id], { allowFail: true }).trim().split(/\s+/).map(Number).includes(f.pid);
  }

  appId(f) {
    return f.id;
  }

  /** The app in front: the top resumed activity's package. */
  async foreground() {
    const out = this.adb(['shell', 'dumpsys', 'activity', 'activities'], { allowFail: true });
    const id = /topResumedActivity=ActivityRecord\{\S+ \S+ ([\w.]+)\//.exec(out)?.[1];
    return id ? { id, pid: await this.pidOf(id) } : null;
  }

  async pidOf(app) {
    return Number(this.adb(['shell', 'pidof', app], { allowFail: true }).trim().split(/\s+/)[0]) || 0;
  }

  /** The app's uid: it survives restarts, unlike its pid, so one filter covers a crash and relaunch. */
  uidOf(app) {
    const out = this.adb(['shell', 'cmd', 'package', 'list', 'packages', '-U', app], { allowFail: true });
    const uid = new RegExp(`^package:${app.replace(/\./g, '\\.')} uid:(\\d+)`, 'm').exec(out)?.[1];
    if (!uid) throw new UsageError(`${app} is not installed on ${this.serial}`);
    return uid;
  }

  /** logcat lines `since` (ms), turned into { t, text } with the date and pid dropped. */
  logcat(args, since) {
    const out = this.adb(['logcat', '-d', '-v', 'year', '-T', (since / 1000).toFixed(3), ...args], { allowFail: true, timeout: 30000 });
    const lines = [];
    for (const line of out.split('\n')) {
      const m = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d\.\d{3})\s+\d+\s+\d+ (\w) (.*)$/.exec(line);
      if (m) lines.push({ t: Date.parse(`${m[1]}T${m[2]}`), text: `${m[2]} ${m[3]} ${m[4].replace(/^(\S*)\s*:/, '$1:')}` });
    }
    return lines.filter((l) => l.t >= since);
  }

  /** The app's logcat lines since `since` (ms). React Native's console.* is tagged ReactNativeJS. */
  async readLogs(app, since, { errors = false } = {}) {
    return this.logcat([`--uid=${this.uidOf(app)}`, ...(errors ? ['*:E'] : [])], since);
  }

  /** Java crashes and native tombstones (the crash buffer), ANRs and other exits, for the app since `since`. */
  async readCrashes(app, since) {
    // A report starts at "FATAL EXCEPTION" (Java) or the "*** *** ***" banner (native tombstone).
    const blocks = [];
    for (const l of this.logcat(['-b', 'crash'], since)) {
      if (!blocks.length || /FATAL EXCEPTION|\*\*\* \*\*\* \*\*\*/.test(l.text)) blocks.push({ t: l.t, lines: [] });
      blocks.at(-1).lines.push(l.text);
    }
    const found = blocks
      .filter((b) => b.lines.some((x) => x.includes(`Process: ${app},`) || x.includes(`>>> ${app} <<<`)))
      .map((b) => ({ t: b.t, text: b.lines.slice(0, 25).join('\n') + (b.lines.length > 25 ? `\n  … ${b.lines.length - 25} more lines` : '') }));
    for (const l of this.logcat(['-s', 'ActivityManager:E'], since))
      if (l.text.includes(`ANR in ${app}`)) found.push({ t: l.t, text: l.text });
    found.push(...this.exits(app, since));
    return found.sort((a, b) => a.t - b.t);
  }

  /**
   Why the app's processes ended (Android 11+ keeps the record): crashes, ANRs, and the deaths that leave
   no crash report — low-memory kills above all. Stops the user or simwright asked for are left out.
   */
  exits(app, since) {
    return parseExits(this.adb(['shell', 'dumpsys', 'activity', 'exit-info', app], { allowFail: true }), app, since);
  }

  async bio(result) {
    // Finger 1 is the one enrolled in Settings; any other id is an unrecognised finger.
    this.adb(['emu', 'finger', 'touch', result === 'match' ? '1' : '9']);
  }
}

/** `dumpsys activity exit-info` → the app's exits since `since` (ms), stops on request left out. */
export function parseExits(out, app, since) {
  const found = [];
  for (const m of out.matchAll(/timestamp=(\S+ \S+) pid=(\d+)[^\n]*\n\s*process=\S+ reason=\d+ \((.+?)\) subreason[^\n]*\n\s*importance=(\d+)[^\n]*description=([^\n]*?) state=/g)) {
    const [, ts, pid, reason, importance, desc] = m;
    const t = Date.parse(ts.replace(' ', 'T'));
    if (!(t >= since) || reason === 'USER REQUESTED') continue;
    const why = { LOW_MEMORY: ' — killed by the system to free memory, not a crash' }[reason] || '';
    const where = Number(importance) <= 100 ? 'in front' : 'in the background';
    found.push({ t, text: `${app} (pid ${pid}) exited at ${ts.split(' ')[1]} while ${where}: ${reason}${why}${desc !== 'null' ? ` (${desc})` : ''}` });
  }
  return found;
}
