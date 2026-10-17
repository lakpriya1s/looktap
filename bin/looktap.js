#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { Android, RECORD_LIMIT_S, adbDevices } from '../lib/android.js';
import { Ios, bootedSimulators } from '../lib/ios.js';
import { IosDevice, physicalDevices } from '../lib/iosdevice.js';
import { clock, grepper, startOf, tail, whichApp } from '../lib/logs.js';
import { ACTIONS as PERMISSION_ACTIONS } from '../lib/permissions.js';
import { ORIENTATIONS, coordinates, pushPayload, rotation, textSize } from '../lib/conditions.js';
import { appGone, center, coveringAt, forgetFront, formatRow, isRef, lastFront, onlyStatusBar, resolveRef, saveRefs, scrollTo, settle, visibleRows, waitFor } from '../lib/screen.js';
import { ADB, HOME, UsageError, has, loadConfig, pickMatch, readJson, run, shotPath, sleep, splitScript, waitFor as retry, writeJson } from '../lib/util.js';

const SKILL = new URL('../skills/looktap/SKILL.md', import.meta.url);

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const HELP = `looktap ${pkg.version} — drive iPhone and Android devices from the shell.

usage: looktap [options] <command> [args]

setup & info
  devices                         booted simulators and adb devices
  doctor                          check the toolchain
  setup                           start the helper (optional: commands start it on first use)
                                  · Android: also adb reverse Metro
  teardown                        stop the helper · Android: remove adb reverse rules

look
  ls [--all] [--json]             on-screen elements: @ref  type  x,y  WxH  label  [= value]
  wait <label|@ref> [--gone]      until it appears (or disappears); default timeout 10 s, or --wait
  scrollto <label> [--up]         swipe until it is fully on screen (default scrolls down)
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
  fill <label|@ref> <text>        clear the field, type, leave it
  hidekb                          dismiss the keyboard
  swipe <x1> <y1> <x2> <y2> [ms]
  back                            Android system back · iOS navigation-bar back button
  home                            the Home button: to the home screen, the app left running
  open <url>                      deep link (e.g. myapp://home)
  launch [app]                    (re)start the app
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
  run '<cmd>; <cmd> …'            several commands in one process (or: run - < script). Stops at the
                                  first failure, which it names
  skill [--install]               print the AI-agent guide (--install: ~/.claude/skills/looktap/SKILL.md)

options
  -p, --platform ios|android      default: whichever has exactly one booted device
  -d, --device <udid|serial>      default: the only booted one
  -o, --out <dir>                 screenshots and videos (default ./shots, or "out" in looktap.config.json)
      --app <id>                  app id for launch/open (or "ios.app" / "android.app" in config)
      --wait <seconds>            how long tap/fill/back wait for their target to appear (default 3)
  -h, --help · -v, --version

env: LOOKTAP_PLATFORM, LOOKTAP_DEVICE, LOOKTAP_OUT, LOOKTAP_WAIT, LOOKTAP_SCALE (Android px per dp),
     LOOKTAP_ANDROID_HELPER=0 (plain adb + uiautomator dump),
     LOOKTAP_EMULATOR_GRPC=0 (no emulator gRPC frames)

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
    else if (['--all', '--plain', '--exact', '--ls', '--json', '--gone', '--up', '--install', '--errors', '--grant', '--config'].includes(a)) opts.flags.add(a.slice(2));
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
    else if (!sims.length) throw new UsageError('no booted simulator or adb device');
    else throw new UsageError('both iOS and Android devices are up — pass -p ios|android');
  }
  const pool = platform === 'ios' ? (sims.length || known || device ? sims : lookForPhones()) : droids;
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
    ok(sims.length > 0, `booted simulators: ${sims.map((s) => s.name).join(', ') || 'none'}`, 'xcrun simctl boot <udid>');
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
  const adb = ADB !== 'adb' || has('adb');
  ok(adb, `adb (Android)${ADB !== 'adb' ? `: ${ADB}` : ''}`, 'install Android SDK platform-tools (or set ANDROID_HOME)');
  if (adb) {
    const d = adbDevices();
    ok(d.length > 0, `adb devices: ${d.map((x) => x.id).join(', ') || 'none'}`, 'start an emulator');
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
  if (cmd === 'devices') {
    for (const s of bootedSimulators()) console.log(`ios      ${s.id}  ${s.name}`);
    for (const d of adbDevices()) console.log(`android  ${d.id}`);
    for (const p of physicalDevices()) console.log(`ios      ${p.id}  ${p.name} (device, iOS ${p.os})`);
    return;
  }

  const config = loadConfig();
  const d = pickDriver(opts, config);
  try {
    return await dispatch(d, cmd, args, opts);
  } finally {
    d.close?.();
  }
}

const deviceId = (d) => d.udid || d.serial;
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
  if (onlyStatusBar(snap.elements))
    console.error('looktap: only the status bar is readable — a system prompt (passcode, permission, alert) may be covering the app. `looktap shot` shows it');
}

/** The element a ref names, if it's still where the last `ls` saw it. */
async function byRef(d, ref) {
  return resolveRef(deviceId(d), ref, (await d.snapshot()).elements);
}

/** Actions after which a vanished app is worth a warning (launch replaces the app on purpose). */
const WATCHED = new Set([...ACTIONS].filter((c) => c !== 'launch'));

/** Until `app` is the app in front (or `ms` pass). */
async function waitForApp(d, app, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const f = await d.frontApp().catch(() => null);
    if (f && d.appId(f) === app) return;
    await sleep(150);
  }
}

function warnIfGone(app, when = '') {
  if (app) console.error(`looktap: warning: ${app} is no longer running${when ? ` (${when})` : ''} — it crashed or was killed. See: looktap crashes ${app}`);
}

async function dispatch(d, cmd, args, opts) {
  const all = opts.flags.has('all');
  const look = opts.flags.has('ls') && ACTIONS.has(cmd);
  // Remember the screen before acting, so --ls waits for the action to show before printing.
  const before = look ? await d.snapshot({ all }) : null;
  const app = WATCHED.has(cmd) ? await d.frontApp().catch(() => null) : null;
  await act(d, cmd, args, opts);
  if (['launch', 'reset', 'uninstall', 'install'].includes(cmd)) forgetFront(deviceId(d));
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
  return retry(async () => {
    const snap = await d.snapshot();
    if (isRef(what)) return { e: resolveRef(deviceId(d), what, snap.elements), snap };
    const live = snap.elements.filter((e) => e.w > 0 && e.h > 0);
    return { e: live.find((e) => e.id === what) || pickMatch(live, what, { exact: opts.flags.has('exact') }), snap };
  }, isRef(what) ? 0 : d.wait);
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
    case 'scrollto': {
      need(1, 'scrollto <label> [--up]');
      const hit = await scrollTo(d, args.join(' '), { up: opts.flags.has('up') });
      return console.log(`found ${JSON.stringify(hit.label)} at ${center(hit).join(',')}`);
    }
    case 'shot': {
      need(1, 'shot <name> [--scale f]');
      if (opts.scale != null && !(opts.scale > 0 && opts.scale <= 1)) throw new UsageError('--scale takes a factor between 0 and 1, e.g. --scale 0.5');
      return d.shot(args[0], { plain: opts.flags.has('plain'), scale: opts.scale ?? 1 });
    }
    case 'burst': return burst(d, args[0], args[1]);
    case 'record': return record(d, args);
    case 'tap': {
      need(1, 'tap <label|@ref>');
      const { e, snap } = await target(d, isRef(args[0]) ? args[0] : args.join(' '), opts);
      const at = center(e);
      await d.tapxy(...at);
      console.log(`tapped ${JSON.stringify(e.label || e.type)} at ${at.join(',')}`);
      // The tap lands on whatever is on top: say so when something else covers the point.
      for (const c of coveringAt(snap.elements, e, at))
        console.error(`looktap: warning: ${JSON.stringify(c.label || c.type)} at ${c.x},${c.y} ${c.w}x${c.h} covers that point and may have taken the tap`);
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
        const { e } = await target(d, isRef(words[0]) ? words[0] : words.join(' '), opts);
        (at = center(e)), (what = `${JSON.stringify(e.label || e.type)} at ${at.join(',')}`);
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
      const left = before && before.id !== launcher && before.id ? await d.pidOf(before.id) : 0;
      return console.log(`home screen${left ? ` · ${before.id} still running in the background, pid ${left}` : ''}`);
    }
    case 'open': need(1, 'open <url>'); return d.open(args[0]);
    case 'launch': {
      const app = args[0] || d.app;
      if (!app) throw new UsageError('usage: looktap launch <app-id> (or set --app / looktap.config.json)');
      return d.launch(app);
    }
    case 'stop': {
      const app = explicitApp(d, args[0], 'stop <app>');
      const was = await d.stop(app);
      if (!was) return console.log(`${app} wasn't running`);
      // Stopped means its process is gone, not that the stop was sent.
      for (let i = 0; i < 20 && (await d.pidOf(app)); i++) await sleep(250);
      const pid = await d.pidOf(app);
      if (pid) throw new Error(`${app} is still running (pid ${pid}) after the stop`);
      return console.log(`stopped ${app} (pid ${was})`);
    }
    case 'bio': need(1, 'bio match|nomatch'); return d.bio(args[0]);
    case 'rotate': {
      const want = args[0] ? rotation(args[0]) : null;
      const r = await d.rotate(want);
      const now = `${ORIENTATIONS[r.turns]} (${r.w}x${r.h})`;
      if (want == null) return console.log(now);
      if (r.turns === want) return console.log(`rotated: ${now}`);
      return console.log(`turned the device to ${ORIENTATIONS[want]}, but the screen stays ${now}: the app in front doesn't support that orientation`);
    }
    case 'logs': return showLogs(d, args[0], opts);
    case 'crashes': return showCrashes(d, args[0], opts);
    case 'app': return showApp(d, args[0]);
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
      return console.log(await d.appearance(args[0]));
    }
    case 'textsize': return console.log(await d.textSize(args[0] && textSize(args[0])));
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

async function showApp(d, arg) {
  const front = await d.foreground();
  console.log(front ? `front: ${front.id || '(unknown app)'}  pid ${front.pid}` : 'front: no app (home screen or a system sheet)');
  const app = arg || d.app;
  if (app && app !== front?.id) {
    const pid = await d.pidOf(app);
    console.log(pid ? `${app}: running in the background, pid ${pid}` : `${app}: not running — if it was, check: looktap crashes`);
  }
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
      else if (cmd === 'devices') {
        for (const s of bootedSimulators()) capture(`ios      ${s.id}  ${s.name}`);
        for (const a of adbDevices()) capture(`android  ${a.id}`);
        for (const p of physicalDevices()) capture(`ios      ${p.id}  ${p.name} (device, iOS ${p.os})`);
      } else if (['mcp', 'skill'].includes(cmd)) throw new UsageError(`${cmd} isn't available over MCP`);
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
    const path = r.text.trim().split('\n').pop();
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
  const steps = splitScript(args[0] === '-' ? readFileSync(0, 'utf8') : args.join(' '));
  for (const [i, words] of steps.entries()) {
    const { opts, cmd, args: stepArgs } = parse(words);
    if (opts.platform || opts.device) throw new UsageError(`run: step ${i + 1} sets -p/-d — pass those to run itself`);
    if (cmd === 'run') throw new UsageError('run: steps cannot run scripts');
    console.log(`$ ${words.join(' ')}`);
    try {
      await dispatch(d, cmd, stepArgs, { ...outer, ...opts, wait: opts.wait ?? outer.wait, flags: opts.flags });
    } catch (e) {
      e.message = `step ${i + 1} (${words.join(' ')}): ${e.message}`;
      throw e;
    }
  }
}

function skill(opts) {
  const text = readFileSync(SKILL, 'utf8');
  if (!opts.flags.has('install')) return process.stdout.write(text);
  const dest = join(homedir(), '.claude', 'skills', 'looktap', 'SKILL.md');
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, text);
  console.log(`installed ${dest}`);
}

main().catch((e) => {
  console.error(`looktap: ${e.message}`);
  process.exit(e instanceof UsageError ? 2 : 1);
});
