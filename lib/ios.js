// iOS simulator driver: WebDriverAgent over HTTP for UI, `xcrun simctl` for the rest.
// No Appium — `setup` installs a prebuilt WebDriverAgent and launches it with simctl.
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { HOME, NotFound, UsageError, freePort, pickMatch, readJson, run, shotPath, sleep, waitFor, writeJson } from './util.js';

export const WDA_VERSION = process.env.SIMDRIVE_WDA_VERSION || '15.1.3';
const WDA_BUNDLE = 'com.facebook.WebDriverAgentRunner.xctrunner';
const STATE = join(HOME, 'wda-ports.json');

export function bootedSimulators() {
  const out = run('xcrun', ['simctl', 'list', 'devices', 'booted', '-j'], { allowFail: true });
  if (!out) return [];
  const devices = Object.values(JSON.parse(out).devices).flat();
  return devices.filter((d) => d.state === 'Booted').map((d) => ({ id: d.udid, name: d.name }));
}

function wdaApp() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x86_64';
  const dir = join(HOME, 'wda', WDA_VERSION, arch);
  const app = join(dir, 'WebDriverAgentRunner-Runner.app');
  if (existsSync(app)) return app;
  mkdirSync(dir, { recursive: true });
  const zip = join(dir, 'wda.zip');
  const url = `https://github.com/appium/WebDriverAgent/releases/download/v${WDA_VERSION}/WebDriverAgentRunner-Build-Sim-${arch}.zip`;
  console.error(`downloading WebDriverAgent ${WDA_VERSION} (${arch})…`);
  run('curl', ['-fsSL', '-o', zip, url], { timeout: 300000 });
  run('unzip', ['-q', '-o', zip, '-d', dir], { timeout: 120000 });
  rmSync(zip, { force: true });
  if (!existsSync(app)) throw new Error(`unexpected archive layout in ${url}`);
  return app;
}

async function wdaReady(port, waitMs = 0) {
  const until = Date.now() + waitMs;
  do {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return true;
    } catch {}
    if (Date.now() < until) await sleep(1000);
  } while (Date.now() < until);
  return false;
}

export class Ios {
  constructor(udid, { out, app, wait = 0 }) {
    this.udid = udid;
    this.wait = wait;
    this.out = out;
    this.app = app;
    this.base = process.env.SIMDRIVE_WDA_URL || null;
  }

  async url() {
    if (this.base) return this.base;
    const port = readJson(STATE, {})[this.udid];
    if (port && (await wdaReady(port))) return (this.base = `http://127.0.0.1:${port}`);
    throw new UsageError(`WebDriverAgent is not running on ${this.udid} — run: simdrive setup`);
  }

  async req(method, path, body) {
    const r = await fetch((await this.url()) + path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });
    const json = await r.json();
    if (!r.ok) throw new Error(`WDA ${method} ${path}: ${json?.value?.message || r.status}`);
    return json;
  }

  async session() {
    const s = (await this.req('GET', '/status')).sessionId;
    return s || (await this.req('POST', '/session', { capabilities: { alwaysMatch: {} } })).sessionId;
  }

  /** Visible labelled elements from one /source call: [{ label, x, y, w, h }]. */
  async visible() {
    const src = (await this.req('GET', '/source?format=json')).value;
    const out = [];
    const walk = (n) => {
      const label = n.label || n.name;
      const r = n.rect || {};
      if ((n.isVisible === '1' || n.isVisible === true) && label && r.width > 0)
        out.push({ label: String(label), x: r.x, y: r.y, w: r.width, h: r.height });
      (n.children || []).forEach(walk);
    };
    walk(src);
    return out;
  }

  /**
   * Fast path: an exact accessibility id is one WDA lookup and a native click.
   * Otherwise match against the visible tree (exact → unique prefix → unique contains).
   */
  async find(label, opts) {
    const s = await this.session();
    try {
      const v = (await this.req('POST', `/session/${s}/elements`, { using: 'accessibility id', value: label })).value;
      if (v?.length) return { label, element: v[0].ELEMENT, session: s };
    } catch {}
    const n = pickMatch(await this.visible(), label, opts);
    return { ...n, session: s };
  }

  // ── commands ────────────────────────────────────────────────────────────

  async setup() {
    const state = readJson(STATE, {});
    if (state[this.udid] && (await wdaReady(state[this.udid]))) {
      console.log(`WebDriverAgent already running on :${state[this.udid]}`);
      return;
    }
    const app = wdaApp();
    run('xcrun', ['simctl', 'install', this.udid, app], { timeout: 120000 });
    const port = await freePort(8100);
    run('xcrun', ['simctl', 'launch', '--terminate-running-process', this.udid, WDA_BUNDLE], {
      env: { SIMCTL_CHILD_USE_PORT: String(port) },
    });
    if (!(await wdaReady(port, 60000))) throw new Error(`WebDriverAgent did not answer on :${port} within 60s`);
    writeJson(STATE, { ...state, [this.udid]: port });
    console.log(`WebDriverAgent ${WDA_VERSION} ready on http://127.0.0.1:${port}`);
  }

  async teardown() {
    run('xcrun', ['simctl', 'terminate', this.udid, WDA_BUNDLE], { allowFail: true });
    const state = readJson(STATE, {});
    delete state[this.udid];
    writeJson(STATE, state);
    console.log('WebDriverAgent stopped');
  }

  async ls({ all = false } = {}) {
    const src = (await this.req('GET', '/source?format=json')).value;
    const rows = [];
    const walk = (n) => {
      const label = n.label || n.name;
      if ((all || n.isVisible === '1' || n.isVisible === true) && label) {
        const r = n.rect || {};
        rows.push(
          `${String(n.type || '').replace('XCUIElementType', '').padEnd(14)} ${String(Math.round(r.x ?? 0)).padStart(4)},${String(Math.round(r.y ?? 0)).padStart(4)} ${Math.round(r.width ?? 0)}x${Math.round(r.height ?? 0)}  ${String(label).slice(0, 90)}`,
        );
      }
      (n.children || []).forEach(walk);
    };
    walk(src);
    console.log(rows.join('\n'));
  }

  async tap(label, opts) {
    const m = await waitFor(() => this.find(label, opts), this.wait);
    if (m.element) {
      await this.req('POST', `/session/${m.session}/element/${m.element}/click`, {});
      console.log(`tapped ${JSON.stringify(m.label)}`);
    } else {
      const x = Math.round(m.x + m.w / 2), y = Math.round(m.y + m.h / 2);
      await this.req('POST', `/session/${m.session}/wda/tap`, { x, y });
      console.log(`tapped ${JSON.stringify(m.label)} at ${x},${y}`);
    }
  }

  async tapxy(x, y) {
    await this.req('POST', `/session/${await this.session()}/wda/tap`, { x: +x, y: +y });
  }

  async type(text) {
    await this.req('POST', `/session/${await this.session()}/wda/keys`, { value: [...text] });
  }

  async fill(label, text) {
    const s = await this.session();
    const q = label.replace(/'/g, "\\'");
    const el = await waitFor(async () => {
      const v = (
        await this.req('POST', `/session/${s}/elements`, {
          using: 'predicate string',
          value: `(type == 'XCUIElementTypeTextField' OR type == 'XCUIElementTypeTextView' OR type == 'XCUIElementTypeSecureTextField' OR type == 'XCUIElementTypeSearchField') AND (label == '${q}' OR name == '${q}' OR placeholderValue == '${q}')`,
        })
      ).value;
      if (!v?.length) throw new NotFound(`no text field labelled: ${label}`);
      return v[0].ELEMENT;
    }, this.wait);
    await this.req('POST', `/session/${s}/element/${el}/click`, {});
    await this.req('POST', `/session/${s}/wda/keys`, { value: [...('\b'.repeat(60) + text)] });
  }

  async keyboardUp(s) {
    const v = (await this.req('POST', `/session/${s}/elements`, { using: 'class name', value: 'XCUIElementTypeKeyboard' })).value;
    return Boolean(v?.length);
  }

  /** Dismiss via the keyboard's own Done/Return key, then check — never report success while it's still up. */
  async hidekb() {
    const s = await this.session();
    if (!(await this.keyboardUp(s))) return console.log('no keyboard');
    try {
      await this.req('POST', `/session/${s}/wda/keyboard/dismiss`, { keyNames: ['Done', 'done', 'Return', 'return', 'Hide keyboard'] });
    } catch {
      // checked below
    }
    if (!(await this.keyboardUp(s))) return console.log('keyboard hidden');
    throw new UsageError(
      "keyboard is still up — it has no Done/Return key (e.g. a search keyboard). Tap outside the field, or tap the screen's cancel/close control",
    );
  }

  async swipe(x1, y1, x2, y2, ms = 150) {
    await this.req('POST', `/session/${await this.session()}/wda/dragfromtoforduration`, {
      fromX: +x1, fromY: +y1, toX: +x2, toY: +y2, duration: +ms / 1000,
    });
  }

  /** iOS has no system back: tap the navigation bar's leading button (native-stack headers are UINavigationBars). */
  async back() {
    const s = await this.session();
    const el = await waitFor(async () => {
      const v = (
        await this.req('POST', `/session/${s}/elements`, {
          using: 'class chain',
          value: '**/XCUIElementTypeNavigationBar/XCUIElementTypeButton[1]',
        })
      ).value;
      if (!v?.length) throw new NotFound("no navigation-bar back button on this screen — tap the screen's own close/back control");
      return v[0].ELEMENT;
    }, this.wait);
    await this.req('POST', `/session/${s}/element/${el}/click`, {});
  }

  async shot(name) {
    const p = shotPath(this.out, name);
    run('xcrun', ['simctl', 'io', this.udid, 'screenshot', p]);
    console.log(p);
  }

  /** Fast frame grab for bursts. */
  frame(path) {
    run('xcrun', ['simctl', 'io', this.udid, 'screenshot', path], { allowFail: true });
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
