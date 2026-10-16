// iOS simulator adapters. Each does a step the way an agent using that tool would: when the tool can't act on a
// label, the agent reads the screen first and acts on what it found (counted as an extra call). null = n/a.
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const center = (f) => [Math.round(f.x + f.width / 2), Math.round(f.y + f.height / 2)];
const LOOP = 8; // swipes an agent tries before giving up on scrolling to something

export default function ({ C, OUT, LOOKTAP, MAESTRO, sh, mcpServer, imageFile, setImg, sleep }) {
  const [sx1, sy1, sx2, sy2] = C.swipe;
  const fullyOn = (y, h) => y >= 0 && y + h <= C.screenH;
  const A = {};

  // ── looktap, the CLI an agent runs from its shell ──
  const lt = (op, ...a) => sh(op, 'node', [LOOKTAP, '-p', 'ios', '-d', C.dev, ...a]);
  A['looktap'] = {
    version: () => 'looktap CLI',
    start: (op) => lt(op, 'setup'),
    stop: () => lt({ calls: 0, bytes: 0 }, 'teardown'),
    launch: (op) => lt(op, 'launch', C.app),
    read: (op) => lt(op, 'ls'),
    tapLabel: (op) => lt(op, 'tap', C.label),
    back: (op) => lt(op, 'back'),
    tapXY: (op) => lt(op, 'tapxy', ...C.xy.map(String)),
    swipe: (op) => lt(op, 'swipe', ...C.swipe.map(String)),
    scrollTo: (op) => lt(op, 'scrollto', C.far),
    fill: (op) => lt(op, 'fill', C.field, C.text),
    screenshot: async (op) => { await lt(op, '-o', OUT, 'shot', 'looktap'); imageFile(op, join(OUT, 'looktap.png')); },
    home: null, // no home button command on iOS
    openUrl: (op) => lt(op, 'open', C.url),
    terminate: null, // `launch` restarts; there is no stop
  };

  // ── looktap MCP ──
  const lm = mcpServer('node', [LOOKTAP, 'mcp']);
  const lc = (op, name, a = {}) => lm.call(op, name, { platform: 'ios', device: C.dev, ...a });
  A['looktap-mcp'] = {
    defs: () => lm.defs, version: () => lm.version,
    start: () => lm.open(),
    stop: () => lm.close(),
    launch: (op) => lc(op, 'looktap', { command: `launch ${C.app}` }),
    read: (op) => lc(op, 'ls'),
    tapLabel: (op) => lc(op, 'tap', { target: C.label }),
    back: (op) => lc(op, 'back'),
    tapXY: (op) => lc(op, 'tap_xy', { x: C.xy[0], y: C.xy[1] }),
    swipe: (op) => lc(op, 'swipe', { x1: sx1, y1: sy1, x2: sx2, y2: sy2 }),
    scrollTo: (op) => lc(op, 'scroll_to', { target: C.far }),
    fill: (op) => lc(op, 'fill', { target: C.field, text: C.text }),
    screenshot: (op) => lc(op, 'screenshot'),
    home: null,
    openUrl: (op) => lc(op, 'looktap', { command: `open ${C.url}` }),
    terminate: null,
  };

  // ── mobile-mcp: list elements (with @refs), act on a ref or coordinates ──
  const mm = mcpServer('npx', ['-y', '@mobilenext/mobile-mcp@1.0.11']);
  const mc = (op, name, a = {}) => mm.call(op, name, { device: C.dev, ...a });
  const mRef = (text, label, types) => {
    for (const line of text.split('\n')) {
      const m = /^\s*(@?\w+)\s+(\w+)\s+label="([^"]*)"/.exec(line);
      if (m && m[3] === label && (!types || types.includes(m[2]))) return { ref: m[1], line };
    }
    return null;
  };
  const mList = (op) => mc(op, 'mobile_list_elements_on_screen');
  const mTapLabel = async (op, label, types) => {
    const r = await mList(op);
    const e = mRef(r.text, label, types);
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
    back: (op) => mTapLabel(op, C.backLabel, ['Button']),
    tapXY: (op) => mc(op, 'mobile_click_on_screen_at_coordinates', { x: C.xy[0], y: C.xy[1] }),
    swipe: (op) => mc(op, 'mobile_swipe_on_screen', { direction: 'up', x: sx1, y: sy1, distance: sy1 - sy2 }),
    scrollTo: async (op) => {
      for (let i = 0; i < LOOP; i++) {
        const e = mRef((await mList(op)).text, C.far);
        const at = e && /at=(-?[\d.]+),(-?[\d.]+)\s+size=([\d.]+)x([\d.]+)/.exec(e.line);
        if (at && fullyOn(+at[2], +at[4])) return;
        await mc(op, 'mobile_swipe_on_screen', { direction: 'up' });
      }
    },
    fill: async (op) => {
      await mTapLabel(op, C.field, ['TextField', 'SearchField']);
      await mc(op, 'mobile_type_keys', { text: C.text });
    },
    screenshot: (op) => mc(op, 'mobile_take_screenshot'),
    home: (op) => mc(op, 'mobile_press_button', { button: 'HOME' }),
    openUrl: (op) => mc(op, 'mobile_open_url', { url: C.url }),
    terminate: (op) => mc(op, 'mobile_terminate_app', { packageName: C.app }),
  };

  // ── ios-simulator-mcp (idb underneath): find an element, tap its centre ──
  const im = mcpServer('npx', ['-y', 'ios-simulator-mcp@2.1.0']);
  const ic = (op, name, a = {}) => im.call(op, name, { udid: C.dev, ...a });
  const iFind = async (op, label, types) => {
    const els = JSON.parse((await ic(op, 'ui_find_element', { search: [label] })).text || '[]');
    const e = els.find((x) => x.AXLabel === label && (!types || types.includes(x.type)));
    if (!e) throw new Error(`no "${label}" found`);
    return e;
  };
  const iTapLabel = async (op, label, types) => {
    const [x, y] = center((await iFind(op, label, types)).frame);
    await ic(op, 'ui_tap', { x, y });
  };
  A['ios-simulator-mcp'] = {
    defs: () => im.defs, version: () => im.version,
    start: () => im.open(),
    stop: () => im.close(),
    launch: (op) => ic(op, 'launch_app', { bundle_id: C.app }),
    read: (op) => ic(op, 'ui_describe_all'),
    tapLabel: (op) => iTapLabel(op, C.label),
    back: (op) => iTapLabel(op, C.backLabel, ['Button']),
    tapXY: (op) => ic(op, 'ui_tap', { x: C.xy[0], y: C.xy[1] }),
    swipe: (op) => ic(op, 'ui_swipe', { x_start: sx1, y_start: sy1, x_end: sx2, y_end: sy2 }),
    scrollTo: async (op) => {
      for (let i = 0; i < LOOP; i++) {
        const e = await iFind(op, C.far).catch(() => null);
        if (e && fullyOn(e.frame.y, e.frame.height)) return;
        await ic(op, 'ui_swipe', { x_start: sx1, y_start: sy1, x_end: sx2, y_end: sy2 });
      }
    },
    fill: async (op) => {
      await iTapLabel(op, C.field, ['TextField', 'SearchField']);
      await ic(op, 'ui_type', { text: C.text });
    },
    screenshot: async (op) => {
      const p = join(OUT, 'ios-simulator-mcp.png');
      await ic(op, 'screenshot', { output_path: p });
      imageFile(op, p);
    },
    home: null, // no hardware-button tool
    openUrl: (op) => ic(op, 'open_url', { url: C.url }),
    terminate: (op) => ic(op, 'terminate_app', { bundle_id: C.app }),
  };

  // ── MobileBuildMCP (formerly XcodeBuildMCP) with its simulator + ui-automation workflows: snapshot refs ──
  const bm = mcpServer('npx', ['-y', 'mobilebuildmcp@2.7.1', 'mcp'], { MOBILEBUILDMCP_ENABLED_WORKFLOWS: 'simulator,ui-automation' });
  const bRef = (text, label, role) => {
    for (const line of text.split('\n')) {
      const [ref, , r, l] = line.trim().split('|');
      if (l === label && (!role || r === role)) return ref;
    }
    return null;
  };
  const bSnap = (op) => bm.call(op, 'snapshot_ui');
  const bTapLabel = async (op, label, role) => {
    const ref = bRef((await bSnap(op)).text, label, role);
    if (!ref) throw new Error(`no "${label}" in the snapshot`);
    await bm.call(op, 'tap', { elementRef: ref });
  };
  A['mobilebuildmcp'] = {
    defs: () => bm.defs, version: () => bm.version,
    start: async (op) => {
      await bm.open();
      await bm.call(op, 'session_set_defaults', { simulatorId: C.dev, bundleId: C.app });
    },
    stop: () => bm.close(),
    launch: (op) => bm.call(op, 'launch_app_sim'),
    read: bSnap,
    tapLabel: (op) => bTapLabel(op, C.label),
    back: (op) => bTapLabel(op, C.backLabel, 'button'),
    tapXY: null, // taps take an elementRef only
    swipe: (op) => bm.call(op, 'gesture', { preset: 'scroll-up' }),
    scrollTo: async (op) => {
      for (let i = 0; i < LOOP; i++) {
        if (bRef((await bSnap(op)).text, C.far)) return;
        await bm.call(op, 'gesture', { preset: 'scroll-up' });
      }
    },
    fill: async (op) => {
      const ref = bRef((await bSnap(op)).text, C.field, 'text-field');
      if (!ref) throw new Error('no search field in the snapshot');
      await bm.call(op, 'type_text', { elementRef: ref, text: C.text });
    },
    screenshot: async (op) => { await bm.call(op, 'screenshot'); imageFile(op); },
    home: (op) => bm.call(op, 'button', { buttonType: 'home' }),
    openUrl: null,
    terminate: (op) => bm.call(op, 'stop_app_sim'),
  };

  // ── Maestro MCP: inline flows ──
  const ms = mcpServer(MAESTRO, ['mcp']);
  const flow = (op, steps, appId = C.app) => ms.call(op, 'run', { device_id: C.dev, yaml: `appId: ${appId}\n---\n${steps}` });
  A['maestro-mcp'] = {
    defs: () => ms.defs, version: () => ms.version,
    start: () => ms.open(),
    stop: () => ms.close(),
    launch: (op) => flow(op, '- launchApp'),
    read: (op) => ms.call(op, 'inspect_screen', { device_id: C.dev }),
    tapLabel: (op) => flow(op, `- tapOn: "${C.label}"`),
    back: (op) => flow(op, `- tapOn: "${C.backLabel}"`), // Maestro's `back` is Android-only
    tapXY: (op) => flow(op, `- tapOn:\n    point: "${C.xy.join(',')}"`),
    swipe: (op) => flow(op, `- swipe:\n    start: "${sx1}, ${sy1}"\n    end: "${sx2}, ${sy2}"`),
    scrollTo: (op) => flow(op, `- scrollUntilVisible:\n    element: "${C.far}"\n    direction: DOWN`),
    // `tapOn: "Search"` matches the Settings row named Search first; an agent reads the screen and taps the field
    // (the element whose hint is "Search") by its bounds.
    fill: async (op) => {
      const find = (e) => (e.hint === C.field ? e : (e.c || []).map(find).find(Boolean));
      const f = JSON.parse((await ms.call(op, 'inspect_screen', { device_id: C.dev })).content.at(-1).text).elements.map(find).find(Boolean);
      if (!f) throw new Error('no search field in inspect_screen');
      const [x1, y1, x2, y2] = f.b.match(/\d+/g).map(Number);
      await flow(op, `- tapOn:\n    point: "${Math.round((x1 + x2) / 2)},${Math.round((y1 + y2) / 2)}"\n- inputText: "${C.text}"`);
    },
    screenshot: (op) => ms.call(op, 'take_screenshot', { device_id: C.dev }),
    home: (op) => flow(op, '- pressKey: Home'),
    openUrl: (op) => flow(op, `- openLink: ${C.url}`),
    terminate: (op) => flow(op, '- stopApp'),
  };

  // ── Appium MCP (its own Appium + WebDriverAgent) ──
  const am = mcpServer('npx', ['-y', 'appium-mcp@1.97.1']);
  const idFrom = (text) => {
    const m = /elementId '([^']+)'/.exec(text) || /([0-9A-Fa-f]{8}-[0-9A-Fa-f-]{20,})/.exec(text) || /"(?:ELEMENT|element-6066-11e4-a52e-4f735466cecf)"\s*:\s*"([^"]+)"/.exec(text);
    if (!m) throw new Error(`no element id in: ${text.slice(0, 150)}`);
    return m[1];
  };
  const aFind = async (op, strategy, selector) => idFrom((await am.call(op, 'appium_find_element', { strategy, selector })).text);
  // Appium's best case: a WebDriverAgent built once beforehand (BENCH_WDA_DERIVED_DATA, an xcodebuild -derivedDataPath)
  // instead of xcodebuild on every session, which on this Mac (Xcode 26.0.1) fails with code 65.
  const WDA = process.env.BENCH_WDA_DERIVED_DATA ? { 'appium:usePrebuiltWDA': true, 'appium:derivedDataPath': process.env.BENCH_WDA_DERIVED_DATA } : {};
  const FIELD = ['-ios predicate string', `label == "${C.field}" AND type IN {"XCUIElementTypeTextField","XCUIElementTypeSearchField"}`];
  A['appium-mcp'] = {
    defs: () => am.defs, version: () => am.version,
    start: async (op) => {
      await am.open();
      await am.call(op, 'prepare_ios_simulator', { udid: C.dev });
      await am.call(op, 'select_device', { platform: 'ios', iosDeviceType: 'simulator', deviceUdid: C.dev });
      await am.call(op, 'appium_session_management', { action: 'create', platform: 'ios', capabilities: JSON.stringify({ 'appium:bundleId': C.app, 'appium:noReset': true, ...WDA }) });
    },
    stop: async () => { await am.call({ calls: 0, bytes: 0 }, 'appium_session_management', { action: 'delete' }).catch(() => {}); await am.close(); },
    launch: (op) => am.call(op, 'appium_app_lifecycle', { action: 'activate', id: C.app }),
    read: (op) => am.call(op, 'appium_get_page_source', {}),
    tapLabel: async (op) => am.call(op, 'appium_gesture', { action: 'tap', elementUUID: await aFind(op, 'accessibility id', C.label) }),
    back: (op) => am.call(op, 'appium_gesture', { action: 'back' }),
    tapXY: (op) => am.call(op, 'appium_gesture', { action: 'tap', x: C.xy[0], y: C.xy[1] }),
    swipe: (op) => am.call(op, 'appium_gesture', { action: 'swipe', x: sx1, y: sy1, endX: sx2, endY: sy2 }),
    scrollTo: (op) => am.call(op, 'appium_gesture', { action: 'scroll_to_element', strategy: 'accessibility id', selector: C.far, direction: 'down' }),
    fill: async (op) => am.call(op, 'appium_set_value', { elementUUID: await aFind(op, ...FIELD), text: C.text }),
    screenshot: (op) => am.call(op, 'appium_screenshot', {}),
    home: (op) => am.call(op, 'appium_mobile_press_key', { key: 'HOME' }),
    openUrl: (op) => am.call(op, 'appium_app_lifecycle', { action: 'deep_link', url: C.url, id: C.browser }),
    terminate: (op) => am.call(op, 'appium_app_lifecycle', { action: 'terminate', id: C.app }),
  };

  // ── Appium server over raw W3C HTTP (what a script, not an agent, would do) ──
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
    if (x2 !== undefined) actions.push({ type: 'pause', duration: 100 }, { type: 'pointerMove', duration: 250, x: x2, y: y2 });
    actions.push({ type: 'pointerUp', button: 0 });
    return http(op, 'POST', `/session/${S}/actions`, { actions: [{ type: 'pointer', id: 'f1', parameters: { pointerType: 'touch' }, actions }] });
  };
  A['appium'] = {
    version: () => 'Appium server (W3C HTTP)',
    start: async (op) => {
      // BENCH_APPIUM_HOME: the Appium install appium-mcp uses (same server and drivers, so only the MCP layer differs)
      const home = process.env.BENCH_APPIUM_HOME;
      const bin = home ? ['node', [join(home, 'node_modules', 'appium', 'index.js')]] : ['npx', ['appium']];
      server = spawn(bin[0], [...bin[1], '--port', '4723', '--log-level', 'error'], { stdio: 'ignore', env: { ...process.env, ...(home ? { APPIUM_HOME: home } : {}) } });
      for (let i = 0; i < 120; i++) { try { if ((await fetch(URL_ + '/status')).ok) break; } catch {} await sleep(500); }
      const caps = { platformName: 'iOS', 'appium:automationName': 'XCUITest', 'appium:udid': C.dev, 'appium:bundleId': C.app, 'appium:noReset': true, ...WDA };
      S = (await http(op, 'POST', '/session', { capabilities: { alwaysMatch: caps } })).value.sessionId;
    },
    stop: async () => { await http({ calls: 0, bytes: 0 }, 'DELETE', `/session/${S}`).catch(() => {}); server?.kill(); },
    launch: (op) => ex(op, 'mobile: launchApp', { bundleId: C.app }),
    read: (op) => http(op, 'GET', `/session/${S}/source`),
    tapLabel: async (op) => http(op, 'POST', `/session/${S}/element/${await el(op, 'accessibility id', C.label)}/click`, {}),
    back: (op) => http(op, 'POST', `/session/${S}/back`, {}),
    tapXY: (op) => pointer(op, C.xy),
    swipe: (op) => pointer(op, C.swipe),
    scrollTo: (op) => ex(op, 'mobile: scroll', { direction: 'down', predicateString: `label == "${C.far}"` }),
    fill: async (op) => http(op, 'POST', `/session/${S}/element/${await el(op, ...FIELD)}/value`, { text: C.text }),
    screenshot: async (op) => { const r = await http(op, 'GET', `/session/${S}/screenshot`); setImg(op, Buffer.from(r.value, 'base64')); op.inline = true; },
    home: (op) => ex(op, 'mobile: pressButton', { name: 'home' }),
    openUrl: (op) => ex(op, 'mobile: deepLink', { url: C.url, bundleId: C.browser }),
    terminate: (op) => ex(op, 'mobile: terminateApp', { bundleId: C.app }),
  };

  // ── idb CLI, the raw baseline under ios-simulator-mcp ──
  const idb = (op, ...a) => sh(op, 'idb', [...a, '--udid', C.dev]);
  const dFind = async (op, label, types) => {
    const els = JSON.parse(await idb(op, 'ui', 'describe-all', '--json'));
    // a text field may be named only by its placeholder (AXValue), as the Settings search field is after a fresh boot
    return els.find((x) => (!types || types.includes(x.type)) && (x.AXLabel === label || (/Field/.test(x.type) && x.AXValue === label)));
  };
  const dTapLabel = async (op, label, types) => {
    const e = await dFind(op, label, types);
    if (!e) throw new Error(`no "${label}"`);
    await idb(op, 'ui', 'tap', ...center(e.frame).map(String));
  };
  A['idb'] = {
    version: () => 'idb CLI',
    start: async () => {},
    launch: (op) => idb(op, 'launch', C.app),
    read: (op) => idb(op, 'ui', 'describe-all', '--json'),
    tapLabel: (op) => dTapLabel(op, C.label),
    back: (op) => dTapLabel(op, C.backLabel, ['Button']),
    tapXY: (op) => idb(op, 'ui', 'tap', ...C.xy.map(String)),
    swipe: (op) => idb(op, 'ui', 'swipe', ...C.swipe.map(String)),
    scrollTo: async (op) => {
      for (let i = 0; i < LOOP; i++) {
        const e = await dFind(op, C.far);
        if (e && fullyOn(e.frame.y, e.frame.height)) return;
        await idb(op, 'ui', 'swipe', ...C.swipe.map(String));
      }
    },
    fill: async (op) => {
      await dTapLabel(op, C.field, ['TextField', 'SearchField']);
      await idb(op, 'ui', 'text', C.text);
    },
    screenshot: async (op) => { const p = join(OUT, 'idb.png'); await idb(op, 'screenshot', p); imageFile(op, p); },
    home: (op) => idb(op, 'ui', 'button', 'HOME'),
    openUrl: (op) => idb(op, 'open', C.url),
    terminate: (op) => idb(op, 'terminate', C.app),
  };

  return A;
}
