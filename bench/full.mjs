// Full feature benchmark: simdrive CLI vs Appium server (raw HTTP) vs appium-mcp (MCP over stdio).
// usage: node full.mjs ios|android [runs] [tools=simdrive,appium,mcp]
// env: BENCH_IOS_UDID, BENCH_ANDROID_SERIAL (default emulator-5554), APPIUM_URL (default http://127.0.0.1:4723),
//      BENCH_DEEPLINK + BENCH_DEEPLINK_APP (a deep link and the installed app that handles it; the deep-link step is skipped without them)
// needs: an Appium 3 server with xcuitest + uiautomator2 drivers running (npx appium), and `npx appium-mcp` reachable.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { Mcp } from './mcp.mjs';

const platform = process.argv[2];
const N = Number(process.argv[3] || 10);
const TOOLS = (process.argv[4] || 'simdrive,appium,mcp').split(',');
const DIR = import.meta.dirname;
const OUT = join(DIR, 'out', platform);
const RESULTS = join(DIR, 'results');
mkdirSync(RESULTS, { recursive: true });
mkdirSync(OUT, { recursive: true });
const SIMDRIVE = join(DIR, '..', 'bin', 'simdrive.js');
const APPIUM = process.env.APPIUM_URL || 'http://127.0.0.1:4723';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();
const log = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);

const IOS = platform === 'ios';
function bootedSim() {
  const all = Object.values(JSON.parse(execFileSync('xcrun', ['simctl', 'list', 'devices', 'booted', '-j'], { encoding: 'utf8' })).devices).flat();
  if (all.length !== 1) throw new Error(`boot exactly one simulator or set BENCH_IOS_UDID (found ${all.length})`);
  return all[0].udid;
}
const C = IOS
  ? {
      dev: process.env.BENCH_IOS_UDID || bootedSim(), app: 'com.apple.Preferences',
      label: 'General', xy: [195, 311], swipeDown: [195, 650, 195, 300], swipeUp: [195, 300, 195, 650],
      field: 'Search', fieldText: 'wifi',
      appiumLabel: { using: 'accessibility id', value: 'General' },
      appiumField: { using: '-ios class chain', value: '**/XCUIElementTypeSearchField[`label == "Search"`]' },
    }
  : {
      dev: process.env.BENCH_ANDROID_SERIAL || 'emulator-5554', app: 'com.android.settings',
      label: 'Network & internet', xy: [200, 275], swipeDown: [206, 700, 206, 300], swipeUp: [206, 300, 206, 700],
      field: 'Search settings', fieldText: 'wifi', openSearch: 'Search Settings',
      appiumLabel: { using: '-android uiautomator', value: 'new UiSelector().text("Network & internet")' },
      appiumField: { using: 'class name', value: 'android.widget.EditText' },
      appiumOpenSearch: { using: '-android uiautomator', value: 'new UiSelector().text("Search Settings")' },
    };
const LINK = process.env.BENCH_DEEPLINK;
const LINK_APP = process.env.BENCH_DEEPLINK_APP;

// ── results ──
const R = {}; // R[op][tool] = [{ms, bytes, calls, err}]
function rec(tool, op, ms, bytes, calls, err) {
  ((R[op] ||= {})[tool] ||= []).push({ ms, bytes, calls, err: err ? String(err).slice(0, 160) : null });
}
async function timed(tool, op, fn) {
  const t = now();
  let bytes = 0, calls = 0, err = null;
  try {
    const r = await fn();
    bytes = r?.bytes ?? 0;
    calls = r?.calls ?? 1;
  } catch (e) {
    err = e.message;
    log(tool, op, 'ERROR', err.slice(0, 200));
  }
  rec(tool, op, now() - t, bytes, calls, err);
}

// ── adapter: simdrive (spawn the CLI per command, as a person/agent does) ──
function sdRun(...args) {
  const out = execFileSync('node', [SIMDRIVE, '-p', platform, '-d', C.dev, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return { bytes: Buffer.byteLength(out), calls: 1 };
}
const simdrive = {
  name: 'simdrive',
  setup: async () => sdRun('setup'),
  teardown: async () => sdRun('teardown'),
  ls: async () => sdRun('ls'),
  tap: async () => sdRun('tap', C.label),
  back: async () => sdRun('back'),
  tapxy: async () => sdRun('tapxy', ...C.xy.map(String)),
  swipe: async (pts) => sdRun('swipe', ...pts.map(String)),
  openSearch: async () => sdRun('tap', C.openSearch),
  fill: async () => sdRun('fill', C.field, C.fieldText),
  type: async () => sdRun('type', ' x'),
  hidekb: async () => sdRun('hidekb'),
  shot: async (i) => sdRun('shot', '-o', OUT, `simdrive_${i}`),
  launch: async () => sdRun('launch', C.app),
  open: async () => sdRun('--app', LINK_APP, 'open', LINK),
  bio: async () => sdRun('bio', 'match'),
};

// ── adapter: Appium server, raw W3C HTTP ──
let S = null;
async function http(method, path, body) {
  const r = await fetch(APPIUM + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path}: ${text.slice(0, 200)}`);
  return { json: JSON.parse(text), bytes: Buffer.byteLength(text) };
}
const exec = (script, arg = {}) => http('POST', `/session/${S}/execute/sync`, { script, args: [arg] });
const elId = (v) => Object.values(v)[0];
async function pointer(points, durationMs) {
  const [x1, y1, x2, y2] = points;
  const actions = [{ type: 'pointerMove', duration: 0, x: x1, y: y1 }, { type: 'pointerDown', button: 0 }];
  if (x2 !== undefined) actions.push({ type: 'pause', duration: 100 }, { type: 'pointerMove', duration: durationMs, x: x2, y: y2 });
  actions.push({ type: 'pointerUp', button: 0 });
  return http('POST', `/session/${S}/actions`, { actions: [{ type: 'pointer', id: 'f1', parameters: { pointerType: 'touch' }, actions }] });
}
const sum = (...rs) => ({ bytes: rs.reduce((a, r) => a + r.bytes, 0), calls: rs.length });
const appium = {
  name: 'appium',
  setup: async () => {
    const caps = IOS
      ? { platformName: 'iOS', 'appium:automationName': 'XCUITest', 'appium:udid': C.dev, 'appium:bundleId': C.app, 'appium:noReset': true,
          'appium:usePreinstalledWDA': true, 'appium:prebuiltWDAPath': join(homedir(), '.simdrive/wda/15.1.3/arm64/WebDriverAgentRunner-Runner.app') }
      : { platformName: 'Android', 'appium:automationName': 'UiAutomator2', 'appium:udid': C.dev, 'appium:appPackage': C.app, 'appium:appActivity': '.Settings', 'appium:noReset': true };
    const r = await http('POST', '/session', { capabilities: { alwaysMatch: caps } });
    S = r.json.value.sessionId;
    return r;
  },
  teardown: async () => http('DELETE', `/session/${S}`),
  ls: async () => http('GET', `/session/${S}/source`),
  tap: async () => { const f = await http('POST', `/session/${S}/element`, C.appiumLabel); return sum(f, await http('POST', `/session/${S}/element/${elId(f.json.value)}/click`, {})); },
  back: async () => http('POST', `/session/${S}/back`, {}),
  tapxy: async () => pointer(C.xy),
  swipe: async (pts) => pointer(pts, IOS ? 150 : 300),
  openSearch: async () => { const f = await http('POST', `/session/${S}/element`, C.appiumOpenSearch); return sum(f, await http('POST', `/session/${S}/element/${elId(f.json.value)}/click`, {})); },
  fill: async () => {
    const f = await http('POST', `/session/${S}/element`, C.appiumField);
    const id = elId(f.json.value);
    const c = await http('POST', `/session/${S}/element/${id}/clear`, {});
    return sum(f, c, await http('POST', `/session/${S}/element/${id}/value`, { text: C.fieldText }));
  },
  type: async () => { const a = await http('GET', `/session/${S}/element/active`); return sum(a, await http('POST', `/session/${S}/element/${elId(a.json.value)}/value`, { text: ' x' })); },
  hidekb: async () => exec('mobile: hideKeyboard', IOS ? { keys: ['Done', 'Return', 'done'] } : {}),
  shot: async (i) => { const r = await http('GET', `/session/${S}/screenshot`); writeFileSync(join(OUT, `appium_${i}.png`), Buffer.from(r.json.value, 'base64')); return r; },
  launch: async () => sum(await exec('mobile: terminateApp', IOS ? { bundleId: C.app } : { appId: C.app }), await exec('mobile: activateApp', IOS ? { bundleId: C.app } : { appId: C.app })),
  open: async () => exec('mobile: deepLink', IOS ? { url: LINK, bundleId: LINK_APP } : { url: LINK, package: LINK_APP }),
  bio: async () => (IOS ? exec('mobile: sendBiometricMatch', { type: 'faceId', match: true }) : exec('mobile: fingerprint', { fingerprintId: 1 })),
};

// ── adapter: appium-mcp over stdio (what an agent's MCP tool calls cost) ──
let M = null;
const mcpCall = async (name, args) => {
  const r = await M.call(name, args);
  if (r.isError) throw new Error(`${name}: ${r.text.slice(0, 200)}`);
  return r;
};
const idFrom = (text) => {
  const m = /elementId '([^']+)'/.exec(text) || /([0-9A-Fa-f]{8}-[0-9A-Fa-f-]{20,})/.exec(text) || /"(?:ELEMENT|element-6066-11e4-a52e-4f735466cecf)"\s*:\s*"([^"]+)"/.exec(text);
  if (!m) throw new Error(`no element id in: ${text.slice(0, 150)}`);
  return m[1];
};
const msum = (...rs) => ({ bytes: rs.reduce((a, r) => a + r.bytes, 0), calls: rs.length });
const mcp = {
  name: 'mcp',
  setup: async () => {
    M = new Mcp();
    await M.init();
    const steps = [];
    if (IOS) steps.push(await mcpCall('prepare_ios_simulator', { udid: C.dev }));
    steps.push(await mcpCall('select_device', IOS ? { platform: 'ios', iosDeviceType: 'simulator', deviceUdid: C.dev } : { platform: 'android', deviceUdid: C.dev }));
    const caps = IOS ? { 'appium:bundleId': C.app, 'appium:noReset': true } : { 'appium:appPackage': C.app, 'appium:appActivity': '.Settings', 'appium:noReset': true, 'appium:udid': C.dev };
    steps.push(await mcpCall('appium_session_management', { action: 'create', platform: platform, capabilities: JSON.stringify(caps) }));
    return msum(...steps);
  },
  teardown: async () => { const r = await mcpCall('appium_session_management', { action: 'delete' }); M.close(); return r; },
  ls: async () => mcpCall('appium_get_page_source', {}),
  tap: async () => {
    const f = await mcpCall('appium_find_element', { strategy: C.appiumLabel.using, selector: C.appiumLabel.value });
    return msum(f, await mcpCall('appium_gesture', { action: 'tap', elementUUID: idFrom(f.text) }));
  },
  back: async () => mcpCall('appium_gesture', { action: 'back' }),
  tapxy: async () => mcpCall('appium_gesture', { action: 'tap', x: C.xy[0], y: C.xy[1] }),
  swipe: async ([x, y, endX, endY]) => mcpCall('appium_gesture', { action: 'swipe', x, y, endX, endY }),
  openSearch: async () => {
    const f = await mcpCall('appium_find_element', { strategy: C.appiumOpenSearch.using, selector: C.appiumOpenSearch.value });
    return msum(f, await mcpCall('appium_gesture', { action: 'tap', elementUUID: idFrom(f.text) }));
  },
  fill: async () => {
    const f = await mcpCall('appium_find_element', { strategy: C.appiumField.using, selector: C.appiumField.value });
    return msum(f, await mcpCall('appium_set_value', { elementUUID: idFrom(f.text), text: C.fieldText }));
  },
  type: async () => {
    let a;
    try { a = await mcpCall('appium_get_active_element', {}); } catch {}
    if (a) return msum(a, await mcpCall('appium_set_value', { elementUUID: idFrom(a.text), text: ' x' }));
    // no focused element (set_value doesn't focus) — an agent re-finds the field
    const f = await mcpCall('appium_find_element', { strategy: C.appiumField.using, selector: C.appiumField.value });
    return msum({ bytes: 0 }, f, await mcpCall('appium_set_value', { elementUUID: idFrom(f.text), text: C.fieldText + ' x' }));
  },
  hidekb: async () => mcpCall('appium_mobile_keyboard', { action: 'hide' }),
  shot: async () => mcpCall('appium_screenshot', {}),
  launch: async () => msum(await mcpCall('appium_app_lifecycle', { action: 'terminate', id: C.app }), await mcpCall('appium_app_lifecycle', { action: 'activate', id: C.app })),
  open: async () => mcpCall('appium_app_lifecycle', { action: 'deep_link', url: LINK, id: LINK_APP }),
  bio: null, // appium-mcp has no biometric tool
};

// Neutral reset (not timed, same for every tool): fresh Settings at its root screen.
function reset() {
  if (IOS) {
    execFileSync('xcrun', ['simctl', 'terminate', C.dev, C.app], { stdio: 'ignore' });
    if (LINK_APP) execFileSync('xcrun', ['simctl', 'terminate', C.dev, LINK_APP], { stdio: 'ignore' });
    execFileSync('xcrun', ['simctl', 'launch', C.dev, C.app], { stdio: 'ignore' });
  } else {
    // Settings search lives in a separate package on Pixel images — stop it too, then start Settings in a cleared task
    for (const pkg of [C.app, LINK_APP, 'com.google.android.settings.intelligence'].filter(Boolean))
      execFileSync('adb', ['-s', C.dev, 'shell', 'am', 'force-stop', pkg]);
    execFileSync('adb', ['-s', C.dev, 'shell', 'input', 'keyevent', 'KEYCODE_HOME']);
    execFileSync('adb', ['-s', C.dev, 'shell', 'am', 'start', '-n', `${C.app}/.Settings`, '-f', '0x10008000'], { stdio: 'ignore' });
  }
}

// ── one scenario, identical for every tool ──
async function scenario(t) {
  log(`== ${t.name}: setup`);
  await timed(t.name, 'setup', () => t.setup());
  await sleep(2000);
  for (let i = 0; i < N; i++) {
    try { reset(); } catch {}
    await sleep(3000);
    log(`${t.name} run ${i + 1}/${N}`);
    await timed(t.name, 'ls (read screen)', () => t.ls());
    await timed(t.name, 'tap (by label)', () => t.tap());
    await sleep(1200);
    await timed(t.name, 'back', () => t.back());
    await sleep(1200);
    await timed(t.name, 'tapxy', () => t.tapxy());
    await sleep(1200);
    await t.back().catch(() => {});
    await sleep(1200);
    await timed(t.name, 'swipe', () => t.swipe(C.swipeDown));
    await sleep(800);
    await t.swipe(C.swipeUp).catch(() => {});
    await sleep(800);
    if (!IOS) {
      // neutral pre-step (not timed): fresh Settings root, then a plain adb tap on "Search Settings"
      reset(); await sleep(3000);
      execFileSync('adb', ['-s', C.dev, 'shell', 'input', 'tap', '383', '255']);
      // 4 s, not 1.5: UiAutomator2 keeps reporting the previous window for ~2-3 s after a cross-package switch
      await sleep(4000);
    }
    await timed(t.name, 'fill', () => t.fill());
    await sleep(800);
    await timed(t.name, 'type', () => t.type());
    await sleep(500);
    await timed(t.name, 'hidekb', () => t.hidekb());
    await sleep(500);
    await timed(t.name, 'shot (screenshot)', () => t.shot(i));
    // bio first, while Settings is in front — never answer the deep-linked app's own unlock prompt
    if (t.bio) await timed(t.name, 'bio', () => t.bio());
    if (LINK && LINK_APP) {
      await timed(t.name, 'open (deep link)', () => t.open());
      await sleep(2500);
    }
    await timed(t.name, 'launch (restart app)', () => t.launch());
    await sleep(3000);
  }
  // burst / screenshot throughput: how many frames in 5 seconds
  log(`${t.name}: burst`);
  if (t.name === 'simdrive') {
    const t0 = now();
    const out = execFileSync('node', [SIMDRIVE, '-p', platform, '-d', C.dev, 'burst', join(OUT, 'burst_simdrive'), '5'], { encoding: 'utf8' });
    const frames = Number(/^(\d+) frames/.exec(out)?.[1] ?? 0);
    rec(t.name, 'burst 5s (frames)', now() - t0, Buffer.byteLength(out), 1, null);
    R['burst 5s (frames)'][t.name].at(-1).frames = frames;
  } else {
    const t0 = now();
    let frames = 0, bytes = 0, calls = 0;
    while (now() - t0 < 5000) { const r = await t.shot(`burst_${frames}`); frames++; bytes += r.bytes; calls++; }
    rec(t.name, 'burst 5s (frames)', now() - t0, bytes, calls, null);
    R['burst 5s (frames)'][t.name].at(-1).frames = frames;
  }
  await timed(t.name, 'teardown', () => t.teardown());
}

const adapters = { simdrive, appium, mcp };
for (const name of TOOLS) {
  try { await scenario(adapters[name]); } catch (e) { log(name, 'ABORTED', e.message); }
  if (!IOS && name !== 'simdrive') {
    // UiAutomator2 keeps UiAutomation busy — release it so the next tool starts clean
    execFileSync('adb', ['-s', C.dev, 'shell', 'am', 'force-stop', 'io.appium.uiautomator2.server'], { stdio: 'ignore' });
    execFileSync('adb', ['-s', C.dev, 'shell', 'am', 'force-stop', 'io.appium.uiautomator2.server.test'], { stdio: 'ignore' });
  }
  await sleep(3000);
}

const tag = process.env.BENCH_TAG ? `-${process.env.BENCH_TAG}` : TOOLS.length < 3 ? `-${TOOLS.join('+')}` : '';
writeFileSync(join(RESULTS, `${platform}${tag}.json`), JSON.stringify(R, null, 2));
log('done');
