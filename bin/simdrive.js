#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { Android, adbDevices } from '../lib/android.js';
import { Ios, bootedSimulators } from '../lib/ios.js';
import { center, coveringAt, formatRow, isRef, onlyStatusBar, resolveRef, saveRefs, scrollTo, settle, visibleRows, waitFor } from '../lib/screen.js';
import { UsageError, has, loadConfig, pickMatch, run, shotPath, sleep, splitScript, waitFor as retry } from '../lib/util.js';

const SKILL = new URL('../skills/simdrive/SKILL.md', import.meta.url);

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const HELP = `simdrive ${pkg.version} — drive an iOS simulator or Android emulator from the shell, no Appium.

usage: simdrive [options] <command> [args]

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

act                               add --ls to any of these to print the settled screen afterwards
  tap <label|@ref> [--exact]      @ref: a row from the last ls. Label: exact, else a prefix/contains
                                  match that names one label (ambiguous → error). Prints what it tapped
  tapxy <x> <y>                   iOS points / Android dp
  type <text>                     into the focused field
  key <name> …                    return, escape, delete, tab, space (Android: also back, home,
                                  or any KEYCODE_*; iOS: also selectall, paste)
  fill <label|@ref> <text>        clear the field, type, leave it
  hidekb                          dismiss the keyboard
  swipe <x1> <y1> <x2> <y2> [ms]
  back                            Android system back · iOS navigation-bar back button
  open <url>                      deep link (e.g. myapp://home)
  launch [app]                    (re)start the app
  bio match|nomatch               Face ID / fingerprint

batch & agents
  run '<cmd>; <cmd> …'            several commands in one process (or: run - < script). Stops at the
                                  first failure, which it names
  skill [--install]               print the AI-agent guide (--install: ~/.claude/skills/simdrive/SKILL.md)

options
  -p, --platform ios|android      default: whichever has exactly one booted device
  -d, --device <udid|serial>      default: the only booted one
  -o, --out <dir>                 screenshot dir (default ./shots, or "out" in simdrive.config.json)
      --app <id>                  app id for launch/open (or "ios.app" / "android.app" in config)
      --wait <seconds>            how long tap/fill/back wait for their target to appear (default 3)
  -h, --help · -v, --version

env: SIMDRIVE_PLATFORM, SIMDRIVE_DEVICE, SIMDRIVE_OUT, SIMDRIVE_WAIT, SIMDRIVE_SCALE (Android px per dp),
     SIMDRIVE_ANDROID_HELPER=0 (plain adb + uiautomator dump),
     SIMDRIVE_EMULATOR_GRPC=0 (no emulator gRPC frames)

Never burst-record a sign-in screen: frames capture typed credentials.`;

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
    else if (['--all', '--plain', '--exact', '--ls', '--json', '--gone', '--up', '--install'].includes(a)) opts.flags.add(a.slice(2));
    else if (a === '--') pos.push(...argv.slice(i + 1)), (i = argv.length);
    else pos.push(a);
  }
  return { opts, cmd: pos[0], args: pos.slice(1) };
}

function pickDriver(opts, config) {
  let platform = opts.platform || process.env.SIMDRIVE_PLATFORM;
  let device = opts.device || process.env.SIMDRIVE_DEVICE;
  // With both -p and -d there is nothing to detect — skip listing devices (saves 0.1–0.3 s per command).
  const known = platform && device;
  const sims = known || platform === 'android' ? [] : bootedSimulators();
  const droids = known || platform === 'ios' ? [] : adbDevices();

  if (device && !platform) {
    platform = sims.some((s) => s.id === device) ? 'ios' : droids.some((d) => d.id === device) ? 'android' : null;
    if (!platform) throw new UsageError(`device ${device} is not booted`);
  }
  if (!platform) {
    if (sims.length && !droids.length) platform = 'ios';
    else if (droids.length && !sims.length) platform = 'android';
    else if (!sims.length) throw new UsageError('no booted simulator or adb device');
    else throw new UsageError('both iOS and Android devices are up — pass -p ios|android');
  }
  const pool = platform === 'ios' ? sims : droids;
  if (!device && !known) {
    if (pool.length !== 1)
      throw new UsageError(
        pool.length ? `${pool.length} ${platform} devices — pass -d one of: ${pool.map((d) => `${d.id} (${d.name})`).join(', ')}` : `no booted ${platform} device`,
      );
    device = pool[0].id;
  }
  const out = opts.out || process.env.SIMDRIVE_OUT || config.out || 'shots';
  const app = opts.app || config[platform]?.app;
  const wait = 1000 * Number(opts.wait ?? process.env.SIMDRIVE_WAIT ?? config.wait ?? 3);
  if (!(wait >= 0)) throw new UsageError('--wait takes seconds, e.g. --wait 5');
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
      console.log(`  iOS input: ${process.env.SIMDRIVE_IOS_HID || (modern ? 'dtuhid' : 'indigo')} (CoreSimulator ${cs})`);
    }
  }
  const adb = has('adb');
  ok(adb, 'adb (Android)', 'install Android SDK platform-tools and put them on PATH');
  if (adb) {
    const d = adbDevices();
    ok(d.length > 0, `adb devices: ${d.map((x) => x.id).join(', ') || 'none'}`, 'start an emulator');
  }
}

async function burst(driver, dir, seconds) {
  if (!dir || !seconds) throw new UsageError('usage: simdrive burst <dir> <seconds>');
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
  if (cmd === 'devices') {
    for (const s of bootedSimulators()) console.log(`ios      ${s.id}  ${s.name}`);
    for (const d of adbDevices()) console.log(`android  ${d.id}`);
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
const ACTIONS = new Set(['tap', 'tapxy', 'type', 'key', 'fill', 'hidekb', 'swipe', 'back', 'open', 'launch', 'bio', 'scrollto']);

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
  const rows = visibleRows(snap.elements, { all });
  saveRefs(deviceId(d), rows);
  if (opts.flags.has('json'))
    return console.log(JSON.stringify({ screen: snap.screen, elements: rows.map((e, i) => ({ ref: `@${i + 1}`, ...e })) }));
  if (!rows.length) console.error('simdrive: no labelled elements on screen (still loading, or the app sets no accessibility labels)');
  else console.log(rows.map((e, i) => formatRow(e, i + 1)).join('\n'));
  if (onlyStatusBar(snap.elements))
    console.error('simdrive: only the status bar is readable — a system prompt (passcode, permission, alert) may be covering the app. `simdrive shot` shows it');
}

/** The element a ref names, if it's still where the last `ls` saw it. */
async function byRef(d, ref) {
  return resolveRef(deviceId(d), ref, (await d.snapshot()).elements);
}

async function dispatch(d, cmd, args, opts) {
  const all = opts.flags.has('all');
  const look = opts.flags.has('ls') && ACTIONS.has(cmd);
  // Remember the screen before acting, so --ls waits for the action to show before printing.
  const before = look ? await d.snapshot({ all }) : null;
  await act(d, cmd, args, opts);
  if (look) await list(d, opts, await settle(d, { all, before, changeTimeout: cmd === 'launch' || cmd === 'open' ? 6000 : 1500 }));
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
    if (args.length < n) throw new UsageError(`usage: simdrive ${usage}`);
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
    case 'tap': {
      need(1, 'tap <label|@ref>');
      const { e, snap } = await target(d, isRef(args[0]) ? args[0] : args.join(' '), opts);
      const at = center(e);
      await d.tapxy(...at);
      console.log(`tapped ${JSON.stringify(e.label || e.type)} at ${at.join(',')}`);
      // The tap lands on whatever is on top: say so when something else covers the point.
      for (const c of coveringAt(snap.elements, e, at))
        console.error(`simdrive: warning: ${JSON.stringify(c.label || c.type)} at ${c.x},${c.y} ${c.w}x${c.h} covers that point and may have taken the tap`);
      return;
    }
    case 'tapxy': need(2, 'tapxy <x> <y>'); return d.tapxy(Number(args[0]), Number(args[1]));
    case 'type': need(1, 'type <text>'); return d.type(args.join(' '));
    case 'key': need(1, 'key <name> … (return, escape, delete, tab, space)'); return d.keys(args);
    case 'fill': {
      need(1, 'fill <label|@ref> <text>');
      const text = args.slice(1).join(' ');
      if (!isRef(args[0])) return d.fill(args[0], text, { exact: opts.flags.has('exact') });
      return d.fillAt(...center(await byRef(d, args[0])), text);
    }
    case 'hidekb': return d.hidekb();
    case 'swipe': need(4, 'swipe <x1> <y1> <x2> <y2> [ms]'); return d.swipe(...args.slice(0, 4).map(Number), args[4] ? Number(args[4]) : undefined);
    case 'back': return d.back();
    case 'open': need(1, 'open <url>'); return d.open(args[0]);
    case 'launch': {
      const app = args[0] || d.app;
      if (!app) throw new UsageError('usage: simdrive launch <app-id> (or set --app / simdrive.config.json)');
      return d.launch(app);
    }
    case 'bio': need(1, 'bio match|nomatch'); return d.bio(args[0]);
    case 'run': return runScript(d, args, opts);
    default: throw new UsageError(`unknown command: ${cmd} (simdrive --help)`);
  }
}

/** Several commands in this one process: one helper connection, no per-command startup. */
async function runScript(d, args, outer) {
  if (!args.length) throw new UsageError("usage: simdrive run '<cmd>; <cmd> …'   or   simdrive run - < script");
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
  const dest = join(homedir(), '.claude', 'skills', 'simdrive', 'SKILL.md');
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, text);
  console.log(`installed ${dest}`);
}

main().catch((e) => {
  console.error(`simdrive: ${e.message}`);
  process.exit(e instanceof UsageError ? 2 : 1);
});
