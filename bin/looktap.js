#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

import { Android, RECORD_LIMIT_S, adbDevices, overWifi, wifiTwin } from '../lib/android.js';
import { KEEPER, connect, hasKeeper, installKeeper, pair, removeKeeper, wifi } from '../lib/wifi.js';
import { Ios, bootedSimulators } from '../lib/ios.js';
import { IosDevice, physicalDevices } from '../lib/iosdevice.js';
import { clock, grepper, setMark, sinceOf, startOf, tail, whichApp } from '../lib/logs.js';
import { ACTIONS as PERMISSION_ACTIONS } from '../lib/permissions.js';
import { COMMANDS, KINDS, capabilities, capability, unsupported } from '../lib/capabilities.js';
import { Recorder, TouchReader, classify, mapper, quote } from '../lib/codegen.js';
import { AGENTS, PROJECT_DEFAULT, claudePlugin, detectAgents, installSkill, installedVersion, pickAgents, skillsDir, uninstallSkill } from '../lib/agents.js';
import { boot, shutdown } from '../lib/boot.js';
import { resizePng } from '../lib/png.js';
import { formatDevice, inventory, lastDevice, rememberDevice } from '../lib/devices.js';
import { ORIENTATIONS, coordinates, foldPosition, pushPayload, rotation, textSize } from '../lib/conditions.js';
import { LOGBOX, appGone, center, logBoxAround, valueBeside, coverage, expectOn, fillCode, poller, tapPoint, forgetFront, formatCoverage, formatRow, isRef, lastFront, logBoxToast, rememberFront, onlyStatusBar, resolveRef, saveRefs, scrollTo, settle, signature, sliding, stillScreen, visibleRows, waitFor } from '../lib/screen.js';
import { formatNotification, fromApp, notificationJson, notificationMatches } from '../lib/notifications.js';
import { duration, formatFrames, formatReading, formatSamples, readingJson } from '../lib/perf.js';
import { flowFiles, flowName, junit } from '../lib/testing.js';
import { clockTime, distance, gpxPlan, metres, parseGpx, planSummary, point, scrubCoords, straightPlan } from '../lib/geo.js';
import { formatPrefs, redactList } from '../lib/prefs.js';
import { BusyError, acquire, kindOf, leases } from '../lib/lease.js';
import { RECOVERY, adbRows, didYouMean, rememberReverses, release, restartAdb, whoLines } from '../lib/upkeep.js';
import { metroUp } from '../lib/android.js';
import { etimeSecs } from '../lib/health.js';
import { ADB, HOME, LockedError, NotFound, StuckError, UsageError, has, loadConfig, pickMatch, readJson, run, shotPath, sleep, splitScript, waitFor as retry, writeJson } from '../lib/util.js';

const SKILL = new URL('../skills/looktap/SKILL.md', import.meta.url);
const SKILL_REFS = new URL('../skills/looktap/references/', import.meta.url);

/** The skill's reference files, { 'commands.md': text, … }: installed beside SKILL.md, printed by `skill <name>`. */
function skillReferences() {
  return Object.fromEntries(readdirSync(SKILL_REFS).filter((f) => f.endsWith('.md')).sort().map((f) => [f, readFileSync(new URL(f, SKILL_REFS), 'utf8')]));
}

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const HELP = `looktap ${pkg.version} — drive iPhone and Android devices from the shell.

usage: looktap [options] <command> [args]

setup & info
  devices [--all] [--json]        what's running or connected: simulator, emulator or real device (model, OS,
                                  USB/Wi-Fi), with window or headless, and what to do for a phone not ready yet.
                                  --all: also what boot can start
  boot [name] [--window|--headless]  boot a simulator or emulator (an iPhone, an Apple Watch, an Android or Wear OS
                                  AVD; name, UDID or AVD; -p to choose) and wait until
                                  it's ready. Default: a window (LOOKTAP_HEADLESS=1 or "headless": true in config
                                  for headless). On a running simulator --window opens its window
  shutdown [name]                 shut down a simulator or emulator
  wifi [--tcpip|--always|--off]   Android phone on USB: connect it over Wi-Fi too, so the cable can come out
                                  (-d still takes its USB serial). Turns on Wireless debugging (Android 11+),
                                  else adb tcpip 5555 (--tcpip: always). Both go off when the phone restarts.
                                  --always (Android 11+, once): installs looktap's small Wi-Fi keeper app, which
                                  turns it back on after restarts and on joining Wi-Fi. --off: removes it
  pair <code> [host:port]         Android, no cable: pair over Wi-Fi with the code on the phone (Developer
                                  options → Wireless debugging → Pair device with pairing code), then connect
  connect <host[:port]>           Android, no cable and no code: connect to the address a device's debugging screen
                                  shows (a Wear OS watch's Debug over Wi-Fi, or after adb tcpip; port 5555 if left
                                  out), waiting while it asks "Allow debugging?"
  doctor [-d <device>] [--fix [--yes]]
                                  check the toolchain; with -d, the way to that device: how it's connected, whether
                                  it's locked, and (a real iPhone) whether its runner answers, over which route.
                                  Android: the adb server and every adb process, the device's state and round trip,
                                  its USB path (hubs), reverse rules, and the recovery steps when one fails.
                                  --fix: restart the adb server (lists who it cuts off and asks first; --yes doesn't),
                                  then put the adb reverse rules back
  who [device]                    who is using the devices: looktap commands and their log captures (exclusive or
                                  shared, owner, age, heartbeat), and adb/idevicesyslog processes started elsewhere
  release <device> [--force]      clear holds whose process is gone or silent for 30 s (--force: live ones, asks)
  reverse <port>[:<port>] | --list | remove <port>|all
                                  Android: the device's localhost:<port> reaches this computer's port (adb reverse)
  metro [port]                    Metro answering here, the reverse rule (added if missing), the device reaching it
  setup                           start the helper (optional: commands start it on first use)
                                  · Android: also adb reverse Metro
  teardown                        stop the helper · Android: remove adb reverse rules

look
  ls [--all] [--json] [--covered]
                                  on-screen elements: @ref  type  x,y  WxH  label  [= value]. A row partly hidden
                                  says so: [56% covered by @16 @17], [30% off screen]. --covered: only those rows
  wait <label|@ref> [--gone]      until it appears (or disappears); default timeout 10 s, or --wait
  wait --settle [--for 1s]        until the screen (its elements and its picture) holds still for 1 s: for web
                                  pages and canvases with no labels to wait for. Timeout 10 s, or --wait
  expect <label|@ref> [= value] [--gone] [--exact]
                                  check it's on screen (with that value), or with --gone that it isn't.
                                  Waits up to --wait (3 s) for it; fails with what's there instead (exit 1)
  scrollto <label> [--up]         swipe until it is fully on screen (default scrolls down; above the keyboard)
  shot <name> [--plain] [--scale f] [--points]  (or screenshot)
                                  screenshot → <out>/<name>.png; --scale 0.5 = half size, fewer image tokens;
                                  --points: one pixel per iOS point / Android dp, so a spot in the image is
                                  tapxy's x y as is (Android emulators bypass FLAG_SECURE; --plain doesn't)
  burst <dir> <seconds>           a frame whenever the screen changes; duplicates removed
  record start [name] | stop      screen video → <out>/<name>.mp4, in the background until stopped
                                  (Android: at most 3 min, and FLAG_SECURE screens record black)

act                               add --ls to any of these to print the settled screen afterwards
  tap <label|@ref> [--exact]      @ref: a row from the last ls. Label: exact, else a prefix/contains
                                  match that names one label (ambiguous → error). Prints what it tapped
  longpress <label|@ref|x y> [ms]
                                  hold for ms (default 800; or --duration <ms>)
  zoom in|out [x y] [--scale f]   two-finger pinch around a point (default: the screen centre; scale 2.5)
  tapxy <x> <y>                   iOS points / Android dp
  type <text>                     into the focused field
  key <name> …                    return, escape, delete, tab, space, selectall, paste, home
                                  (Android: also back, or any KEYCODE_*)
  fill <label|@ref> <text>        clear the field, type, check it holds the text (a password field: its
                                  length), retyping slowly if it doesn't; fails if it still doesn't
  paste <text>                    put text on the device's clipboard, check it's there, paste it into the
                                  focused field
  code <digits>                   a one-time code into its row of boxes: types from the first box, checks
                                  each box, pastes the code if typing didn't fill them
  hidekb                          dismiss the keyboard and take focus from the field
  swipe <x1> <y1> <x2> <y2> [ms]  a drag over ms (or --duration <ms>)
  back                            Android system back · iOS navigation-bar back button
  home                            the Home button: to the home screen, the app left running
  open <url>                      deep link (e.g. myapp://home)
  launch [app] [--time|--resume] [--until <text>]
                                  (re)start the app. --time: how long until it's in front and its first
                                  screen has settled (Android: also the system's own TotalTime). --resume:
                                  bring it forward as it was, without restarting it. --until: then wait until
                                  <text> is on screen (past a splash screen; up to --wait, default 30 s)
  stop [app]                      (or terminate) terminate it, and wait until its process is gone (Android: force-stop, which
                                  also removes its geofences, alarms and jobs)
  kill [app]                      end its process as the system does under memory pressure (Home, then Android
                                  am kill / iOS SIGKILL): its registrations survive, for "app killed" tests
  background [app]                Home, then check the app is in the background and still running
  value <label|@ref>              print the element's value alone (a switch: 1 or 0), for scripts
  bio match|nomatch               Face ID / fingerprint
  dismiss logbox [--until-gone]   close React Native's LogBox toast (dev builds), which blocks taps around it.
                                  --until-gone: close it again whenever it comes back, until it stays gone 1 s.
                                  "dismissLogBox": true in looktap.config.json closes it before every tap
  rotate [portrait|landscape|left|right|upsidedown]
                                  turn the device (landscape = left: turned counter-clockwise); no
                                  argument prints the current orientation. ls, taps and shots follow it
  fold [closed|half|open]         fold or open a foldable simulator (iPhone Duo); ls, taps and shots follow
                                  the screen it then shows. No argument prints which one that is

debug                             [app] defaults to --app / config, else the app in front
  logs [app] [--errors] [--grep re] [--since 5m|<mark>] [--lines n] [--all]
                                  the app's log since the last \`logs\` (first time: the last minute).
                                  iOS hides Apple-framework chatter unless it's an error (--all keeps it).
                                  A real iPhone has no history: collected from the first logs or launch on
  logs [app] --follow [--grep re] [--for 10m]
                                  the app's log as it comes, until Ctrl+C (or --for), with its process starting
                                  and ending as events: a killed app relaunched in the background shows here
  logs [app] --buffer <b> | --tag T1,T2
                                  Android: one logcat buffer (main, system, crash, events, all), or only those tags.
                                  An empty answer is checked against the device's clock: a stale log is warned about
  logs [app] --follow --file <f>  the capture appended to a file; after an adb restart it attaches again and records
                                  the gap
  logs --clear                    Android: empty the device's log (logcat -c)
  logs mark [name]                a marker now: --since <name> starts there (default name: mark)
  crashes [app] [--since 1h]      crashes, ANRs, low-memory kills since the last \`crashes\` (first: last hour)
  app [app]                       which app is in front, and whether [app] is running (pid)
  ps <app>                        its pid, how long it has run, and whether it's in front
  app [app] --paths               where its files are: iOS the bundle, data folder and app groups (on the Mac),
                                  Android its APKs and data folder (readable with run-as on debuggable builds)
  apps [filter] [--all] [--json]  installed apps: id, name, version (--all: system apps too). A filter
                                  matches part of the id or name; nothing matching → exit 1
  notifications [app] [--until <text>] [--all] [--json]
                                  what Notification Center / the notification shade holds, newest first: app,
                                  title, body (iOS simulator: also the push payload). --until: wait until one
                                  has <text> (up to --wait, default 30 s). A real iPhone: read off its screen,
                                  pulling Notification Center down for a moment. --all: ongoing ones too
  prefs <app> [key …] [--file f] [--redact k,…] [--json]
                                  the app's UserDefaults (iOS; a device: development builds) or SharedPreferences
                                  (Android: debuggable builds, --file picks the file) as key = value. Values whose
                                  keys look like coordinates are redacted, and --redact hides more keys
  geofences [app]                 Android: the geofences the system holds for the app (no coordinates)
  battery [app] [--reset|--restore]
                                  Android: the app's battery use since --reset (which also makes a phone on USB
                                  count as unplugged; --restore undoes that)
  network <app> [--for 60s]       Android: what the app sent and received over the window, and in how many bursts
  capabilities [--json]           what this device can't do, or can only in part, and why
  perf [app] [--for 10s] [--json] the app's CPU (100% = one core), memory and threads; --for: a reading
                                  each second, then avg/max (iOS: the footprint Xcode shows; Android: PSS)
  perf [app] --frames             frames since the last perf --frames, janky %, p50–p99 frame time (iOS: from
                                  the screen itself, a real iPhone over its USB cable; the first call starts counting)

app state                         <app> defaults to --app / config (never the app in front)
  install <path> [--grant]        iOS: a simulator .app · Android: an .apk (keeps data; --grant: all
                                  runtime permissions). Prints the app id, version code and how long it took
  uninstall <app>
  reset <app>                     as if freshly installed: data and permissions cleared (iOS: the
                                  keychain survives, as on a real iPhone)
  permission grant|revoke|reset <name> [app]
                                  camera, microphone, location, location-always, photos, contacts,
                                  calendar, notifications, motion, all … (Android: or android.permission.*)

conditions
  location <lat> <lon> | clear    simulated GPS; prints "location set", never the coordinates. Android phones:
                                  through the shell's test providers (Android 12+); clear restores the real GPS
  route --from <lat,lon>|--from-current|--offset-from-pref <app>:<latKey>,<lonKey>
        --distance 630m [--bearing 0] [--speed 1.4] [--step 1s] [--then-still 7m] [--background]
  route --gpx <file> [--speed-scale 2] [--step 1s] [--then-still 7m] [--background]
                                  move, not jump: fixes along a line (bearing in degrees, speed in m/s) or a GPX
                                  track, then hold still. Prints distance and time, never coordinates
  route stop | status             end a route (and remove the test providers: the real GPS again); how far it got
  appearance [dark|light]         dark mode; no argument prints the current one
  textsize [size]                 Dynamic Type / font scale: xs s m l xl xxl xxxl ax1…ax5 (or the iOS
                                  names, e.g. accessibility-large); no argument prints the current one
  statusbar clean|live            9:41, full battery and signal, for screenshots
  network [offline|online]        Android: airplane mode; no argument prints the current state (the iOS
                                  simulator shares the Mac's network)
  push <app> <payload>            iOS: a remote notification. Payload: a .json file, '{json}', or plain
                                  text for an alert (Android pushes need Firebase)

flows                             steps of run scripts and test flows, for what has no label to wait for
  pause <seconds>                 wait a fixed time (2, 1.5s, 500ms): prefer wait/wait --settle when they apply
  handoff <message> [--until <label|@ref>] [--gone]
                                  a person's turn (a consent screen, a second factor): shows the message (and a
                                  macOS notification), then waits until <label> is on screen (--gone: off it),
                                  up to 5 min or --wait. Without --until, until Enter is pressed in the terminal

batch & agents
  mcp [--config]                  serve these commands over MCP (stdio), for AI clients without a shell.
                                  --config prints a client config with absolute paths
  codegen <flow-file> [app]       Android: restart the app, then save each touch on the device as a flow
                                  step (tap by label, fill, scrollto, back …). Commands typed here (expect …)
                                  are run and saved too; undo drops the last step; Enter or Ctrl+C ends it
  run '<cmd>; <cmd> …' [--ls]     several commands in one process (or: run - < script). Stops at the
                                  first failure, which it names, with the screen and the steps not run;
                                  --ls: then the screen it ended on. Separate looktap commands chained in one
                                  shell script: after a failed action the later actions and waits are skipped
                                  (LOOKTAP_CONTINUE_AFTER_FAILURE=1 runs them anyway)
  test <flow|dir> … [--junit f]   run flow files (run scripts, one step per line) as tests: a line per
                                  flow, exit 1 if any fails. A failure saves the screen, a screenshot,
                                  error logs and crashes in <out>/failures/<flow>/; --junit writes a report.
                                  An app that dies during a flow fails it
  skill [name] [--install|--uninstall|--list] [--agents a,b|all] [--project]
                                  print the AI-agent guide (name: one of its references, e.g. commands). --install: into every coding agent found here
                                  (Claude Code, Codex, Cursor, Gemini CLI, Copilot, OpenCode, …), or --agents;
                                  run it again after an upgrade. --project: into this repo instead of your
                                  home folder. --list: the agents, what's installed where

options
  -p, --platform ios|android      default: whichever has exactly one booted device
  -d, --device <udid|serial>      default: the one the last command used (for 10 min, while it's up),
                                  else the only booted one
  -o, --out <dir>                 screenshots and videos (default ./shots, or "out" in looktap.config.json)
      --app <id>                  app id for launch/open (or "ios.app" / "android.app" in config)
      --wait <seconds>            how long tap/fill/back wait for their target to appear (default 3)
      --busy-wait <seconds>       when another session is driving the device, wait this long for it (default 10),
                                  then fail with who holds it (LOOKTAP_BUSY_WAIT)
      --wait-unlock <seconds>     when the device is locked, wait this long for someone to unlock it, then carry
                                  on (default 0: fail at once). Or "waitUnlock" in config, LOOKTAP_WAIT_UNLOCK
  -h, --help · -v, --version

env: LOOKTAP_PLATFORM, LOOKTAP_DEVICE, LOOKTAP_OUT, LOOKTAP_WAIT, LOOKTAP_SCALE (Android px per dp),
     LOOKTAP_ANDROID_HELPER=0 (plain adb + uiautomator dump), LOOKTAP_ADB_TIMEOUT (seconds an adb call may
     take, default 15), LOOKTAP_OWNER (your session's name in looktap who),
     LOOKTAP_EMULATOR_GRPC=0 (no emulator gRPC frames), LOOKTAP_HEADLESS=1 (boot without a window)

Never burst or record a sign-in screen: frames capture typed credentials.`;

/** Other names for a command: what adb, simctl and other tools call it. (`kill` is its own command: see kill vs stop.) */
const ALIASES = { terminate: 'stop', screenshot: 'shot' };

/** Commands that run without a device. */
const HOST_COMMANDS = ['help', 'doctor', 'skill', 'mcp', 'devices', 'boot', 'wifi', 'pair', 'connect', 'shutdown', 'who', 'release'];

// ── a chain of commands that went off course ───────────────────────────────
// An agent often sends several looktap commands in one shell call, one per line or joined with ";". The shell runs
// every one even after one fails, so when the app went another way (a different screen, a button that isn't there),
// each later command fails slowly against the wrong screen, minutes in all, or taps something real on it. So once an
// action fails, the later actions and waits from the same script (same parent shell, not a terminal) are skipped at
// once with what failed. Reading the screen still runs. A person typing in a terminal is never stopped.
const CHAIN = join(HOME, 'chain.json');
const CHAIN_MS = 10 * 60e3;
/** What starts the stop: an action that couldn't do what it was asked. A failed check (expect, wait) doesn't: `expect X || looktap tap Y` is a choice. */
const chainFails = (cmd) => cmd !== 'launch' && (ACTIONS.has(cmd) || cmd === 'run' || cmd === 'value');
/** What it stops: acting or waiting on a screen nobody has looked at since. */
const chainStops = (cmd) => chainFails(cmd) || cmd === 'wait' || cmd === 'expect';
const chained = () => !process.stdin.isTTY && !process.env.LOOKTAP_CONTINUE_AFTER_FAILURE;

/** Remember that an action failed in this script, unless the failure is about the device (locked, stuck, busy). */
function failedIn(d, cmd, args, e) {
  if (!chained() || !chainFails(cmd) || e instanceof LockedError || e instanceof StuckError || e instanceof BusyError) return;
  try {
    writeJson(CHAIN, { ...readJson(CHAIN, {}), [deviceId(d)]: { ppid: process.ppid, at: Date.now(), step: [cmd, ...args].join(' '), why: String(e.message).split('\n')[0].slice(0, 200) } });
  } catch {}
}

/** Skip an action or wait that follows a failed one in the same script. */
function afterFailure(d, cmd) {
  if (!chained() || !chainStops(cmd)) return;
  const f = readJson(CHAIN, {})[deviceId(d)];
  if (!f || f.ppid !== process.ppid || Date.now() - f.at > CHAIN_MS) return;
  throw new UsageError(
    `skipped: an earlier command in this script failed (looktap ${f.step}: ${f.why}), so the app is not where the rest of the script expects. Read the screen (looktap ls), then send the next steps for the screen it is on, in a new command. (LOOKTAP_CONTINUE_AFTER_FAILURE=1 runs it anyway)`,
  );
}

/**
 The screen was read (ls, shot) or the app restarted (launch) after the failure: whoever sends the next command has
 seen where it is, so it isn't stopped. (An agent that keeps one shell open for all its commands has one parent for
 all of them: without this, its corrected next step would be stopped too.)
 */
function lookedAgain(d, cmd) {
  if (!['ls', 'shot', 'launch'].includes(cmd)) return;
  const all = readJson(CHAIN, {});
  if (all[deviceId(d)]?.ppid !== process.ppid) return;
  delete all[deviceId(d)];
  try {
    writeJson(CHAIN, all);
  } catch {}
}

/** A command looktap doesn't have: say so before looking for a device, with the one probably meant. */
function knownCommand(cmd) {
  const known = [...HOST_COMMANDS, ...COMMANDS];
  if (known.includes(cmd)) return;
  const meant = didYouMean(cmd, known);
  throw new UsageError(`unknown command: ${cmd}${meant ? ` — did you mean looktap ${meant}?` : ''} (looktap --help lists them)`);
}

/**
 Run a device command the way every caller does: hold the device's lease for as long as it runs (exclusive for what
 changes the device, shared for reading and streams), then probe the way to it (a stuck adb link fails here, at once,
 with what's wrong), then the command.
 */
async function drive(d, cmd, args, opts) {
  const device = deviceId(d);
  const kind = process.env.LOOKTAP_ROUTE_PLAN ? 'shared-stream' : kindOf(cmd, args);
  const wait = 1000 * Number(opts.busyWait ?? process.env.LOOKTAP_BUSY_WAIT ?? 10);
  if (!(wait >= 0)) throw new UsageError('--busy-wait takes seconds, e.g. --busy-wait 30');
  const lease = cmd === 'capabilities' ? null : await acquire(device, { kind, command: [cmd, ...args, ...[...opts.flags].map((f) => `--${f}`)].join(' ').slice(0, 120), wait });
  try {
    if (d.health && cmd !== 'capabilities') d.health();
    return await dispatch(d, cmd, args, opts);
  } finally {
    lease?.release();
  }
}

function parse(argv) {
  const opts = { flags: new Set() };
  const pos = [];
  let unknown = null;
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
    else if (a === '--until') opts.until = val();
    else if (a === '--wait-unlock') opts.waitUnlock = val();
    else if (a === '--duration') opts.duration = val();
    else if (a === '--from') opts.from = val();
    else if (a === '--bearing') opts.bearing = val();
    else if (a === '--distance') opts.distance = val();
    else if (a === '--speed') opts.speed = val();
    else if (a === '--step') opts.step = val();
    else if (a === '--then-still') opts.thenStill = val();
    else if (a === '--gpx') opts.gpx = val();
    else if (a === '--speed-scale') opts.speedScale = val();
    else if (a === '--offset-from-pref') opts.offsetFromPref = val();
    else if (a === '--file') opts.file = val();
    else if (a === '--redact') opts.redact = val();
    else if (a === '--busy-wait') opts.busyWait = val();
    else if (a === '--tag') opts.tag = val();
    else if (a === '--buffer') opts.buffer = val();
    else if (['--all', '--plain', '--exact', '--ls', '--json', '--gone', '--up', '--install', '--errors', '--grant', '--config', '--headless', '--window', '--paths', '--frames', '--time', '--resume', '--project', '--uninstall', '--list', '--settle', '--points', '--covered', '--tcpip', '--always', '--off', '--until-gone', '--follow', '--background', '--from-current', '--reset', '--restore', '--yes', '--force', '--fix', '--clear'].includes(a)) opts.flags.add(a.slice(2));
    else if (a === '--') pos.push(...argv.slice(i + 1)), (i = argv.length);
    // An option looktap doesn't know is a mistake, not an argument: dropped quietly, a guessed flag changes nothing
    // and nobody hears of it. Negative numbers (-0.1276) and a lone - stay arguments.
    else if (/^--?[a-z]/i.test(a)) unknown ??= a;
    else pos.push(a);
  }
  // Names other tools use, and agents guess: the same command.
  const cmd = ALIASES[pos[0]] ?? pos[0];
  if (unknown) {
    const usage = usageOf(cmd);
    // A label or text can start with "-" too: it goes after --.
    const text = ['tap', 'longpress', 'type', 'fill', 'paste', 'wait', 'expect', 'scrollto', 'handoff'].includes(cmd);
    throw new UsageError(`unknown option ${unknown}${cmd ? ` for ${cmd}` : ''}${usage ? `; usage: ${usage}` : ''}${text ? ` (text that starts with "-" goes after --: looktap ${cmd} -- ${unknown})` : ''}`);
  }
  if (opts.duration != null) {
    if (!['swipe', 'longpress'].includes(cmd)) throw new UsageError(`--duration goes with swipe and longpress${cmd ? `, not ${cmd}` : ''}`);
    opts.duration = gestureMs(opts.duration);
  }
  return { opts, cmd, args: pos.slice(1) };
}

/** The command's line from the help text (`swipe <x1> <y1> <x2> <y2> [ms]`), or null. */
function usageOf(cmd) {
  if (!cmd || !/^[a-z]+$/.test(cmd)) return null;
  const line = HELP.split('\n').find((l) => l.startsWith(`  ${cmd} `) || l === `  ${cmd}`);
  return line ? line.trim().split(/\s{2,}/)[0] : null;
}

/** A physical iPhone/iPad's hardware UDID (00008110-000A…, or 40 hex digits on older ones), not a simulator's. */
const physicalUdid = (id) => /^[0-9A-F]{8}-[0-9A-F]{16}$|^[0-9a-f]{40}$/i.test(id || '');

function pickDriver(opts, config) {
  let platform = opts.platform || process.env.LOOKTAP_PLATFORM;
  let device = opts.device || process.env.LOOKTAP_DEVICE;
  // No device named: the one the last command drove, while it's recent and still up.
  if (!device) ({ platform, device } = lastDevice(platform) || { platform, device });
  // With both -p and -d there is nothing to detect — skip listing devices (saves 0.3–0.5 s per command).
  const known = platform && device;
  const sims = known || platform === 'android' ? [] : bootedSimulators();
  const droids = known || platform === 'ios' ? [] : adbDevices();
  // Real iPhones are looked for only when nothing else answers, or when -d names one: simulator and
  // emulator choice works exactly as it did.
  let phones = null;
  const lookForPhones = () => (phones ??= physicalDevices());

  if (device && !platform) {
    platform = sims.some((s) => s.id === device) ? 'ios' : droids.some((d) => d.id === device) ? 'android' : null;
    // A USB serial whose cable came out: the same phone over Wi-Fi (after looktap wifi).
    const twin = !platform && wifiTwin(device, droids.map((d) => d.id), (id) => run(ADB, ['-s', id, 'shell', 'getprop', 'ro.serialno'], { allowFail: true, timeout: 5000 }).trim());
    if (twin) (platform = 'android'), (device = twin);
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
  rememberDevice(platform, device);
  const out = opts.out || process.env.LOOKTAP_OUT || config.out || 'shots';
  const app = opts.app || config[platform]?.app;
  const wait = 1000 * Number(opts.wait ?? process.env.LOOKTAP_WAIT ?? config.wait ?? 3);
  if (!(wait >= 0)) throw new UsageError('--wait takes seconds, e.g. --wait 5');
  const d =
    platform === 'ios' && physicalUdid(device) ? new IosDevice(device, { out, app, wait, team: process.env.LOOKTAP_TEAM || config.ios?.team })
    : platform === 'ios' ? new Ios(device, { out, app, wait })
    : new Android(device, { out, app, wait });
  const unlock = Number(opts.waitUnlock ?? process.env.LOOKTAP_WAIT_UNLOCK ?? config.waitUnlock ?? 0);
  if (!(unlock >= 0)) throw new UsageError('--wait-unlock takes seconds, e.g. --wait-unlock 60');
  d.waitUnlock = unlock * 1000;
  const env = process.env.LOOKTAP_DISMISS_LOGBOX;
  d.dismissLogBox = env != null && env !== '' ? env !== '0' : config.dismissLogBox === true;
  return d;
}

async function doctor(opts) {
  // null: worth knowing, neither good nor bad.
  const ok = (b, msg, fix) => console.log(`${b == null ? '·' : b ? '✓' : '✗'} ${msg}${b === false && fix ? `  → ${fix}` : ''}`);
  ok(Number(process.versions.node.split('.')[0]) >= 18, `node ${process.versions.node} (needs ≥ 18)`);
  const xc = has('xcrun');
  ok(xc, 'xcrun (iOS)', 'install Xcode + command line tools');
  if (xc) {
    const sims = bootedSimulators();
    ok(sims.length > 0, `booted simulators: ${sims.map((s) => s.name).join(', ') || 'none'}`, 'looktap boot <name> (looktap devices --all lists them)');
    const dev = run('xcode-select', ['-p'], { allowFail: true }).trim();
    ok(existsSync('/Library/Developer/PrivateFrameworks/CoreSimulator.framework'), 'CoreSimulator.framework (iOS helper)', 'install Xcode');
    // Same rule as the helper: CoreSimulator 1155.4+ (Xcode 27) takes input through dtuhidd.
    const cs = run('defaults', ['read', '/Library/Developer/PrivateFrameworks/CoreSimulator.framework/Resources/Info', 'CFBundleVersion'], { allowFail: true }).trim();
    const modern = cs && cs.localeCompare('1155.4', undefined, { numeric: true }) >= 0;
    // Up to Xcode 26 in Developer/Library/PrivateFrameworks, from 27.1 in Contents/SharedFrameworks. Only indigo input uses it.
    const simKit = dev && ['Library/PrivateFrameworks', '../SharedFrameworks'].some((d) => existsSync(join(dev, d, 'SimulatorKit.framework')));
    const indigo = (process.env.LOOKTAP_IOS_HID || (modern ? 'dtuhid' : 'indigo')) === 'indigo';
    if (simKit || indigo) ok(simKit, `SimulatorKit in ${dev || 'no developer dir'} (iOS input)`, 'sudo xcode-select -s /Applications/Xcode.app');
    if (cs) {
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
  if (xc && !opts.device) for (const p of physicalDevices()) ok(null, `real iPhone: ${p.name} (${p.id}) — looktap doctor -d ${p.id} checks the way to it`);
  if (!opts.device) {
    if (opts.flags.has('fix')) throw new UsageError('doctor --fix needs the device: looktap doctor -d <serial> --fix');
    return;
  }
  // The way to one device, layer by layer: adb server, USB link, device, app. What a command needs before it can drive it.
  let d, failed = false;
  try {
    d = pickDriver(opts, loadConfig());
  } catch (e) {
    if (!(e instanceof StuckError)) throw e;
    ok(false, e.message);
    failed = true;
  }
  const android = d ? Boolean(d.serial) : opts.platform !== 'ios';
  if (d) console.log(`\n${KINDS[d.kind].title} ${deviceId(d)}`);
  try {
    if (android) for (const row of adbRows(opts.device)) (ok(...row), (failed ||= row[0] === false));
    if (d) for (const row of await d.diagnose({ app: opts.app || d.app })) (ok(...row), (failed ||= row[0] === false));
  } finally {
    d?.close?.();
  }
  if (!android) return;
  if (failed) console.log(`\nIf the phone is stuck, in this order:\n${RECOVERY.map((r, i) => `  ${i + 1}. ${r.replace('<serial>', opts.device)}`).join('\n')}`);
  if (opts.flags.has('fix')) for (const line of await restartAdb({ yes: opts.flags.has('yes'), say: (m) => console.log(m) })) console.log(line);
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

  if (cmd === 'doctor') return doctor(opts);
  if (cmd === 'skill') return skill(opts, args);
  if (cmd === 'mcp') return opts.flags.has('config') ? mcpConfig() : mcp(opts);
  if (cmd === 'devices') return console.log(deviceLines(opts).join('\n'));
  if (cmd === 'boot') {
    const r = await boot(args.join(' ') || null, { platform: opts.platform, ...display(opts, loadConfig()) });
    rememberDevice(r.platform, r.id);
    return console.log(booted(r));
  }
  if (cmd === 'wifi') return wifiCommand(opts);
  if (cmd === 'pair') {
    const r = await pair(args[0], args[1] || null, { say: (m) => console.error(`looktap: ${m}`) });
    if (!r.id) return console.log(`paired with ${r.address}, but adb hasn't connected yet — looktap devices shows it once it does`);
    rememberDevice('android', r.id);
    console.log(`paired and connected: ${r.id}`);
    if (!hasKeeper(r.id)) console.log(ALWAYS_HINT);
    return;
  }
  if (cmd === 'connect') {
    const r = await connect(args[0], { say: (m) => console.error(`looktap: ${m}`) });
    rememberDevice('android', r.id);
    return console.log(r.already ? `already connected: ${r.id}` : `connected: ${r.id}. It goes off when the device restarts: turn debugging over Wi-Fi back on and run looktap connect again`);
  }
  if (cmd === 'shutdown') return console.log(shutDown(await shutdown(args.join(' ') || opts.device || null, { platform: opts.platform })));
  if (cmd === 'who') return console.log(whoLines(args[0] || opts.device || null).join('\n'));
  if (cmd === 'release') return console.log(await release(args[0] || opts.device, { force: opts.flags.has('force'), yes: opts.flags.has('yes') }));
  knownCommand(cmd);

  const config = loadConfig();
  const d = pickDriver(opts, config);
  try {
    afterFailure(d, cmd);
    const r = await drive(d, cmd, args, opts).catch((e) => {
      failedIn(d, cmd, args, e);
      throw e;
    });
    lookedAgain(d, cmd);
    return r;
  } catch (e) {
    await screenOnFailure(d, cmd, e, opts);
    throw e;
  } finally {
    d.close?.();
  }
}

const deviceId = (d) => d.udid || d.serial;

const ALWAYS_HINT = 'The phone turns Wireless debugging off when it restarts: looktap wifi --always keeps it on (installs looktap\'s small Wi-Fi keeper app; looktap wifi --off removes it)';

/** `wifi`: connect an Android phone over Wi-Fi; --always installs the keeper first, --off removes it. */
async function wifiCommand(opts) {
  const say = (m) => console.error(`looktap: ${m}`);
  const device = opts.device || null;
  if (opts.flags.has('always') && opts.flags.has('off')) throw new UsageError('wifi takes --always or --off, not both');
  if (opts.flags.has('off')) {
    const r = removeKeeper(device);
    return console.log(`${r.removed ? `removed looktap's Wi-Fi keeper (${KEEPER}) from ${r.id}; ` : ''}Wireless debugging off — looktap wifi turns it on again until the next restart`);
  }
  let kept = null;
  if (opts.flags.has('always')) {
    kept = await installKeeper(device, { say });
    console.log(`installed looktap's Wi-Fi keeper (${KEEPER}) on ${kept}: the phone turns Wireless debugging back on by itself after a restart and whenever it joins Wi-Fi (a network not yet "always allowed" asks first). looktap wifi --off removes it`);
    // Already on Wi-Fi only (after pair): nothing more to connect.
    if (overWifi(kept)) return;
  }
  const r = await wifi({ device: kept || device, tcpip: opts.flags.has('tcpip'), say });
  if (r.already) console.log(`already over Wi-Fi: ${r.serial} → ${r.id}`);
  else {
    rememberDevice('android', r.id);
    console.log(`over Wi-Fi: ${r.serial} → ${r.id}${r.address && r.address !== r.id ? ` (${r.address})` : ''}, by ${r.via}. The cable can come out; -d ${r.serial} still finds it`);
  }
  if (!kept && r.via !== 'adb tcpip' && !hasKeeper(r.serial)) console.log(ALWAYS_HINT);
}

/** Failures whose fix is on the screen: a label or ref not there, an ambiguous label, a screen not as expected. */
const screenFailure = (e) => e instanceof NotFound || /expect failed|is ambiguous|is not in the last listing/.test(e.message);

/**
 After such a failure (a `run` step's too), print the error and then the screen as it is now, with fresh @refs: the
 agent fixes the step from this output instead of spending another call on `ls`. `e.printed` marks it as said.
 */
async function screenOnFailure(d, cmd, e, opts) {
  if (cmd === 'test' || cmd === 'codegen' || !screenFailure(e)) return;
  console.error(`looktap: ${e.message}`);
  if (e.after) console.error(`looktap: ${e.after}`);
  e.printed = true;
  console.error('looktap: the screen now:');
  await list(d, opts, e.snap).catch((err) => console.error(`looktap: (couldn't read the screen: ${err.message})`));
}

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
const ACTIONS = new Set(['tap', 'longpress', 'zoom', 'tapxy', 'type', 'key', 'fill', 'paste', 'code', 'hidekb', 'swipe', 'back', 'home', 'open', 'launch', 'bio', 'scrollto', 'rotate', 'fold']);

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
  // What's partly hidden: under another element (a row under a tab bar) or past the screen's edge.
  const hidden = coverage(snap.elements, rows, snap.screen);
  const onlyHidden = opts.flags.has('covered');
  if (opts.flags.has('json')) {
    const json = (e, i) => {
      const h = hidden.get(i);
      return { ref: `@${i + 1}`, ...e, ...(h?.covered && { covered: Math.round(h.covered * 100), coveredBy: h.by }), ...(h?.off && { offScreen: Math.round(h.off * 100) }) };
    };
    return console.log(JSON.stringify({ screen: snap.screen, elements: rows.map(json).filter((_, i) => !onlyHidden || hidden.has(i)) }));
  }
  const lines = rows.map((e, i) => (hidden.has(i) ? `${formatRow(e, i + 1)}  ${formatCoverage(hidden.get(i))}` : onlyHidden ? null : formatRow(e, i + 1))).filter(Boolean);
  if (!rows.length && d.watch && (await d.dozing?.().catch(() => false)))
    console.error('looktap: the watch has dimmed to its always-on face, with nothing to read: looktap key WAKEUP (commands that act on the screen wake it themselves)');
  else if (!rows.length) console.error('looktap: no labelled elements on screen (still loading, or the app sets no accessibility labels)');
  else if (!lines.length) console.log(`nothing covered or cut off (${rows.length} elements on screen)`);
  else console.log(lines.join('\n'));
  // The system's own dialogs belong to package "android": only then is it worth asking what it is.
  const stuck = front?.id === 'android' ? await d.stuck?.().catch(() => null) : null;
  if (stuck) console.error(`looktap: ${stuck.app} ${stuck.why}: the system's dialog about it is on screen, and the app can't be driven until it closes. See: looktap crashes ${stuck.app}`);
  else if (snap.elements.some((e) => LOGBOX.test(e.label || '')))
    console.error("looktap: React Native's LogBox toast is up: it blocks taps around it (a bottom tab bar). Close it with looktap dismiss logbox (or \"dismissLogBox\": true in looktap.config.json, before every tap)");
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

/** Commands made of other commands: each of their steps waits for an unlock itself, so the whole is never run again. */
const COMPOUND = new Set(['run', 'test', 'codegen']);

/**
 Run a command. Stopped by the lock screen before it did anything (LockedError) with --wait-unlock: wait for someone
 to unlock the device, then run it once more.
 */
async function dispatch(d, cmd, args, opts) {
  try {
    return await dispatchOnce(d, cmd, args, opts);
  } catch (e) {
    const ms = opts.waitUnlock != null ? Number(opts.waitUnlock) * 1000 : d.waitUnlock;
    if (!(e instanceof LockedError) || !(ms > 0) || COMPOUND.has(cmd)) throw e;
    await untilUnlocked(d, ms);
    return dispatchOnce(d, cmd, args, opts);
  }
}

/** Until the device is unlocked, for up to `ms`; a LockedError after that. */
async function untilUnlocked(d, ms) {
  console.error(`looktap: the device is locked — waiting up to ${Math.round(ms / 1000)} s for someone to unlock it`);
  for (const until = Date.now() + ms; Date.now() < until; await sleep(1000)) {
    if (!(await d.locked())) return console.error('looktap: unlocked — carrying on');
  }
  throw new LockedError();
}

async function dispatchOnce(d, cmd, args, opts) {
  const all = opts.flags.has('all');
  const look = opts.flags.has('ls') && ACTIONS.has(cmd);
  // Remember the screen before acting, so --ls waits for the action to show before printing.
  const before = look ? await d.snapshot({ all }) : null;
  if (d.assertUnlocked && SCREEN.has(cmd)) await d.assertUnlocked(cmd, args);
  const app = WATCHED.has(cmd) ? await d.frontApp().catch(() => null) : null;
  // The screen just read doubles as the first look for the action's target: one read fewer on a slow device.
  await act(d, cmd, args, before ? { ...opts, snap: before } : opts);
  if (['launch', 'stop', 'kill', 'reset', 'uninstall', 'install'].includes(cmd)) forgetFront(deviceId(d));
  // The app launch started is in front: if it dies after launch returned, the next look names it.
  if (cmd === 'launch') {
    const f = await d.frontApp().catch(() => null);
    if (f && d.appId(f) === (args[0] || d.app)) rememberFront(deviceId(d), f);
  }
  // A cold start can take seconds, and the old screen may still be animating: wait for the app itself.
  if (look && cmd === 'launch') await waitForApp(d, args[0] || d.app, 6000);
  let after = look ? await settle(d, { all, before, changeTimeout: cmd === 'launch' || cmd === 'open' ? 6000 : 1500 }) : null;
  // A debug build's splash while its bundle comes from Metro: wait it out (up to --wait, default 120 s), not return on it.
  if (look && cmd === 'launch' && d.fromMetro && splashLike(after.elements)) after = await pastSplash(d, { all, timeout: opts.wait != null ? Number(opts.wait) * 1000 : 120e3 });
  if (app) warnIfGone(await appGone(d, app));
  if (look) await list(d, { ...opts, checked: Boolean(app) }, after);
  if (look && cmd === 'launch' && !opts.until && !d.fromMetro && splashLike(after.elements))
    console.error('looktap: a few elements and nothing to tap: this may be a splash or loading screen (a React Native debug build loading its bundle). Follow with: looktap wait "<text>", or next time: looktap launch --until "<text>"');
}

/** A screen settle stopped at that is likely still loading: three rows at most, none a control or a field. */
function splashLike(elements) {
  const rows = visibleRows(elements).filter((e) => e.type !== 'Keyboard' && !(e.y + e.h <= 60));
  // Android React Native's Pressable is a labelled ViewGroup: it counts as tappable.
  return rows.length > 0 && rows.length <= 3 && !rows.some((e) => e.field || /Button|ViewGroup|Cell|Link|Switch|Tab|Field/.test(e.type));
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
    if (c.close) console.error("looktap: that's React Native's LogBox toast (dev builds), which blocks taps around it: looktap dismiss logbox closes it (\"dismissLogBox\": true in looktap.config.json does that before every tap), then tap again");
  }
}

/** Close React Native's LogBox toast if it's among `elements`: tap its ×, wait for it to go. Returns where it tapped, or null. */
async function closeLogBox(d, elements) {
  const toast = logBoxToast(elements);
  if (!toast) return null;
  await d.tapxy(...toast.close);
  for (let i = 0; i < 10 && logBoxToast((await d.snapshot()).elements); i++) await sleep(150);
  return toast.close;
}

/**
 `dismiss logbox --until-gone`: close the toast, and again each time it comes back, until it has stayed gone for a
 second. A toast that keeps returning (a warning logged on every render) fails after `timeout`. Returns how many
 times it closed it.
 */
async function logBoxGone(d, timeout, quiet = 1000) {
  let closed = 0, clear = Date.now();
  for (const until = Date.now() + timeout; Date.now() < until; ) {
    const els = (await d.snapshot()).elements;
    if (logBoxToast(els)) {
      await closeLogBox(d, els);
      closed++;
      clear = Date.now();
    } else if (Date.now() - clear >= quiet) return closed;
    else await sleep(150);
  }
  throw new Error(`the LogBox toast kept coming back (closed ${closed} times in ${timeout / 1000} s): the app logs that warning over and over. Ask for LogBox.ignoreAllLogs() in test builds, or set "dismissLogBox": true in looktap.config.json`);
}

/** After `launch --ls` stopped at a debug build's splash: until its first real screen (the bundle came from Metro). */
async function pastSplash(d, { all, timeout }) {
  console.error('looktap: bundle loading from Metro…');
  const t0 = Date.now();
  for (let tick = 1; Date.now() - t0 < timeout; tick++) {
    await sleep(1000);
    if (!splashLike((await d.snapshot({ all })).elements)) {
      console.error(`looktap: the bundle loaded after ${Math.round((Date.now() - t0) / 1000)} s`);
      return settle(d, { all, changeTimeout: 0 });
    }
    if (tick % 15 === 0) console.error(`looktap: still loading (${tick} s)…`);
  }
  console.error(`looktap: still on the splash screen after ${Math.round(timeout / 1000)} s: is Metro serving (its terminal shows the bundle building)? looktap logs --errors shows what the app said`);
  return settle(d, { all, changeTimeout: 0 });
}

/**
 Run a command that carries a location, and fail without it: whatever the command said (an adb or simctl error quotes
 its arguments) comes back as "failed: <reason>" with every coordinate-like number taken out.
 */
async function located(fn) {
  try {
    return await fn();
  } catch (e) {
    const reason = scrubCoords(String(e.message).split('\n').find((l) => l.trim()) || 'unknown').replace(/^.*? failed \(\d+\): /, '').trim();
    const err = new (e instanceof UsageError ? UsageError : Error)(`failed: ${reason}`);
    throw err;
  }
}

/** Where looktap last put each device (a simulator can't be asked): `route --from-current` starts there. Kept on disk only. */
const LOCATIONS = join(HOME, 'locations.json');
function rememberLocation(d, at) {
  const all = readJson(LOCATIONS, {});
  if (at) all[deviceId(d)] = { at, t: Date.now() };
  else delete all[deviceId(d)];
  writeJson(LOCATIONS, all);
}

/** A route running in the background, per device: { pid, log, plan, m, ms, stillMs, started }. */
const ROUTES = join(HOME, 'routes.json');

/** Stop a background route on this device (its process), if one runs. Returns its record, or null. */
async function stopRouteWorker(d) {
  const all = readJson(ROUTES, {});
  const r = all[deviceId(d)];
  if (!r) return null;
  delete all[deviceId(d)];
  writeJson(ROUTES, all);
  if (r.pid && run('ps', ['-o', 'command=', '-p', String(r.pid)], { allowFail: true }).includes('looktap')) {
    try {
      process.kill(r.pid, 'SIGTERM');
    } catch {}
    for (let i = 0; i < 20 && run('ps', ['-o', 'pid=', '-p', String(r.pid)], { allowFail: true }).trim(); i++) await sleep(100);
  }
  if (r.plan) rmSync(r.plan, { force: true });
  return r;
}

/** `route …`: build the plan of fixes, then play it here or in the background; `route stop` / `route status`. */
async function routeCommand(d, args, opts) {
  const usage = 'route --from <lat,lon>|--from-current|--offset-from-pref <app>:<latKey>,<lonKey> --distance 630m [--bearing 0] [--speed 1.4] [--step 1s] [--then-still 7m] [--background] | route --gpx <file> … | route stop | route status';
  if (args[0] === 'stop') {
    const r = await stopRouteWorker(d);
    const c = await located(() => d.clearLocation());
    rememberLocation(d, null);
    return console.log(`${r ? 'route stopped · ' : ''}${c?.note || 'location cleared'}`);
  }
  if (args[0] === 'status') {
    const r = readJson(ROUTES, {})[deviceId(d)];
    if (!r) return console.log('no route running in the background on this device');
    // A device's route runs in its own process; the simulator's in the simulator, by the clock.
    const alive = r.pid ? Boolean(run('ps', ['-o', 'pid=', '-p', String(r.pid)], { allowFail: true }).trim()) : Date.now() - r.started < r.ms + r.stillMs;
    const failed = r.log && existsSync(r.log) ? readFileSync(r.log, 'utf8').split('\n').find((l) => l.startsWith('looktap: ')) : null;
    const at = Date.now() - r.started;
    const where = at < r.ms ? `${metres((at / r.ms) * r.m)} of ${metres(r.m)} · ${clockTime(at)} of ${clockTime(r.ms)}` : at < r.ms + r.stillMs ? `at the end, still · ${clockTime(at)} of ${clockTime(r.ms + r.stillMs)}` : `done: ${metres(r.m)}`;
    if (failed) return console.log(`stopped: ${failed.slice(9)}`);
    return console.log(`${alive ? 'running' : 'ended'}: ${where}`);
  }
  if (args.length) throw new UsageError(`usage: looktap ${usage}`);
  // The background process `route --background` starts: its plan comes in a file, never on a command line.
  const plan = process.env.LOOKTAP_ROUTE_PLAN;
  if (plan && !mcpMode) {
    delete process.env.LOOKTAP_ROUTE_PLAN;
    return playRoute(d, JSON.parse(readFileSync(plan, 'utf8')));
  }
  const ms = (v, name) => {
    const x = duration(v);
    if (!(x >= 0)) throw new UsageError(`${name} takes a duration: 5s, 500ms, 7m`);
    return x;
  };
  const step = opts.step != null ? ms(opts.step, '--step') : 1000;
  const still = opts.thenStill != null ? ms(opts.thenStill, '--then-still') : 0;
  const speed = opts.speed != null ? Number(opts.speed) : 1.4;
  let fixes;
  if (opts.gpx) {
    if (opts.from || opts.flags.has('from-current') || opts.offsetFromPref || opts.distance) throw new UsageError('--gpx plays the file from its start: leave out --from and --distance');
    fixes = gpxPlan(parseGpx(readFileSync(opts.gpx, 'utf8')), { speed, scale: opts.speedScale != null ? Number(opts.speedScale) : 1, step, still });
  } else {
    if ([opts.from, opts.flags.has('from-current'), opts.offsetFromPref].filter(Boolean).length !== 1) throw new UsageError(`usage: looktap ${usage} — start with one of --from, --from-current, --offset-from-pref`);
    const brg = opts.bearing != null ? Number(opts.bearing) : 0;
    if (!(brg >= 0 && brg <= 360)) throw new UsageError('--bearing takes degrees clockwise from north, 0–360 (90 = east)');
    const from = opts.from ? point(opts.from) : opts.flags.has('from-current') ? await currentPoint(d) : await prefPoint(d, opts.offsetFromPref);
    fixes = straightPlan({ from, brg, dist: distance(opts.distance), speed, step, still });
  }
  const sum = planSummary(fixes);
  const what = `${metres(sum.m)} over ${clockTime(sum.ms)}${sum.stillMs ? `, then still for ${clockTime(sum.stillMs)}` : ''}`;
  await stopRouteWorker(d); // one route per device
  if (!opts.flags.has('background')) {
    console.log(`route: ${what} (Ctrl+C stops it where it is)`);
    return playRoute(d, { fixes, step });
  }
  // The simulator plays it itself: started, it runs on without looktap.
  if (!d.feed) {
    await located(() => d.route(fixes, { step }));
    rememberLocation(d, fixes.at(-1).at);
    writeJson(ROUTES, { ...readJson(ROUTES, {}), [deviceId(d)]: { pid: 0, log: '', ...sum, started: Date.now() } });
    return console.log(`route started in the simulator: ${what}. looktap route stop ends it and clears the location`);
  }
  // A device is fed fix by fix: by a looktap process of its own, from a plan file (never on a command line).
  const dir = join(HOME, 'routes');
  mkdirSync(dir, { recursive: true });
  const base = join(dir, deviceId(d).replace(/[^\w.-]/g, '_'));
  writeFileSync(`${base}.plan.json`, JSON.stringify({ fixes, step }));
  const { openSync } = await import('node:fs');
  const out = openSync(`${base}.log`, 'w');
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, [new URL(import.meta.url).pathname, 'route', '-p', d.serial ? 'android' : 'ios', '-d', deviceId(d)], {
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, LOOKTAP_ROUTE_PLAN: `${base}.plan.json` },
  });
  child.unref();
  writeJson(ROUTES, { ...readJson(ROUTES, {}), [deviceId(d)]: { pid: child.pid, log: `${base}.log`, plan: `${base}.plan.json`, ...sum, started: Date.now() } });
  console.log(`route running in the background (pid ${child.pid}): ${what}. looktap route status says how far it got; looktap route stop ends it${d.serial ? ' and removes the test providers' : ''}`);
}

/** Play a plan here: fix by fix into the device's feed (Android, a lockdown iPhone), or simctl's player (the simulator). */
async function playRoute(d, { fixes, step }) {
  const sum = planSummary(fixes);
  const every = Math.max(10e3, (sum.ms + sum.stillMs) / 10);
  const progress = (f) => console.log(f.still ? `  still at the end · ${clockTime(f.ms)} of ${clockTime(sum.ms + sum.stillMs)}` : `  ${metres(f.m)} of ${metres(sum.m)} · ${clockTime(f.ms)} of ${clockTime(sum.ms)}`);
  let stopped = false, last = null, shown = null;
  const onStop = () => (stopped = true);
  process.once('SIGINT', onStop);
  process.once('SIGTERM', onStop);
  const t0 = Date.now();
  try {
    // The simulator plays the route itself (simctl): looktap keeps time beside it. A device is fed each fix.
    if (d.feed) await located(() => d.startMock());
    else await located(() => d.route(fixes, { step }));
    for (const f of fixes) {
      while (!stopped && Date.now() - t0 < f.ms) await sleep(Math.min(250, f.ms - (Date.now() - t0)));
      if (stopped) break;
      if (d.feed) await located(() => d.feed(f));
      last = f;
      if (f === fixes.at(-1) || shown == null || f.ms - shown >= every) (shown = f.ms), progress(f);
    }
  } finally {
    process.off('SIGINT', onStop);
    process.off('SIGTERM', onStop);
    if (last) rememberLocation(d, last.at);
  }
  if (stopped) {
    // simctl's player runs on inside the simulator: pin it where the route had got to.
    if (!d.feed && last) await located(() => d.location(...last.at));
    return console.log(`route stopped after ${metres(last?.m || 0)} · the device stays there until looktap location clear`);
  }
  const off = last && (await d.realLocationLeak?.(last.at).catch(() => null));
  if (off) console.error(`looktap: warning: ${REAL_GPS(off)}`);
  console.log(`route done: ${metres(sum.m)} in ${clockTime(sum.ms)}${sum.stillMs ? ` and still for ${clockTime(sum.stillMs)}` : ''} · the device stays at its end until looktap location clear${d.serial ? ' (which removes the test providers)' : ''}`);
}

/** `route --from-current`: where the device is now (Android's last fix), else where looktap last put it. */
async function currentPoint(d) {
  const at = (await d.currentLocation?.().catch(() => null)) || readJson(LOCATIONS, {})[deviceId(d)]?.at;
  if (!at) throw new UsageError(`--from-current: ${d.serial ? "the device has no last known location yet (is Location on?)" : "a simulator can't say where it is, and looktap hasn't set one"}: pass --from <lat,lon>, or set a start with looktap location first`);
  return at;
}

/** `--offset-from-pref <app>:<latKey>,<lonKey>`: the start point the app saved in its preferences, never printed. */
async function prefPoint(d, spec) {
  const m = /^([^:]+):([^,]+),(.+)$/.exec(spec || '');
  if (!m) throw new UsageError('--offset-from-pref takes <app>:<latKey>,<lonKey>, e.g. com.example.app:homeLat,homeLon');
  const [, app, latKey, lonKey] = m;
  if (!d.prefs) unsupported(d.kind, 'prefs');
  const files = await d.prefs(app, { keys: [latKey, lonKey] });
  const find = (k) => Object.values(files).find((v) => v && k in v)?.[k];
  const [lat, lon] = [find(latKey), find(lonKey)].map(Number);
  const missing = [latKey, lonKey].filter((k) => find(k) == null);
  if (missing.length) throw new UsageError(`--offset-from-pref: ${app} has no ${missing.join(' or ')} in its preferences (looktap prefs ${app} lists its keys, coordinates redacted)`);
  if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) throw new UsageError(`--offset-from-pref: ${latKey} and ${lonKey} don't hold a latitude and longitude in degrees`);
  return [lat, lon];
}

/** `prefs <app> [key …]`: the app's preferences as key = value, coordinates redacted. */
async function showPrefs(d, args, opts) {
  const usage = 'prefs <app> [key …] [--file name] [--redact key,…] [--json]';
  const app = args[0] || d.app;
  if (!app) throw new UsageError(`usage: looktap ${usage}`);
  if (!d.prefs) unsupported(d.kind, 'prefs');
  const keys = args.slice(1), extra = redactList(opts.redact);
  const files = await d.prefs(app, { file: opts.file || null, keys });
  const names = Object.keys(files);
  const all = { redacted: [], missing: new Set(keys) };
  const json = {};
  for (const f of names) {
    const r = formatPrefs(files[f], { keys, extra, all: opts.flags.has('all') });
    all.redacted.push(...r.redacted);
    for (const k of keys) if (!r.missing.includes(k)) all.missing.delete(k);
    if (opts.flags.has('json')) json[f] = Object.fromEntries(r.entries.map(([k, v]) => [k, Buffer.isBuffer(v) ? `<data, ${v.length} bytes>` : typeof v === 'bigint' ? String(v) : v]));
    else if (r.lines.length || !keys.length) {
      if (names.length > 1) console.log(`# ${f}`);
      console.log(r.lines.length ? r.lines.join('\n') : '(empty)');
      if (r.hidden) console.log(`(${r.hidden} of Apple's own keys left out: --all shows them)`);
    }
  }
  if (opts.flags.has('json')) console.log(JSON.stringify(names.length === 1 ? json[names[0]] : json));
  if (all.redacted.length) console.error(`looktap: redacted ${[...new Set(all.redacted)].join(', ')}: they look like coordinates${extra.length ? ' or were named with --redact' : ' (--redact names more keys to hide)'}`);
  if (all.missing.size) throw new Error(`not set: ${[...all.missing].join(', ')}`);
}

/** `geofences <app>` on Android: what Play services and AOSP hold for the app, coordinates never printed. */
function printGeofences(app, g) {
  if (!g.gmsClient && !g.fences.length && !g.aosp) {
    console.log(`${app}: no geofences registered — Play services keeps no geofencing request for it, and AOSP's Geofence Manager has none`);
    if (g.events.length) console.log(`earlier:\n${g.events.map((e) => `  ${e}`).join('\n')}`);
    return;
  }
  if (g.gmsClient) console.log(`${app}: Play services is geofencing for it (its location request on the app's behalf: ${g.gmsClient})`);
  if (g.fences.length) {
    console.log(`${g.fences.length} geofence${g.fences.length === 1 ? '' : 's'}:`);
    for (const f of g.fences) console.log(`  ${f.id ?? '(no id)'}${f.radius ? `  radius ${f.radius} m` : ''}${f.transitions ? `  ${f.transitions}` : ''}`);
  } else if (g.gmsClient) console.log("  (this Play services build doesn't list each geofence's id and radius: log them from the app to see them)");
  if (g.aosp) console.log(`AOSP Geofence Manager: ${g.aosp} line${g.aosp === 1 ? '' : 's'} name it (LocationManager proximity alerts)`);
  if (g.events.length) console.log(`recent changes:\n${g.events.map((e) => `  ${e}`).join('\n')}`);
}

/** `battery [app] [--reset|--restore]`: Android batterystats for the app, before/after a scenario. */
async function showBattery(d, arg, opts) {
  if (!d.battery) unsupported(d.kind, 'battery');
  if (opts.flags.has('restore')) {
    await d.battery(null, { restore: true });
    return console.log('battery: the device reports its real charging state again');
  }
  const app = explicitApp(d, arg, 'battery <app> [--reset|--restore]');
  if (opts.flags.has('reset')) {
    await d.battery(app, { reset: true });
    return console.log(`battery stats reset, and the device counts as unplugged so they build up over the cable. Run the scenario, then looktap battery ${app}; looktap battery --restore when you're done`);
  }
  const r = await d.battery(app);
  console.log(`${app}: ${r.mAh != null ? `${r.mAh} mAh estimated${r.detail ? ` ${r.detail}` : ''}` : 'no power estimate for it yet'}${r.since ? ` · on battery for ${r.since}` : ''}`);
  for (const l of r.lines) console.log(`  ${l}`);
  if (r.charging) console.error(`looktap: warning: the device is charging, so batterystats isn't counting: looktap battery ${app} --reset makes it count as unplugged`);
}

/**
 `network <app> [--for 60s]`: the app's traffic over the window, sampled every 2 s from netstats: bytes and packets
 each way, and the bursts it came in (a burst: traffic after a quiet sample). An app that batches its uploads
 shows few bursts.
 */
async function networkUse(d, app, opts) {
  if (!d.netTotals) unsupported(d.kind, 'network <app>');
  const span = opts.for != null ? duration(opts.for) : 60e3;
  if (!(span > 0)) throw new UsageError('--for takes a duration: 30s, 2m');
  console.error(`looktap: watching ${app}'s traffic for ${clockTime(span)}…`);
  const t0 = Date.now(), first = d.netTotals(app);
  let prev = first, quiet = true;
  const bursts = [];
  while (Date.now() - t0 < span) {
    await sleep(Math.min(2000, span - (Date.now() - t0)));
    const now = d.netTotals(app);
    const moved = now.tb > prev.tb || now.rb > prev.rb;
    if (moved && quiet) bursts.push({ at: Date.now() - t0, tb: 0, rb: 0 });
    if (moved) (bursts.at(-1).tb += now.tb - prev.tb), (bursts.at(-1).rb += now.rb - prev.rb);
    quiet = !moved;
    prev = now;
  }
  const kb = (b) => (b >= 1024 * 1024 ? `${(b / 1048576).toFixed(1)} MB` : `${(b / 1024).toFixed(1)} KB`);
  console.log(`${app} over ${clockTime(Date.now() - t0)}: sent ${kb(prev.tb - first.tb)} (${prev.tp - first.tp} packets), received ${kb(prev.rb - first.rb)} (${prev.rp - first.rp} packets), in ${bursts.length} burst${bursts.length === 1 ? '' : 's'}`);
  for (const b of bursts.slice(0, 20)) console.log(`  at ${clockTime(b.at)}: sent ${kb(b.tb)}, received ${kb(b.rb)}`);
  if (bursts.length > 20) console.log(`  … ${bursts.length - 20} more`);
}

/** `logs mark [name]`: a marker now, for `logs --since <name>` (and crashes --since) to start from. */
/** The warning when Play services' fused location is far from the simulated one: the phone's own location is mixed in. */
const REAL_GPS = (off) =>
  `the phone's own location is still reaching apps: Play services' fused location is ${metres(off)} from the simulated one (it mixes in Wi-Fi and cell positions, so a walk can look like a drive). Turn off Google Location Accuracy (Settings → Location → Location services) while testing`;

/** `reverse <port>[:<port>]`, `reverse --list`, `reverse --remove <port>|all`: the device's localhost reaching this computer. */
function reverseCommand(d, args, opts) {
  if (!d.reverse) {
    if (['ios-simulator', 'watchos-simulator'].includes(d.kind)) return console.log("the simulator shares this Mac's network: localhost on it is this Mac's, no rule needed");
    unsupported(d.kind, 'reverse');
  }
  const show = (rules) => (rules.length ? rules.map((r) => `${r.remote} → this computer's ${r.local}`).join('\n') : 'no adb reverse rules');
  if (opts.flags.has('list') || !args.length) {
    const rules = d.reverses();
    rememberReverses(d.serial, rules);
    return console.log(show(rules));
  }
  if (args[0] === '--remove' || args[0] === 'remove') {
    if (!args[1]) throw new UsageError('usage: looktap reverse remove <port>|all');
    const rules = d.unreverse(args[1]);
    rememberReverses(d.serial, rules);
    return console.log(show(rules));
  }
  const m = /^(\d{1,5})(?::(\d{1,5}))?$/.exec(args[0]);
  if (!m) throw new UsageError('usage: looktap reverse <port>[:<port>] (the device\'s port, then this computer\'s), reverse --list, reverse remove <port>|all');
  const rules = d.reverse(Number(m[1]), Number(m[2] || m[1]));
  rememberReverses(d.serial, rules);
  console.log(`the device's localhost:${m[1]} now reaches this computer's port ${m[2] || m[1]}`);
}

/** `metro [port]`: is Metro answering on this computer, and can the device reach it? */
async function metroCommand(d, args) {
  const port = Number(args[0] || 8081);
  const up = await metroUp(port);
  console.log(up ? `Metro is running on this computer (localhost:${port}/status answers)` : `Metro isn't answering on this computer's port ${port}: start it (npx react-native start, or npx expo start)`);
  if (!d.reverse) {
    if (['ios-simulator', 'watchos-simulator'].includes(d.kind)) return console.log("the simulator shares this Mac's network: it reaches Metro at localhost");
    return console.log('a real iPhone reaches Metro over Wi-Fi, at this Mac\'s IP address (the app\'s dev menu → Configure Bundler)');
  }
  let rules = d.reverses();
  if (!rules.some((r) => r.remote === `tcp:${port}`)) {
    rules = d.reverse(port, port);
    console.log(`added adb reverse tcp:${port}: the device's localhost:${port} reaches this computer`);
  } else console.log(`adb reverse tcp:${port} is set`);
  rememberReverses(d.serial, rules);
  if (!up) return;
  const reach = d.reachesMetro(port);
  console.log(reach == null ? "(the device has no nc to check it can reach Metro: the reverse rule is set)" : reach ? 'the device reaches Metro' : `the device doesn't reach Metro through the reverse rule: replug the cable, or looktap doctor -d ${d.serial}`);
}

/** `ps <app>`: its pid, how long it has run, and whether it's in front. */
async function showPs(d, arg) {
  const app = explicitApp(d, arg, 'ps <app>');
  if (d.ps) {
    const p = await d.ps(app);
    if (!p) return console.log(`${app}: not running`);
    return console.log(`${app}: pid ${p.pid}${p.secs != null ? `, up ${clockTime(p.secs * 1000)}` : ''}, ${p.front ? 'in front' : 'in the background'}`);
  }
  const pid = await d.pidOf(app);
  if (!pid) return console.log(`${app}: not running`);
  const front = (await d.foreground().catch(() => null))?.id === app;
  // A simulator's apps are processes on this Mac: ps knows how long they've run.
  const etime = ['ios-simulator', 'watchos-simulator'].includes(d.kind) ? run('ps', ['-o', 'etime=', '-p', String(pid)], { allowFail: true, timeout: 5000 }).trim() : '';
  console.log(`${app}: pid ${pid}${etime ? `, up ${clockTime(etimeSecs(etime) * 1000)}` : ''}, ${front ? 'in front' : 'in the background'}`);
}

function markLogs(d, name = 'mark', opts) {
  const t = setMark(deviceId(d), name);
  console.log(`mark ${JSON.stringify(name)} at ${clock(t)} — after the action: looktap logs <app> --since ${name}`);
}

/**
 `shot --points`: one pixel per iOS point or Android dp, so a spot in the picture is tapxy's x y as it is. Android knows
 its density up front; iOS is shot at full size and shrunk to the screen's width in points.
 */
async function shotInPoints(d, name, opts) {
  const path = shotPath(d.out, name);
  if (d.serial) await d.shot(name, { plain: opts.flags.has('plain'), scale: Math.min(1, 1 / d.scale) });
  else {
    await d.shot(name, {});
    const points = d.screen?.w || (await d.snapshot()).screen.w;
    resizePng(path, points / readFileSync(path).readUInt32BE(16));
  }
  const png = readFileSync(path);
  console.error(`looktap: ${png.readUInt32BE(16)}x${png.readUInt32BE(20)} px, one per ${d.serial ? 'dp' : 'point'}: tapxy x y = the image's x y`);
}

/**
 `handoff <message> [--until <label>] [--gone]`: a step only a person can do (a consent screen, a second factor). The
 message goes straight to the terminal (test holds a flow's output until it ends) and to a macOS notification; then
 it waits until the screen shows the person is done, or (in a terminal, without --until) until Enter.
 */
async function handoff(d, args, opts) {
  const message = args.join(' ');
  const gone = opts.flags.has('gone');
  if (!message) throw new UsageError('usage: looktap handoff <message> [--until <label|@ref>] [--gone]');
  if (gone && !opts.until) throw new UsageError('handoff --gone goes with --until <label>');
  // stdin is the protocol under MCP, and a script under run -: only a terminal can take an Enter.
  if (!opts.until && !process.stdin.isTTY)
    throw new UsageError(`handoff needs --until <label> here, since there's no terminal to press Enter in: e.g. handoff ${quote(message)} --until "Home"`);
  const timeout = opts.wait != null ? Number(opts.wait) * 1000 : 300e3;
  if (!(timeout > 0)) throw new UsageError('--wait takes seconds, e.g. --wait 600');
  const span = timeout >= 60e3 ? `${Math.round(timeout / 60e3)} min` : `${timeout / 1000} s`;
  const until = opts.until ? `once ${JSON.stringify(opts.until)} is ${gone ? 'gone from' : 'on'} the screen` : 'when you press Enter here';
  process.stderr.write(`${process.stderr.isTTY ? '\x07' : ''}looktap: your turn on the device: ${message} — looktap carries on ${until} (waiting up to ${span})\n`);
  if (process.platform === 'darwin' && process.env.LOOKTAP_NOTIFY !== '0')
    run('osascript', ['-e', `display notification ${JSON.stringify(message)} with title "looktap: your turn on the device"`], { allowFail: true, timeout: 5000 });
  if (opts.until) {
    try {
      const hit = await waitFor(d, deviceId(d), opts.until, { gone, timeout });
      return console.log(`handed back: ${gone ? `${opts.until} is gone` : `found ${JSON.stringify(hit.label)}`}`);
    } catch (e) {
      if (e instanceof NotFound) throw new Error(`handoff: not done within ${span} (${e.message})`);
      throw e;
    }
  }
  const rl = createInterface({ input: process.stdin });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`handoff: nobody pressed Enter within ${span}`)), timeout);
      rl.once('line', () => (clearTimeout(timer), resolve()));
    });
  } finally {
    rl.close();
  }
  console.log('handed back');
}

/**
 `launch --until <text>`: after the launch, until `text` is on screen — past a splash screen, or a debug build loading
 its bundle. Up to --wait seconds (default 30: a bundle's first load from Metro is slow).
 */
async function launchedUntil(d, app, opts) {
  if (!opts.until) return;
  // A first bundle from Metro over adb reverse takes 30-60 s on a real phone.
  const timeout = opts.wait != null ? Number(opts.wait) * 1000 : d.fromMetro ? 120e3 : 30e3;
  try {
    const hit = await waitFor(d, deviceId(d), opts.until, { timeout });
    console.log(`launched ${app}: ${JSON.stringify(hit.label)} is on screen`);
  } catch (e) {
    if (!(e instanceof NotFound)) throw e;
    if (!(await d.pidOf(app))) throw new Error(`${app} exited while looktap waited for ${JSON.stringify(opts.until)} — see: looktap crashes ${app}`);
    throw e;
  }
}

/** A gesture's length in ms: a bare number is ms (`600`), or with a unit (`600ms`, `0.8s`). */
function gestureMs(v) {
  const ms = /^\d+$/.test(String(v)) ? Number(v) : /[a-z]$/.test(String(v)) ? Math.round(duration(v)) : NaN;
  if (!(ms > 0)) throw new UsageError(`a gesture's length is milliseconds, e.g. 600 or 0.6s, not ${JSON.stringify(String(v))}`);
  return ms;
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
      if (opts.flags.has('settle')) {
        if (args.length) throw new UsageError('usage: looktap wait --settle [--for 1s] (no label: it waits for the whole screen)');
        const quiet = opts.for != null ? duration(opts.for) : 1000;
        if (!(quiet > 0)) throw new UsageError('--for takes a duration: 1s, 500ms');
        const ms = await stillScreen(d, { quiet, timeout: opts.wait != null ? Number(opts.wait) * 1000 : 10000 });
        return console.log(`settled: the screen held still for ${quiet / 1000} s (after ${(ms / 1000).toFixed(1)} s)`);
      }
      need(1, 'wait <label|@ref> [--gone] | wait --settle');
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
      need(1, 'shot <name> [--scale f] [--points]');
      if (opts.scale != null && !(opts.scale > 0 && opts.scale <= 1)) throw new UsageError('--scale takes a factor between 0 and 1, e.g. --scale 0.5');
      if (opts.flags.has('points')) {
        if (opts.scale != null) throw new UsageError('shot takes --scale or --points, not both');
        return shotInPoints(d, args[0], opts);
      }
      await d.shot(args[0], { plain: opts.flags.has('plain'), scale: opts.scale ?? 1 });
      return shotSize(d, shotPath(d.out, args[0]), opts.scale ?? 1);
    }
    case 'burst': return burst(d, args[0], args[1]);
    case 'record': return record(d, args);
    case 'tap': {
      need(1, 'tap <label|@ref>');
      let { e, snap } = await target(d, isRef(args[0]) ? args[0] : args.join(' '), opts);
      // "dismissLogBox": close React Native's toast first, then find the target again (it may have moved).
      if (d.dismissLogBox && (await closeLogBox(d, snap.elements))) ({ e, snap } = await target(d, isRef(args[0]) ? args[0] : args.join(' '), { ...opts, snap: null }));
      // Aimed at a part of it nothing covers: the tap lands on whatever is on top.
      let { at, covers, avoided } = tapPoint(snap.elements, e);
      // React Native's LogBox toast over it: a tap there opens the LogBox. Close the toast, find the target again, once.
      const toast = covers.some((c) => c.close) && (await closeLogBox(d, snap.elements));
      if (toast) {
        ({ e, snap } = await target(d, isRef(args[0]) ? args[0] : args.join(' '), { ...opts, snap: null }));
        ({ at, covers, avoided } = tapPoint(snap.elements, e));
      }
      await d.tapxy(...at);
      const name = (c) => JSON.stringify((c.label || c.type).slice(0, 40));
      console.log(`tapped ${JSON.stringify(e.label || e.type)} at ${at.join(',')}${avoided.length ? ` (off-centre: ${avoided.map(name).join(', ')} covers its middle)` : ''}`);
      if (toast) console.error(`looktap: note: React Native's LogBox toast covered it, so looktap closed the toast first (its × at ${toast.join(',')}). If it keeps coming back: looktap dismiss logbox --until-gone, or "dismissLogBox": true in looktap.config.json`);
      warnCovered(covers);
      return;
    }
    case 'longpress': {
      need(1, 'longpress <label|@ref|x y> [ms]');
      const num = (v) => /^\d+(\.\d+)?$/.test(v ?? '');
      // Two leading numbers are a point; a trailing number is the hold time, unless it is the whole target.
      const xy = num(args[0]) && num(args[1]);
      const timed = opts.duration == null && args.length > (xy ? 2 : 1) && /^\d+$/.test(args.at(-1));
      const ms = gestureMs(opts.duration ?? (timed ? args.at(-1) : 800));
      let at, what;
      if (xy) (at = [Number(args[0]), Number(args[1])]), (what = `${at.join(',')}`);
      else {
        const words = timed ? args.slice(0, -1) : args;
        let { e, snap } = await target(d, isRef(words[0]) ? words[0] : words.join(' '), opts);
        const covered = tapPoint(snap.elements, e).covers.some((c) => c.close);
        if ((d.dismissLogBox || covered) && (await closeLogBox(d, snap.elements))) {
          ({ e, snap } = await target(d, isRef(words[0]) ? words[0] : words.join(' '), { ...opts, snap: null }));
          if (covered) console.error("looktap: note: React Native's LogBox toast covered it, so looktap closed the toast first");
        }
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
    case 'tapxy': {
      need(2, 'tapxy <x> <y>');
      const [x, y] = [Number(args[0]), Number(args[1])];
      // A point on the toast's card is aimed at it (a flow that taps its × by hand): left to the tap. One around it (the
      // tab bar under its invisible container, which takes every touch there) closes the toast first.
      const els = (opts.snap || (await d.snapshot())).elements, toast = logBoxToast(els);
      const onCard = toast && x >= toast.x && x <= toast.x + toast.w && y >= toast.y && y <= toast.y + toast.h;
      if (toast && !onCard && (d.dismissLogBox || logBoxAround(els, x, y))) {
        await closeLogBox(d, els);
        if (!d.dismissLogBox) console.error("looktap: note: React Native's LogBox toast takes the touches around it, so looktap closed it before tapping");
      }
      return d.tapxy(x, y);
    }
    case 'type': need(1, 'type <text>'); return d.type(args.join(' '));
    case 'key': need(1, 'key <name> … (return, escape, delete, tab, space, selectall, paste, home)'); return d.keys(args);
    case 'fill': {
      need(1, 'fill <label|@ref> <text>');
      const text = args.slice(1).join(' ');
      if (!isRef(args[0])) return d.fill(args[0], text, { exact: opts.flags.has('exact') });
      const field = await byRef(d, args[0]);
      return d.fillAt(...center(field), text, field);
    }
    case 'paste': need(1, 'paste <text>'); return d.paste(args.join(' '));
    case 'code': {
      need(1, 'code <digits>');
      const r = await fillCode(d, args.join(''));
      return console.log(`entered ${args.join('')} in ${r.boxes} boxes (${r.how})`);
    }
    case 'hidekb': return d.hidekb();
    case 'swipe': {
      need(4, 'swipe <x1> <y1> <x2> <y2> [ms]');
      if (args.length > 5 || (args[4] && opts.duration != null)) throw new UsageError('usage: looktap swipe <x1> <y1> <x2> <y2> [ms] (or --duration <ms>)');
      const ms = opts.duration ?? args[4];
      return d.swipe(...args.slice(0, 4).map(Number), ms != null ? gestureMs(ms) : undefined);
    }
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
      if (!front && (await d.locked())) throw new LockedError(); // no app in front: the lock screen looks the same
      const left = before && before.id !== launcher && before.id ? await d.pidOf(before.id) : 0;
      return console.log(`home screen${left ? ` · ${before.id} still running in the background, pid ${left}` : ''}`);
    }
    case 'open': need(1, 'open <url>'); return d.open(args[0]);
    case 'launch': {
      const app = args[0] || d.app;
      if (!app) throw new UsageError('usage: looktap launch <app-id> (or set --app / looktap.config.json)');
      if (opts.until && opts.flags.has('time')) throw new UsageError('launch takes --time or --until, not both');
      if (opts.flags.has('resume')) {
        if (opts.flags.has('time')) throw new UsageError('launch takes --time or --resume, not both');
        await d.launch(app, { resume: true });
        // Done means it's in front, not that the start was sent.
        if (!(await waitForApp(d, app, 6000))) throw new Error(`${app} didn't come to the front`);
        console.log(`resumed ${app}`);
        return launchedUntil(d, app, opts);
      }
      // A debug build loading its bundle from Metro on this Mac: reverse the port first, and wait longer for it.
      d.fromMetro = d.metro ? await d.metro(app) : false;
      if (opts.flags.has('time')) return timedLaunch(d, app);
      await d.launch(app);
      if (opts.until) {
        if (!(await waitForApp(d, app, 10000)) && !(await d.pidOf(app))) throw new Error(`${app} exited right after it started — see: looktap crashes ${app}`);
        if (d.fromMetro) console.error('looktap: bundle loading from Metro…');
        return launchedUntil(d, app, opts);
      }
      // Done means it's in front, not that the start was sent: an app that dies at once says so. It can reach the
      // front before it dies (iOS shows its launch screen), so it's checked again a moment after.
      const died = new Error(`${app} exited right after it started — see: looktap crashes ${app}`);
      for (const until = Date.now() + 10000; Date.now() < until; ) {
        const front = await waitForApp(d, app, 1000);
        if (front) await sleep(500);
        if (!(await d.pidOf(app))) throw died;
        if (front) return;
      }
      return console.error(`looktap: warning: ${app} is running, but didn't come to the front within 10 s`);
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
    case 'dismiss': {
      if (args[0]?.toLowerCase() !== 'logbox') throw new UsageError('usage: looktap dismiss logbox [--until-gone]');
      if (opts.flags.has('until-gone')) {
        const n = await logBoxGone(d, opts.wait != null ? Number(opts.wait) * 1000 : 10000);
        return console.log(n ? `closed the LogBox toast ${n === 1 ? 'once' : `${n} times`}: it has stayed gone for 1 s` : 'no LogBox toast on screen (it stayed gone for 1 s)');
      }
      const closed = await closeLogBox(d, (opts.snap || (await d.snapshot())).elements);
      return console.log(closed ? `closed the LogBox toast (tapped its × at ${closed.join(',')})` : 'no LogBox toast on screen');
    }
    case 'pause': {
      need(1, 'pause <seconds> (2, 1.5s, 500ms)');
      const ms = duration(args[0]);
      if (!(ms >= 0) || ms > 600e3) throw new UsageError('pause takes up to 10 minutes: 2, 1.5s, 500ms, 1m');
      await sleep(ms);
      return console.log(`paused ${ms >= 1000 ? `${ms / 1000} s` : `${ms} ms`}`);
    }
    case 'handoff': return handoff(d, args, opts);
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
    case 'fold': {
      const want = args[0] ? foldPosition(args[0]) : null;
      if (!d.fold) unsupported(d.kind, 'fold');
      const r = await d.fold(want);
      if (!r.position) throw new UsageError(`this simulator doesn't fold — ${capability(d.kind, 'fold').why}`);
      const { w, h } = await d.rotate();
      return console.log(`${r.position}: the ${r.screen?.id === 1 ? 'outer' : 'inner'} screen (${w}x${h})`);
    }
    case 'logs': return args[0] === 'mark' ? markLogs(d, args[1], opts) : showLogs(d, args[0], opts);
    case 'crashes': return showCrashes(d, args[0], opts);
    case 'app': return opts.flags.has('paths') ? showPaths(d, args[0]) : showApp(d, args[0]);
    case 'apps': return showApps(d, args.join(' '), opts);
    case 'notifications': return showNotifications(d, args.join(' '), opts);
    case 'install': {
      need(1, 'install <path.app|path.apk> [--grant]');
      const t = Date.now();
      const r = await d.install(args[0], { grant: opts.flags.has('grant') });
      const { id, version } = r && typeof r === 'object' ? r : { id: r };
      return console.log(`installed ${id || args[0]}${version ? ` (version code ${version})` : ''} in ${((Date.now() - t) / 1000).toFixed(1)} s`);
    }
    case 'reverse': return reverseCommand(d, args, opts);
    case 'metro': return metroCommand(d, args);
    case 'ps': return showPs(d, args[0]);
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
      if (args[0] === 'clear') {
        await stopRouteWorker(d);
        const r = await located(() => d.clearLocation());
        rememberLocation(d, null);
        return console.log(r?.note || 'location cleared');
      }
      const [lat, lon] = coordinates(args);
      await located(() => d.location(lat, lon));
      rememberLocation(d, [lat, lon]);
      // Never the coordinates: what an agent reads back shouldn't carry a location.
      console.log('location set');
      const off = await d.realLocationLeak?.([lat, lon]).catch(() => null);
      if (off) console.error(`looktap: warning: ${REAL_GPS(off)}`);
      return;
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
      // An app id: how much it sent and received, and in how many bursts.
      if (args[0] && /\./.test(args[0])) return networkUse(d, args[0], opts);
      if (args[0] && !['offline', 'online'].includes(args[0])) throw new UsageError('usage: looktap network [offline|online] | network <app> [--for 60s]');
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
    case 'route': return routeCommand(d, args, opts);
    case 'prefs': return showPrefs(d, args, opts);
    case 'kill': {
      const app = explicitApp(d, args[0], 'kill <app>');
      if (!d.kill) unsupported(d.kind, 'kill');
      const r = await d.kill(app);
      if (!r.pid) return console.log(`${app} wasn't running`);
      return console.log(
        `killed ${app} (pid ${r.pid}) as the system does under memory pressure: ${r.how}. What it registered stays (${d.serial ? 'geofences, alarms, jobs, its services' : 'region monitoring, significant-change monitoring, background tasks'})${r.after ? ` · the system started it again right away, pid ${r.after}` : ''}`,
      );
    }
    case 'background': {
      const app = explicitApp(d, args[0], 'background <app>');
      const was = await d.pidOf(app);
      if (!was) throw new Error(`${app} isn't running: launch it first (looktap launch ${app})`);
      if ((await d.foreground())?.id === app) {
        await d.home();
        for (let i = 0; i < 12 && (await d.foreground())?.id === app; i++) await sleep(250);
        if ((await d.foreground())?.id === app) throw new Error(`pressed Home, but ${app} is still in front`);
      }
      const pid = await d.pidOf(app);
      if (!pid) throw new Error(`${app} ended when it went to the background (pid ${was}) — see: looktap crashes ${app}`);
      return console.log(`${app} is in the background, still running, pid ${pid}${pid !== was ? ` (it restarted: was ${was})` : ''}${d.serial ? '' : ' (iOS suspends it within seconds unless it has background work)'}`);
    }
    case 'value': {
      need(1, 'value <label|@ref>');
      const { e, snap } = await target(d, isRef(args[0]) ? args[0] : args.join(' '), opts);
      // A label with no value of its own: the switch in its row (Android settings rows draw it apart from the text).
      const v = e.value ?? valueBeside(snap.elements, e)?.value;
      if (v == null) console.error(`looktap: ${JSON.stringify(e.label || e.type)} has no value (a ${e.type}), and no switch beside it: printed empty`);
      return console.log(v ?? '');
    }
    case 'geofences': {
      const app = explicitApp(d, args[0], 'geofences <app>');
      if (!d.geofences) unsupported(d.kind, 'geofences');
      return printGeofences(app, await d.geofences(app));
    }
    case 'battery': return showBattery(d, args[0], opts);
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

/** Android log buffers `--buffer` takes. */
const BUFFERS = ['main', 'system', 'crash', 'events', 'radio', 'kernel', 'all'];

/**
 A stale log: the device's newest log line is far behind its clock (a stopped logd, or a buffer nothing writes to),
 so "no lines from the app" means nothing. Says so; returns the warning or null.
 */
function staleLog(d) {
  if (!d.logAge) return null;
  const { now, newest } = d.logAge();
  if (!now || !newest || now - newest < 10 * 60e3) return null;
  const msg = `the device's newest log line is ${clockTime(now - newest)} old (by the device's own clock): its log buffer is stale or logd has stopped, so a missing line proves nothing. looktap logs --clear starts it fresh; if new lines still don't come, reboot the device`;
  console.error(`looktap: warning: ${msg}`);
  return msg;
}

async function showLogs(d, arg, opts) {
  if (opts.buffer && !BUFFERS.includes(opts.buffer)) throw new UsageError(`--buffer takes ${BUFFERS.join(', ')}`);
  if ((opts.buffer || opts.tag) && !d.serial) throw new UsageError('--buffer and --tag are Android logcat filters (iOS: --grep)');
  if (opts.flags.has('clear')) {
    if (!d.clearLogs) throw new UsageError("logs --clear is Android's logcat -c (iOS keeps its log; logs mark and --since start from now)");
    d.clearLogs(opts.buffer === 'all');
    return console.log(`cleared the device's log${opts.buffer === 'all' ? ' (all buffers)' : ''}: the next logs starts from now`);
  }
  const app = await whichApp(d, arg);
  if (opts.flags.has('follow')) return followLogs(d, app, opts);
  const since = startOf(deviceId(d), `logs:${app}`, opts.since, 60e3);
  const keep = grepper(opts.grep);
  const lines = (await d.readLogs(app, since, { errors: opts.flags.has('errors'), all: opts.flags.has('all'), buffer: opts.buffer, tag: opts.tag })).filter(keep);
  if (!lines.length) staleLog(d);
  if (!lines.length) return console.log(`no ${opts.flags.has('errors') ? 'errors' : 'log lines'} from ${app} since ${clock(since)}`);
  const { shown, dropped } = tail(lines, opts.lines > 0 ? opts.lines : 80);
  if (dropped) console.log(`… ${dropped} earlier lines (--lines ${lines.length} to see them, or --grep / --errors to narrow)`);
  console.log(shown.map((l) => (l.text.length > 500 ? l.text.slice(0, 500) + ' …' : l.text)).join('\n'));
}

/**
 `logs --follow`: the app's lines as they come (--grep, --errors filter them), and its process starting and ending as
 events between them, until Ctrl+C or --for. Android follows the app's uid, so a relaunch is followed too; the
 system's own line says why it started (a broadcast: a geofence's PendingIntent, an alarm).
 */
async function followLogs(d, app, opts) {
  if (!d.followLogs) unsupported(d.kind, 'logs');
  if (mcpMode && opts.for == null) throw new UsageError('logs --follow over MCP needs --for (e.g. --for 60s): a call has to end');
  const span = opts.for != null ? duration(opts.for) : 0;
  if (opts.for != null && !(span > 0)) throw new UsageError('--for takes a duration: 30s, 10m');
  const since = opts.since ? sinceOf(deviceId(d), opts.since) : Date.now();
  const keep = grepper(opts.grep), errors = opts.flags.has('errors');
  let seen = (await d.pidOf(app).catch(() => 0)) || 0;
  // --file: the capture goes to a file (appended), so it survives this terminal; the events go there too.
  const file = opts.file ? resolve(opts.file) : null;
  if (file) mkdirSync(dirname(file), { recursive: true }), appendFileSync(file, '');
  const out = file ? (line) => appendFileSync(file, `${line}\n`) : (line) => console.log(line);
  console.error(`looktap: following ${app}'s log${opts.grep ? ` (lines matching ${opts.grep})` : ''}${seen ? `, running as pid ${seen}` : ', not running now'}${file ? ` into ${file}` : ''} — ${span ? `for ${clockTime(span)}, or ` : ''}until Ctrl+C`);
  staleLog(d);
  const stop = d.followLogs(app, since, {
    all: opts.flags.has('all'),
    buffer: opts.buffer,
    tag: opts.tag,
    onGap: ({ from, to, by }) => {
      const line = `── capture interrupted ${clock(from).slice(0, 8)}–${clock(to).slice(0, 8)}: ${by ? `adb restarted by ${by.from}` : 'adb dropped the connection'} (lines from that time were read back where the device still had them)`;
      out(line);
      if (file) console.error(`looktap: ${line.slice(3)}`);
    },
    onLine: (l) => {
      if (errors && !/^\S+ [EF] /.test(l.text)) return;
      if (keep(l)) out(l.text.length > 500 ? `${l.text.slice(0, 500)} …` : l.text);
    },
    onEvent: async (e) => {
      if (e.kind === 'died') return out(`── ${app} ended (pid ${e.pid})${e.why ? `: ${e.why}` : ''}`);
      if (e.pid === seen && !e.why) return;
      // In front or not, a moment after it started: a region event relaunches it in the background.
      await sleep(500);
      const front = (await d.foreground().catch(() => null))?.id === app;
      out(`── ${app} ${seen ? 'relaunched' : 'started'} ${front ? 'in front' : 'in the background'}, pid ${e.pid}${e.why ? ` (${e.why})` : ''}`);
      seen = e.pid;
    },
  });
  await new Promise((resolve) => {
    if (span) setTimeout(resolve, span);
    process.once('SIGINT', resolve);
  });
  stop();
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
 `notifications [app] [--until text] [--all] [--json]`: what the device holds, newest first. --until waits for one
 whose title or body has the text (one already there counts). Ongoing ones (charging, a foreground service) only
 with --all or an app.
 */
async function showNotifications(d, app, opts) {
  const json = opts.flags.has('json');
  const all = opts.flags.has('all') || Boolean(app);
  // A real iPhone shows app names (HEALTH), not ids.
  const name = app.includes('.') && d instanceof IosDevice ? (await d.apps({ all: true }).catch(() => [])).find((a) => a.id === app)?.name : null;
  let hidden = 0;
  const read = async (o) => {
    const list = (await d.notifications(o)).filter((n) => !app || fromApp(n, app, name));
    hidden = all ? 0 : list.filter((n) => n.ongoing).length;
    return all ? list : list.filter((n) => !n.ongoing);
  };
  const from = app ? ` from ${app}` : '';
  if (!opts.until) {
    const list = await read();
    if (json) return console.log(notificationJson(list));
    if (!list.length) console.log(`no notifications${from}`);
    for (const n of list) console.log(formatNotification(n));
    if (hidden) console.log(`(${hidden} ongoing hidden: --all lists them)`);
    return;
  }
  const timeout = opts.wait != null ? Number(opts.wait) * 1000 : 30e3;
  if (!(timeout >= 0)) throw new UsageError('--wait takes seconds, e.g. --wait 30');
  // A real iPhone: Notification Center is pulled down at the start and the end; in between, banners are watched.
  const phone = d instanceof IosDevice;
  const t0 = Date.now();
  let list = [];
  for (let first = true; ; first = false) {
    const last = Date.now() - t0 >= timeout;
    list = await read(phone ? { open: first || last } : undefined);
    const hit = list.find((n) => notificationMatches(n, opts.until));
    if (hit) return console.log(json ? notificationJson([hit]) : formatNotification(hit));
    if (last) break;
    await sleep(Math.min(phone ? 300 : 1000, Math.max(0, timeout - (Date.now() - t0))));
  }
  const shown = list.slice(0, 8).map((n) => `  ${formatNotification(n)}`);
  throw new Error(`no notification${from} matching ${JSON.stringify(opts.until)} within ${timeout / 1000} s${shown.length ? `; there are:\n${shown.join('\n')}` : ' (there are none)'}`);
}

/**
 `looktap mcp`: serve the commands over MCP (stdio). Each call's output — console.log/error anywhere
 in looktap — becomes the tool result; stdout carries nothing but protocol messages.
 */
let mcpMode = false;

async function mcp(outer) {
  mcpMode = true;
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
      else if (cmd === 'doctor') await doctor({ ...opts, device: opts.device || where.device, platform: opts.platform || where.platform });
      else if (cmd === 'devices') capture(deviceLines(opts).join('\n'));
      else if (cmd === 'boot') capture(booted(await boot(args.join(' ') || null, { platform: opts.platform, ...display(opts, config) })));
      else if (cmd === 'shutdown') capture(shutDown(await shutdown(args.join(' ') || opts.device || null, { platform: opts.platform })));
      else if (['mcp', 'skill'].includes(cmd)) throw new UsageError(`${cmd} isn't available over MCP`);
      else if (cmd === 'who') capture(whoLines(args[0] || opts.device || where.device || null).join('\n'));
      else if (cmd === 'release') capture(await release(args[0] || opts.device || where.device, { force: opts.flags.has('force'), yes: opts.flags.has('yes') }));
      else {
        knownCommand(cmd);
        const d = driverFor({ platform: opts.platform || where.platform, device: opts.device || where.device });
        const o = { ...base, ...opts, wait: opts.wait ?? base.wait, flags: opts.flags };
        await drive(d, cmd, args, o).catch(async (e) => {
          await screenOnFailure(d, cmd, e, o);
          throw e;
        });
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
      return { text: (e.printed ? sink : [...sink, `looktap: ${msg}`, ...(e.after ? [`looktap: ${e.after}`] : [])]).join('\n'), error: true };
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
  await runSteps(d, args[0] === '-' ? readFileSync(0, 'utf8') : args.join(' '), outer);
  // --ls: the screen the steps ended on, once it holds still, so a batch needs no `ls` call after it.
  if (outer.flags.has('ls')) await list(d, outer, await settle(d, { all: outer.flags.has('all') }));
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
      const rest = steps.slice(i + 1).map((w) => w.join(' '));
      e.message = `step ${i + 1} (${words.join(' ')}): ${e.message}`;
      // What didn't run, so the agent can send the rest (or a corrected rest) once it has read the screen.
      if (rest.length) e.after = `not run: ${rest.map((r, j) => `${i + 2 + j}. ${r}`).join(' · ')}. The app went another way: read the screen below (or looktap ls), then run the steps that fit it`;
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
function skill(opts, args = []) {
  const source = readFileSync(SKILL, 'utf8');
  const references = skillReferences();
  // `skill commands`: one reference file, for an agent that can't open the installed copy.
  if (args.length) {
    const text = references[`${args[0].replace(/\.md$/, '')}.md`];
    if (args.length > 1 || !text) throw new UsageError(`skill takes one of: ${Object.keys(references).map((f) => f.slice(0, -3)).join(', ')}`);
    return process.stdout.write(text);
  }
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
  const written = installSkill(agents, { source, references, version: pkg.version, home, root });
  console.log(`installed the looktap skill (${pkg.version}) for:`);
  // The references sit beside SKILL.md: say so, or an install looks the same as one of the single-file skill.
  const refs = Object.keys(references).length;
  const extra = refs ? ` + ${refs} reference${refs === 1 ? '' : 's'}` : '';
  for (const w of written) console.log(`  ${w.agents.map((a) => a.name).join(', ').padEnd(16)} ${tilde(w.file)}${extra}`);
  const missing = AGENTS.filter((a) => !agents.includes(a) && !(a.id === 'claude' && plugin)).map((a) => a.id);
  console.log(
    `${note}Restart an agent that's already running to load it.${missing.length ? ` Others: looktap skill --install --agents <${missing.slice(0, 4).join('|')}|…> (looktap skill --list shows them all)` : ''}`,
  );
}

/** The coding agent running looktap right now, by what it sets in its commands' environment, or null. */
const AGENT_ENV = { claude: 'CLAUDECODE', gemini: 'GEMINI_CLI' };
const callingAgent = (env = process.env) => AGENTS.find((a) => AGENT_ENV[a.id] && env[AGENT_ENV[a.id]]) || null;

/**
 doctor's line about the agent guide: which agents have it. An outdated copy is a problem only for the agent running
 doctor; old copies for other agents (installed once, maybe not used any more) get a note, not a failure.
 */
function skillStatus(ok) {
  const home = homedir();
  const have = AGENTS.map((a) => ({ a, v: installedVersion(join(skillsDir(a, { home }), 'looktap', 'SKILL.md')) })).filter((x) => x.v != null);
  if (claudePlugin({ home }) && !have.some((x) => x.a.id === 'claude')) have.unshift({ a: { id: 'claude', name: 'Claude Code (plugin)' }, v: pkg.version });
  if (!have.length) return ok(false, 'agent skill: not installed for any agent', 'looktap skill --install');
  const me = callingAgent();
  if (me && !have.some((x) => x.a.id === me.id)) ok(false, `agent skill: not installed for ${me.name}, the agent running this`, `looktap skill --install --agents ${me.id}`);
  const stale = have.filter((x) => x.v !== pkg.version);
  const mine = stale.filter((x) => x.a.id === me?.id), others = stale.filter((x) => x.a.id !== me?.id);
  ok(!mine.length, `agent skill: ${have.map((x) => x.a.name).join(', ')}${mine.length ? ` (outdated for ${me.name}: ${mine[0].v})` : ''}`, `looktap skill --install --agents ${me?.id}`);
  if (others.length) ok(null, `older copies of the skill (${others[0].v}${others.some((x) => x.v !== others[0].v) ? ' and others' : ''}) for ${others.map((x) => x.a.name).join(', ')}: looktap skill --install refreshes them, if you use those agents`);
}

main().catch((e) => {
  if (!e.printed) console.error(`looktap: ${e.message}${e.after ? `\nlooktap: ${e.after}` : ''}`);
  process.exit(e instanceof UsageError ? 2 : 1);
});
