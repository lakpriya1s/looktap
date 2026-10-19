// The landing page's scroll story: one scene per feature. A scene sets the phone up (start), then plays beats:
// each types a command into the demo terminal, moves the phone, and prints what looktap prints. `covers`
// names the commands a scene shows; site/build.mjs fails if a command in bin/looktap.js is in none.
// Importable in Node (no DOM at import time) so the build can check coverage.

export const APP = 'com.example.demostore';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const warn = (s) => ({ c: 'warn', s });
const err = (s) => ({ c: 'err', s });
const ok = (s) => ({ c: 'ok', s });
const dim = (s) => ({ c: 'dim', s });

/** `--ls` output: the settled screen, a few rows. */
const listed = (p, n = 6) => {
  const rows = p.rows();
  return [...rows.slice(0, n).map(dim), ...(rows.length > n ? [dim(`… ${rows.length - n} more rows`)] : [])];
};

/** tap <label>: find it looktap's way, touch it, run `then`, print what looktap prints. */
async function tap(p, label, { ls = false, then } = {}) {
  const { e, error } = p.find(label);
  if (error) return [err(`looktap: ${error}`)];
  const at = p.centre(e);
  await p.tapEl(e);
  if (then) await then(e);
  return [`tapped ${JSON.stringify(e.label)} at ${at.join(',')}`, ...(ls ? listed(p) : [])];
}

export const SCENES = [
  {
    id: 'look',
    kicker: '01 · Look',
    title: 'The screen, as text',
    body: `<p><code>ls</code> lists what's on screen, one row per element: a ref, its type, where it is, and its label. It reads native screens, React Native, and web content in Safari or a web view.</p>
<p>A screen read is about <strong>1 KB of text</strong>, where other agent tools return 4–125 KB. That's what an agent pays for in context, every turn.</p>`,
    covers: ['ls'],
    start: (p) => p.show('signin'),
    beats: [
      {
        cmd: 'looktap ls',
        run: async (p) => {
          p.showRefs();
          return p.rows().map((s) => ({ s, ref: true }));
        },
      },
    ],
  },
  {
    id: 'tap',
    kicker: '02 · Tap',
    title: 'Tap by label, never by guess',
    body: `<p>Name the element: an exact label, else a prefix or substring that matches <em>one</em> label. A match that could mean two things is an error, not a coin toss. Or use the <code>@ref</code> from the last <code>ls</code>, or plain coordinates with <code>tapxy</code>.</p>
<p>Every tap says what it hit and where.</p>`,
    covers: ['tap', 'tapxy'],
    start: (p) => p.show('home'),
    beats: [
      { cmd: 'looktap tap "milk"', run: (p) => tap(p, 'milk') },
      { cmd: 'looktap tap "Oat milk, 1 L"', run: (p) => tap(p, 'Oat milk, 1 L') },
      {
        cmd: 'looktap tap Add --ls',
        run: (p) => tap(p, 'Add', { ls: true, then: async () => p.set({ cart: 3 }) }),
      },
      {
        cmd: (c) => (c.ios ? 'looktap tapxy 348 121' : 'looktap tapxy 367 132'),
        run: async (p) => {
          await p.touch(348, 121);
          return [];
        },
      },
    ],
  },
  {
    id: 'type',
    kicker: '03 · Type',
    title: 'Fill forms the way a person does',
    body: `<p><code>fill</code> focuses a field, clears it and types. <code>type</code> adds to the focused field, and <code>key</code> presses return, tab, delete and friends. On iOS, characters a US keyboard can't type are pasted.</p>
<p><code>hidekb</code> checks after every method it tries, and it never reports success while the keyboard is still up.</p>`,
    covers: ['fill', 'type', 'key', 'hidekb'],
    start: (p) => p.show('signin'),
    beats: [
      {
        cmd: 'looktap fill Email sam',
        run: async (p) => {
          const { e } = p.find('Email');
          await p.tapEl(e);
          p.overlay({ kind: 'keyboard' });
          await p.typeInto('Email', 'sam');
          return [];
        },
      },
      {
        cmd: 'looktap type "@example.com"',
        run: async (p) => {
          await p.typeInto('Email', 'sam@example.com', 40);
          return [];
        },
      },
      {
        cmd: 'looktap key tab',
        run: async (p) => {
          p.set({ focus: 'Password' });
          return [];
        },
      },
      {
        cmd: 'looktap hidekb --ls',
        run: async (p) => {
          await p.touch(335, 799);
          p.clear('keyboard');
          p.set({ focus: null });
          return [p.platform === 'ios' ? 'keyboard hidden (its Done key)' : 'keyboard hidden', ...listed(p, 5)];
        },
      },
    ],
  },
  {
    id: 'gestures',
    kicker: '04 · Move',
    title: 'Swipe, scroll, hold, pinch',
    body: `<p><code>swipe</code> drags, <code>scrollto</code> swipes until a row is fully on screen, <code>longpress</code> holds, and <code>zoom</code> is a real two-finger pinch on both platforms.</p>
<p><code>open</code> follows a deep link, <code>back</code> goes back (Android's system Back, or the iOS navigation bar's), <code>home</code> presses the Home button, and <code>location</code> moves the GPS.</p>`,
    covers: ['swipe', 'scrollto', 'longpress', 'zoom', 'open', 'back', 'home', 'location'],
    start: (p) => p.show('home'),
    beats: [
      {
        cmd: (c) => (c.ios ? 'looktap swipe 195 600 195 300' : 'looktap swipe 206 656 206 328'),
        run: async (p) => {
          p.swipe(195, 600, 195, 300);
          await p.scrollList(216);
          return [];
        },
      },
      {
        cmd: 'looktap scrollto "Gift card"',
        run: async (p) => {
          await p.swipe(195, 600, 195, 400, 300);
          await p.scrollList(310);
          const { e } = p.find('Gift card');
          return [`found "Gift card" at ${p.centre(e).join(',')}`];
        },
      },
      {
        cmd: 'looktap open demostore://stores',
        run: async (p) => {
          p.show('map');
          return [];
        },
      },
      {
        cmd: 'looktap location 51.5072 -0.1276',
        run: async (p) => {
          p.overlay({ kind: 'dot', x: 196, y: 404 });
          return ['location 51.5072, -0.1276'];
        },
      },
      {
        cmd: (c) => (c.ios ? 'looktap longpress 120 560 --ls' : 'looktap longpress 126 612 --ls'),
        run: async (p, c) => {
          await p.touch(120, 560, { hold: 800 });
          p.overlay({ kind: 'pin', x: 120, y: 560 });
          p.overlay({ kind: 'card', title: 'Dropped Pin', sub: 'Harbour Street · 0.4 mi', buttons: ['Directions', 'Share'] });
          return [`long-pressed ${c.ios ? '120,560' : '126,612'} for 800 ms`, ...listed(p, 5)];
        },
      },
      {
        cmd: 'looktap zoom in',
        run: async (p) => {
          const { w, h } = p.screenSize();
          await p.pinch(195, 422);
          p.set({ zoom: 1.7 });
          return [`zoomed in at ${Math.round(w / 2)},${Math.round(h / 2)} (fingers 80 ↔ 200 apart)`];
        },
      },
      {
        cmd: 'looktap back --ls',
        run: async (p) => {
          const back = p.find('Back').e;
          if (back) await p.tapEl(back);
          p.show('home');
          return listed(p, 4);
        },
      },
      {
        cmd: 'looktap home',
        run: async (p) => {
          p.set({ screen: 'springboard' });
          return [`home screen · ${APP} still running in the background, pid 4127`];
        },
      },
    ],
  },
  {
    id: 'wait',
    kicker: '05 · Wait',
    title: 'Wait for it. Don’t sleep',
    body: `<p><code>wait</code> returns the moment a label appears, or with <code>--gone</code>, the moment it's gone. No fixed sleeps that are too short on a slow day and wasted on a fast one.</p>
<p>Every action already waits up to 3 s for its target, and <code>--ls</code> waits for the screen to settle before printing it.</p>`,
    covers: ['wait'],
    start: (p) => {
      p.show('signin');
      p.set({ values: { Email: 'sam@example.com', Password: '••••••••••' } });
    },
    beats: [
      {
        cmd: 'looktap tap "Sign in"',
        run: (p) => tap(p, 'Sign in', { then: async () => p.overlay({ kind: 'spinner' }) }),
      },
      {
        cmd: 'looktap wait Welcome',
        run: async (p) => {
          await sleep(1100);
          p.show('home');
          p.overlay({ kind: 'welcome' });
          const { e } = p.find('Welcome back, Sam');
          return [`found "Welcome back, Sam" at ${p.centre(e).join(',')}`];
        },
      },
      { cmd: 'looktap wait Loading --gone', run: async () => ['gone: Loading'] },
    ],
  },
  {
    id: 'capture',
    kicker: '06 · Capture',
    title: 'Screenshots, bursts and video',
    body: `<p><code>shot</code> saves a PNG and prints its path: an agent opens it only when layout or colour matters. <code>--scale 0.5</code> halves the image tokens. On Android emulators it captures <code>FLAG_SECURE</code> screens too.</p>
<p><code>burst</code> keeps a frame each time the screen changes, to catch a spinner or a toast. <code>record start</code> … <code>record stop</code> saves an MP4 of a whole flow.</p>`,
    covers: ['shot', 'burst', 'record'],
    start: (p) => p.show('home'),
    beats: [
      {
        cmd: 'looktap shot home --scale 0.5',
        run: async (p) => {
          p.flash();
          return ['shots/home.png'];
        },
      },
      {
        cmd: 'looktap record start checkout',
        run: async (p) => {
          p.rec(true);
          return ['recording to /Users/you/app/shots/checkout.mp4 — stop with: looktap record stop'];
        },
      },
      {
        cmd: 'looktap tap Add',
        run: (p) => tap(p, 'Add', { then: async () => (p.set({ cart: 3 }), p.overlay({ kind: 'toast', text: 'Added to bag', y: 630 })) }),
      },
      {
        cmd: 'looktap record stop',
        run: async (p) => {
          p.rec(false);
          return ['/Users/you/app/shots/checkout.mp4  6 s'];
        },
      },
      { cmd: 'looktap burst ./frames 3', run: async () => ['48 frames, 9 distinct, in ./frames'] },
    ],
  },
  {
    id: 'debug',
    kicker: '07 · Debug',
    title: 'When the app vanishes, you hear why',
    body: `<p>An app that dies is named the moment looktap notices, right in the output of the tap that killed it.</p>
<p><code>crashes</code> reads the crash report (exception, reason, the top frames), and on Android ANRs and <strong>low-memory kills</strong> too. <code>logs</code> shows only what's new since you last looked, with <code>--errors</code> and <code>--grep</code> to narrow it. <code>app</code> says what's in front, and <code>capabilities</code> what this device can't do.</p>`,
    covers: ['logs', 'crashes', 'app', 'capabilities'],
    start: (p) => p.show('home'),
    beats: [
      {
        cmd: 'looktap tap "Checkout · 2 items" --ls',
        run: async (p) => {
          const out = await tap(p, 'Checkout · 2 items', { then: () => p.crash() });
          return [...out, warn(`looktap: warning: ${APP} is no longer running — it crashed or was killed. See: looktap crashes ${APP}`), ...listed(p, 4)];
        },
      },
      {
        cmd: 'looktap crashes',
        run: async (p, c) =>
          c.ios
            ? [
                'DemoStore crashed at 2026-10-15 10:24:07 — EXC_BREAKPOINT (SIGTRAP)',
                '  Fatal error: Unexpectedly found nil while unwrapping an Optional value',
                dim('  DemoStore              CheckoutView.total.getter + 412'),
                dim('  DemoStore              CheckoutView.body.getter + 96'),
                dim('  SwiftUI                ViewGraph.updateOutputs() + 188'),
              ]
            : [
                'FATAL EXCEPTION: main',
                `Process: ${APP}, PID: 4242`,
                'java.lang.NullPointerException: cart.total must not be null',
                dim(`  at ${APP}.checkout.CheckoutViewModel.total(CheckoutViewModel.kt:41)`),
                dim(`  at ${APP}.checkout.CheckoutScreen.render(CheckoutScreen.kt:88)`),
              ],
      },
      {
        cmd: 'looktap logs --errors',
        run: async (p, c) =>
          c.ios
            ? ['10:24:07.118 E [com.example.demostore:checkout] total requested before cart loaded', '10:24:07.121 F DemoStore/CheckoutView.swift:58: Fatal error: Unexpectedly found nil']
            : ['10:24:07.118 E CheckoutViewModel: total requested before cart loaded', '10:24:07.140 E AndroidRuntime: FATAL EXCEPTION: main'],
      },
      {
        cmd: 'looktap app',
        run: async (p, c) => [c.ios ? 'front: com.apple.springboard  pid 2310' : 'front: com.google.android.apps.nexuslauncher  pid 1877', `${APP}: not running — if it was, check: looktap crashes`],
      },
      {
        cmd: 'looktap capabilities',
        run: async (p, c) =>
          c.ios
            ? [
                'iOS simulator 5C3F1A2E-8B47-4D0A-9E61-2F7C8D4B9A10',
                dim("partly  back     iOS has no system Back: it taps the navigation bar's back button, else a top-left Back button"),
                dim("no      network  the simulator uses the Mac's own network, so it can't go offline or slow by itself. …"),
                'yes     setup, teardown, ls, wait, scrollto, shot, burst, record, tap, longpress, zoom, …',
              ]
            : [
                'Android emulator emulator-5554',
                dim('partly  record          at most 3 minutes, and FLAG_SECURE screens record black'),
                dim('partly  zoom            only through the Android helper (the default): adb input has no multi-touch'),
                dim("no      push            Android pushes come through Firebase (FCM), so adb can't inject one: …"),
                dim('no      location clear  the emulator keeps its last location: set a new one instead'),
                'yes     setup, teardown, ls, wait, scrollto, shot, burst, tap, longpress, tapxy, type, key, …',
              ],
      },
    ],
  },
  {
    id: 'bio',
    kicker: '08 · Biometrics',
    title: 'Face ID and fingerprints, on cue',
    body: `<p><code>bio match</code> and <code>bio nomatch</code> answer the system's biometric prompt: Face ID on the iOS simulator, a fingerprint on the Android emulator. Test the happy path and the failure path without a face or a finger.</p>`,
    covers: ['bio'],
    start: (p) => {
      p.show('signin');
      p.overlay({ kind: 'faceid', state: '' });
    },
    beats: [
      {
        cmd: 'looktap bio nomatch',
        run: async (p) => {
          p.overlay({ kind: 'faceid', state: 'bad' });
          await sleep(700);
          p.overlay({ kind: 'faceid', state: '' });
          return [];
        },
      },
      {
        cmd: 'looktap bio match --ls',
        run: async (p) => {
          p.overlay({ kind: 'faceid', state: 'ok' });
          await sleep(650);
          p.show('home');
          return listed(p, 4);
        },
      },
    ],
  },
  {
    id: 'conditions',
    kicker: '09 · Conditions',
    title: 'Dark mode, big text, landscape, offline',
    body: `<p>Put the device in the state your bug report describes, one command each: <code>appearance dark</code>, <code>textsize ax2</code> (Dynamic Type or font scale), <code>statusbar clean</code> for a 9:41 screenshot, <code>push</code> a notification (iOS), go <code>network offline</code> (Android airplane mode).</p>
<p><code>rotate landscape</code> turns the device, and everything follows: <code>ls</code> coordinates, taps and screenshots match what's on screen. An app that doesn't support the orientation stays put, and looktap says so.</p>`,
    covers: ['appearance', 'textsize', 'statusbar', 'push', 'network', 'rotate'],
    start: (p) => p.show('home'),
    beats: [
      {
        cmd: 'looktap appearance dark',
        run: async (p) => {
          p.set({ dark: true });
          return ['dark'];
        },
      },
      {
        cmd: 'looktap textsize ax2',
        run: async (p, c) => {
          p.set({ text: 1.18 });
          return [c.ios ? 'accessibility-large' : 'accessibility-large (font scale 1.7)'];
        },
      },
      {
        cmd: 'looktap statusbar clean',
        run: async (p) => {
          p.set({ clean: true });
          return ['status bar: 9:41, full battery and signal'];
        },
      },
      {
        cmd: `looktap push ${APP} "Your order has shipped"`,
        run: async (p, c) => {
          if (!c.ios) return [err("looktap: push isn't available on the Android emulator — Android pushes come through Firebase (FCM), so adb can't inject one: send it from your backend or the Firebase console")];
          p.overlay({ kind: 'banner', text: 'Your order has shipped' });
          setTimeout(() => p.clear('banner'), 2200);
          return [`pushed to ${APP}`];
        },
      },
      {
        cmd: 'looktap network offline',
        run: async (p, c) => {
          if (c.ios) return [err("looktap: network isn't available on the iOS simulator — the simulator uses the Mac's own network, so it can't go offline or slow by itself. Network Link Conditioner (…) throttles the whole Mac")];
          p.set({ offline: true });
          p.overlay({ kind: 'offline' });
          return ['network: offline (airplane mode)'];
        },
      },
      {
        cmd: 'looktap rotate landscape --ls',
        run: async (p) => {
          p.clear('offline');
          await p.rotate(true);
          const { w, h } = p.screenSize();
          return [`rotated: landscape left (${w}x${h})`, ...listed(p, 5)];
        },
      },
    ],
  },
  {
    id: 'state',
    kicker: '10 · App state',
    title: 'Fresh installs and permission prompts, on demand',
    body: `<p><code>install</code> a build and get its app id back, and <code>apps</code> says what's installed, with versions. <code>reset</code> puts an app back to a fresh install (data and permissions cleared), and <code>permission grant|revoke|reset</code> uses the same names on both platforms: camera, location, photos, notifications and more.</p>
<p>These commands always need the app id. They never act on whatever happens to be on screen.</p>`,
    covers: ['install', 'apps', 'permission', 'reset', 'launch', 'stop', 'uninstall'],
    start: (p) => p.show('springboardEmpty'),
    beats: [
      {
        cmd: (c) => (c.ios ? 'looktap install build/DemoStore.app' : 'looktap install build/demo-store.apk'),
        run: async (p) => {
          p.set({ screen: 'springboard', freshIcon: true });
          return [`installed ${APP}`];
        },
      },
      { cmd: 'looktap apps demo', run: async (p, c) => [`${APP}  ${c.ios ? 'Demo Store  v1.4 (212)' : 'v212'}`] },
      { cmd: `looktap permission grant camera ${APP}`, run: async (p, c) => [`granted: ${c.ios ? 'camera' : 'CAMERA'} for ${APP}`] },
      { cmd: `looktap reset ${APP}`, run: async () => [`reset ${APP}: data and permissions cleared — launch it to start fresh`] },
      {
        cmd: `looktap launch ${APP} --ls`,
        run: async (p) => {
          p.set({ freshIcon: false });
          p.show('signin');
          p.overlay({ kind: 'alert', title: '“Demo Store” Would Like to Send You Notifications', message: 'Notifications may include alerts, sounds and icon badges.', buttons: ['Don’t Allow', 'Allow'] });
          return listed(p, 4);
        },
      },
      { cmd: 'looktap tap Allow', run: (p) => tap(p, 'Allow', { then: async () => p.clear('alert') }) },
      {
        cmd: `looktap stop ${APP}`,
        run: async (p) => {
          p.set({ screen: 'springboard' });
          return [`stopped ${APP} (pid 4127)`];
        },
      },
      {
        cmd: `looktap uninstall ${APP}`,
        run: async (p) => {
          p.show('springboardEmpty');
          return [`uninstalled ${APP}`];
        },
      },
    ],
  },
  {
    id: 'honest',
    kicker: '11 · Honest failures',
    title: 'It tells you when something is off',
    body: `<p>A tap that lands on a toast instead of the button prints a warning. A stale <code>@ref</code> is an error, not a tap on whatever moved into its place. When a system prompt covers the app, <code>ls</code> says so instead of returning an empty screen, and on a locked phone every command that needs the screen stops with <em>the device is locked</em> instead of typing into the lock screen.</p>
<p>Exit code 2 means usage: bad arguments, element not found, no device. A script can <code>set -e</code> and stop at the first surprise.</p>`,
    covers: [],
    start: (p) => {
      p.show('home');
      p.overlay({ kind: 'toast', text: 'Added to bag', y: 222 });
    },
    beats: [
      {
        cmd: 'looktap tap Add',
        run: async (p, c) => {
          const out = await tap(p, 'Add');
          const toast = p.toPlatform(p.visible().find((e) => e.kind === 'toast'));
          return [...out, warn(`looktap: warning: "Added to bag" at ${toast.x},${toast.y} ${toast.w}x${toast.h} covers that point and may have taken the tap`)];
        },
      },
      {
        cmd: 'looktap tap @9',
        run: async (p, c) => {
          p.clear('toast');
          await p.scrollList(150);
          return [err(`looktap: @9 ("Add" at ${c.ios ? '314,420' : '331,459'}) is no longer on screen — run: looktap ls`)];
        },
      },
      {
        cmd: 'looktap ls',
        run: async (p) => {
          p.overlay({ kind: 'passcode' });
          return [err('looktap: only the status bar is readable — a system prompt (passcode, permission, alert) may be covering the app. `looktap shot` shows it')];
        },
      },
    ],
  },
  {
    id: 'agents',
    kicker: '12 · For agents',
    title: 'Built for the agent loop',
    body: `<p>Turns cost more than milliseconds. <code>--ls</code> on any action returns the settled screen, so look-then-act is one call. <code>run</code> batches known steps in one process, <code>ls --json</code> gives structure, and the Claude Code plugin teaches Claude the loop in about 150 tokens per session.</p>
<p>For chat apps without a shell, <code>npx -y @looktap/mcp</code> serves the same commands over MCP. It's in the official MCP Registry.</p>
<div class="tools" data-tools aria-label="MCP tools"></div>`,
    covers: ['run', 'mcp', 'skill'],
    start: (p) => p.show('signin'),
    beats: [
      {
        cmd: `looktap run 'fill Email sam@example.com; tap "Sign in"; wait Welcome'`,
        run: async (p, c) => {
          const { e } = p.find('Email');
          await p.tapEl(e);
          await p.typeInto('Email', 'sam@example.com', 25);
          p.set({ focus: null });
          const out = [dim('$ fill Email sam@example.com'), dim('$ tap "Sign in"'), ...(await tap(p, 'Sign in'))];
          p.show('home');
          p.overlay({ kind: 'welcome' });
          return [...out, dim('$ wait Welcome'), `found "Welcome back, Sam" at ${p.centre(p.find('Welcome back, Sam').e).join(',')}`];
        },
      },
      {
        cmd: 'looktap ls --json',
        run: async (p) => {
          const { w, h } = p.screenSize();
          const els = p.visible().slice(0, 2).map((e, i) => {
            const q = p.toPlatform(e);
            return `{"ref":"@${i + 1}","label":${JSON.stringify(q.label)},"type":"${q.type}","x":${q.x},"y":${q.y},"w":${q.w},"h":${q.h}}`;
          });
          return [`{"screen":{"w":${w},"h":${h}},"elements":[${els.join(',')},…]}`];
        },
      },
      { cmd: 'claude plugin install looktap --marketplace lakpriya1s/looktap', run: async () => ['✔ Successfully installed plugin: looktap@looktap'] },
      {
        cmd: 'claude mcp add looktap -- npx -y @looktap/mcp',
        run: async () => ['Added stdio MCP server looktap with command: npx -y @looktap/mcp to local config'],
      },
    ],
  },
  {
    id: 'test',
    kicker: '13 · Test',
    title: 'What worked becomes a test',
    body: `<p><code>expect</code> checks the screen: a label is there, a field holds a value, an error is gone. It waits up to 3 s for it, and when it fails it says what's there instead.</p>
<p>Save the steps that worked as a flow file, and <code>looktap test</code> runs your flows in CI: a line per flow, a JUnit report, and for every failure the screen, a screenshot, error logs and crashes. An app that dies fails its flow.</p>
<p>On Android, <code>looktap codegen</code> writes the flow while you use the phone: each touch becomes a tap by label, a fill, a scrollto.</p>`,
    covers: ['expect', 'test', 'codegen'],
    start: (p) => {
      p.show('signin');
      p.set({ values: { Email: 'sam@example.com' } });
    },
    beats: [
      {
        cmd: 'looktap expect Email = sam@example.com',
        run: async (p) => [ok(`ok: "Email" = "sam@example.com" at ${p.centre(p.find('Email').e).join(',')}`)],
      },
      {
        cmd: 'looktap expect Email = kim@example.com',
        run: async () => [err('looktap: expect failed: "Email" is "sam@example.com", expected "kim@example.com" (waited 3 s)')],
      },
      {
        cmd: 'looktap codegen flows/sign-in.txt',
        run: async (p) => {
          await sleep(500);
          return [dim(`+ launch ${APP}`), dim('+ wait "Sign in"'), '+ fill Email sam@example.com', '+ tap "Sign in"', dim('saved 5 steps to flows/sign-in.txt')];
        },
      },
      {
        cmd: 'looktap test flows/ --junit results/junit.xml',
        run: async (p) => {
          await sleep(600);
          p.show('home');
          return [
            ok('✓ flows/browse.txt  9 steps · 6.1 s'),
            ok('✓ flows/checkout.txt  12 steps · 8.7 s'),
            ok('✓ flows/sign-in.txt  6 steps · 4.8 s'),
            '3 flows: 3 passed, 0 failed · 19.6 s · results/junit.xml',
          ];
        },
      },
    ],
  },
  {
    id: 'setup',
    kicker: '14 · Setup',
    title: 'Nothing to install on simulators',
    body: `<p>No server to run and no npm dependencies. looktap's own small helpers start on first use: a macOS helper that speaks to the simulator through Apple's frameworks, and a 10 KB Android helper run with <code>app_process</code>. A real iPhone gets a small XCUITest runner, built and signed with your own Apple ID on first use.</p>
<p><code>boot</code> starts a simulator or emulator by name and waits until it's ready; <code>shutdown</code> stops it. Ready for the first command in under a second, against 8–29 s for mobile-mcp, Maestro and Appium.</p>`,
    covers: ['doctor', 'devices', 'boot', 'shutdown', 'setup', 'teardown'],
    start: (p) => p.show('springboard'),
    beats: [
      {
        cmd: 'looktap doctor',
        run: async (p, c) =>
          c.ios
            ? [ok('✓ node 22.11.0 (needs ≥ 18)'), ok('✓ xcrun (iOS)'), ok('✓ booted simulators: iPhone 18 Pro'), ok('✓ CoreSimulator.framework (iOS helper)'), dim('  iOS input: indigo (CoreSimulator 1048)')]
            : [ok('✓ node 22.11.0 (needs ≥ 18)'), ok('✓ adb (Android)'), ok('✓ adb devices: emulator-5554')],
      },
      {
        cmd: (c) => (c.ios ? 'looktap boot "iPhone 18 Pro"' : 'looktap boot Pixel_9a'),
        run: async (p, c) => [c.ios ? 'booted: ios  9F1C2A44-…-77E0  iPhone 18 Pro (iOS 26.0)' : 'booted: android  emulator-5554  Pixel_9a'],
      },
      {
        cmd: 'looktap devices',
        run: async (p, c) =>
          c.ios
            ? ['ios      9F1C2A44-…-77E0  iPhone 18 Pro · simulator · iOS 26.0 · window', 'ios      00008150-…-401E  Sam’s iPhone (iPhone 17 Pro) · device · iOS 26.0 · USB']
            : ['android  emulator-5554  Pixel_9a · emulator · Android 16 · window', 'android  R58N30ABCDE  Samsung SM-S931B · device · Android 16 · USB'],
      },
      {
        cmd: 'looktap setup',
        run: async (p, c) => [c.ios ? 'looktap iOS helper ready on 9F1C2A44-…-77E0' : 'adb emulator-5554 ready · scale 2.625 (dp = px ÷ 2.625) · reverse tcp:8081 · helper on · emulator gRPC frames'],
      },
      { cmd: 'looktap teardown', run: async (p, c) => [c.ios ? 'iOS helper stopped' : 'removed adb reverse rules · helper stopped'] },
      {
        cmd: (c) => (c.ios ? 'looktap shutdown "iPhone 18 Pro"' : 'looktap shutdown Pixel_9a'),
        run: async (p, c) => [c.ios ? 'shut down: ios  9F1C2A44-…-77E0  iPhone 18 Pro' : 'shut down: android  emulator-5554  Pixel_9a'],
      },
    ],
  },
  {
    id: 'phones',
    kicker: '15 · Real phones',
    title: 'Your own phone, same commands',
    body: `<p>Plug in an iPhone or an Android phone and the commands are the same. <code>devices</code> says which is a simulator, an emulator or a real phone, and when a phone isn't ready yet, what to tap on it: Trust, "Allow USB debugging?", Developer Mode.</p>
<p>What a real phone can't do, it says up front, with what to do instead: no fake GPS, no injected pushes. And a locked phone stops every command with <em>the device is locked</em>, instead of typing into the passcode screen.</p>`,
    covers: [],
    device: (ios) => (ios ? 'Sam’s iPhone · USB' : 'Samsung SM-S931B · USB'),
    start: (p) => p.show('home'),
    beats: [
      {
        cmd: 'looktap devices --all',
        run: async (p, c) =>
          c.ios
            ? [
                'ios      00008150-…-401E  Sam’s iPhone (iPhone 17 Pro) · device · iOS 26.0 · USB',
                'ios      9F1C2A44-…-77E0  iPhone 18 Pro · simulator · iOS 26.0 · window',
                warn('ios      00008120-…-1C2E  Sam’s iPad (iPad Air) · device · iOS 26.0 · Wi-Fi  ✗ not ready: Developer Mode is off: Settings → Privacy & Security → Developer Mode'),
                '',
                dim('not running (looktap boot <name>):'),
                dim('ios      4B7D0E19-…-A3C2  iPad Pro 13-inch (M5) · simulator · iOS 26.0'),
              ]
            : [
                'android  R58N30ABCDE  Samsung SM-S931B · device · Android 16 · USB',
                'android  emulator-5554  Pixel_9a · emulator · Android 16 · window',
                warn('android  R9TX21KLMNP  SM A065F · device · USB  ✗ not ready: accept "Allow USB debugging?" on the phone (tick "Always allow")'),
                '',
                dim('not running (looktap boot <name>):'),
                dim('android  Pixel_Tablet  Pixel_Tablet · emulator'),
              ],
      },
      {
        cmd: (c) => `looktap -d ${c.ios ? '00008150-…-401E' : 'R58N30ABCDE'} tap "Oat milk, 1 L"`,
        run: (p) => tap(p, 'Oat milk, 1 L'),
      },
      {
        cmd: (c) => `looktap -d ${c.ios ? '00008150-…-401E' : 'R58N30ABCDE'} location 51.5072 -0.1276`,
        run: async (p, c) => [
          err(`looktap: location isn't available on ${c.ios ? 'a real iPhone or iPad — a real device uses its own GPS; use a simulator to fake one' : 'an Android device — a device uses its own GPS (faking it needs a mock-location app)'}`),
        ],
      },
      {
        cmd: (c) => `looktap -d ${c.ios ? '00008150-…-401E' : 'R58N30ABCDE'} type "oat milk"`,
        run: async (p) => {
          p.overlay({ kind: 'passcode' });
          return [err('looktap: the device is locked: unlock it, then run the command again')];
        },
      },
    ],
  },
];
