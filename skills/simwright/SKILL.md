---
name: simwright
description: Drive an iOS simulator or Android emulator from the shell with simwright — read the screen, tap, type, swipe, deep-link, screenshot, record, read logs and crashes, and set permissions, location, dark mode and text size. Use when asked to open, navigate, test, reproduce a bug in, or take screenshots of a mobile app running in a simulator or emulator.
---

# simwright

`simwright` drives a booted iOS simulator or Android emulator. Every command is one short shell call that
prints a few lines of text. Nothing is installed on the device. Its helper starts on first use.

## Before you start

```bash
simwright doctor     # checks Node, Xcode / adb and booted devices; fix what it reports
simwright devices    # booted simulators and adb devices
```

- **One booted device is picked automatically.** With several, pass `-p ios|android` and/or `-d <udid|serial>`.
- **Put the app id in `simwright.config.json`** at the repo root, so `launch`, `logs`, `crashes`, `reset` and
  the rest know which app you mean. simwright uses the nearest one, walking up from the current folder:

  ```json
  { "out": "shots", "wait": 3, "ios": { "app": "com.example.myapp" }, "android": { "app": "com.example.myapp" } }
  ```

  Command-line options beat `SIMWRIGHT_*` environment variables, which beat the config file.

## The loop

1. **Look:** `simwright ls` lists what's on screen, one row per element:

   ```
   @1   Button           16, 285 358x54  General
   @2   Button           16, 339 358x54  Accessibility
   @3   TextField        33, 773 324x38  Search  = Search
   ```

   The columns are: ref, type, x,y, width×height (iOS points / Android dp), label, and `= value` for fields.
   `ls` lists labelled elements and unlabelled buttons. `ls --all` includes everything. `ls --json` prints
   `{screen, elements: [{ref, label, type, x, y, w, h, value}]}` when you need to parse it.
2. **Act, and see the result in the same call** with `--ls`:

   ```bash
   simwright tap @1 --ls            # tap the row from the last ls, then print the settled screen
   simwright tap "General" --ls     # or by label
   simwright fill @3 "wifi" --ls
   ```

3. Repeat. Read the `--ls` output instead of running `ls` again.

`--ls` works on `tap`, `longpress`, `zoom`, `tapxy`, `fill`, `type`, `key`, `hidekb`, `swipe`, `back`, `open`,
`launch`, `bio`, `rotate` and `scrollto`. It waits for the screen to change (up to 1.5 s, 6 s for
`launch`/`open`), then for it to settle, then prints it.

## Choosing a target

- **`@N` refs** come from the most recent `ls`/`--ls` on that device. Use them for unlabelled buttons and
  duplicate labels. A ref whose element moved or vanished is an error, never a wrong tap. If that happens, run `ls` again.
- **Labels** match exactly first, then a unique prefix/substring. An ambiguous label is an error: use more
  of the label, `--exact`, or a ref.
- **`tapxy x y`** is the last resort, for things `ls` doesn't list. Use the units `ls` prints.

## Don't sleep, wait

```bash
simwright wait "Welcome"               # until it appears (10 s default; --wait 30 for longer)
simwright wait "Loading" --gone        # until it disappears
simwright scrollto "Privacy & Security"   # swipe until it's fully on screen (--up to go back)
```

`tap`, `fill` and `back` already wait up to 3 s for their target (`--wait <seconds>` changes it).

**After an action that loads data, wait for what you expect.** `--ls` returns once the screen stops
changing, and a loading skeleton (grey placeholder bars) stops changing too. If `--ls` shows a heading but
none of the content, run `simwright wait "<text you expect>"` rather than acting on the placeholder.

## Several known steps in one call

```bash
simwright run 'tap General; tap About; wait "iOS Version"; ls'
```

`run` stops at the first failing step and names it. `run -` reads the steps from stdin, one per line. Use it
for paths you already know. Explore one step at a time.

## Screenshots

`simwright shot <name>` saves a PNG and prints its path. Don't open the image unless you need to *see* it
(layout, colours, images). `ls` already tells you what's on screen. When you do look, use
`--scale 0.5`: it's a quarter of the image tokens and still readable.

Screenshots and videos go to `-o <dir>` (default `shots`, or `"out"` in the config). On Android emulators
`shot` also captures `FLAG_SECURE` screens; `--plain` uses the ordinary path, which shows them black.

For something too quick to catch with `shot` (a toast, a spinner, a transition):

```bash
simwright burst frames 3                 # a PNG each time the screen changes, for 3 s; duplicates dropped
simwright record start checkout          # a video in the background…
simwright record stop                    # …saved to <out>/checkout.mp4 (Android: at most 3 min)
```

## When something goes wrong

```bash
simwright logs --errors        # the app's errors since your last `logs` (first time: the last minute)
simwright logs --grep checkout # everything it logged that matches; --since 5m for a fixed window
simwright logs --lines 200     # more than the default 80 lines (newest kept); --all keeps iOS framework noise
simwright crashes              # crash reports / ANRs / low-memory kills since your last `crashes` (--since 1h)
simwright app                  # which app is in front, and its pid
```

- **Each `logs` shows only what's new**, so run it right after the step that misbehaved. You don't have to
  remember timestamps.
- **A warning that the app "is no longer running"** means it crashed or was killed. It comes after an
  action or at the next `ls`. Run the `crashes` command it names. On iOS, run it again a minute later for the
  full report.
  - On Android, `LOW_MEMORY` means the system killed the app. That's not a bug in the app; relaunch it.
- The app defaults to `--app`/config, else the one in front. Pass the id when the app is gone: `simwright crashes com.example`.
- Log lines can contain tokens or personal data. Quote only the lines that matter.

## Starting from a known state

```bash
simwright install build/MyApp.app        # or an .apk (keeps its data; --grant: all permissions); prints the app id
simwright uninstall com.example.app
simwright reset com.example.app          # fresh-install state: data and permissions cleared (iOS keeps the keychain)
simwright permission grant location com.example.app   # also revoke / reset
```

Permissions: `camera`, `microphone`, `location`, `location-always`, `photos`, `contacts`, `calendar`,
`notifications`, `motion`, `all`; on Android also any `android.permission.*`.

Conditions:

```bash
simwright location 51.5074 -0.1278   # simulated GPS; `location clear` on iOS (Android emulators keep the last fix)
simwright appearance dark            # or light; no argument prints the current mode
simwright textsize ax2               # xs s m l xl xxl xxxl ax1…ax5; no argument prints the current size
simwright statusbar clean            # 9:41, full battery, for screenshots; `live` to undo
simwright rotate landscape           # left, right, upsidedown, portrait; no argument prints it
simwright network offline            # Android only (airplane mode); online to undo
simwright push com.example.app "Your order shipped"   # iOS only; or a .json file, or '{json}'
```

- **Set back what you change.** Appearance, text size, the status bar, the orientation and the network stay as
  you leave them, for the next person and for other apps.
- **After `rotate`, read the screen again.** `ls`, taps and shots follow the turned screen, so old @refs and
  coordinates are stale. If the app doesn't support the orientation, `rotate` says so and nothing turns.
- **`reset` signs the user out** of most apps: ask before resetting an app someone else signed in to.
- These commands need the app id. They never act on whatever happens to be on screen.

## Every command

| Command | What it does |
|---|---|
| `ls [--all] [--json]` | What's on screen, one row per element |
| `wait <label\|@ref> [--gone]` | Until it appears (or disappears). 10 s, or `--wait` |
| `scrollto <label> [--up]` | Swipe until it's fully on screen |
| `shot <name> [--plain] [--scale f]` | Screenshot to `<out>/<name>.png`; prints the path |
| `burst <dir> <seconds>` | A frame each time the screen changes |
| `record start [name]` · `record stop` | A video of everything in between |
| `tap <label\|@ref> [--exact]` | Tap; prints what it tapped |
| `longpress <label\|@ref\|x y> [ms]` | Hold (default 800 ms) |
| `zoom in\|out [x y] [--scale f]` | Two-finger pinch around a point (default: centre; scale 2.5) |
| `tapxy <x> <y>` | Tap a point, in the units `ls` prints |
| `type <text>` | Into the focused field |
| `key <name> …` | `return` `escape` `delete` `tab` `space`; Android also `back` `home` `KEYCODE_*`; iOS also `selectall` `paste` |
| `fill <label\|@ref> <text> [--exact]` | Focus, clear, type. Empty text just clears |
| `hidekb` | Dismiss the keyboard; exits 2 if it's still up |
| `swipe <x1> <y1> <x2> <y2> [ms]` | A swipe (default 150 ms iOS, 300 ms Android) |
| `back` | Android Back · iOS navigation-bar back button |
| `open <url>` | Deep link |
| `launch [app]` | (Re)start the app |
| `bio match\|nomatch` | Face ID / fingerprint |
| `rotate [orientation]` | Turn the device, or print the current orientation |
| `logs [app] [--errors] [--grep re] [--since 5m] [--lines n] [--all]` | The app's log since the last `logs` |
| `crashes [app] [--since 1h]` | Crashes, ANRs, low-memory kills since the last `crashes` |
| `app [app]` | The app in front, and whether `[app]` is running |
| `install <path> [--grant]` · `uninstall <app>` · `reset <app>` | App state |
| `permission grant\|revoke\|reset <name> [app]` | Runtime permissions |
| `location` · `appearance` · `textsize` · `statusbar` · `network` · `push` | Conditions (above) |
| `run '<cmd>; <cmd> …'` · `run -` | Several steps in one process |
| `devices` · `doctor` | Booted devices · toolchain check |
| `setup` · `teardown` | Start / stop the helper ahead of time (Android: also `adb reverse` for Metro on 8081) |
| `mcp [--config]` | The same commands over MCP, for clients without a shell |
| `skill [--install]` | Print this guide, or install it as a Claude Code skill |

Options: `-p, --platform ios|android` · `-d, --device <udid|serial>` · `-o, --out <dir>` · `--app <id>` ·
`--wait <seconds>` · `-h, --help` · `-v, --version`.
Exit codes: `0` OK, `2` usage or not found (bad arguments, no element, no device), `1` anything else.

## Rules

- **Never type real credentials, OTPs or card numbers.** A person signs in, then you take over.
- **Never `burst` or `record` a sign-in or passcode screen.** The frames capture what's typed.
- Against a live backend every tap is real. Use the smallest amounts, and undo what you create.
- `hidekb` exits 2 if the keyboard is still up (iOS search keyboards have no Done key). Tap the
  screen's close/cancel control instead.
- `tap` prints a **warning** when another element covers the tap point (a toast, a dev-warning banner,
  a floating bar). The tap probably hit that instead: dismiss it, then tap again.
- If `ls` says **only the status bar is readable**, a system prompt (passcode, permission, alert) is on
  top. `shot` to see it. Never enter a passcode unless the user gave it to you for this device.
- Exit code 2 means "not found / usage". Read the message, run `ls`, adjust. Don't retry the same command blindly.
