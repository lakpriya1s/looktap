// Every agent-facing mobile tool on this machine, the same commands on the same system app, checked by a neutral oracle.
//   node bench/run.mjs ios|android [runs=10] [tool,tool,…]
// Per step it records: ms (until the tool answered), seenMs (until the oracle saw the result on screen), tool calls an
// agent needs, and bytes those calls put in its context. "n/a" means the tool has no way to do it.
// Oracle and resets are neutral and untimed: iOS `idb ui describe-all` + simctl, a real iPhone its screen over USB read
// with text recognition + devicectl (BENCH_IOS_UDID=<its UDID>, see iphone.mjs), Android `adb` (see android.mjs).
// needs: idb (fb-idb + idb-companion), Maestro, Appium 3 with xcuitest/uiautomator2, Node 20+, npx.
import { execFile, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { startMcp } from './mcp-client.mjs';
import { deviceSampler, host, sampler, settle } from './usage.mjs';

const execP = promisify(execFile);
const platform = process.argv[2];
if (!['ios', 'android'].includes(platform)) throw new Error('usage: run.mjs ios|android [runs] [tools]');
const IOS = platform === 'ios';
const N = Number(process.argv[3] || 10);
const ONLY = process.argv[4]?.split(',');
const DIR = import.meta.dirname;
const OUT = join(DIR, 'out', platform);
mkdirSync(OUT, { recursive: true });
mkdirSync(join(DIR, 'results'), { recursive: true });
// BENCH_LOOKTAP: an installed looktap's bin/looktap.js (default: this checkout)
const LOOKTAP = process.env.BENCH_LOOKTAP || join(DIR, '..', 'bin', 'looktap.js');
const MAESTRO = `${process.env.HOME}/.maestro/bin/maestro`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();
const log = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);

function bootedSim() {
  const all = Object.values(JSON.parse(execFileSync('xcrun', ['simctl', 'list', 'devices', 'booted', '-j'], { encoding: 'utf8' })).devices).flat();
  if (all.length !== 1) throw new Error(`boot exactly one simulator or set BENCH_IOS_UDID (found ${all.length})`);
  return all[0].udid;
}

// A real iPhone over USB when BENCH_IOS_UDID names one
const PHONE = IOS && process.env.BENCH_IOS_UDID ? (await import('./iphone.mjs')).realIphone() : null;
const C = PHONE
  ? (await import('./iphone.mjs')).config(PHONE)
  : IOS
  ? {
      dev: process.env.BENCH_IOS_UDID || bootedSim(),
      app: 'com.apple.Preferences', appName: 'Settings', browser: 'com.apple.mobilesafari', browserName: 'Safari',
      label: 'General', inside: 'About', backLabel: 'Settings', xy: [195, 311], swipe: [195, 600, 195, 200],
      far: 'Developer', field: 'Search', text: 'wifi', url: 'https://example.com', screenH: 844,
    }
  : (await import('./android.mjs')).config();

// ── the neutral oracle ──
const O = PHONE
  ? (await import('./iphone.mjs')).oracle(C, { until })
  : IOS
  ? (() => {
      const screen = async () => JSON.parse((await execP('idb', ['ui', 'describe-all', '--udid', C.dev, '--json'], { maxBuffer: 1e8 })).stdout);
      const find = (els, label, types) => els.find((e) => e.AXLabel === label && (!types || types.includes(e.type)));
      const front = (els) => els.find((e) => e.type === 'Application')?.AXLabel;
      const running = async (id) => (await execP('xcrun', ['simctl', 'spawn', C.dev, 'launchctl', 'list'])).stdout.includes(`UIKitApplication:${id}[`);
      const terminate = (id) => execP('xcrun', ['simctl', 'terminate', C.dev, id]).catch(() => {});
      const home = () => execP('idb', ['ui', 'button', '--udid', C.dev, 'HOME']); // this argument order marks it as the oracle's (usage.mjs)
      return {
        screen, find, running,
        async atHome() {
          await terminate(C.app);
          await terminate(C.browser);
          await home();
          await until(async () => [' ', undefined].includes(front(await screen())));
          await until(async () => !(await running(C.app)) && !(await running(C.browser)));
          await sleep(500); // launchd reaps the process a moment after it disappears from the list
        },
        async fresh() {
          await this.atHome();
          for (let i = 0; i < 4; i++) {
            // right after a terminate, launchd may not have reaped the old process yet
            const ok = await execP('xcrun', ['simctl', 'launch', C.dev, C.app]).then(() => true, () => false);
            if (ok && (await until(async () => this.checks.launch(await screen())))) break;
            await sleep(1000);
          }
          await sleep(1000); // the bottom search field appears a moment after the list
        },
        checks: {
          launch: (els) => front(els) === C.appName && !!find(els, C.label),
          opened: (els) => !!find(els, C.inside),
          back: (els) => front(els) === C.appName && !!find(els, C.label) && !find(els, C.inside),
          swiped: (els) => { const g = find(els, C.label); return front(els) === C.appName && (!g || g.frame.y < C.xy[1] - 150); },
          scrolled: (els) => { const d = find(els, C.far); return !!d && d.frame.y >= 0 && d.frame.y + d.frame.height <= C.screenH; },
          // While the field is being edited iOS leaves it out of the tree, but the results echo the query ("No Results for
          // “wifi”"). Nothing on the start screen contains the text. Case-insensitive: iOS may capitalise it.
          filled: (els) => els.some((e) => `${e.AXLabel} ${e.AXValue}`.toLowerCase().includes(C.text)),
          home: (els) => front(els) !== C.appName,
          url: (els) => front(els) === C.browserName,
        },
        // A fresh simulator for every tool: no helper, cache or broken state carried over from the tool before.
        async reboot() {
          await execP('xcrun', ['simctl', 'shutdown', C.dev]).catch(() => {});
          await execP('idb', ['kill']).catch(() => {}); // its companion holds the old simulator's ports
          await execP('xcrun', ['simctl', 'boot', C.dev]);
          await execP('xcrun', ['simctl', 'bootstatus', C.dev, '-b']);
          // Every tool runs with the Simulator window open, as a person would have it (quitting the app also shuts
          // the simulator down). Rendering the window costs the host the same for every tool.
          await execP('open', ['-a', 'Simulator', '--args', '-CurrentDeviceUDID', C.dev]);
          if (!(await until(async () => (await execP('pgrep', ['-f', 'Simulator.app/Contents/MacOS/Simulator']).catch(() => ({ stdout: '' }))).stdout.trim() !== '', 30000)))
            throw new Error('the Simulator app did not open');
          // Ask accessibility nothing until the simulator has settled: an early query can leave its accessibility
          // tree empty for the rest of that boot (every reader then sees one bare Application element).
          await sleep(20000);
          await execP('xcrun', ['simctl', 'launch', C.dev, C.app]);
          if (!(await until(async () => (await screen()).length > 3, 60000))) throw new Error('accessibility tree still empty after reboot');
          await sleep(5000);
        },
        async alive() { return (await execP('xcrun', ['simctl', 'list', 'devices', C.dev])).stdout.includes('(Booted)'); },
        async terminated() { return !(await running(C.app)); },
        async cleanup() {
          for (const id of ['com.facebook.WebDriverAgentRunner.xctrunner', 'dev.mobile.maestro-driver-iosUITests.xctrunner']) await terminate(id);
        },
      };
    })()
  : (await import('./android.mjs')).oracle(C);

async function until(fn, ms = 8000) {
  const end = now() + ms;
  while (now() < end) {
    try { if (await fn()) return true; } catch {}
    await sleep(150);
  }
  return false;
}

// ── call counting: everything an agent's context would receive ──
const newOp = () => ({ calls: 0, bytes: 0, text: '', image: 0, pausedMs: 0 });
// The model's turn between two calls of one step (an agent never fires the next call within milliseconds): waited,
// but not counted in the step's time.
const AGENT_TURN_MS = 2000;
async function agentTurn(op) { await sleep(AGENT_TURN_MS); op.pausedMs += AGENT_TURN_MS; }
async function sh(op, cmd, args) {
  const { stdout, stderr } = await execP(cmd, args, { maxBuffer: 1e8 });
  op.calls++;
  op.bytes += Buffer.byteLength(stdout) + Buffer.byteLength(stderr);
  op.text = stdout;
  return stdout;
}
function mcpServer(cmd, args, env) {
  const s = {
    m: null,
    async open() {
      s.m = await startMcp(cmd, args, { env, timeout: 600000 });
      s.defs = Buffer.byteLength(JSON.stringify(s.m.tools));
      s.version = `${s.m.server?.name} ${s.m.server?.version}`;
    },
    async close() { await s.m?.close(); },
    async call(op, name, a = {}) {
      const r = await s.m.call(name, a, 600000);
      op.calls++;
      op.bytes += r.bytes;
      op.text = r.text;
      const img = r.content.find((c) => c.type === 'image');
      if (img) { setImg(op, Buffer.from(img.data, 'base64')); op.inline = true; }
      const b64 = /(iVBORw0KGgo|\/9j\/)[A-Za-z0-9+/=]{5000,}/.exec(r.text); // a PNG or JPEG returned as text
      if (b64) { setImg(op, Buffer.from(b64[0], 'base64')); op.inline = true; }
      if (!op.image) imageFile(op); // saved to disk, and the path returned (Appium MCP's default)
      if (!r.ok) throw new Error(`${name}: ${(r.raw.error?.message || r.content.at(-1)?.text || r.error || r.text).slice(0, 240)}`); // the last block: some servers lead with a notice
      return r;
    },
  };
  return s;
}
// Pixel size from a PNG or JPEG header: what a model is charged for an image (about w × h / 750 tokens).
function imgDims(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    for (let i = 2; i < buf.length - 9; ) {
      if (buf[i] !== 0xff) { i++; continue; }
      const m = buf[i + 1];
      if (m >= 0xc0 && m <= 0xc3) return [buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5)];
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return null;
}
const setImg = (op, buf) => { op.image = Math.max(op.image, buf.length); op.dims = imgDims(buf) || op.dims; };
// A screenshot saved to a file instead of returned inline: the agent gets a path.
function imageFile(op, path) {
  const p = path || /(\/[^\s"']+\.(?:png|jpe?g))/i.exec(op.text)?.[1];
  if (p && existsSync(p)) setImg(op, readFileSync(p));
}

const ios = (await import('./adapters-ios.mjs')).default;
const android = IOS ? null : (await import('./android.mjs')).adapters;
const ctx = { C, O, OUT, LOOKTAP, MAESTRO, platform, sh, mcpServer, imageFile, setImg, agentTurn, sleep, until, execP, log };
const ADAPTERS = IOS ? ios(ctx) : android(ctx);

// ── one step: run the tool's way of doing it, then wait (untimed) for the oracle ──
const R = { meta: {}, tools: {} };
// BENCH_STEPS="fill field|screenshot" (| between names: "tap x,y" has a comma): re-run only these steps (the rest still run, untimed, to set up the screen)
// and merge them into the existing results file.
const STEPS = process.env.BENCH_STEPS?.split('|');
async function step(tool, name, fn, check) {
  if (STEPS && !STEPS.includes(name)) { await fn?.(newOp()).catch(() => {}); return; }
  const rows = ((R.tools[tool].steps ||= {})[name] ||= []);
  if (!fn) return rows.push({ na: true });
  const op = newOp();
  const t0 = now();
  let err = null;
  try { await fn(op); } catch (e) { err = e.message.slice(0, 300); }
  const ms = now() - t0 - op.pausedMs;
  let ok = false;
  let seenMs = null;
  if (!err) {
    const end = now() + 8000;
    while (true) {
      const tp = now();
      try { ok = await check(op); } catch { ok = false; }
      if (ok) { seenMs = tp - t0 - op.pausedMs; break; }
      if (now() > end) break;
      await sleep(100);
    }
  }
  if (!ok) log(`  ${tool} ${name}: FAIL ${err || '(oracle did not see it)'}`);
  // what the screen showed when a step failed (untimed: after the check)
  if (!ok && PHONE) await O.shot(join(OUT, `fail-${tool}-${name.replace(/\W+/g, '-')}.png`)).catch(() => {});
  if (!ok && !IOS) await execP('adb', ['-s', C.dev, 'exec-out', 'screencap', '-p'], { encoding: 'buffer', maxBuffer: 1e8 }).then((r) => writeFileSync(join(OUT, `fail-${tool}-${name.replace(/\W+/g, '-')}.png`), r.stdout), () => {});
  rows.push({ ms: Math.round(ms), seenMs: seenMs == null ? null : Math.round(Math.max(ms, seenMs)), calls: op.calls, bytes: op.bytes, image: op.image || undefined, dims: op.dims, inline: op.inline, ok, err });
}

const els = () => O.screen();
async function scenario(name, t) {
  R.tools[name] = { steps: {} };
  await O.reboot();
  R.tools[name].hostBefore = await settle(R.meta.idleBusyPct);
  log(`== ${name}: setup (host ${R.tools[name].hostBefore.busyPct}% busy, ${R.tools[name].hostBefore.freeMb} MB free)`);
  await O.fresh();
  const setupUsage = sampler();
  setupUsage.start();
  const op = newOp();
  const t0 = now();
  try {
    await t.start(op);
    await t.read(op); // ready = the first screen read came back
    R.tools[name].setupMs = Math.round(now() - t0);
    R.tools[name].setupUsage = setupUsage.stop();
  } catch (e) {
    setupUsage.stop();
    R.tools[name].setupError = e.message.slice(0, 400);
    log(`  ${name}: setup failed ${e.message.slice(0, 300)}`);
    await t.stop?.().catch(() => {});
    return;
  }
  R.tools[name].defsBytes = t.defs?.() ?? 0;
  R.tools[name].version = t.version?.();
  const usage = sampler();
  const onDevice = IOS ? null : deviceSampler(C.dev); // Android helpers live inside the emulator
  usage.start();
  onDevice?.start();
  try {
    await runs(name, t);
  } finally { // never leave a sampler's timer running
    R.tools[name].usage = usage.stop();
    if (onDevice) R.tools[name].deviceUsage = onDevice.stop();
  }
  await t.stop?.().catch((e) => log(`  ${name}: stop failed ${e.message}`));
}

async function runs(name, t) {
  for (let i = 0; i < N; i++) {
    log(`${name} run ${i + 1}/${N}`);
    // Same conditions for every run, not only every tool: the Mac back near idle, and the device too (Android)
    const before = { host: (await settle(R.meta.idleBusyPct, { maxMs: 30000, kill: false })).busyPct };
    if (O.idle) before.deviceLoad = await O.idle(60000);
    (R.tools[name].runConditions ||= []).push(before);
    if (O.alive && !(await O.alive())) {
      // the device went away mid-run (not something a tool did on purpose): bring it back, note it, carry on
      log(`  ${name}: device not running before run ${i + 1}; rebooting it`);
      (R.tools[name].deviceRestarts ||= []).push(i + 1);
      await O.reboot();
    }
    await O.atHome();
    await step(name, 'launch app', t.launch, async () => O.checks.launch(await els()));
    await sleep(500);
    await step(name, 'read screen', t.read, async (op) => op.text.includes(C.label) || op.text.includes(C.label.replace(/&/g, '&amp;')));
    await step(name, 'tap by label', t.tapLabel, async () => O.checks.opened(await els()));
    await until(async () => O.checks.opened(await els()), 3000);
    await sleep(400);
    await step(name, 'back', t.back, async () => O.checks.back(await els()));
    await until(async () => O.checks.back(await els()), 3000);
    await sleep(400);
    await step(name, 'tap x,y', t.tapXY, async () => O.checks.opened(await els()));
    await O.fresh();
    await step(name, 'swipe', t.swipe, async () => O.checks.swiped(await els()));
    await O.fresh();
    await step(name, 'scroll to label', t.scrollTo, async () => O.checks.scrolled(await els()));
    await O.fresh();
    await step(name, 'fill field', t.fill, async () => O.checks.filled(await els()));
    await step(name, 'screenshot', t.screenshot, async (op) => op.image > 5000);
    await O.fresh();
    await step(name, 'home', t.home, async () => O.checks.home(await els()));
    await O.atHome();
    await step(name, 'open URL', t.openUrl, async () => O.checks.url(await els()));
    await O.fresh();
    await step(name, 'terminate app', t.terminate, () => O.terminated());
  }
}

R.meta = {
  date: new Date().toISOString(),
  platform,
  device: C.model || C.dev, // a real phone by its model: never its name, serial or UDID
  runs: N,
  host: `${execFileSync('sysctl', ['-n', 'machdep.cpu.brand_string'], { encoding: 'utf8' }).trim()}, macOS ${execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim()}`,
};
// The Mac's idle load before any tool ran: the level every tool waits for before it starts.
await settle(100, { maxMs: 0 });
await sleep(5000);
const idle = [await host(), await host(), await host()];
R.meta.idleBusyPct = Math.round(idle.reduce((a, h) => a + h.busyPct, 0) / idle.length);
R.meta.idleFreeMb = idle.at(-1).freeMb;
log(`idle baseline: ${R.meta.idleBusyPct}% busy, ${R.meta.idleFreeMb} MB free`);
const file = join(DIR, 'results', `${platform}${process.env.BENCH_TAG ? '-' + process.env.BENCH_TAG : ''}.json`);
// A real phone's serial or UDID never goes into the results (tools quote it in their errors)
const scrub = (json) => (C.real ? json.replaceAll(C.dev, '<device>').replaceAll(JSON.stringify(C.name || '\0').slice(1, -1), '<device name>') : json);
const PREV = STEPS ? JSON.parse(readFileSync(file, 'utf8')) : null;
for (const [name, t] of Object.entries(ADAPTERS)) {
  if (ONLY && !ONLY.includes(name)) continue;
  try { await scenario(name, t); } catch (e) { log(name, 'ABORTED', e.message); }
  await O.cleanup();
  if (PREV) {
    // every step re-run: the whole tool is replaced (setup, CPU/RAM, run conditions too), not just its steps
    const whole = R.tools[name] && Object.keys(R.tools[name].steps).length === Object.keys(PREV.tools[name]?.steps || {}).length;
    if (whole) PREV.tools[name] = { ...R.tools[name], steps: {}, rerun: PREV.tools[name]?.rerun };
    for (const [s, rows] of Object.entries(R.tools[name]?.steps || {})) {
      PREV.tools[name].steps[s] = rows;
      (PREV.tools[name].rerun ||= {})[s] = { date: new Date().toISOString(), why: process.env.BENCH_RERUN_WHY || '' };
    }
    writeFileSync(file, scrub(JSON.stringify(PREV, null, 2)));
  } else writeFileSync(file, scrub(JSON.stringify(R, null, 2)));
  await sleep(2000);
}
log(`wrote ${file}`);
O.close?.();
// summary: median ms / median seen ms / calls / KB / passes
const med = (a) => { const s = a.filter((x) => x != null).sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
for (const [name, t] of Object.entries(R.tools)) {
  const u = t.usage || {};
  console.log(`\n${name}  setup ${t.setupMs ?? 'FAILED'} ms  defs ${((t.defsBytes || 0) / 1024).toFixed(1)} KB  RAM peak ${u.peakRssMb} MB mean ${u.meanRssMb} MB  CPU mean ${u.meanCpuPct}% peak ${u.peakCpuPct}%`);
  for (const [s, rows] of Object.entries(t.steps)) {
    if (rows[0]?.na) { console.log(`  ${s.padEnd(16)} n/a`); continue; }
    const ok = rows.filter((r) => r.ok);
    console.log(`  ${s.padEnd(16)} ${String(med(rows.map((r) => r.ms))).padStart(6)} ms  seen ${String(med(ok.map((r) => r.seenMs))).padStart(6)} ms  ${med(rows.map((r) => r.calls))} calls  ${(med(rows.map((r) => r.bytes)) / 1024).toFixed(1)} KB  ${ok.length}/${rows.length} ok`);
  }
}
