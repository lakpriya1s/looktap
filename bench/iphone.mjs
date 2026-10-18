// A real iPhone over USB: config, the neutral oracle, and the resets between steps and tools.
// The oracle is the phone's screen as macOS sees it over the cable (the capture device QuickTime records from), read
// with Vision's text recognition (eye/eye.swift). It shares nothing with the tools under test: no XCTest runner, no
// WebDriverAgent, no accessibility queries. Resets use `xcrun devicectl` only.
import { execFile, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';

const execP = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DIR = import.meta.dirname;

/** The one real iPhone connected over USB (or BENCH_IOS_UDID), or null when there is none. */
export function realIphone() {
  const want = process.env.BENCH_IOS_UDID;
  const list = devicectlSync(['list', 'devices'])?.result?.devices || [];
  const phones = list.filter((d) => d.hardwareProperties?.reality === 'physical' && d.hardwareProperties?.platform === 'iOS' && d.connectionProperties?.transportType === 'wired');
  return phones.find((d) => !want || d.hardwareProperties.udid === want) || null;
}

function devicectlSync(args) {
  const out = join(tmpdir(), `bench-devicectl-${process.pid}-${Date.now()}.json`);
  try {
    execFileSync('xcrun', ['devicectl', ...args, '--json-output', out, '-q'], { stdio: 'ignore', timeout: 60000 });
  } catch {}
  try { return JSON.parse(readFileSync(out, 'utf8')); } catch { return null; } finally { rmSync(out, { force: true }); }
}

async function devicectl(args) {
  const out = join(tmpdir(), `bench-devicectl-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  try { await execP('xcrun', ['devicectl', ...args, '--json-output', out, '-q'], { timeout: 60000 }); } catch {}
  try { return JSON.parse(readFileSync(out, 'utf8')); } catch { return null; } finally { rmSync(out, { force: true }); }
}

export function config(phone) {
  const hw = phone.hardwareProperties, dp = phone.deviceProperties;
  return {
    dev: hw.udid,
    name: dp.name, // scrubbed from the results like the UDID
    real: true,
    // what the report says about the phone: the model, never its name or UDID
    model: `${hw.marketingName} (iOS ${dp.osVersionNumber})`,
    app: 'com.apple.Preferences', appName: 'Settings', browser: 'com.apple.mobilesafari', browserName: 'Safari',
    // The real Settings app opens with account and offer banners, which push General below the fold: Family is the
    // first row with a plain label. Its page is checked by a heading that holds no personal data.
    label: 'Family', inside: 'Subscriptions', backLabel: 'Settings', xy: [197, 287], swipe: [196, 600, 196, 200],
    far: 'Developer', field: 'Search', text: 'wifi', url: 'https://example.com', screenH: 852,
    listBottom: 775, // the list ends where the floating search bar starts
    // rows only the Settings list shows (to tell it is in front)
    rows: ['Family', 'Airplane Mode', 'General', 'Accessibility', 'Privacy & Security', 'Battery', 'Developer', 'Notifications', 'Sounds & Haptics'],
  };
}

/** The eye: a long-running Swift helper; each request reads the newest frame. */
function eye(name) {
  const bin = join(DIR, 'out', 'eye');
  const src = join(DIR, 'eye', 'eye.swift');
  if (!existsSync(bin) || statSync(bin).mtimeMs < statSync(src).mtimeMs) {
    mkdirSync(join(DIR, 'out'), { recursive: true });
    execFileSync('swiftc', ['-O', src, '-o', bin], { stdio: 'ignore' });
  }
  let p = null, lines = null, queue = Promise.resolve(), size = null;
  const waiters = [];
  const start = async () => {
    p = spawn(bin, [name], { stdio: ['pipe', 'pipe', 'ignore'] });
    lines = createInterface({ input: p.stdout });
    lines.on('line', (l) => waiters.shift()?.(JSON.parse(l)));
    const first = await new Promise((r) => waiters.push(r));
    if (!first.ready) throw new Error(`the screen reader could not start: ${first.error}`);
    size = { w: first.w / 3, h: first.h / 3 }; // points (3× on every current iPhone)
  };
  const ask = (line) => (queue = queue.then(async () => {
    if (!p || p.exitCode !== null) await start();
    const answer = new Promise((r) => waiters.push(r));
    p.stdin.write(line + '\n');
    return answer;
  }));
  return {
    /** Text on screen: [{ s, x, y, w, h }] in points. */
    async read() {
      const r = await ask('ocr');
      if (r.error) throw new Error(r.error);
      return r.items.map((i) => ({ s: i.s, x: i.x * size.w, y: i.y * size.h, w: i.w * size.w, h: i.h * size.h }));
    },
    png: (path) => ask(`png ${path}`),
    close() { p?.kill(); },
  };
}

export function oracle(C, { until }) {
  const E = eye(realIphoneName(C.dev));
  const find = (els, s) => els.find((e) => e.s === s);
  const has = (els, s) => !!find(els, s);
  const inSettings = (els) => C.rows.some((r) => has(els, r)) || has(els, C.inside);
  const pids = async (paths) =>
    ((await devicectl(['device', 'info', 'processes', '--device', C.dev]))?.result?.runningProcesses || [])
      .filter((p) => paths.some((x) => (typeof x === 'string' ? p.executable?.includes(x) : x.test(p.executable || ''))))
      .map((p) => p.processIdentifier);
  // the apps' main executables (not their extensions); a URL opens in the default browser, which may not be Safari
  const APP = { [C.app]: /\/Preferences\.app\/Preferences$/, [C.browser]: /\/MobileSafari\.app\/MobileSafari$/ };
  const BROWSERS = [APP[C.browser], /\/(Brave|Chrome|Firefox|Edge|Opera|DuckDuckGo)[^/]*\.app\/[^/]+$/];
  // iOS ignores SIGTERM from the app in front: SIGKILL
  const kill = async (paths) => { for (const pid of await pids(paths)) await devicectl(['device', 'process', 'terminate', '--device', C.dev, '--pid', String(pid), '--kill']); };
  const running = async (id) => (await pids([APP[id]])).length > 0;
  const O = {};
  Object.assign(O, {
    screen: () => E.read(),
    shot: (path) => E.png(path),
    async atHome() {
      // with no app left, SpringBoard shows the home screen
      await kill([APP[C.app], ...BROWSERS]);
      await until(async () => (await pids([APP[C.app], ...BROWSERS])).length === 0, 15000);
      await until(async () => O.checks.home(await E.read()), 8000);
      await sleep(500);
    },
    async fresh() {
      await O.atHome();
      for (let i = 0; i < 4; i++) {
        await devicectl(['device', 'process', 'launch', '--device', C.dev, '--terminate-existing', C.app]);
        if (await until(async () => O.checks.launch(await E.read()), 10000)) break;
        await sleep(1000);
      }
      await sleep(1000); // the bottom search field appears a moment after the list
    },
    checks: {
      launch: (els) => { const t = find(els, C.appName); return !!t && t.y < 170 && t.h > 20 && has(els, C.label); }, // the large "Settings" title
      opened: (els) => has(els, C.inside),
      back: (els) => has(els, C.label) && !has(els, C.inside) && has(els, C.appName),
      swiped: (els) => { const f = find(els, C.label); return inSettings(els) && !has(els, C.inside) && (!f || f.y < C.xy[1] - 150); },
      scrolled: (els) => { const d = find(els, C.far); return !!d && d.y >= 0 && d.y + d.h <= C.screenH; },
      // the query as typed; "Wi-Fi" in the results doesn't count (the hyphen)
      filled: (els) => els.some((e) => e.s.toLowerCase().includes(C.text)),
      home: (els) => els.length > 3 && !inSettings(els) && !O.checks.url(els),
      // example.com's own text, in whichever browser opened it
      url: (els) => els.some((e) => /This domain is for use|Example Domain|^example\.com$/.test(e.s)),
    },
    // A fair start for every tool without a reboot (a rebooted iPhone waits at its passcode): every UI-test runner
    // and helper the tools leave behind is stopped, on the Mac and on the phone.
    async reboot() {
      for (const p of ['xcodebuild test-without-building', 'go-ios', 'runwda', 'appium', 'maestro', 'mobilecli', 'looktap.js mcp', 'mobile-mcp', 'appium-mcp']) await execP('pkill', ['-f', p]).catch(() => {});
      await kill(['xctrunner', '-Runner.app/']);
      if ((await devicectl(['device', 'info', 'lockState', '--device', C.dev]))?.result?.passcodeRequired) throw new Error('the iPhone is locked: unlock it and start again');
      await sleep(3000);
    },
    async alive() { return !!realIphone(); },
    async terminated() { return !(await running(C.app)); },
    async cleanup() { await kill(['xctrunner', '-Runner.app/']); },
    close: () => E.close(),
  });
  return O;
}

/** The capture device carries the phone's name: picked by it, so a second iPhone on the Mac is never read. */
function realIphoneName(udid) {
  const d = (devicectlSync(['list', 'devices'])?.result?.devices || []).find((x) => x.hardwareProperties?.udid === udid);
  return d?.deviceProperties?.name || '';
}
