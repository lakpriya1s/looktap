// Android emulator: config, the neutral oracle, and the adapters.
// The oracle can't use `uiautomator dump`: only one UiAutomation client may be connected, and Appium's server,
// Maestro's driver and looktap's helper each hold one. So it reads `dumpsys` instead: the resumed activity, the
// fragments on screen, and the view tree's ids and bounds (dumpsys shows no text, so text steps are checked by what
// they change: the search screen's results appear, the list moves).
import { execFile, execFileSync, spawn } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execP = promisify(execFile);
const LOOP = 8;

export function config() {
  const dev = process.env.BENCH_ANDROID_SERIAL || 'emulator-5554';
  const density = Number(/(\d+)/.exec(execFileSync('adb', ['-s', dev, 'shell', 'wm', 'density'], { encoding: 'utf8' }).split('\n').filter(Boolean).at(-1))[1]) / 160;
  const [w, h] = /(\d+)x(\d+)/.exec(execFileSync('adb', ['-s', dev, 'shell', 'wm', 'size'], { encoding: 'utf8' }).split('\n').filter(Boolean).at(-1)).slice(1).map(Number);
  const dp = (v) => Math.round(v * density);
  const wDp = Math.round(w / density);
  // mobile-mcp names an emulator by its AVD, not its adb serial
  const avd = dev.startsWith('emulator-') ? execFileSync('adb', ['-s', dev, 'shell', 'getprop', 'ro.boot.qemu.avd_name'], { encoding: 'utf8' }).trim() : dev;
  // Samsung's One UI Settings: its own labels and search, and Samsung Internet opens links
  const samsung = execFileSync('adb', ['-s', dev, 'shell', 'getprop', 'ro.product.manufacturer'], { encoding: 'utf8' }).trim().toLowerCase() === 'samsung';
  const oneUi = samsung && {
    browser: 'com.sec.android.app.sbrowser', label: 'Connections', fragment: 'ConnectionsSettings',
    xyDp: [Math.round(wDp / 2), Number(process.env.BENCH_ANDROID_ROW_Y || 465)], // the Connections row
    far: 'About phone', openSearch: 'Search settings', field: 'Search',
    openSearchDesc: true, // the search button has no text, only a content description
    list: 'new UiSelector().resourceId("com.android.settings:id/recycler_view")', // the first scrollable is the collapsing header
    search: 'com.android.settings.intelligence', fieldClass: 'android.widget.AutoCompleteTextView',
  };
  return {
    dev, avd, density, dp, real: !dev.startsWith('emulator-'),
    // a real phone goes into the results by its model, never its serial
    model: dev.startsWith('emulator-') ? undefined : execFileSync('adb', ['-s', dev, 'shell', 'echo "$(getprop ro.product.manufacturer) $(getprop ro.product.model) (Android $(getprop ro.build.version.release))"'], { encoding: 'utf8' }).trim(),
    app: 'com.android.settings', activity: 'com.android.settings/.Settings', browser: 'com.android.chrome',
    label: 'Network & internet', fragment: 'NetworkDashboardFragment', home: 'TopLevelSettings',
    xyDp: [Math.round(wDp / 2), Number(process.env.BENCH_ANDROID_ROW_Y || 284)], // the Network & internet row
    swipeDp: [Math.round(wDp / 2), 700, Math.round(wDp / 2), 300],
    far: 'System', openSearch: 'Search Settings', field: 'Search settings', text: 'wifi', url: 'https://example.com',
    search: 'com.google.android.settings.intelligence',
    screen: { w, h },
    ...oneUi,
  };
}

export function oracle(C) {
  const adb = (...a) => execP('adb', ['-s', C.dev, 'shell', ...a], { maxBuffer: 1e8 }).then((r) => r.stdout);
  const resumed = async () => /(?:topResumedActivity|mResumedActivity)[=:].*? u0 (\S+)/.exec(await adb('dumpsys', 'activity', 'activities'))?.[1] || '';
  const top = () => adb('dumpsys', 'activity', 'top');
  // The resumed window's view tree as ids + bounds: changes when the list scrolls or the screen changes.
  const tree = async () => {
    const t = await top();
    const last = t.lastIndexOf('View Hierarchy:');
    return t.slice(last).split('\n').map((l) => /\{[0-9a-f]+ [^}]*? (-?\d+,-?\d+--?\d+,-?\d+)(?: #\w+ (\S+))?/.exec(l)).filter(Boolean).map((m) => `${m[2] || ''}@${m[1]}`).join('|');
  };
  let freshTree = '';
  const resultRows = (t) => {
    const L = t.split('\n');
    const i = L.findIndex((l) => l.includes('app:id/list_results'));
    if (i < 0) return 0;
    const ind = L[i].length - L[i].trimStart().length;
    let n = 0;
    for (let j = i + 1; j < L.length && L[j].trim() && L[j].length - L[j].trimStart().length > ind; j++) if (!L[j].includes(' 0,0-0,0 ')) n++;
    return n;
  };
  const O = {
    screen: async () => ({ resumed: await resumed(), top: await top() }),
    async atHome() {
      for (const p of [C.app, C.browser, C.search]) await adb('am', 'force-stop', p);
      await adb('input', 'keyevent', 'KEYCODE_HOME');
      await until(async () => !(await resumed()).startsWith(C.app));
      await sleep(500);
    },
    async fresh() {
      await O.atHome();
      await adb('am', 'start', '-n', C.activity, '-f', '0x10008000');
      await until(async () => O.checks.launch(await O.screen()));
      await sleep(1500);
      freshTree = await tree();
    },
    // A rebooted device for every tool, as on iOS: no helper, UiAutomation client or state left from the tool before.
    // The emulator window stays open across the reboot.
    async reboot() {
      if (C.real) return O.reset();
      await execP('adb', ['-s', C.dev, 'reboot']).catch(() => {});
      await sleep(5000);
      await execP('adb', ['-s', C.dev, 'wait-for-device']);
      if (!(await until(async () => (await adb('getprop', 'sys.boot_completed')).trim() === '1', 300000))) throw new Error('the emulator did not finish booting');
      await sleep(15000);
      await O.idle(180000); // boot-time jobs (package scans, app updates, compilation) run for a while after boot
    },
    // A real phone isn't rebooted: it would come back at its PIN screen, and wireless debugging off. Instead the tools'
    // on-device helpers are stopped and the phone left to calm down. Keep it charging with Developer options → Stay awake.
    async reset() {
      for (const p of ['io.appium.uiautomator2.server', 'io.appium.uiautomator2.server.test', 'io.appium.settings', 'dev.mobile.maestro', 'dev.mobile.maestro.test', 'com.mobilenext.devicekit']) await adb('am', 'force-stop', p).catch(() => {});
      // Helpers that run as app_process, not as a package (each holds the one UiAutomation connection while it runs)
      for (const p of ['com.looktap.Server', 'com.mobilenext.mobilecli.DeviceServer', 'uiautomator']) await adb('pkill', '-f', p).catch(() => {});
      await adb('input', 'keyevent', 'KEYCODE_WAKEUP');
      if (/isKeyguardShowing=true/.test(await adb('dumpsys', 'window'))) throw new Error('the phone is locked: unlock it and start again');
      await O.idle(120000);
    },
    // Wait until the device's 1-minute load is under 1.0 on two checks in a row. Returns the load it started from.
    async idle(maxMs = 60000) {
      const load = async () => Number((await adb('cat', '/proc/loadavg')).split(' ')[0]);
      const first = await load().catch(() => null);
      if (C.real) return first; // a phone's load counts its own background work (this one idles near 27): noted, not waited on
      let calm = 0;
      const end = performance.now() + maxMs;
      while (performance.now() < end && calm < 2) {
        calm = (await load().catch(() => 9)) < 1.0 ? calm + 1 : 0;
        if (calm < 2) await sleep(5000);
      }
      return first;
    },
    async alive() { return (await execP('adb', ['-s', C.dev, 'get-state']).catch(() => ({ stdout: '' }))).stdout.trim() === 'device'; },
    checks: {
      launch: (s) => s.resumed.startsWith(C.app) && s.top.includes(C.home) && !s.top.includes(C.fragment),
      opened: (s) => s.top.includes(C.fragment),
      back: (s) => s.resumed.startsWith(C.app) && s.top.includes(C.home) && !s.top.includes(C.fragment),
      swiped: async (s) => s.resumed.startsWith(C.app) && (await tree()) !== freshTree,
      scrolled: async (s) => s.resumed.startsWith(C.app) && (await tree()) !== freshTree,
      // dumpsys shows no text, but the search screen's result list is empty until a query is typed (0 rows → 62 for "wifi")
      filled: (s) => s.resumed.startsWith(C.search) && resultRows(s.top) > 0,
      home: (s) => !s.resumed.startsWith(C.app),
      url: (s) => s.resumed.startsWith(C.browser),
    },
    async terminated() { return !(await adb('pidof', C.app).catch(() => '')).trim(); },
    async cleanup() {},
  };
  return O;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    try { if (await fn()) return true; } catch {}
    await sleep(150);
  }
  return false;
}

export function adapters({ C, OUT, LOOKTAP, MAESTRO, sh, mcpServer, imageFile, setImg, agentTurn }) {
  const A = {};
  const [xd, yd] = C.xyDp;
  const [px, py] = C.xyDp.map(C.dp);
  const swPx = C.swipeDp.map(C.dp);

  // ── looktap CLI (dp coordinates) ──
  const lt = (op, ...a) => sh(op, 'node', [LOOKTAP, '-p', 'android', '-d', C.dev, ...a]);
  A['looktap'] = {
    version: () => 'looktap CLI',
    start: (op) => lt(op, 'setup'),
    stop: () => lt({ calls: 0, bytes: 0 }, 'teardown'),
    launch: (op) => lt(op, 'launch', C.app),
    read: (op) => lt(op, 'ls'),
    tapLabel: (op) => lt(op, 'tap', C.label),
    back: (op) => lt(op, 'back'),
    tapXY: (op) => lt(op, 'tapxy', String(xd), String(yd)),
    swipe: (op) => lt(op, 'swipe', ...C.swipeDp.map(String)),
    scrollTo: (op) => lt(op, 'scrollto', C.far),
    // Search opens in another activity: an agent waits for its field before typing (fill waits for it)
    fill: async (op) => { await lt(op, 'tap', C.openSearch); await agentTurn(op); await lt(op, 'fill', C.field, C.text); },
    screenshot: async (op) => { await lt(op, '-o', OUT, 'shot', 'looktap'); imageFile(op, join(OUT, 'looktap.png')); },
    home: (op) => lt(op, 'key', 'home'),
    openUrl: (op) => lt(op, 'open', C.url),
    terminate: (op) => lt(op, 'stop', C.app), // since 0.3.0
  };

  // ── looktap MCP ──
  const lm = mcpServer('node', [LOOKTAP, 'mcp']);
  const lc = (op, name, a = {}) => lm.call(op, name, { platform: 'android', device: C.dev, ...a });
  A['looktap-mcp'] = {
    defs: () => lm.defs, version: () => lm.version,
    start: () => lm.open(),
    stop: () => lm.close(),
    launch: (op) => lc(op, 'looktap', { command: `launch ${C.app}` }),
    read: (op) => lc(op, 'ls'),
    tapLabel: (op) => lc(op, 'tap', { target: C.label }),
    back: (op) => lc(op, 'back'),
    tapXY: (op) => lc(op, 'tap_xy', { x: xd, y: yd }),
    swipe: (op) => lc(op, 'swipe', { x1: C.swipeDp[0], y1: C.swipeDp[1], x2: C.swipeDp[2], y2: C.swipeDp[3] }),
    scrollTo: (op) => lc(op, 'scroll_to', { target: C.far }),
    fill: async (op) => { await lc(op, 'tap', { target: C.openSearch }); await agentTurn(op); await lc(op, 'fill', { target: C.field, text: C.text }); },
    screenshot: (op) => lc(op, 'screenshot'),
    home: (op) => lc(op, 'key', { keys: ['home'] }),
    openUrl: (op) => lc(op, 'looktap', { command: `open ${C.url}` }),
    terminate: (op) => lc(op, 'looktap', { command: `stop ${C.app}` }), // since 0.3.0
  };

  // ── mobile-mcp ──
  const mm = mcpServer('npx', ['-y', '@mobilenext/mobile-mcp@1.0.11']);
  const mc = (op, name, a = {}) => mm.call(op, name, { device: C.avd, ...a });
  const mRef = (text, label) => {
    for (const line of text.split('\n')) {
      const m = /^\s*(@?\w+)\s+(\S+)\s+(?:label|text)="([^"]*)"/.exec(line);
      if (m && m[3] === label) return { ref: m[1], line };
      if (line.includes(`"${label}"`)) { const r = /^\s*(@\w+)/.exec(line); if (r) return { ref: r[1], line }; }
    }
    return null;
  };
  const mList = (op) => mc(op, 'mobile_list_elements_on_screen');
  const mTapLabel = async (op, label) => {
    const e = mRef((await mList(op)).text, label);
    if (!e) throw new Error(`no "${label}" in the element list`);
    await mc(op, 'mobile_click_on_screen_at_coordinates', { ref: e.ref });
  };
  A['mobile-mcp'] = {
    defs: () => mm.defs, version: () => mm.version,
    start: () => mm.open(),
    stop: () => mm.close(),
    launch: (op) => mc(op, 'mobile_launch_app', { packageName: C.app }),
    read: mList,
    tapLabel: (op) => mTapLabel(op, C.label),
    back: (op) => mc(op, 'mobile_press_button', { button: 'BACK' }),
    tapXY: (op) => mc(op, 'mobile_click_on_screen_at_coordinates', { x: px, y: py }),
    swipe: (op) => mc(op, 'mobile_swipe_on_screen', { direction: 'up', x: swPx[0], y: swPx[1], distance: swPx[1] - swPx[3] }),
    scrollTo: async (op) => {
      for (let i = 0; i < LOOP; i++) {
        if (mRef((await mList(op)).text, C.far)) return;
        await mc(op, 'mobile_swipe_on_screen', { direction: 'up' });
      }
    },
    fill: async (op) => {
      await mTapLabel(op, C.openSearch);
      await agentTurn(op);
      // look at the new screen before typing, until the search field is there
      for (let i = 0; i < 10 && !mRef((await mList(op)).text, C.field); i++);
      await mc(op, 'mobile_type_keys', { text: C.text });
    },
    screenshot: (op) => mc(op, 'mobile_take_screenshot'),
    home: (op) => mc(op, 'mobile_press_button', { button: 'HOME' }),
    openUrl: (op) => mc(op, 'mobile_open_url', { url: C.url }),
    terminate: (op) => mc(op, 'mobile_terminate_app', { packageName: C.app }),
  };

  // ── Maestro MCP ──
  const ms = mcpServer(MAESTRO, ['mcp']);
  const flow = (op, steps) => ms.call(op, 'run', { device_id: C.dev, yaml: `appId: ${C.app}\n---\n${steps}` });
  A['maestro-mcp'] = {
    defs: () => ms.defs, version: () => ms.version,
    start: () => ms.open(),
    stop: () => ms.close(),
    launch: (op) => flow(op, '- launchApp'),
    read: (op) => ms.call(op, 'inspect_screen', { device_id: C.dev }),
    tapLabel: (op) => flow(op, `- tapOn: "${C.label}"`),
    back: (op) => flow(op, '- back'),
    tapXY: (op) => flow(op, `- tapOn:\n    point: "${px},${py}"`),
    swipe: (op) => flow(op, `- swipe:\n    start: "${swPx[0]}, ${swPx[1]}"\n    end: "${swPx[2]}, ${swPx[3]}"`),
    scrollTo: (op) => flow(op, `- scrollUntilVisible:\n    element: "${C.far}"\n    direction: DOWN`),
    fill: (op) => flow(op, `- tapOn: "${C.openSearch}"\n- inputText: "${C.text}"`),
    screenshot: (op) => ms.call(op, 'take_screenshot', { device_id: C.dev }),
    home: (op) => flow(op, '- pressKey: Home'),
    openUrl: (op) => flow(op, `- openLink: ${C.url}`),
    terminate: (op) => flow(op, '- stopApp'),
  };

  // ── Appium MCP and the raw Appium server (same install, so only the MCP layer differs) ──
  const am = mcpServer('npx', ['-y', 'appium-mcp@1.97.1']);
  const idFrom = (text) => {
    const m = /elementId '([^']+)'/.exec(text) || /([0-9A-Fa-f]{8}-[0-9A-Fa-f-]{20,})/.exec(text) || /"(?:ELEMENT|element-6066-11e4-a52e-4f735466cecf)"\s*:\s*"([^"]+)"/.exec(text);
    if (!m) throw new Error(`no element id in: ${text.slice(0, 150)}`);
    return m[1];
  };
  const byText = (t) => ['-android uiautomator', t === C.openSearch && C.openSearchDesc ? `new UiSelector().description("${t}")` : `new UiSelector().text("${t}")`];
  const caps = { 'appium:appPackage': C.app, 'appium:appActivity': '.Settings', 'appium:noReset': true, 'appium:udid': C.dev };
  A['appium-mcp'] = {
    defs: () => am.defs, version: () => am.version,
    start: async (op) => {
      await am.open();
      await am.call(op, 'select_device', { platform: 'android', deviceUdid: C.dev });
      await am.call(op, 'appium_session_management', { action: 'create', platform: 'android', capabilities: JSON.stringify(caps) });
    },
    stop: async () => { await am.call({ calls: 0, bytes: 0 }, 'appium_session_management', { action: 'delete' }).catch(() => {}); await am.close(); },
    launch: (op) => am.call(op, 'appium_app_lifecycle', { action: 'activate', id: C.app }),
    read: (op) => am.call(op, 'appium_get_page_source', {}),
    tapLabel: async (op) => am.call(op, 'appium_gesture', { action: 'tap', elementUUID: idFrom((await am.call(op, 'appium_find_element', { strategy: byText(C.label)[0], selector: byText(C.label)[1] })).text) }),
    back: (op) => am.call(op, 'appium_mobile_press_key', { key: 'BACK' }),
    tapXY: (op) => am.call(op, 'appium_gesture', { action: 'tap', x: px, y: py }),
    swipe: (op) => am.call(op, 'appium_gesture', { action: 'swipe', x: swPx[0], y: swPx[1], endX: swPx[2], endY: swPx[3] }),
    scrollTo: (op) => am.call(op, 'appium_gesture', { action: 'scroll_to_element', strategy: byText(C.far)[0], selector: byText(C.far)[1], direction: 'down' }),
    fill: async (op) => {
      await am.call(op, 'appium_gesture', { action: 'tap', elementUUID: idFrom((await am.call(op, 'appium_find_element', { strategy: byText(C.openSearch)[0], selector: byText(C.openSearch)[1] })).text) });
      await agentTurn(op);
      // Search opens in another activity: find its field and set the text, and on an error find it again and retry,
      // as an agent would (each try is a call)
      let err = null;
      for (let i = 0; i < 5; i++) {
        const f = await am.call(op, 'appium_find_element', { strategy: 'class name', selector: C.fieldClass || 'android.widget.EditText' }).then((r) => idFrom(r.text), () => null);
        if (!f) continue;
        try { await am.call(op, 'appium_set_value', { elementUUID: f, text: C.text }); return; } catch (e) { err = e; }
      }
      throw err || new Error('no search field');
    },
    screenshot: (op) => am.call(op, 'appium_screenshot', {}),
    home: (op) => am.call(op, 'appium_mobile_press_key', { key: 'HOME' }),
    openUrl: (op) => am.call(op, 'appium_app_lifecycle', { action: 'deep_link', url: C.url, id: C.browser }),
    terminate: (op) => am.call(op, 'appium_app_lifecycle', { action: 'terminate', id: C.app }),
  };

  const URL_ = 'http://127.0.0.1:4723';
  let S = null;
  let server = null;
  const http = async (op, method, path, body) => {
    const r = await fetch(URL_ + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    op.calls++;
    op.bytes += Buffer.byteLength(text);
    op.text = text;
    if (!r.ok) throw new Error(`${method} ${path}: ${text.slice(0, 200)}`);
    return JSON.parse(text);
  };
  const ex = (op, script, arg = {}) => http(op, 'POST', `/session/${S}/execute/sync`, { script, args: [arg] });
  const el = async (op, using, value) => Object.values((await http(op, 'POST', `/session/${S}/element`, { using, value })).value)[0];
  const pointer = (op, [x1, y1, x2, y2]) => {
    const actions = [{ type: 'pointerMove', duration: 0, x: x1, y: y1 }, { type: 'pointerDown', button: 0 }];
    if (x2 !== undefined) actions.push({ type: 'pause', duration: 100 }, { type: 'pointerMove', duration: 300, x: x2, y: y2 });
    actions.push({ type: 'pointerUp', button: 0 });
    return http(op, 'POST', `/session/${S}/actions`, { actions: [{ type: 'pointer', id: 'f1', parameters: { pointerType: 'touch' }, actions }] });
  };
  A['appium'] = {
    version: () => 'Appium server (W3C HTTP)',
    start: async (op) => {
      const home = process.env.BENCH_APPIUM_HOME;
      const bin = home ? ['node', [join(home, 'node_modules', 'appium', 'index.js')]] : ['npx', ['appium']];
      server = spawn(bin[0], [...bin[1], '--port', '4723', '--log-level', 'error'], { stdio: 'ignore', env: { ...process.env, ...(home ? { APPIUM_HOME: home } : {}) } });
      for (let i = 0; i < 120; i++) { try { if ((await fetch(URL_ + '/status')).ok) break; } catch {} await sleep(500); }
      // 300 s as appium-mcp sets it: Appium's default 60 s ends the session during the runner's idle waits between runs
      S = (await http(op, 'POST', '/session', { capabilities: { alwaysMatch: { platformName: 'Android', 'appium:automationName': 'UiAutomator2', 'appium:newCommandTimeout': 300, ...caps } } })).value.sessionId;
    },
    stop: async () => { await http({ calls: 0, bytes: 0 }, 'DELETE', `/session/${S}`).catch(() => {}); server?.kill(); },
    launch: (op) => ex(op, 'mobile: activateApp', { appId: C.app }),
    read: (op) => http(op, 'GET', `/session/${S}/source`),
    tapLabel: async (op) => http(op, 'POST', `/session/${S}/element/${await el(op, ...byText(C.label))}/click`, {}),
    back: (op) => http(op, 'POST', `/session/${S}/back`, {}),
    tapXY: (op) => pointer(op, [px, py]),
    swipe: (op) => pointer(op, swPx),
    // One UI nests its list in a scrolling header, and UiScrollable stops halfway: there, find and swipe, as an agent would
    scrollTo: async (op) => {
      if (!C.list) return el(op, '-android uiautomator', `new UiScrollable(new UiSelector().scrollable(true)).scrollIntoView(new UiSelector().text("${C.far}"))`);
      for (let i = 0; i < LOOP; i++) {
        const found = (await http(op, 'POST', `/session/${S}/elements`, { using: '-android uiautomator', value: `new UiSelector().text("${C.far}")` })).value;
        if (found.length) return;
        await pointer(op, swPx);
      }
    },
    fill: async (op) => {
      await http(op, 'POST', `/session/${S}/element/${await el(op, ...byText(C.openSearch))}/click`, {});
      await agentTurn(op);
      let err = null;
      for (let i = 0; i < 5; i++) {
        const f = await el(op, 'class name', C.fieldClass || 'android.widget.EditText').catch(() => null);
        if (!f) continue;
        try { await http(op, 'POST', `/session/${S}/element/${f}/value`, { text: C.text }); return; } catch (e) { err = e; }
      }
      throw err || new Error('no search field');
    },
    screenshot: async (op) => { const r = await http(op, 'GET', `/session/${S}/screenshot`); setImg(op, Buffer.from(r.value, 'base64')); op.inline = true; },
    home: (op) => ex(op, 'mobile: pressKey', { keycode: 3 }),
    openUrl: (op) => ex(op, 'mobile: deepLink', { url: C.url, package: C.browser }),
    terminate: (op) => ex(op, 'mobile: terminateApp', { appId: C.app }),
  };

  // ── adb, the raw baseline (uiautomator dump + input) ──
  const adb = (op, ...a) => sh(op, 'adb', ['-s', C.dev, ...a]);
  const dump = (op) => adb(op, 'exec-out', 'uiautomator', 'dump', '/dev/tty');
  const nodeCenter = (xml, label) => {
    const esc = label.replace(/&/g, '&amp;').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // uiautomator's XML escapes &
    const m = new RegExp(`(?:text|content-desc)="${esc}"[^>]*?bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`).exec(xml);
    return m && [Math.round((+m[1] + +m[3]) / 2), Math.round((+m[2] + +m[4]) / 2), +m[2], +m[4]];
  };
  const dTap = async (op, label) => {
    const c = nodeCenter(await dump(op), label);
    if (!c) throw new Error(`no "${label}"`);
    await adb(op, 'shell', 'input', 'tap', String(c[0]), String(c[1]));
  };
  A['adb'] = {
    version: () => 'adb + uiautomator',
    start: async () => {},
    launch: (op) => adb(op, 'shell', 'am', 'start', '-n', C.activity),
    read: dump,
    tapLabel: (op) => dTap(op, C.label),
    back: (op) => adb(op, 'shell', 'input', 'keyevent', 'KEYCODE_BACK'),
    tapXY: (op) => adb(op, 'shell', 'input', 'tap', String(px), String(py)),
    swipe: (op) => adb(op, 'shell', 'input', 'swipe', ...swPx.map(String), '300'),
    scrollTo: async (op) => {
      for (let i = 0; i < LOOP; i++) {
        const c = nodeCenter(await dump(op), C.far);
        if (c && c[3] <= C.screen.h) return;
        await adb(op, 'shell', 'input', 'swipe', ...swPx.map(String), '300');
      }
    },
    fill: async (op) => {
      await dTap(op, C.openSearch);
      await agentTurn(op);
      for (let i = 0; i < 10 && !nodeCenter(await dump(op), C.field); i++); // read until the search field is there
      await adb(op, 'shell', 'input', 'text', C.text);
    },
    screenshot: async (op) => { const { stdout } = await execP('adb', ['-s', C.dev, 'exec-out', 'screencap', '-p'], { encoding: 'buffer', maxBuffer: 1e8 }); op.calls++; setImg(op, stdout); }, // `> shot.png` in a shell: the agent gets a file
    home: (op) => adb(op, 'shell', 'input', 'keyevent', 'KEYCODE_HOME'),
    openUrl: (op) => adb(op, 'shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', C.url),
    terminate: (op) => adb(op, 'shell', 'am', 'force-stop', C.app),
  };

  return A;
}
