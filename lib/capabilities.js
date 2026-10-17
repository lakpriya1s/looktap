// What each kind of device can't do, or can do only in part — in one place. `looktap capabilities`, the README's
// platform table and the errors the drivers throw for what a device can't do all read it, so they can't disagree.
import { SERVICES } from './permissions.js';
import { UsageError } from './util.js';

/** Every command that acts on a device (test/capabilities.test.js checks it against the CLI). */
export const COMMANDS = [
  'setup', 'teardown', 'ls', 'wait', 'scrollto', 'shot', 'burst', 'record', 'tap', 'longpress', 'zoom', 'tapxy', 'type',
  'key', 'fill', 'hidekb', 'swipe', 'back', 'home', 'open', 'launch', 'stop', 'bio', 'rotate', 'logs', 'crashes', 'app',
  'install', 'uninstall', 'reset', 'location', 'appearance', 'textsize', 'statusbar', 'network', 'push', 'permission',
  'run', 'capabilities',
];

/** Device kinds: what the README's table calls them, and how an error names one. */
export const KINDS = {
  'ios-simulator': { title: 'iOS simulator', name: 'the iOS simulator' },
  'ios-device': { title: 'iPhone / iPad', name: 'a real iPhone or iPad' },
  'android-emulator': { title: 'Android emulator', name: 'the Android emulator' },
  'android-device': { title: 'Android device', name: 'an Android device' },
};

/** Permission names one platform lacks, e.g. "camera and notifications". */
const lacking = (platform) => Object.keys(SERVICES).filter((n) => !SERVICES[n][platform]).join(', ').replace(/, ([^,]*)$/, ' and $1');

const IOS_BACK = ['conditional', "iOS has no system Back: it taps the navigation bar's back button, else a top-left Back button"];
const ANDROID = {
  'location clear': ['unsupported', 'the emulator keeps its last location: set a new one instead'],
  push: ['unsupported', "Android pushes come through Firebase (FCM), so adb can't inject one: send it from your backend or the Firebase console"],
  record: ['conditional', 'at most 3 minutes, and FLAG_SECURE screens record black'],
  zoom: ['conditional', 'only through the Android helper (the default): adb input has no multi-touch'],
  permission: ['conditional', `${lacking('android')} are iOS-only; any android.permission.* works`],
};

/** kind → command (or "command subcommand") → [status, why]. A command not listed is supported. */
export const LIMITS = {
  'ios-simulator': {
    back: IOS_BACK,
    permission: ['conditional', `${lacking('ios')} can't be set: simctl privacy has no such service`],
    network: ['unsupported', "the simulator uses the Mac's own network, so it can't go offline or slow by itself. Network Link Conditioner (Xcode → Open Developer Tool → More Developer Tools → Additional Tools) throttles the whole Mac"],
  },
  'ios-device': {
    back: IOS_BACK,
    zoom: ['conditional', "around the screen's centre only"],
    record: ['unsupported', 'use burst for frames, or QuickTime Player for video'],
    location: ['unsupported', 'a real device uses its own GPS; use a simulator to fake one'],
    network: ['unsupported', 'turn on Airplane Mode in Control Center'],
    push: ['unsupported', 'send a real push through APNs'],
    statusbar: ['unsupported', 'only simulators can override the status bar'],
    textsize: ['unsupported', 'change it in Settings → Display & Brightness → Text Size'],
    bio: ['unsupported', 'Face ID needs a real face on a device'],
    permission: ['unsupported', 'change it in the Settings app'],
    reset: ['unsupported', 'uninstall and install the app again'],
    logs: ['unsupported', 'use Console.app with the device selected'],
    crashes: ['unsupported', 'see Xcode → Window → Devices and Simulators → View Device Logs'],
  },
  'android-emulator': ANDROID,
  'android-device': {
    ...ANDROID,
    shot: ['conditional', 'FLAG_SECURE screens come out black (emulators bypass it)'],
    burst: ['conditional', 'FLAG_SECURE screens come out black (emulators bypass it)'],
    location: ['unsupported', 'a device uses its own GPS (faking it needs a mock-location app)'],
    'location clear': ['unsupported', 'a device uses its own GPS (faking it needs a mock-location app)'],
    bio: ['unsupported', 'fingerprints can only be simulated on an emulator'],
    network: ['conditional', "airplane mode: over wireless adb, going offline also drops looktap's connection"],
  },
};

/** { status, why } for a command (or "command subcommand", falling back to the command) on a kind of device. */
export function capability(kind, command) {
  const limits = LIMITS[kind] || {};
  const hit = limits[command] || limits[command.split(' ')[0]];
  return hit ? { status: hit[0], why: hit[1] } : { status: 'supported' };
}

/** Throw the reason `command` can't run on this kind of device. */
export function unsupported(kind, command) {
  const { why } = capability(kind, command);
  throw new UsageError(`${command} isn't available on ${KINDS[kind]?.name || 'this device'}${why ? ` — ${why}` : ''}`);
}

/** Every command on a kind of device: { command: { status, why? } }, with "command subcommand" limits too. */
export function capabilities(kind) {
  const out = {};
  for (const c of [...COMMANDS, ...Object.keys(LIMITS[kind] || {}).filter((k) => k.includes(' '))]) out[c] = capability(kind, c);
  return out;
}

const MARK = { supported: '✅', conditional: '⚠️', unsupported: '❌' };

/** The README's table: every command that isn't fully supported everywhere, one column per kind of device. */
export function capabilityTable() {
  const kinds = Object.keys(KINDS);
  const partial = [...new Set(kinds.flatMap((k) => Object.keys(LIMITS[k])))].sort();
  const cell = (k, c) => {
    const { status, why } = capability(k, c);
    return why ? `${MARK[status]} ${why.replace(/\|/g, '\\|')}` : MARK[status];
  };
  return [
    `| Command | ${kinds.map((k) => KINDS[k].title).join(' | ')} |`,
    `|---|${kinds.map(() => '---').join('|')}|`,
    ...partial.map((c) => `| \`${c}\` | ${kinds.map((k) => cell(k, c)).join(' | ')} |`),
  ].join('\n');
}
