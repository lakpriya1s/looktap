#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { Android, adbDevices } from '../lib/android.js';
import { Ios, bootedSimulators } from '../lib/ios.js';
import { UsageError, has, loadConfig, run, shotPath, sleep } from '../lib/util.js';

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
  ls [--all]                      on-screen elements: x,y  WxH  label
  shot <name> [--plain]           screenshot → <out>/<name>.png (Android emulators bypass FLAG_SECURE;
                                  --plain uses screencap)
  burst <dir> <seconds>           paced frames for transient states; duplicates removed

act
  tap <label> [--exact]           accessibility label: exact, else a prefix/contains match that
                                  names one label (ambiguous → error). Prints what it tapped
  tapxy <x> <y>                   iOS points / Android dp
  type <text>                     into the focused field
  fill <label> <text>             clear the field at <label>, type, leave it
  hidekb                          dismiss the keyboard
  swipe <x1> <y1> <x2> <y2> [ms]
  back                            Android system back
  open <url>                      deep link (e.g. myapp://home)
  launch [app]                    (re)start the app
  bio match|nomatch               Face ID / fingerprint

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
    else if (a === '--all' || a === '--plain' || a === '--exact') opts.flags.add(a.slice(2));
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

async function dispatch(d, cmd, args, opts) {
  const need = (n, usage) => {
    if (args.length < n) throw new UsageError(`usage: simdrive ${usage}`);
  };

  switch (cmd) {
    case 'setup': return d.setup();
    case 'teardown': return d.teardown();
    case 'ls': return d.ls({ all: opts.flags.has('all') });
    case 'shot': need(1, 'shot <name>'); return d.shot(args[0], { plain: opts.flags.has('plain') });
    case 'burst': return burst(d, args[0], args[1]);
    case 'tap': need(1, 'tap <label>'); return d.tap(args.join(' '), { exact: opts.flags.has('exact') });
    case 'tapxy': need(2, 'tapxy <x> <y>'); return d.tapxy(Number(args[0]), Number(args[1]));
    case 'type': need(1, 'type <text>'); return d.type(args.join(' '));
    case 'fill': need(1, 'fill <label> <text>'); return d.fill(args[0], args.slice(1).join(' '), { exact: opts.flags.has('exact') });
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
    default: throw new UsageError(`unknown command: ${cmd} (simdrive --help)`);
  }
}

main().catch((e) => {
  console.error(`simdrive: ${e.message}`);
  process.exit(e instanceof UsageError ? 2 : 1);
});
