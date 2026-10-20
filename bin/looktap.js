#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

import { Android, RECORD_LIMIT_S, adbDevices } from '../lib/android.js';
import { Ios, bootedSimulators } from '../lib/ios.js';
import { IosDevice, physicalDevices } from '../lib/iosdevice.js';
import { clock, grepper, startOf, tail, whichApp } from '../lib/logs.js';
import { ACTIONS as PERMISSION_ACTIONS } from '../lib/permissions.js';
import { KINDS, capabilities, capability, unsupported } from '../lib/capabilities.js';
import { Recorder, TouchReader, classify, mapper, quote } from '../lib/codegen.js';
import { AGENTS, PROJECT_DEFAULT, claudePlugin, detectAgents, installSkill, installedVersion, pickAgents, skillsDir, uninstallSkill } from '../lib/agents.js';
import { boot, shutdown } from '../lib/boot.js';
import { formatDevice, inventory } from '../lib/devices.js';
import { ORIENTATIONS, coordinates, pushPayload, rotation, textSize } from '../lib/conditions.js';
import { LOGBOX, appGone, center, expectOn, poller, tapPoint, forgetFront, formatRow, isRef, lastFront, onlyStatusBar, resolveRef, saveRefs, scrollTo, settle, signature, sliding, visibleRows, waitFor } from '../lib/screen.js';
import { duration, formatFrames, formatReading, formatSamples, readingJson } from '../lib/perf.js';
import { flowFiles, flowName, junit } from '../lib/testing.js';
import { ADB, HOME, LOCKED, NotFound, UsageError, has, loadConfig, pickMatch, readJson, run, shotPath, sleep, splitScript, waitFor as retry, writeJson } from '../lib/util.js';

const SKILL = new URL('../skills/looktap/SKILL.md', import.meta.url);

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const HELP = `looktap ${pkg.version} — drive iPhone and Android devices from the shell.

usage: looktap [options] <command> [args]

setup & info
  devices [--all] [--json]        what's running or connected: simulator, emulator or real device (model, OS,
                                  USB/Wi-Fi), with window or headless, and what to do for a phone not ready yet.
                                  --all: also what boot can start
  boot [name] [--window|--headless]  boot a simulator or emulator (name, UDID or AVD; -p to choose) and wait until
                                  it's ready. Default: a window (LOOKTAP_HEADLESS=1 or "headless": true in config
                                  for headless). On a running simulator --window opens its window
  shutdown [name]                 shut down a simulator or emulator
  doctor                          check the toolchain
  setup                           start the helper (optional: commands start it on first use)
                                  · Android: also adb reverse Metro
  teardown                        stop the helper · Android: remove adb reverse rules

look
  ls [--all] [--json]             on-screen elements: @ref  type  x,y  WxH  label  [= value]
  wait <label|@ref> [--gone]      until it appears (or disappears); default timeout 10 s, or --wait
  expect <label|@ref> [= value] [--gone] [--exact]
                                  check it's on screen (with that value), or with --gone that it isn't.
                                  Waits up to --wait (3 s) for it; fails with what's there instead (exit 1)
  scrollto <label> [--up]         swipe until it is fully on screen (default scrolls down; above the keyboard)
  shot <name> [--plain] [--scale f]  screenshot → <out>/<name>.png; --scale 0.5 = half size, fewer
                                  image tokens (Android emulators bypass FLAG_SECURE; --plain doesn't)
  burst <dir> <seconds>           a frame whenever the screen changes; duplicates removed
  record start [name] | stop      screen video → <out>/<name>.mp4, in the background until stopped
                                  (Android: at most 3 min, and FLAG_SECURE screens record black)

act                               add --ls to any of these to print the settled screen afterwards
  tap <label|@ref> [--exact]      @ref: a row from the last ls. Label: exact, else a prefix/contains
                                  match that names one label (ambiguous → error). Prints what it tapped
  longpress <label|@ref|x y> [ms] hold for ms (default 800)
  zoom in|out [x y] [--scale f]   two-finger pinch around a point (default: the screen centre; scale 2.5)
  tapxy <x> <y>                   iOS points / Android dp
  type <text>                     into the focused field
  key <name> …                    return, escape, delete, tab, space, selectall, paste, home
                                  (Android: also back, or any KEYCODE_*)
  fill <label|@ref> <text>        clear the field, type, check it holds the text (Android), leave it
  hidekb                          dismiss the keyboard and take focus from the field
  swipe <x1> <y1> <x2> <y2> [ms]
  back                            Android system back · iOS navigation-bar back button
  home                            the Home button: to the home screen, the app left running
  open <url>                      deep link (e.g. myapp://home)
  launch [app] [--time|--resume]  (re)start the app. --time: how long until it's in front and its first
                                  screen has settled (Android: also the system's own TotalTime). --resume:
                                  bring it forward as it was, without restarting it
  stop [app]                      terminate it, and wait until its process is gone
  bio match|nomatch               Face ID / fingerprint
  rotate [portrait|landscape|left|right|upsidedown]
                                  turn the device (landscape = left: turned counter-clockwise); no
                                  argument prints the current orientation. ls, taps and shots follow it

debug                             [app] defaults to --app / config, else the app in front
  logs [app] [--errors] [--grep re] [--since 5m] [--lines n] [--all]
                                  the app's log since the last \`logs\` (first time: the last minute).
                                  iOS hides Apple-framework chatter unless it's an error (--all keeps it)
  crashes [app] [--since 1h]      crashes, ANRs, low-memory kills since the last \`crashes\` (first: last hour)
  app [app]                       which app is in front, and whether [app] is running (pid)
  app [app] --paths               where its files are: iOS the bundle, data folder and app groups (on the Mac),
                                  Android its APKs and data folder (readable with run-as on debuggable builds)
  apps [filter] [--all] [--json]  installed apps: id, name, version (--all: system apps too). A filter
                                  matches part of the id or name; nothing matching → exit 1
  capabilities [--json]           what this device can't do, or can only in part, and why
  perf [app] [--for 10s] [--json] the app's CPU (100% = one core), memory and threads; --for: a reading
                                  each second, then avg/max (iOS: the footprint Xcode shows; Android: PSS)
  perf [app] --frames             frames since the last perf --frames, janky %, p50–p99 frame time (iOS: from
                                  the screen itself, a real iPhone over its USB cable; the first call starts counting)

app state                         <app> defaults to --app / config (never the app in front)
  install <path> [--grant]        iOS: a simulator .app · Android: an .apk (keeps data; --grant: all
                                  runtime permissions). Prints the app id
  uninstall <app>
  reset <app>                     as if freshly installed: data and permissions cleared (iOS: the
                                  keychain survives, as on a real iPhone)
  permission grant|revoke|reset <name> [app]
                                  camera, microphone, location, location-always, photos, contacts,
                                  calendar, notifications, motion, all … (Android: or android.permission.*)

conditions
  location <lat> <lon> | clear    simulated GPS (Android: emulators)
  appearance [dark|light]         dark mode; no argument prints the current one
  textsize [size]                 Dynamic Type / font scale: xs s m l xl xxl xxxl ax1…ax5 (or the iOS
                                  names, e.g. accessibility-large); no argument prints the current one
  statusbar clean|live            9:41, full battery and signal, for screenshots
  network [offline|online]        Android: airplane mode; no argument prints the current state (the iOS
                                  simulator shares the Mac's network)
  push <app> <payload>            iOS: a remote notification. Payload: a .json file, '{json}', or plain
                                  text for an alert (Android pushes need Firebase)

batch & agents
  mcp [--config]                  serve these commands over MCP (stdio), for AI clients without a shell.
                                  --config prints a client config with absolute paths
  codegen <flow-file> [app]       Android: restart the app, then save each touch on the device as a flow
                                  step (tap by label, fill, scrollto, back …). Commands typed here (expect …)
                                  are run and saved too; undo drops the last step; Enter or Ctrl+C ends it
  run '<cmd>; <cmd> …'            several commands in one process (or: run - < script). Stops at the
                                  first failure, which it names
  test <flow|dir> … [--junit f]   run flow files (run scripts, one step per line) as tests: a line per
                                  flow, exit 1 if any fails. A failure saves the screen, a screenshot,
                                  error logs and crashes in <out>/failures/<flow>/; --junit writes a report.
                                  An app that dies during a flow fails it
  skill [--install|--uninstall|--list] [--agents a,b|all] [--project]
                                  print the AI-agent guide. --install: into every coding agent found here
                                  (Claude Code, Codex, Cursor, Gemini CLI, Copilot, OpenCode, …), or --agents;
                                  run it again after an upgrade. --project: into this repo instead of your
                                  home folder. --list: the agents, what's installed where

options
  -p, --platform ios|android      default: whichever has exactly one booted device
  -d, --device <udid|serial>      default: the only booted one
  -o, --out <dir>                 screenshots and videos (default ./shots, or "out" in looktap.config.json)
      --app <id>                  app id for launch/open (or "ios.app" / "android.app" in config)
      --wait <seconds>            how long tap/fill/back wait for their target to appear (default 3)
  -h, --help · -v, --version

env: LOOKTAP_PLATFORM, LOOKTAP_DEVICE, LOOKTAP_OUT, LOOKTAP_WAIT, LOOKTAP_SCALE (Android px per dp),
     LOOKTAP_ANDROID_HELPER=0 (plain adb + uiautomator dump),
     LOOKTAP_EMULATOR_GRPC=0 (no emulator gRPC frames), LOOKTAP_HEADLESS=1 (boot without a window)

Never burst or record a sign-in screen: frames capture typed credentials.`;

function parse(argv) {
  const opts = { flags: new Set() };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      if (i + 1 >= argv.length) throw new UsageError(`${a} needs a value`);
      return argv[++i];
    };
    if (a === '-p' || a === '--platform') opts.platform = val();
    else if (a === '-d' || a === '--device') opts.device = val();
    else if (a === '-o' || a === '--out') opts.out = val();
    else if (a === '--app') opts.app = val();
    else if (a === '--wait') opts.wait = val();
    else if (a === '-h' || a === '--help') opts.flags.add('help');
    else if (a === '-v' || a === '--version') opts.flags.add('version');
    else if (a === '--scale') opts.scale = Number(val());
    else if (a === '--since') opts.since = val();
    else if (a === '--grep') opts.grep = val();
    else if (a === '--lines') opts.lines = Number(val());
    else if (a === '--junit') opts.junit = val();
    else if (a === '--for') opts.for = val();
    else if (a === '--agents') opts.agents = val();
    else if (['--all', '--plain', '--exact', '--ls', '--json', '--gone', '--up', '--install', '--errors', '--grant', '--config', '--headless', '--window', '--paths', '--frames', '--time', '--resume', '--project', '--uninstall', '--list'].includes(a)) opts.flags.add(a.slice(2));
    else if (a === '--') pos.push(...argv.slice(i + 1)), (i = argv.length);
    else pos.push(a);
  }
  return { opts, cmd: pos[0], args: pos.slice(1) };
}

/** A physical iPhone/iPad's hardware UDID (00008110-000A…, or 40 hex digits on older ones), not a simulator's. */
const physicalUdid = (id) => /^[0-9A-F]{8}-[0-9A-F]{16}$|^[0-9a-f]{40}$/i.test(id || '');

function pickDriver(opts, config) {
  let platform = opts.platform || process.env.LOOKTAP_PLATFORM;
  let device = opts.device || process.env.LOOKTAP_DEVICE;
  // With both -p and -d there is nothing to detect — skip listing devices (saves 0.1–0.3 s per command).
  const known = platform && device;
  const sims = known || platform === 'android' ? [] : bootedSimulators();
  const droids = known || platform === 'ios' ? [] : adbDevices();
  // Real iPhones are looked for only when nothing else answers, or when -d names one: simulator and
  // emulator choice works exactly as it did.
  let phones = null;
  const lookForPhones = () => (phones ??= physicalDevices());

  if (device && !platform) {
    platform = sims.some((s) => s.id === device) ? 'ios' : droids.some((d) => d.id === device) ? 'android' : null;
    if (!platform && lookForPhones().some((p) => p.id === device)) platform = 'ios';
    if (!platform) throw new UsageError(`device ${device} is not booted`);
  }
  if (!platform) {
    if (sims.length && !droids.length) platform = 'ios';
    else if (droids.length && !sims.length) platform = 'android';
    else if (!sims.length && lookForPhones().length) platform = 'ios';
    else if (!sims.length) throw new UsageError('no booted simulator or adb device — looktap devices --all lists what looktap boot can start');
    else throw new UsageError('both iOS and Android devices are up — pass -p ios|android');
  }
  // A phone adb lists over both USB and Wi-Fi is one phone: picked by its USB id (-d can still name the other).
  const pool = platform === 'ios' ? (sims.length || known || device ? sims : lookForPhones()) : droids.filter((d) => !d.samePhoneAs);
  if (!device && !known) {
    if (pool.length !== 1)
      throw new UsageError(
        pool.length ? `${pool.length} ${platform} devices — pass -d one of: ${pool.map((d) => `${d.id} (${d.name})`).join(', ')}` : `no booted ${platform} device`,
      );
    device = pool[0].id;
  }
  const out = opts.out || process.env.LOOKTAP_OUT || config.out || 'shots';
  const app = opts.app || config[platform]?.app;
  const wait = 1000 * Number(opts.wait ?? process.env.LOOKTAP_WAIT ?? config.wait ?? 3);
  if (!(wait >= 0)) throw new UsageError('--wait takes seconds, e.g. --wait 5');
  if (platform === 'ios' && physicalUdid(device)) return new IosDevice(device, { out, app, wait, team: process.env.LOOKTAP_TEAM || config.ios?.team });
  return platform === 'ios' ? new Ios(device, { out, app, wait }) : new Android(device, { out, app, wait });
}

function doctor() {
  const ok = (b, msg, fix) => console.log(`${b ? '✓' : '✗'} ${msg}${!b && fix ? `  → ${fix}` : ''}`);
  ok(Number(process.versions.node.split('.')[0]) >= 18, `node ${process.versions.node} (needs ≥ 18)`);
  const xc = has('xcrun');
  ok(xc, 'xcrun (iOS)', 'install Xcode + command line tools');
  if (xc) {
    const sims = bootedSimulators();
    ok(sims.length > 0, `booted simulators: ${sims.map((s) => s.name).join(', ') || 'none'}`, 'looktap boot <name> (looktap devices --all lists them)');
    const dev = run('xcode-select', ['-p'], { allowFail: true }).trim();
    ok(existsSync('/Library/Developer/PrivateFrameworks/CoreSimulator.framework'), 'CoreSimulator.framework (iOS helper)', 'install Xcode');
    ok(dev && existsSync(join(dev, 'Library/PrivateFrameworks/SimulatorKit.framework')), `SimulatorKit in ${dev || 'no developer dir'} (iOS helper)`, 'sudo xcode-select -s /Applications/Xcode.app');
    // Same rule as the helper: CoreSimulator 1155.4+ (Xcode 27) takes input through dtuhidd.
    const cs = run('defaults', ['read', '/Library/Developer/PrivateFrameworks/CoreSimulator.framework/Resources/Info', 'CFBundleVersion'], { allowFail: true }).trim();
    if (cs) {
      const modern = cs.localeCompare('1155.4', undefined, { numeric: true }) >= 0;
      console.log(`  iOS input: ${process.env.LOOKTAP_IOS_HID || (modern ? 'dtuhid' : 'indigo')} (CoreSimulator ${cs})`);
    }
  }
  skillStatus(ok);
  const adb = ADB !== 'adb' || has('adb');
  ok(adb, `adb (Android)${ADB !== 'adb' ? `: ${ADB}` : ''}`, 'install Android SDK platform-tools (or set ANDROID_HOME)');
  if (adb) {
    const d = adbDevices();
    ok(d.length > 0, `adb devices: ${d.map((x) => x.id).join(', ') || 'none'}`, 'looktap boot <AVD name>, or connect a phone');
  }
}

async function burst(driver, dir, seconds) {
  if (!dir || !seconds) throw new UsageError('usage: looktap burst <dir> <seconds>');
  // Native stream: a frame whenever the screen changes, duplicates already dropped.
  const r = await driver.burst?.(dir, Number(seconds));
  if (r) return console.log(`${r.frames} frames, ${r.distinct} distinct, in ${dir}`);
  const end = Date.now() + Number(seconds) * 1000;
  let i = 0;
  while (Date.now() < end) {
    driver.frame(shotPath(dir, `b_${String(++i).padStart(4, '0')}`));
    await sleep(400);
  }
  // keep the first frame of each run of identical frames
  const seen = new Set();
  let kept = 0;
  for (const f of readdirSync(dir).filter((x) => /^b_\d+\.png$/.test(x)).sort()) {
    const p = join(dir, f);
    const h = createHash('md5').update(readFileSync(p)).digest('hex');
    if (seen.has(h)) rmSync(p);
    else seen.add(h), kept++;
  }
  console.log(`${i} frames, ${kept} distinct, in ${dir}`);
}

async function main() {
  const { opts, cmd, args } = parse(process.argv.slice(2));
  if (opts.flags.has('version')) return console.log(pkg.version);
  if (!cmd || opts.flags.has('help') || cmd === 'help') return console.log(HELP);

  if (cmd === 'doctor') return doctor();
  if (cmd === 'skill') return skill(opts);
  if (cmd === 'mcp') return opts.flags.has('config') ? mcpConfig() : mcp(opts);
  if (cmd === 'devices') return console.log(deviceLines(opts).join('\n'));
  if (cmd === 'boot') return console.log(booted(await boot(args.join(' ') || null, { platform: opts.platform, ...display(opts, loadConfig()) })));
  if (cmd === 'shutdown') return console.log(shutDown(await shutdown(args.join(' ') || opts.device || null, { platform: opts.platform })));

  const config = loadConfig();
  const d = pickDriver(opts, config);
  try {
    return await dispatch(d, cmd, args, opts);
  } finally {
    d.close?.();
  }
}

const deviceId = (d) => d.udid || d.serial;

/** `devices`: every device, what it is and whether it's ready; --all adds what `boot` can start; --json for agents. */
function deviceLines(opts) {
  const list = inventory({ all: opts.flags.has('all') });
  if (opts.flags.has('json')) return [JSON.stringify(list, null, 2)];
  const on = list.filter((d) => d.running !== false), off = list.filter((d) => d.running === false);
  const lines = on.map(formatDevice);
  if (off.length) lines.push('', 'not running (looktap boot <name>):', ...off.map(formatDevice));
  return lines.length ? lines : ['no device running or connected — looktap devices --all lists what looktap boot can start'];
}

const booted = (r) => `${r.already ? 'already running' : 'booted'}: ${r.platform}  ${r.id}  ${r.name}${r.os ? ` (${r.os})` : ''} · ${r.display}${r.note ? ` — ${r.note}` : ''}`;

/** boot's window: --window / --headless, else LOOKTAP_HEADLESS=1|0, else "headless" in looktap.config.json. */
function display(opts, config) {
  if (opts.flags.has('window') && opts.flags.has('headless')) throw new UsageError('boot takes --window or --headless, not both');
  const flag = opts.flags.has('headless') ? 'headless' : opts.flags.has('window') ? 'window' : null;
  if (flag) return { display: flag, explicit: true };
  const env = process.env.LOOKTAP_HEADLESS;
  const headless = env != null && env !== '' ? env !== '0' : config.headless === true;
  return { display: headless ? 'headless' : 'window', explicit: false };
}
const shutDown = (r) => `shut down: ${r.platform}  ${r.id}  ${r.name}`;
const ACTIONS = new Set(['tap', 'longpress', 'zoom', 'tapxy', 'type', 'key', 'fill', 'hidekb', 'swipe', 'back', 'home', 'open', 'launch', 'bio', 'scrollto', 'rotate']);

/** Print the listing (text or --json) and remember its @refs. `snap` defaults to a fresh read. */
async function list(d, opts, snap) {
  const all = opts.flags.has('all');
  if (!snap) {
    // Nothing labelled yet almost always means mid-launch: give it up to --wait.
    const until = Date.now() + d.wait;
    snap = await d.snapshot({ all });
    while (!snap.elements.some((e) => e.label) && Date.now() < until) {
      await sleep(150);
      snap = await d.snapshot({ all });
    }
  }
  // Reading order. Content found by probing (iOS web pages) arrives in grid order, not document order.
  const rows = visibleRows(snap.elements, { all }).sort((a, b) => a.y - b.y || a.x - b.x);
  // An app that died since the last look (after a command returned) is named here, before its absence confuses.
  const front = await d.frontApp().catch(() => null);
  if (!opts.checked) {
    const last = lastFront(deviceId(d));
    const ago = last && (Date.now() - last.at) / 60000;
    warnIfGone(await appGone(d, last), ago >= 1 ? `it was in front at the last ls, ${Math.round(ago)} min ago` : '');
  }
  saveRefs(deviceId(d), rows, front);
  if (opts.flags.has('json'))
    return console.log(JSON.stringify({ screen: snap.screen, elements: rows.map((e, i) => ({ ref: `@${i + 1}`, ...e })) }));
  if (!rows.length) console.error('looktap: no labelled elements on screen (still loading, or the app sets no accessibility labels)');
  else console.log(rows.map((e, i) => formatRow(e, i + 1)).join('\n'));
  // The system's own dialogs belong to package "android": only then is it worth asking what it is.
  const stuck = front?.id === 'android' ? await d.stuck?.().catch(() => null) : null;
  if (stuck) console.error(`looktap: ${stuck.app} ${stuck.why}: the system's dialog about it is on screen, and the app can't be driven until it closes. See: looktap crashes ${stuck.app}`);
  else if (snap.elements.some((e) => LOGBOX.test(e.label || '')))
    console.error("looktap: React Native's LogBox toast is up: it blocks taps around it (a bottom tab bar). tap reports its × when it gets in the way");
  if (onlyStatusBar(snap.elements))
    console.error('looktap: only the status bar is readable — a system prompt (passcode, permission, alert) may be covering the app. `looktap shot` shows it');
}

/** The element a ref names, if it's still where the last `ls` saw it. */
async function byRef(d, ref) {
  return resolveRef(deviceId(d), ref, (await d.snapshot()).elements);
}

/** Commands that read or act on the screen: they stop while the lock screen is up (bio can unlock it). */
const SCREEN = new Set([...ACTIONS, 'ls', 'wait', 'expect', 'scrollto', 'codegen'].filter((c) => c !== 'bio'));

/** Actions after which a vanished app is worth a warning (launch replaces the app on purpose). */
const WATCHED = new Set([...ACTIONS].filter((c) => c !== 'launch'));

/** Until `app` is the app in front (or `ms` pass). */
async function waitForApp(d, app, ms, gap = 150) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const f = await d.frontApp().catch(() => null);
    if (f && d.appId(f) === app) return true;
    await sleep(gap);
  }
  return false;
}

/** While `test` runs a flow: an app that dies fails the flow instead of only warning. `gone` names it. */
const testing = { on: false, gone: null };

function warnIfGone(app, when = '') {
  if (app && testing.on) {
    testing.gone = app;
    throw new Error(`${app} is no longer running${when ? ` (${when})` : ''} — it crashed or was killed`);
  }
  if (app) console.error(`looktap: warning: ${app} is no longer running${when ? ` (${when})` : ''} — it crashed or was killed. See: looktap crashes ${app}`);
}

async function dispatch(d, cmd, args, opts) {
  const all = opts.flags.has('all');
  const look = opts.flags.has('ls') && ACTIONS.has(cmd);
  // Remember the screen before acting, so --ls waits for the action to show before printing.
  const before = look ? await d.snapshot({ all }) : null;
  if (d.assertUnlocked && SCREEN.has(cmd)) await d.assertUnlocked(cmd, args);
  const app = WATCHED.has(cmd) ? await d.frontApp().catch(() => null) : null;
  // The screen just read doubles as the first look for the action's target: one read fewer on a slow device.
  await act(d, cmd, args, before ? { ...opts, snap: before } : opts);
  if (['launch', 'stop', 'reset', 'uninstall', 'install'].includes(cmd)) forgetFront(deviceId(d));
  // A cold start can take seconds, and the old screen may still be animating: wait for the app itself.
  if (look && cmd === 'launch') await waitForApp(d, args[0] || d.app, 6000);
  const after = look ? await settle(d, { all, before, changeTimeout: cmd === 'launch' || cmd === 'open' ? 6000 : 1500 }) : null;
  if (app) warnIfGone(await appGone(d, app));
  if (look) await list(d, { ...opts, checked: Boolean(app) }, after);
}

/**
 What `tap` aims at: @ref from the last ls, else an accessibility identifier (iOS) or label —
 exact, unique prefix, unique substring. Waits up to --wait for it. Returns the element and the screen.
 */
async function target(d, what, opts) {
  let fresh = opts.snap; // a screen read a moment ago (dispatch's `before`): used for the first try only
  const look = poller(d);
  return retry(async () => {
    const snap = fresh || (await look());
    fresh = null;
    if (isRef(what)) return { e: resolveRef(deviceId(d), what, snap.elements), snap };
    const live = snap.elements.filter((e) => e.w > 0 && e.h > 0);
    try {
      return { e: live.find((e) => e.id === what) || pickMatch(live, what, { exact: opts.flags.has('exact') }), snap };
    } catch (e) {
      if (e instanceof NotFound) e.snap = snap;
      throw e;
    }
  }, isRef(what) ? 0 : d.wait).catch(async (e) => {
    // Not found because the app is under a "not responding" dialog: say that, not that the label is missing.
    const stuck = e instanceof NotFound ? await d.stuck?.().catch(() => null) : null;
    if (stuck) e.message += ` — ${stuck.app} ${stuck.why}, and the system's dialog about it is on screen (looktap crashes ${stuck.app})`;
    throw e;
  });
}

/**
 After a setting the system applies as a configuration change: Android may restart the app in front for it. Say so,
 since every ref is then stale. Looks for a second at most, and only when it knows the app's process.
 */
async function noteRestart(d, before) {
  if (!before?.pid) return;
  for (const until = Date.now() + 1000; Date.now() < until; await sleep(250)) {
    const pid = await d.pidOf(before.id);
    if (pid && pid !== before.pid) return console.error(`looktap: note: ${before.id} restarted (configuration change, pid ${before.pid} → ${pid}): refs are stale, run looktap ls`);
  }
}

/** After `shot`: the image's size against the screen's, so a point in the picture converts to tapxy's units. */
async function shotSize(d, path, scale) {
  let png;
  try {
    png = readFileSync(path);
  } catch {
    return;
  }
  if (png.length < 24 || png.toString('latin1', 12, 16) !== 'IHDR') return;
  const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
  // Only what the driver already knows, no extra screen read: Android's density, the iOS helper's screen size.
  const per = d.serial ? 1 / (d.scale * scale) : d.screen?.w / w;
  if (!(per > 0)) return;
  const screen = { w: Math.round(w * per), h: Math.round(h * per) };
  const unit = d.serial ? 'dp' : 'pt';
  console.error(`looktap: ${w}x${h} px = ${screen.w}x${screen.h} ${unit}: tapxy x y = image x y × ${+per.toFixed(3)}`);
}

/** Say so when something else covers the point a tap went to; name React Native's dev toast, the usual culprit. */
function warnCovered(covers) {
  for (const c of covers) {
    console.error(`looktap: warning: ${JSON.stringify(c.label || c.type)} at ${c.x},${c.y} ${c.w}x${c.h} covers that point and may have taken the tap`);
    if (c.close) console.error(`looktap: that's React Native's LogBox toast (dev builds), which blocks taps around it: dismiss it with looktap tapxy ${c.close.join(' ')} (its ×), then tap again`);
  }
}

async function act(d, cmd, args, opts) {
  const need = (n, usage) => {
    if (args.length < n) throw new UsageError(`usage: looktap ${usage}`);
  };

  switch (cmd) {
    case 'setup': return d.setup();
    case 'teardown': return d.teardown();
    case 'ls': return list(d, opts);
    case 'wait': {
      need(1, 'wait <label|@ref> [--gone]');
      const target = args.join(' ');
      const gone = opts.flags.has('gone');
      const hit = await waitFor(d, deviceId(d), target, { gone, timeout: opts.wait != null ? Number(opts.wait) * 1000 : 10000 });
      return console.log(gone ? `gone: ${target}` : `found ${JSON.stringify(hit.label)} at ${center(hit).join(',')}`);
    }
    case 'expect': {
      const usage = 'expect <label|@ref> [= value] [--gone] [--exact]';
      const eq = args.indexOf('=');
      const what = (eq < 0 ? args : args.slice(0, eq)).join(' ');
      const want = eq < 0 ? null : args.slice(eq + 1).join(' ');
      const gone = opts.flags.has('gone');
      if (!what || (gone && want != null)) throw new UsageError(`usage: looktap ${usage}`);
      const timeout = opts.wait != null ? Number(opts.wait) * 1000 : d.wait;
      if (!(timeout >= 0)) throw new UsageError('--wait takes seconds, e.g. --wait 5');
      const r = await expectOn(d, deviceId(d), what, { want, gone, exact: opts.flags.has('exact'), timeout });
      if (!r.ok) throw new Error(`expect failed: ${r.why}${timeout ? ` (waited ${timeout / 1000} s)` : ''}`);
      if (gone) return console.log(`ok: gone: ${what}`);
      return console.log(`ok: ${JSON.stringify(r.hit.label || r.hit.type)}${want != null ? ` = ${JSON.stringify(want)}` : ''} at ${center(r.hit).join(',')}`);
    }
    case 'scrollto': {
      need(1, 'scrollto <label> [--up]');
      const hit = await scrollTo(d, args.join(' '), { up: opts.flags.has('up') });
      return console.log(`found ${JSON.stringify(hit.label)} at ${center(hit).join(',')}`);
    }
    case 'shot': {
      need(1, 'shot <name> [--scale f]');
      if (opts.scale != null && !(opts.scale > 0 && opts.scale <= 1)) throw new UsageError('--scale takes a factor between 0 and 1, e.g. --scale 0.5');
      await d.shot(args[0], { plain: opts.flags.has('plain'), scale: opts.scale ?? 1 });
      return shotSize(d, shotPath(d.out, args[0]), opts.scale ?? 1);
    }
    case 'burst': return burst(d, args[0], args[1]);
    case 'record': return record(d, args);
    case 'tap': {
      need(1, 'tap <label|@ref>');
      const { e, snap } = await target(d, isRef(args[0]) ? args[0] : args.join(' '), opts);
      // Aimed at a part of it nothing covers: the tap lands on whatever is on top.
      const { at, covers, avoided } = tapPoint(snap.elements, e);
      await d.tapxy(...at);
      const name = (c) => JSON.stringify((c.label || c.type).slice(0, 40));
      console.log(`tapped ${JSON.stringify(e.label || e.type)} at ${at.join(',')}${avoided.length ? ` (off-centre: ${avoided.map(name).join(', ')} covers its middle)` : ''}`);
      warnCovered(covers);
      return;
    }
    case 'longpress': {
      need(1, 'longpress <label|@ref|x y> [ms]');
      const num = (v) => /^\d+(\.\d+)?$/.test(v ?? '');
      // Two leading numbers are a point; a trailing number is the hold time, unless it is the whole target.
      const xy = num(args[0]) && num(args[1]);
      const timed = args.length > (xy ? 2 : 1) && /^\d+$/.test(args.at(-1));
      const ms = timed ? Number(args.at(-1)) : 800;
      let at, what;
      if (xy) (at = [Number(args[0]), Number(args[1])]), (what = `${at.join(',')}`);
      else {
        const words = timed ? args.slice(0, -1) : args;
        const { e, snap } = await target(d, isRef(words[0]) ? words[0] : words.join(' '), opts);
        const p = tapPoint(snap.elements, e);
        warnCovered(p.covers);
        (at = p.at), (what = `${JSON.stringify(e.label || e.type)} at ${at.join(',')}`);
      }
      await d.longpress(...at, ms);
      return console.log(`long-pressed ${what} for ${ms} ms`);
    }
    case 'zoom': {
      const usage = 'zoom in|out [x y] [--scale f]';
      if (!['in', 'out'].includes(args[0])) throw new UsageError(`usage: looktap ${usage}`);
      const scale = opts.scale ?? 2.5;
      if (!(scale > 1)) throw new UsageError('zoom --scale takes a factor above 1, e.g. --scale 3 (default 2.5)');
      const { w, h } = (await d.snapshot()).screen;
      const [x, y] = args.length >= 3 ? [Number(args[1]), Number(args[2])] : [Math.round(w / 2), Math.round(h / 2)];
      if (!(x >= 0 && x <= w && y >= 0 && y <= h)) throw new UsageError(`usage: looktap ${usage} — x y within the screen (${w}x${h})`);
      // Fingers on a horizontal line through the point, kept on screen.
      const room = Math.max(20, Math.min(x, w - x) - 8);
      const near = Math.min(40, room / scale), far = Math.min(near * scale, room);
      await d.pinch(x, y, ...(args[0] === 'in' ? [near, far] : [far, near]));
      return console.log(`zoomed ${args[0]} at ${x},${y} (fingers ${Math.round(2 * near)} ↔ ${Math.round(2 * far)} apart)`);
    }
    case 'tapxy': need(2, 'tapxy <x> <y>'); return d.tapxy(Number(args[0]), Number(args[1]));
    case 'type': need(1, 'type <text>'); return d.type(args.join(' '));
    case 'key': need(1, 'key <name> … (return, escape, delete, tab, space, selectall, paste, home)'); return d.keys(args);
    case 'fill': {
      need(1, 'fill <label|@ref> <text>');
      const text = args.slice(1).join(' ');
      if (!isRef(args[0])) return d.fill(args[0], text, { exact: opts.flags.has('exact') });
      return d.fillAt(...center(await byRef(d, args[0])), text);
    }
    case 'hidekb': return d.hidekb();
    case 'swipe': need(4, 'swipe <x1> <y1> <x2> <y2> [ms]'); return d.swipe(...args.slice(0, 4).map(Number), args[4] ? Number(args[4]) : undefined);
    case 'back': return d.back();
    case 'home': {
      const before = await d.foreground();
      await d.home();
      // Done means the home screen is in front, not that the button was pressed.
      const launcher = await d.homeScreen();
      let front;
      for (let i = 0; i < 12; i++) {
        front = await d.foreground();
        if (!front || front.id === launcher) break; // no app in front is the home screen too
        await sleep(250);
      }
      if (front && front.id !== launcher) throw new Error(`pressed Home, but ${front.id || 'an app'} is still in front`);
      if (!front && (await d.locked())) throw new UsageError(LOCKED); // no app in front: the lock screen looks the same
      const left = before && before.id !== launcher && before.id ? await d.pidOf(before.id) : 0;
      return console.log(`home screen${left ? ` · ${before.id} still running in the background, pid ${left}` : ''}`);
    }
    case 'open': need(1, 'open <url>'); return d.open(args[0]);
    case 'launch': {
      const app = args[0] || d.app;
      if (!app) throw new UsageError('usage: looktap launch <app-id> (or set --app / looktap.config.json)');
      if (opts.flags.has('resume')) {
        if (opts.flags.has('time')) throw new UsageError('launch takes --time or --resume, not both');
        await d.launch(app, { resume: true });
        // Done means it's in front, not that the start was sent.
        if (!(await waitForApp(d, app, 6000))) throw new Error(`${app} didn't come to the front`);
        return console.log(`resumed ${app}`);
      }
      return opts.flags.has('time') ? timedLaunch(d, app) : d.launch(app);
    }
    case 'stop': {
      const app = explicitApp(d, args[0], 'stop <app>');
      const was = await d.stop(app);
      if (!was) return console.log(`${app} wasn't running`);
      // Stopped means that process is gone, not that the stop was sent. The system may start a new one at once
      // (Android does for the top screen of another app's task): that's a restart, not a failed stop.
      let pid = await d.pidOf(app);
      for (let i = 0; i < 20 && pid === was; i++) await sleep(250), (pid = await d.pidOf(app));
      if (pid === was) throw new Error(`${app} is still running (pid ${pid}) after the stop`);
      return console.log(`stopped ${app} (pid ${was})${pid ? ` · the system started it again right away, pid ${pid}` : ''}`);
    }
    case 'bio': need(1, 'bio match|nomatch'); return d.bio(args[0]);
    case 'rotate': {
      const want = args[0] ? rotation(args[0]) : null;
      const r = await d.rotate(want);
      const now = `${ORIENTATIONS[r.turns]} (${r.w}x${r.h})`;
      if (want == null) return console.log(now);
      const limit = capability(d.kind, 'rotate');
      if (limit.why && d.homeScreen && (await d.foreground())?.id === (await d.homeScreen())) console.error(`looktap: warning: ${limit.why}`);
      if (r.turns === want) return console.log(`rotated: ${now}`);
      return console.log(`turned the device to ${ORIENTATIONS[want]}, but the screen stays ${now}: the app in front doesn't support that orientation`);
    }
    case 'logs': return showLogs(d, args[0], opts);
    case 'crashes': return showCrashes(d, args[0], opts);
    case 'app': return opts.flags.has('paths') ? showPaths(d, args[0]) : showApp(d, args[0]);
    case 'apps': return showApps(d, args.join(' '), opts);
    case 'install': {
      need(1, 'install <path.app|path.apk> [--grant]');
      const id = await d.install(args[0], { grant: opts.flags.has('grant') });
      return console.log(`installed ${id || args[0]}`);
    }
    case 'uninstall': {
      const app = explicitApp(d, args[0], 'uninstall <app>');
      await d.uninstall(app);
      return console.log(`uninstalled ${app}`);
    }
    case 'reset': {
      const app = explicitApp(d, args[0], 'reset <app>');
      await d.reset(app);
      return console.log(`reset ${app}: data and permissions cleared — launch it to start fresh`);
    }
    case 'location': {
      need(1, 'location <lat> <lon> | location clear');
      if (args[0] === 'clear') return (await d.clearLocation(), console.log('location cleared'));
      const [lat, lon] = coordinates(args);
      await d.location(lat, lon);
      return console.log(`location ${lat}, ${lon}`);
    }
    case 'appearance': {
      if (args[0] && !['dark', 'light'].includes(args[0])) throw new UsageError('usage: looktap appearance [dark|light]');
      const front = args[0] && (await d.frontApp().catch(() => null));
      console.log(await d.appearance(args[0]));
      return noteRestart(d, front);
    }
    case 'textsize': {
      const front = args[0] && (await d.frontApp().catch(() => null));
      console.log(await d.textSize(args[0] && textSize(args[0])));
      return noteRestart(d, front);
    }
    case 'statusbar': {
      if (!['clean', 'live'].includes(args[0])) throw new UsageError('usage: looktap statusbar clean|live');
      await d.statusBar(args[0] === 'clean');
      return console.log(args[0] === 'clean' ? 'status bar: 9:41, full battery and signal' : 'status bar: live');
    }
    case 'network': {
      if (args[0] && !['offline', 'online'].includes(args[0])) throw new UsageError('usage: looktap network [offline|online]');
      return console.log(`network: ${await d.network(args[0])}`);
    }
    case 'push': {
      need(2, "push <app> <payload.json | '{json}' | text>");
      await d.push(args[0], pushPayload(args.slice(1).join(' ')));
      return console.log(`pushed to ${args[0]}`);
    }
    case 'permission': {
      const usage = `permission ${PERMISSION_ACTIONS.join('|')} <name> [app]`;
      need(2, usage);
      if (!PERMISSION_ACTIONS.includes(args[0])) throw new UsageError(`usage: looktap ${usage}`);
      const app = explicitApp(d, args[2], usage);
      const perms = await d.permission(args[0], args[1], app);
      const what = perms ? perms.join(', ') : args[1];
      return console.log(`${{ grant: 'granted', revoke: 'revoked', reset: 'reset (it will ask again)' }[args[0]]}: ${what} for ${app}`);
    }
    case 'run': return runScript(d, args, opts);
    case 'test': return runTests(d, args, opts);
    case 'codegen': return codegen(d, args, opts);
    case 'capabilities': return showCapabilities(d, opts);
    case 'perf': return showPerf(d, args[0], opts);
    default: throw new UsageError(`unknown command: ${cmd} (looktap --help)`);
  }
}

const RECORDINGS = join(HOME, 'recordings.json');

/**
 `record start [name]` / `record stop`. The recording runs in the background, so its state (the file, and the
 process to stop) is kept per device in ~/.looktap/recordings.json for the `stop` that may come later.
 */
async function record(d, args) {
  const usage = 'record start [name] | record stop';
  const all = readJson(RECORDINGS, {});
  const id = deviceId(d);
  const save = () => writeJson(RECORDINGS, all);
  if (args[0] === 'start') {
    if (all[id]) throw new UsageError(`already recording to ${all[id].path} — stop it first: looktap record stop`);
    mkdirSync(d.out, { recursive: true });
    const t = new Date(), p = (n) => String(n).padStart(2, '0');
    const name = args[1] || `rec_${t.getFullYear()}${p(t.getMonth() + 1)}${p(t.getDate())}_${p(t.getHours())}${p(t.getMinutes())}${p(t.getSeconds())}`;
    // Absolute: the stop can come from another directory.
    const path = resolve(d.out, name.endsWith('.mp4') ? name : `${name}.mp4`);
    all[id] = { ...(await d.recordStart(path)), path, started: Date.now() };
    save();
    return console.log(`recording to ${path} — stop with: looktap record stop`);
  }
  if (args[0] === 'stop') {
    const r = all[id];
    if (!r) throw new UsageError('nothing is recording on this device (looktap record start)');
    delete all[id];
    save();
    await d.recordStop(r);
    const secs = Math.round((Date.now() - r.started) / 1000);
    const capped = d.serial && secs > RECORD_LIMIT_S ? ` (Android stopped it after ${RECORD_LIMIT_S} s)` : '';
    return console.log(`${r.path}  ${Math.min(secs, d.serial ? RECORD_LIMIT_S : secs)} s${capped}`);
  }
  throw new UsageError(`usage: looktap ${usage}`);
}

/** The app a state-changing command acts on: named, or --app / config. Never guessed from the screen. */
function explicitApp(d, arg, usage) {
  const app = arg || d.app;
  if (!app) throw new UsageError(`usage: looktap ${usage} — name the app (or set --app / looktap.config.json)`);
  return app;
}

async function showLogs(d, arg, opts) {
  const app = await whichApp(d, arg);
  const since = startOf(deviceId(d), `logs:${app}`, opts.since, 60e3);
  const keep = grepper(opts.grep);
  const lines = (await d.readLogs(app, since, { errors: opts.flags.has('errors'), all: opts.flags.has('all') })).filter(keep);
  if (!lines.length) return console.log(`no ${opts.flags.has('errors') ? 'errors' : 'log lines'} from ${app} since ${clock(since)}`);
  const { shown, dropped } = tail(lines, opts.lines > 0 ? opts.lines : 80);
  if (dropped) console.log(`… ${dropped} earlier lines (--lines ${lines.length} to see them, or --grep / --errors to narrow)`);
  console.log(shown.map((l) => (l.text.length > 500 ? l.text.slice(0, 500) + ' …' : l.text)).join('\n'));
}

async function showCrashes(d, arg, opts) {
  const app = await whichApp(d, arg);
  const since = startOf(deviceId(d), `crashes:${app}`, opts.since, 3600e3);
  const found = await d.readCrashes(app, since);
  if (!found.length) return console.log(`no crashes from ${app} since ${clock(since)}`);
  console.log(found.map((c) => c.text).join('\n\n'));
}

/** What this device can't do, or can do only in part; --json: every command with its status. */
function showCapabilities(d, opts) {
  const all = capabilities(d.kind);
  if (opts.flags.has('json')) return console.log(JSON.stringify({ kind: d.kind, device: deviceId(d), commands: all }, null, 2));
  console.log(`${KINDS[d.kind].title} ${deviceId(d)}`);
  const limited = Object.entries(all).filter(([, c]) => c.status !== 'supported');
  const width = Math.max(...limited.map(([name]) => name.length));
  for (const [name, c] of limited) console.log(`${c.status === 'unsupported' ? 'no     ' : 'partly '} ${name.padEnd(width)}  ${c.why}`);
  const rest = Object.keys(all).filter((name) => all[name].status === 'supported');
  console.log(`yes     ${rest.join(', ')}`);
}

async function showApp(d, arg) {
  const front = await d.foreground();
  if (!front && (await d.locked())) console.log('front: the lock screen (the device is locked)');
  else console.log(front ? `front: ${front.id || '(unknown app)'}  pid ${front.pid}` : 'front: no app (home screen or a system sheet)');
  const app = arg || d.app;
  if (app && app !== front?.id) {
    const pid = await d.pidOf(app);
    console.log(pid ? `${app}: running in the background, pid ${pid}` : `${app}: not running — if it was, check: looktap crashes`);
  }
}

/**
 `launch --time`: a cold start (the old copy is stopped first, outside the timing), timed from the start command
 until the app is in front, and until its first screen settled: the first of two equal reads in a row (the screen
 already looked like that then). Android adds the system's own measure (am start -W's TotalTime).
 */
async function timedLaunch(d, app) {
  const t = Date.now();
  const r = await d.launch(app);
  const t0 = r?.startedAt || t;
  if (!(await waitForApp(d, app, 30000, 50))) throw new Error(`${app} didn't come to the front within 30 s`);
  const front = Date.now() - t0;
  // A read right after a launch can take a second (the helper re-reads while the launch animation runs), so the
  // screen settled at most that long before the first matching read returned: say so when it's that coarse.
  let prev = null, settled = null;
  for (const until = Date.now() + 15000; Date.now() < until; ) {
    const start = Date.now() - t0;
    const snap = await d.snapshot();
    const read = { snap, start, end: Date.now() - t0 };
    if (prev && signature(snap) === signature(prev.snap) && snap.elements.length && !sliding(snap)) {
      settled = prev;
      break;
    }
    prev = read;
    await sleep(100);
  }
  const s = (ms) => `${(ms / 1000).toFixed(2)} s`;
  const spread = settled && settled.end - settled.start;
  console.log(
    `launched ${app}: in front after ${s(front)}, ` +
      (settled == null ? 'its screen was still changing after 15 s' : `first screen settled by ${s(settled.end)}`) +
      (spread > 300 ? ` (reads took ${s(spread)} here, so it may have settled up to that much sooner)` : '') +
      (r?.totalTime ? ` · Android TotalTime ${r.totalTime} ms` : ''),
  );
}

/** `perf [app]`: one reading (or --for: one a second), or with --frames the frame stats since the last call. */
async function showPerf(d, arg, opts) {
  const app = await whichApp(d, arg);
  const json = opts.flags.has('json');
  if (opts.flags.has('frames')) {
    const f = await d.frames(app);
    return console.log(json ? JSON.stringify({ app, ...f }) : formatFrames(app, f).join('\n'));
  }
  if (opts.for == null) {
    const r = await d.perf(app);
    return console.log(json ? JSON.stringify({ app, ...readingJson(r) }) : formatReading(app, r).join('\n'));
  }
  const span = duration(opts.for);
  if (!(span > 0)) throw new UsageError('--for takes a duration: 10s, 1m, 500ms');
  // The app is looked up once; each later reading reuses its pid (a restarted app fails with "stopped").
  const t0 = Date.now(), samples = [];
  let stopped = null;
  do {
    try {
      samples.push({ at: Date.now() - t0, ...(await d.perf(app, 1000, samples[0]?.pid)) });
    } catch (e) {
      if (!samples.length) throw e;
      stopped = e; // keep what was measured before the app stopped
      break;
    }
  } while (Date.now() - t0 < span);
  if (json) console.log(JSON.stringify({ app, samples: samples.map(readingJson), ...(stopped && { stopped: stopped.message }) }));
  else console.log(formatSamples(app, samples).join('\n'));
  if (stopped) throw stopped;
}

/** `app [app] --paths`: where the app's bundle and data are, one per line. */
async function showPaths(d, arg) {
  const app = arg || d.app;
  if (!app) throw new UsageError('usage: looktap app <app> --paths (or set --app / the config)');
  for (const [what, path, note] of await d.paths(app)) console.log(`${what.padEnd(6)}  ${path}${note ? `  (${note})` : ''}`);
}

/**
 `apps [filter]`: the installed apps, one per line (--all: system apps too). A filter matches part of the id or
 name, and when nothing matches it fails (exit 1): `looktap apps com.example` answers "is it installed?".
 */
async function showApps(d, filter, opts) {
  const q = filter.toLowerCase();
  // A named app is looked for among system apps too: com.apple.Preferences, com.android.settings.
  const all = opts.flags.has('all') || Boolean(q);
  const apps = (await d.apps({ all })).filter((a) => !q || a.id.toLowerCase().includes(q) || a.name?.toLowerCase().includes(q));
  if (opts.flags.has('json')) return console.log(JSON.stringify(apps));
  if (!apps.length) {
    if (q) throw new Error(`no installed app matches "${filter}"`);
    return console.log('no apps installed besides the system ones (--all lists those)');
  }
  const width = Math.max(...apps.map((a) => a.id.length));
  for (const a of apps) console.log([a.id.padEnd(width), a.name, a.version && `v${a.version}`, a.system && '(system)'].filter(Boolean).join('  ').trimEnd());
}

/**
 `looktap mcp`: serve the commands over MCP (stdio). Each call's output — console.log/error anywhere
 in looktap — becomes the tool result; stdout carries nothing but protocol messages.
 */
async function mcp(outer) {
  const { serveMcp } = await import('../lib/mcp.js');
  const config = loadConfig();
  // A client's working directory may be anywhere (even /): screenshots go to a fixed place by default.
  const base = { ...outer, out: outer.out || process.env.LOOKTAP_OUT || config.out || join(HOME, 'shots') };
  const drivers = new Map();
  let last = null; // a call that names no device uses the one the previous call used
  const driverFor = (where) => {
    if (!where.platform && !where.device && last) return last;
    const key = `${where.platform || base.platform || ''}|${where.device || base.device || ''}`;
    if (!drivers.has(key)) drivers.set(key, pickDriver({ ...base, platform: where.platform || base.platform, device: where.device || base.device }, config));
    return (last = drivers.get(key));
  };

  let sink = null;
  const capture = (...a) => (sink ? sink.push(a.join(' ')) : process.stderr.write(a.join(' ') + '\n'));
  console.log = console.error = console.warn = console.info = capture;

  const exec = async (words, where) => {
    sink = [];
    try {
      const { opts, cmd, args } = parse(words);
      if (!cmd || cmd === 'help') capture(HELP);
      else if (cmd === 'doctor') doctor();
      else if (cmd === 'devices') capture(deviceLines(opts).join('\n'));
      else if (cmd === 'boot') capture(booted(await boot(args.join(' ') || null, { platform: opts.platform, ...display(opts, config) })));
      else if (cmd === 'shutdown') capture(shutDown(await shutdown(args.join(' ') || opts.device || null, { platform: opts.platform })));
      else if (['mcp', 'skill'].includes(cmd)) throw new UsageError(`${cmd} isn't available over MCP`);
      else {
        const d = driverFor({ platform: opts.platform || where.platform, device: opts.device || where.device });
        await dispatch(d, cmd, args, { ...base, ...opts, wait: opts.wait ?? base.wait, flags: opts.flags });
      }
      return { text: sink.join('\n') };
    } catch (e) {
      // A device that went away (or any failure that isn't a usage problem) gets a fresh driver next time.
      if (!(e instanceof UsageError)) {
        for (const [k, d] of drivers) d.close?.(), drivers.delete(k);
        last = null;
      }
      // Name the tool parameters, not the command-line flags.
      const msg = e.message.replace('pass -p ios|android', 'pass platform: "ios" or "android"').replace(/pass -d one of/, 'pass device: one of');
      return { text: [...sink, `looktap: ${msg}`].join('\n'), error: true };
    } finally {
      sink = null;
    }
  };

  const script = (text, where) => {
    const steps = splitScript(text || '');
    if (!steps.length) return { text: 'looktap: empty command', error: true };
    return steps.length === 1 ? exec(steps[0], where) : exec(['run', text], where);
  };

  const shot = async (scale, where) => {
    const r = await exec(['shot', `mcp_${Date.now()}`, '--scale', String(scale)], where);
    if (r.error) return { error: r.text };
    const path = r.text.trim().split('\n').find((l) => l.endsWith('.png'));
    return { path, png: readFileSync(path) };
  };

  await serveMcp({ version: pkg.version, exec, script, shot });
  for (const d of drivers.values()) d.close?.();
}

/** A client config for `looktap mcp` with absolute paths: GUI apps start servers with a minimal PATH. */
function mcpConfig() {
  const script = new URL(import.meta.url).pathname;
  const dirs = [dirname(process.execPath), ADB !== 'adb' ? dirname(ADB) : null, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].filter(Boolean);
  const server = { command: process.execPath, args: [script, 'mcp'], env: { PATH: [...new Set(dirs)].join(':') } };
  console.log(JSON.stringify({ mcpServers: { looktap: server } }, null, 2));
  console.error(`
Paste into your MCP client's config, e.g.
  Claude Desktop: ~/Library/Application Support/Claude/claude_desktop_config.json
  Cursor:         ~/.cursor/mcp.json
  Claude Code:    claude mcp add looktap -- ${process.execPath} ${script} mcp
                  (or, from npm without installing: claude mcp add looktap -- npx -y @looktap/mcp)`);
}

/** Several commands in this one process: one helper connection, no per-command startup. */
async function runScript(d, args, outer) {
  if (!args.length) throw new UsageError("usage: looktap run '<cmd>; <cmd> …'   or   looktap run - < script");
  return runSteps(d, args[0] === '-' ? readFileSync(0, 'utf8') : args.join(' '), outer);
}

/** Run a script's steps in order; the first failure stops it, named by its step. Returns how many ran. */
async function runSteps(d, text, outer, { env = null } = {}) {
  const steps = splitScript(text, { env });
  for (const [i, words] of steps.entries()) {
    const { opts, cmd, args: stepArgs } = parse(words);
    if (opts.platform || opts.device) throw new UsageError(`run: step ${i + 1} sets -p/-d — pass those to run itself`);
    if (cmd === 'run' || cmd === 'test') throw new UsageError(`run: steps cannot run ${cmd === 'run' ? 'scripts' : 'tests'}`);
    console.log(`$ ${words.join(' ')}`);
    try {
      await dispatch(d, cmd, stepArgs, { ...outer, ...opts, wait: opts.wait ?? outer.wait, flags: opts.flags });
    } catch (e) {
      e.message = `step ${i + 1} (${words.join(' ')}): ${e.message}`;
      throw e;
    }
  }
  return steps.length;
}

/** Everything console.log/error print while `fn` runs, as lines; what it throws is printed too. */
async function quietly(fn) {
  const lines = [];
  const saved = [console.log, console.error];
  console.log = console.error = (...a) => lines.push(...a.join(' ').split('\n'));
  try {
    await fn();
  } catch (e) {
    lines.push(`looktap: ${e.message}`);
  } finally {
    [console.log, console.error] = saved;
  }
  return lines;
}

/**
 `test <flow|dir> …`: each flow file is a `run` script, run in this process one after another. Prints one line
 per flow (a failure with its output and where its evidence went), then the totals; fails if any flow failed.
 */
async function runTests(d, args, opts) {
  if (!args.length) throw new UsageError('usage: looktap test <flow|dir> … [--junit report.xml] [-o dir]');
  const files = flowFiles(args);
  if (!files.length) throw new UsageError(`test: no flow files in ${args.join(' ')}`);
  const started = Date.now();
  const results = [];
  for (const file of files) {
    const start = Date.now();
    let error = null, steps = 0;
    // Each flow answers for its own app: one that died before it started isn't its failure.
    forgetFront(deviceId(d));
    Object.assign(testing, { on: true, gone: null });
    const lines = await quietly(async () => {
      try {
        steps = await runSteps(d, readFileSync(file, 'utf8'), opts, { env: process.env });
      } catch (e) {
        error = e;
      }
    });
    testing.on = false;
    const r = { file, ms: Date.now() - start, lines, error };
    results.push(r);
    const took = `${(r.ms / 1000).toFixed(1)} s`;
    if (!error) {
      console.log(`✓ ${file}  ${steps} step${steps === 1 ? '' : 's'} · ${took}`);
      continue;
    }
    r.evidence = await evidence(d, file, start, r);
    console.log(`✗ ${file}  ${took}\n    ${error.message}`);
    // The flow's own output, so a CI log shows how it got there.
    for (const l of lines.slice(-15)) console.log(`    │ ${l}`);
    if (r.evidence) console.log(`    evidence: ${r.evidence}`);
  }
  const ms = Date.now() - started;
  if (opts.junit) {
    mkdirSync(dirname(resolve(opts.junit)), { recursive: true });
    writeFileSync(opts.junit, junit(results, { ms }));
  }
  const failed = results.filter((r) => r.error).length;
  const total = `${results.length} flow${results.length === 1 ? '' : 's'}: ${results.length - failed} passed, ${failed} failed · ${(ms / 1000).toFixed(1)} s${opts.junit ? ` · ${opts.junit}` : ''}`;
  if (failed) throw new Error(total);
  console.log(total);
}

/**
 `codegen <flow-file> [app]`: relaunch the app (a replay starts there too), then turn each touch on the device into a
 step of the flow file as it happens. Lines typed here (expect …, wait …) run and are saved as steps; `undo` drops
 the last step; an empty line, Ctrl+D or Ctrl+C ends it. The file is rewritten after every step.
 */
async function codegen(d, args, opts) {
  if (!d.touches) unsupported(d.kind, 'codegen');
  const usage = 'usage: looktap codegen <flow-file> [app]';
  const file = args[0];
  if (!file) throw new UsageError(usage);
  if (existsSync(file)) throw new UsageError(`${file} already exists: name a new file, or delete that one first`);
  const app = args[1] || d.app || (await d.foreground())?.id;
  if (!app) throw new UsageError(`${usage} — name the app (or set --app / looktap.config.json)`);
  const ts = d.touchscreen();
  if (!ts) throw new UsageError(`can't read the touchscreen of ${deviceId(d)} (adb shell getevent -pl lists none)`);

  // A cold start, as the replay will have: a running app would come back on whatever screen it was left.
  await d.stop(app);
  await d.launch(app);
  await waitForApp(d, app, 6000);
  const first = await settle(d, { changeTimeout: 0 });
  // Something on the first screen to wait for, that `wait` finds again: the replay's proof the app is up.
  const anchor = visibleRows(first.elements).find((e) => {
    try {
      return e.label && pickMatch(first.elements, e.label) === e;
    } catch {
      return false;
    }
  });
  const steps = [`stop ${app}`, `launch ${app}`, ...(anchor ? [`wait ${quote(anchor.label)}`] : [])];
  const now = new Date(), two = (n) => String(n).padStart(2, '0');
  const when = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())} ${two(now.getHours())}:${two(now.getMinutes())}`;
  const head = `# recorded with looktap codegen on ${deviceId(d)}, ${when}\n# run it: looktap test ${file}\n`;
  mkdirSync(dirname(resolve(file)), { recursive: true });
  const save = () => writeFileSync(file, head + steps.map((s) => `${s}\n`).join(''));
  save();
  for (const s of steps) console.log(`+ ${s}`);
  const start = steps.length; // undo never takes back the start

  const rec = new Recorder(d, null, {
    emit: (s) => (steps.push(s), save(), console.log(`+ ${s}`)),
    dropLast: () => steps.length > start && (console.log(`- ${steps.pop()}`), save()),
    note: (m) => console.log(`  (${m})`),
  });
  await rec.start();
  const gestureNav = d.gestureNav();
  const view = () => {
    const { w, h, rotation } = rec.display;
    return { map: mapper(ts, rec.display, d.scale), screen: { w: (rotation % 2 ? h : w) / d.scale, h: (rotation % 2 ? w : h) / d.scale, gestureNav } };
  };
  let at = null;
  let v = view();
  const reader = new TouchReader({
    onDown: () => {
      v = view();
      at = rec.down();
    },
    onGesture: (g) => {
      const dp = { ...g, pointers: g.pointers.map((p) => ({ path: p.path.map(([t, x, y]) => [t, ...v.map(x, y)]) })) };
      rec.gesture(classify(dp, v.screen), at);
    },
  });
  rec.screen = v.screen;
  const child = d.touches((line) => reader.line(line));
  console.log(`recording ${app} to ${file} — use the phone. Type a command to add it as a step (expect "Welcome"),
undo to drop the last step, Enter on an empty line (or Ctrl+C) to finish.`);

  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
  await new Promise((done) => {
    rl.on('line', (line) => {
      const text = line.trim();
      if (!text) return rl.close();
      rec.queue = rec.queue.then(async () => {
        if (text === 'undo') return rec.dropLast();
        // What the phone did before this line comes first.
        await rec.endTyping(null);
        rec.flushSwipes();
        for (const words of splitScript(text)) {
          const { opts: o, cmd, args: a } = parse(words);
          if (['codegen', 'run', 'test'].includes(cmd)) return console.log(`  (${cmd} can't be a step)`);
          try {
            await rec.ask(() => dispatch(d, cmd, a, { ...opts, ...o, wait: o.wait ?? opts.wait, flags: o.flags }));
            rec.emit(words.map(quote).join(' '));
          } catch (e) {
            return console.log(`looktap: ${e.message} — not saved`);
          }
        }
      }).catch((e) => console.log(`looktap: ${e.message}`));
    });
    rl.on('SIGINT', () => rl.close());
    rl.on('close', done);
  });
  child.kill();
  await rec.finish();
  save();
  console.log(`saved ${steps.length} steps to ${file} — run it: looktap test ${file}`);
}

/**
 What a failed flow leaves for whoever reads the CI run, in <out>/failures/<flow>/: error.txt, output.txt,
 screen.txt (ls), screen.png, and the app's error logs and crashes since the flow started — whatever this
 device can give. Returns the folder, or null if it couldn't be written.
 */
async function evidence(d, file, since, r) {
  const dir = resolve(d.out, 'failures', flowName(file));
  try {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  } catch {
    return null;
  }
  const save = (name, lines) => lines.length && writeFileSync(join(dir, name), lines.join('\n') + '\n');
  save('error.txt', [file, r.error.message]);
  save('output.txt', r.lines);
  save('screen.txt', await quietly(() => list(d, { flags: new Set(), checked: true })));
  const out = d.out;
  d.out = dir;
  await quietly(() => d.shot('screen', {}));
  d.out = out;
  const app = d.app || testing.gone || (await d.foreground().catch(() => null))?.id;
  if (app) {
    const print = (items) => items.length && console.log(items.map((x) => x.text).join('\n'));
    save('logs.txt', await quietly(async () => print(await d.readLogs(app, since, { errors: true }))));
    save('crashes.txt', await quietly(async () => print(await d.readCrashes(app, since))));
  }
  return relative(process.cwd(), dir) || dir;
}

/** The repo the current folder is in (where .git is), else the current folder: where --project installs go. */
function repoRoot() {
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) return dir;
    if (dir === dirname(dir)) return process.cwd();
  }
}

const tilde = (p) => (p.startsWith(homedir()) ? `~${p.slice(homedir().length)}` : relative(process.cwd(), p) || p);

/**
 `skill`: print the guide. --install: write it for every coding agent found on this machine (or --agents), each in
 the folder and frontmatter that agent reads; --project: into this repo for the team. --uninstall takes it out
 again, --list shows every supported agent and what's installed where.
 */
function skill(opts) {
  const source = readFileSync(SKILL, 'utf8');
  const home = homedir();
  const actions = ['install', 'uninstall', 'list'].filter((f) => opts.flags.has(f));
  if (actions.length > 1) throw new UsageError('skill takes one of --install, --uninstall, --list');
  if (!actions.length) {
    if (opts.agents || opts.flags.has('project')) throw new UsageError('--agents and --project go with skill --install, --uninstall or --list');
    return process.stdout.write(source);
  }
  const root = opts.flags.has('project') ? repoRoot() : null;
  const found = detectAgents({ home });
  if (actions[0] === 'list') {
    const width = Math.max(...AGENTS.map((a) => a.name.length));
    const dirs = AGENTS.map((a) => skillsDir(a, { home, root }));
    const dirWidth = Math.max(...dirs.map((d) => tilde(d).length));
    console.log(`looktap ${pkg.version} · agent guide ${root ? `in ${tilde(root)}` : 'in your home folder'}\n`);
    AGENTS.forEach((a, i) => {
      const v = installedVersion(join(dirs[i], 'looktap', 'SKILL.md'));
      const plugin = a.id === 'claude' && !root && claudePlugin({ home }) ? 'the looktap plugin' : '';
      const state = v == null ? plugin : v === pkg.version ? `installed (${v})` : `installed (${v}) — outdated: looktap skill --install`;
      console.log(`${a.id.padEnd(12)} ${a.name.padEnd(width)}  ${found.includes(a) ? 'found' : '     '}  ${tilde(dirs[i]).padEnd(dirWidth)}  ${state}`.trimEnd());
    });
    return;
  }
  // Which agents: named, else the ones found here (for a repo: the two folders most agents read).
  let agents = opts.agents ? pickAgents(opts.agents) : root ? AGENTS.filter((a) => PROJECT_DEFAULT.includes(a.id)) : found;
  if (actions[0] === 'uninstall') {
    const removed = uninstallSkill(opts.agents ? agents : AGENTS, { home, root });
    if (!removed.length) return console.log('the looktap skill is not installed for any agent here');
    for (const r of removed) console.log(`removed  ${r.agent.name.padEnd(16)} ${tilde(r.dir)}`);
    return;
  }
  let note = '';
  // Claude Code with the looktap plugin already has the skill: a second copy would show it twice.
  const plugin = !root && claudePlugin({ home });
  if (plugin && !opts.agents && agents.some((a) => a.id === 'claude')) {
    agents = agents.filter((a) => a.id !== 'claude');
    note += 'Claude Code: skipped, it has the looktap plugin, which carries the skill and updates with it.\n';
  } else if (plugin && agents.some((a) => a.id === 'claude'))
    console.error('looktap: warning: Claude Code also has the looktap plugin, so it will see the skill twice (looktap skill --uninstall --agents claude undoes this copy)');
  if (!agents.length && note) return console.log(note.trim());
  if (!agents.length) {
    agents = AGENTS.filter((a) => PROJECT_DEFAULT.includes(a.id));
    note += 'No coding agent found on this machine, so it went to the two folders most agents read.\n';
  }
  const written = installSkill(agents, { source, version: pkg.version, home, root });
  console.log(`installed the looktap skill (${pkg.version}) for:`);
  for (const w of written) console.log(`  ${w.agents.map((a) => a.name).join(', ').padEnd(16)} ${tilde(w.file)}`);
  const missing = AGENTS.filter((a) => !agents.includes(a) && !(a.id === 'claude' && plugin)).map((a) => a.id);
  console.log(
    `${note}Restart an agent that's already running to load it.${missing.length ? ` Others: looktap skill --install --agents <${missing.slice(0, 4).join('|')}|…> (looktap skill --list shows them all)` : ''}`,
  );
}

/** doctor's line about the agent guide: which agents have it, and whether a copy is older than this looktap. */
function skillStatus(ok) {
  const home = homedir();
  const have = AGENTS.map((a) => ({ a, v: installedVersion(join(skillsDir(a, { home }), 'looktap', 'SKILL.md')) })).filter((x) => x.v != null);
  const stale = have.filter((x) => x.v !== pkg.version);
  if (claudePlugin({ home }) && !have.some((x) => x.a.id === 'claude')) have.unshift({ a: { name: 'Claude Code (plugin)' }, v: pkg.version });
  const names = have.map((x) => x.a.name).join(', ');
  if (!have.length) return ok(false, 'agent skill: not installed for any agent', 'looktap skill --install');
  ok(!stale.length, `agent skill: ${names}${stale.length ? ` (outdated for ${stale.map((x) => `${x.a.name} ${x.v}`).join(', ')})` : ''}`, 'looktap skill --install');
}

main().catch((e) => {
  console.error(`looktap: ${e.message}`);
  process.exit(e instanceof UsageError ? 2 : 1);
});
