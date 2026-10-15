# simdrive

Drive an **iOS simulator** or an **Android emulator** from your terminal. You
can read what's on screen, tap, type, swipe, open deep links, trigger Face
ID/fingerprint, and take screenshots, with **no Appium, no WebDriverAgent, and
nothing installed on the device**.

```bash
simdrive setup                    # optional: starts simdrive's helper ahead of time
simdrive open myapp://home        # jump to a screen
simdrive ls                       # what's on screen
simdrive tap "Open menu"          # tap by accessibility label
simdrive shot home__menu          # → shots/home__menu.png
```

---

> How it compares with Appium and the Appium MCP server, in speed, output size
> and reliability: see **[BENCHMARK.md](BENCHMARK.md)**.

## Contents

1. [What it is (and isn't)](#what-it-is-and-isnt)
2. [How it works](#how-it-works)
3. [Install](#install)
4. [First run](#first-run)
5. [Examples](#examples)
6. [Command reference](#command-reference)
7. [Options, environment variables, config file](#options-environment-variables-config-file)
8. [Troubleshooting](#troubleshooting)
9. [Rules](#rules)
10. [Development](#development)

---

## What it is (and isn't)

simdrive is a small command-line tool. Each command does one thing and prints
a few lines of plain text. That makes it easy to use in three ways:

- **by hand:** poke at a screen while you debug it
- **in shell scripts:** repeatable screenshot sweeps or reproduction steps
- **by AI agents:** each step costs one short command and a small text result,
  instead of an image-heavy automation session

It was built for design-QA screenshot sweeps: capturing every screen and state
of an app on several device sizes.

**It is not a test framework.** It has no assertions and no spec files, and it
doesn't run in CI. Checks that should run on every build belong in your app's
own test suite.

---

## How it works

simdrive ships its own small helper for each platform. **Nothing is installed on
the simulator or device**, and there's no Appium, WebDriverAgent, or npm package
anywhere in the loop.

| | iOS simulator | Android emulator / device |
|---|---|---|
| Read screen | `simdrive-sim`, a macOS helper that reads the simulator's accessibility tree through Apple's simulator frameworks (CoreSimulator + AccessibilityPlatformTranslation) | `simdrive-server.jar`, a 7 KB helper pushed to `/data/local/tmp` and run with `app_process`. It keeps one UiAutomation connection open |
| Tap, type, swipe, keys | The same helper, as touch and keyboard events sent through SimulatorKit | The same helper, as input events through UiAutomation |
| Screenshots, `burst` | The simulator display's framebuffer, read in-process | Emulators: the emulator's gRPC API (frames from the host, which also gets past `FLAG_SECURE`). Devices: the helper |
| Deep links, launch, biometrics | `xcrun simctl` | `adb` and the emulator console |

Each helper starts on first use, keeps running in the background, and is
replaced automatically when simdrive is upgraded. `simdrive setup` starts it
ahead of time, and `simdrive teardown` stops it.

**iOS caveat.** The iOS helper uses Apple's private simulator frameworks, the
same ones `idb` uses. They can change between Xcode releases. `simdrive doctor`
checks they're present and shows which input path applies:

- **Xcode 26 and earlier** (CoreSimulator below 1155.4): touches and keys go
  through SimulatorKit's HID client ("indigo"). Tested.
- **Xcode 27** (CoreSimulator 1155.4 and later): the simulator ignores that
  path, so touches and keys go as XPC messages to the simulator's `dtuhidd`
  service ("dtuhid"), the same way idb does it. **Not yet tested against Xcode
  27.** Reading the screen and screenshots don't depend on it.

`SIMDRIVE_IOS_HID=indigo|dtuhid` overrides the choice. It applies when the
helper starts, so run `simdrive teardown` first.

**Android fallback.** If the helper can't start, simdrive falls back to plain
`adb` + `uiautomator dump`, which works everywhere but takes about 2.5 s per
screen read. `SIMDRIVE_ANDROID_HELPER=0` forces that path.

---

## Install

### Requirements

| For | You need |
|---|---|
| Everything | **Node 18+** (`node -v`) |
| iOS | **Xcode** with command-line tools, and at least one simulator runtime. Apple Silicon or Intel Mac |
| Android | **Android SDK platform-tools** with `adb` on your `PATH`, plus an emulator (AVD) or a USB-debugging device |

simdrive has **zero npm dependencies**.

### Install from a checkout

```bash
cd /path/to/simdrive
npm install -g .
simdrive --version
```

### Install from a tarball (to share with someone)

```bash
cd /path/to/simdrive
npm pack                                  # → simdrive-0.1.0.tgz (includes both helpers)
# send the .tgz, then on their machine:
npm install -g simdrive-0.1.0.tgz
```

### Run without installing

```bash
node bin/simdrive.js --help
```

### Uninstall

```bash
npm uninstall -g simdrive
rm -rf ~/.simdrive                        # helper sockets, logs, port registry
```

---

## First run

### 1. Check the toolchain

```bash
simdrive doctor
```

```
✓ node 22.23.2 (needs ≥ 18)
✓ xcrun (iOS)
✓ booted simulators: iPhone 14
✓ CoreSimulator.framework (iOS helper)
✓ SimulatorKit in /Applications/Xcode.app/Contents/Developer (iOS helper)
✓ adb (Android)
✗ adb devices: none  → start an emulator
```

### 2a. iOS: boot a simulator

```bash
xcrun simctl list devices available            # find a udid
xcrun simctl boot <udid> && open -a Simulator
simdrive setup                                 # optional: the first command starts the helper anyway
# simdrive iOS helper ready on 42E41FA7-…
```

The helper exits by itself when its simulator shuts down.

### 2b. Android: boot an emulator

```bash
$ANDROID_HOME/emulator/emulator -list-avds
$ANDROID_HOME/emulator/emulator -avd Pixel_9a &
simdrive setup
# adb emulator-5554 ready · scale 2.625 (dp = px ÷ 2.625) · reverse tcp:8081 · helper on · emulator gRPC frames
```

> Want keyboard-open screenshots? Set `hw.keyboard = no` in
> `~/.android/avd/<name>.avd/config.ini` **before** booting. Otherwise the
> emulator assumes a hardware keyboard and the on-screen one never appears.

### 3. Launch the app and look around

```bash
simdrive launch                  # app id comes from simdrive.config.json
simdrive ls
```

```
@1   Button           16, 285 358x54  General
@2   Button           16, 339 358x54  Accessibility
@3   TextField        33, 773 324x38  Search  = Search
```

Each `ls` row shows a **ref** (`@1`), the element type, its **x,y** position,
its **width×height**, and its **label**, plus `= value` for fields that hold
text. The positions are in the same units that `tapxy` and `swipe` take.
Unlabelled buttons are listed too, as `(no label)`, so they can be tapped by ref.

---

## Examples

### Navigate and screenshot one screen

```bash
simdrive open myapp://messages
sleep 2
simdrive shot messages__default
```

### Tap by label, not by coordinates

```bash
simdrive tap "Open menu"              # exact accessibility label (or identifier on iOS)
# tapped "Open menu" at 30,62
simdrive tap "Messages"               # no exact match → the one label starting with it
# tapped "Messages, 2 unread" at 342,62
simdrive tap "Wi"                     # matches two different labels → refuses
# simdrive: "Wi" is ambiguous — matches 2 labels: "Wi-Fi", "Wi-Fi hotspot"
simdrive tap --exact "Messages"       # exact only, no fuzzy fallback
simdrive tap @7                       # row @7 of the last ls (unlabelled or duplicate labels)
simdrive tapxy 205 874                # when ls doesn't list it at all
```

A ref only works while its element is still where `ls` saw it. If the screen
changed, `tap @7` fails ("no longer on screen — run: simdrive ls") rather than
tapping something else.

`tap` always prints what it aimed at. If another element covers that point (a
toast, a dev-warning banner, a floating bar), it also prints a warning, because
the tap probably landed on the cover instead. A fuzzy (prefix or contains) match is
used only when it points at **one** label. If it could mean two things, simdrive
stops instead of guessing. Use `--exact` in scripts where a near-miss must fail.

Labels survive layout changes; coordinates don't. Use `tapxy` only for elements
that `ls` doesn't list.

### Fill a form and capture its validation errors

```bash
simdrive tap "Edit profile"
simdrive fill "Email" not-an-email
simdrive fill "Name" ""               # empty: clears the field
simdrive hidekb
simdrive shot profile__validation
```

`tap`, `fill` and `back` wait up to 3 s for their target to appear, so a command
right after a navigation doesn't fail just because the screen is still loading.
Change this with `--wait <seconds>`, or `--wait 0` to fail at once.

`fill` finds the field by its label (on iOS also its identifier), or the first
field at or below a matching label, clears it, and types. On
Android it also presses Enter, because React Native fields only blur (and show
validation) on Enter or a focus change. Back just hides the keyboard.

### Wait instead of sleeping

```bash
simdrive wait "Welcome"               # until it's on screen (default up to 10 s; --wait 30)
simdrive wait "Loading" --gone        # until it's gone
```

### Scroll

```bash
simdrive scrollto "Privacy & Security"   # swipe until it's fully on screen; fails at the end of the list
simdrive scrollto "General" --up         # the other way
simdrive swipe 200 700 200 250        # scroll down (finger moves up)
simdrive swipe 200 250 200 700        # scroll up / pull to refresh
simdrive swipe 200 700 200 250 800    # slower: 800 ms
```

### Go back

```bash
simdrive back       # Android: system Back. iOS: taps the navigation bar's back button
```

On iOS, `back` taps the button UIKit tags `BackButton`, or else a button
labelled "Back" in the top-left corner (custom headers, such as React Native's).
If a screen has neither (a modal, a bottom sheet), `back` says so. Tap its close
control instead.

### Biometrics

```bash
simdrive bio match       # iOS: Face ID success · Android: enrolled finger 1
simdrive bio nomatch     # iOS: Face ID failure · Android: unknown finger
```

On Android, enrol a fingerprint once first: Settings → Security → Fingerprint,
using a screen-lock PIN, and touch with `simdrive bio match` when it asks.

### Catch a spinner, toast, or transition (`burst`)

These states last under a second, so start the burst **in the background**, then
trigger the action:

```bash
simdrive burst ./frames 5 &           # 5 s: a frame each time the screen changes
simdrive swipe 200 250 200 700        # pull to refresh
wait
# 61 frames, 23 distinct, in ./frames   ← only distinct frames are saved
```

### Same screen on several devices

Pick the device per command with `-p` and `-d`:

```bash
simdrive devices
# ios      42E41FA7-…  iPhone 14
# ios      F9213EDC-…  iPhone 16 Pro
# android  emulator-5554

for d in 42E41FA7-EA40-45C1-8C6E-13A70BAF1FD6 F9213EDC-180D-412B-B24C-2FD69A37D3AC; do
  simdrive -d $d setup                # each simulator gets its own helper
  simdrive -d $d open myapp://home
done
sleep 2
simdrive -d 42E41FA7-EA40-45C1-8C6E-13A70BAF1FD6 shot -o shots/iphone14     home
simdrive -d F9213EDC-180D-412B-B24C-2FD69A37D3AC shot -o shots/iphone16pro  home
simdrive -p android                                shot -o shots/pixel9a      home
```

Passing **both** `-p` and `-d` (or exporting them) also makes every command
about 0.2 s faster, because simdrive then skips listing devices.

To save typing in a long session, export defaults:

```bash
export SIMDRIVE_PLATFORM=android SIMDRIVE_DEVICE=emulator-5554 SIMDRIVE_OUT=shots/pixel9a
simdrive shot home
```

### A repeatable screenshot sweep (script)

```bash
#!/bin/sh
set -e
simdrive setup
simdrive launch
for route in home search messages profile settings; do
  simdrive open "myapp://$route"
  sleep 2
  simdrive shot "$route"
  simdrive swipe 200 700 200 250
  sleep 1
  simdrive shot "${route}__scrolled"
done
```

The person running it must already be signed in. See [Rules](#rules).

### Android screenshots on secure screens

Apps that set `FLAG_SECURE` (common in banking and payment apps) make normal
Android screenshots come out black. On emulators `simdrive shot` takes the frame
from the emulator itself, which gets past that. Use `--plain` to take a normal
on-device screenshot, for example on a physical device or to check that a
screen *is* secure:

```bash
simdrive -p android shot account__detail          # real content
simdrive -p android shot --plain account__detail  # black if the screen is secure
```

### Using it from an AI agent

simdrive is built for agent loops: every command is one short shell call with a
few lines of text back. Install the agent guide as a Claude Code skill:

```bash
simdrive skill --install       # → ~/.claude/skills/simdrive/SKILL.md  (simdrive skill prints it)
```

What makes agent sessions fast (an agent spends seconds per turn, so turns
matter more than milliseconds):

- **`--ls` on any action** prints the screen once it has settled, so acting and
  looking take one turn instead of two:

  ```bash
  simdrive tap @3 --ls
  simdrive fill "Email" a@b.co --ls
  ```

- **`wait`** instead of guessing `sleep`s.
- **`run`** batches known steps into one call, in one process:

  ```bash
  simdrive run 'tap General; wait About; tap About --ls'
  ```

  It prints each step as `$ <step>`, stops at the first failure, and names it.
  `simdrive run - < steps.txt` reads one step per line (`#` lines are comments).
- **`ls --json`** gives structured output: `{screen, elements: [{ref, label, type, x, y, w, h, value}]}`.
- **`shot --scale 0.5`** is a quarter of the image tokens when the agent needs to
  *see* the screen. Usually `ls` is enough and the PNG is never opened.

---

## Command reference

| Command | What it does |
|---|---|
| `simdrive devices` | Lists booted iOS simulators and adb devices |
| `simdrive doctor` | Checks Node, Xcode tools and the simulator frameworks the iOS helper needs, adb, and booted devices |
| `simdrive setup` | Starts the helper (commands also start it on first use; no-op if it's running). **Android:** also `adb reverse tcp:8081` for Metro, and reports the density scale |
| `simdrive teardown` | Stops the helper. **Android:** also removes `adb reverse` rules. Stop the Android helper before using Appium or `uiautomator`: only one UiAutomation connection can exist |
| `simdrive ls [--all] [--json]` | Visible elements with a label, plus unlabelled buttons, each with an `@ref`. `--all` includes everything. `--json` prints `{screen, elements}`. If the screen is still loading (nothing labelled yet), waits up to `--wait` |
| `simdrive wait <label\|@ref> [--gone]` | Waits until it's on screen (or with `--gone`, until it isn't). Exact label/identifier, else substring. Default up to 10 s, or `--wait`. Exits 2 on timeout |
| `simdrive scrollto <label> [--up]` | Swipes until the element is fully on screen. Fails when a swipe no longer moves the screen, or after 15 swipes |
| `simdrive tap <label\|@ref> [--exact]` | `@ref`: the row from the last `ls`, if it's still there. Otherwise taps the element with that accessibility label. Exact match first. Otherwise a prefix, then contains, match, but only if it names a single label (ambiguous → exit 2). Prints what it tapped. `--exact` turns fuzzy matching off |
| `simdrive tapxy <x> <y>` | Taps a point (iOS points / Android dp, the units `ls` prints) |
| `simdrive type <text>` | Types into the currently focused field |
| `simdrive key <name> …` | Presses keys: `return`, `escape`, `delete`, `tab`, `space`. Android also takes `back`, `home` and any `KEYCODE_*`. iOS also takes `selectall` and `paste` |
| `simdrive fill <label\|@ref> <text> [--exact]` | Focuses the field at `<label>` (same matching as `tap`) or `@ref`, clears it, types `<text>`. Empty text just clears |
| `simdrive hidekb` | Dismisses the keyboard with its own Done/Return key, then checks. Prints `keyboard hidden` / `no keyboard`. **Exits 2 if the keyboard is still up** (e.g. an iOS search keyboard has no such key), never a false success |
| `simdrive swipe <x1> <y1> <x2> <y2> [ms]` | Drags from one point to another. Default 150 ms on iOS, 300 ms on Android |
| `simdrive back` | Android system Back. iOS: the navigation bar's back button |
| `simdrive open <url>` | Opens a deep link (e.g. `myapp://…`) |
| `simdrive launch [app-id]` | Restarts the app. Without an id, uses `--app` or the config file |
| `simdrive bio match\|nomatch` | Simulates Face ID (iOS) or a fingerprint (Android) |
| `simdrive shot <name> [--plain] [--scale f]` | Saves `<out>/<name>.png` and prints its path. `--scale 0.5` saves it at half size |
| `simdrive burst <dir> <seconds>` | Saves a frame each time the screen changes, for `<seconds>`. Only distinct frames are kept |
| `simdrive run '<cmd>; <cmd> …'` | Runs several commands in one process. `run -` reads them from stdin, one per line. Stops at the first failure and names the step |
| `simdrive skill [--install]` | Prints the AI-agent guide. `--install` writes it to `~/.claude/skills/simdrive/SKILL.md` |

**`--ls`** works on `tap`, `tapxy`, `fill`, `type`, `key`, `hidekb`, `swipe`,
`back`, `open`, `launch`, `bio` and `scrollto`. After the action, it waits for
the screen to change (up to 1.5 s, or 6 s for `launch`/`open`), then for it to
stop changing (up to ~2.5 s), then prints it like `ls`. A loading skeleton also
stops changing, so follow up with `wait "<expected text>"` when content loads.

**Exit codes:** `0` means OK, `2` means a usage problem (bad arguments, element
not found, no device, helper can't start), and `1` means anything else failed. A
script can `set -e` and stop at the first missing element.

---

## Options, environment variables, config file

### Options (work with every command)

| Option | Meaning |
|---|---|
| `-p, --platform ios\|android` | Which platform. Default: whichever has a booted device; required when both do |
| `-d, --device <udid\|serial>` | Which device. Default: the only booted one |
| `-o, --out <dir>` | Screenshot folder. Default: `shots` |
| `--wait <seconds>` | How long `tap`, `fill` and `back` keep looking for their target before "not found" (default `3`). An ambiguous match fails immediately; it's never retried |
| `--app <id>` | App id for `launch` and `open` |
| `-h, --help`, `-v, --version` | |

### Environment variables

| Variable | Meaning |
|---|---|
| `SIMDRIVE_PLATFORM`, `SIMDRIVE_DEVICE`, `SIMDRIVE_OUT`, `SIMDRIVE_WAIT` | Defaults for `-p`, `-d`, `-o`, `--wait` |
| `SIMDRIVE_SCALE` | Override Android's px-per-dp (normally read from `wm density`) |
| `SIMDRIVE_ANDROID_HELPER=0` | Don't use the Android helper: plain `adb` + `uiautomator dump` (slower) |
| `SIMDRIVE_EMULATOR_GRPC=0` | Don't take Android emulator frames over gRPC: use the emulator console instead |
| `SIMDRIVE_IOS_HID=indigo\|dtuhid` | Force the iOS input path (default: chosen from the CoreSimulator version). Takes effect when the helper starts |
| `SIMDRIVE_HOME` | Where helper sockets, logs and the port registry live (default `~/.simdrive`) |

### Config file: `simdrive.config.json`

simdrive uses the **nearest** `simdrive.config.json` found by walking up from
the current folder. For example, at the root of your app repo:

```json
{
  "out": "shots",
  "ios": { "app": "com.example.myapp" },
  "android": { "app": "com.example.myapp" }
}
```

Precedence: command-line option, then environment variable, then config file,
then built-in default.

### Files simdrive writes

| Path | What |
|---|---|
| `~/.simdrive/sim-<udid prefix>.sock`, `.log` | The iOS helper's socket and log |
| `~/.simdrive/helpers.json` | Which local port reaches each Android device's helper |
| `~/.simdrive/refs/<device>.json` | What `@1`…`@N` meant in the last `ls` on that device |
| `/data/local/tmp/simdrive-server.jar` (device) | The Android helper |
| `<out>/<name>.png` | Your screenshots |

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| iOS: `SimulatorKit not found …` / `… has no Indigo HID builders` | `simdrive doctor`. Point `xcode-select` at a full Xcode (`sudo xcode-select -s /Applications/Xcode.app`) |
| iOS: `input unavailable (dtuhid): dtuhidd did not answer` | The simulator is still booting, or its input daemon is restarting. Wait a few seconds and retry |
| iOS: `input unavailable (dtuhid): the simulator has no …hid.digitizer` | That runtime predates Xcode 27's input service: `simdrive teardown`, then unset `SIMDRIVE_IOS_HID` |
| iOS: an element you can see is missing from `ls` | Some containers hide their children from the accessibility tree. simdrive probes empty containers to find them, but `tapxy` is the fallback |
| iOS: `ls` lists Safari's toolbar but not the web page | Web content (Safari, in-app browsers, web views) isn't read yet. Use `shot` and `tapxy` |
| `only the status bar is readable — a system prompt … may be covering the app` | A passcode, permission or alert prompt drawn by iOS. `simdrive shot` to see it |
| `both iOS and Android devices are up — pass -p ios\|android` | Add `-p`, or `export SIMDRIVE_PLATFORM=…` |
| `2 ios devices — pass -d one of: …` | Add `-d <udid>` (listed in the message) |
| `not found: <label>` | Run `simdrive ls` and copy the label exactly. If the screen is slow to load, raise `--wait` |
| `keyboard is still up — it has no Done/Return key` (iOS) | Search keyboards only have a Search key. Tap outside the field, or the screen's Cancel/close control |
| Android `ls` is empty or fails right after boot | The emulator isn't fully up. Wait until `adb shell getprop sys.boot_completed` prints `1`, then a few more seconds |
| Android `ls` fails after an Appium session was used | Appium's helper still holds UiAutomation: `adb shell am force-stop io.appium.uiautomator2.server` |
| Appium / `uiautomator` fail after simdrive was used | simdrive's helper holds UiAutomation: `simdrive -p android teardown` |
| `Android helper did not start — falling back to uiautomator dump` | Something else holds UiAutomation (see above). simdrive keeps working, just slower |
| Android `type` fails with `Can't find service: input` | Still booting. Wait and retry |
| Android keyboard never appears | `hw.keyboard = no` in the AVD's `config.ini`, then cold-boot the emulator |
| Android screenshot is black | That screen is `FLAG_SECURE`. Use `shot` without `--plain` on an emulator. System PIN and biometric sheets stay black in every mode |
| `launch` says `no launchable activity` | The app isn't installed on that device, or the id is wrong. Check with `adb shell pm list packages \| grep <your-app>` or `xcrun simctl listapps booted` |
| App sits on the splash screen (Android) | Metro isn't reachable. Run `simdrive setup` (adds `adb reverse tcp:8081`), make sure Metro is running, then `simdrive launch` |
| `"<label>" is ambiguous — matches N labels` | Use more of the label (copy it from `ls`), or `--exact` |
| `type` fails on non-ASCII text (Android) | The virtual keyboard map has no such characters. Type them on the device. On iOS, simdrive pastes text it can't type |

---

## Rules

- **Never script a sign-in with real credentials**, whether from a shell script
  or an AI agent. A person signs in and enters OTPs. Then let simdrive take over.
- **Never `burst` a sign-in or passcode screen.** The frames capture what's typed.
  Delete any frames that slip in.
- **Against a live backend, every action is real.** Use the smallest amounts
  (£1 / €1), then withdraw, reject, or delete what you created.
- Don't commit screenshots of real customer data.

---

## Development

```
simdrive/
├── bin/simdrive.js           CLI: argument parsing, device selection, doctor, burst
├── lib/ios.js                iOS helper client + simctl
├── lib/android.js            Android helper client, adb fallback, density scaling
├── lib/helper.js             JSON-lines socket protocol both helpers speak
├── lib/emulator.js           Android emulator gRPC (frames), no dependencies
├── lib/png.js                PNG encoder for raw emulator frames
├── lib/screen.js             ls rows, @refs, wait, scrollto, settle (platform-neutral)
├── lib/util.js               process helpers, config lookup, label matching, run-script parsing
├── lib/assets/               built helpers (simdrive-sim, simdrive-server.jar)
├── native/ios/               simdrive-sim source (Objective-C) + build.sh
├── native/android/           simdrive-server source (Java) + build.sh
├── skills/simdrive/SKILL.md  the AI-agent guide (simdrive skill)
└── test/                     node:test unit tests (no device needed)
```

```bash
npm test                          # unit tests
native/ios/build.sh               # rebuild the iOS helper (needs Xcode)
native/android/build.sh           # rebuild the Android helper (needs the Android SDK + a JDK)
node bin/simdrive.js --help       # run from source
npm pack                          # build a distributable tarball
```

Notes for contributors:

- **Zero dependencies, on purpose.** Use only Node built-ins (`net`, `http2`,
  `zlib`, `child_process`, `node:test`). The helpers use only what ships with
  macOS/Xcode and Android.
- **Helpers are versioned by content hash.** After rebuilding one, the next
  command replaces the copy that's running. Commit the rebuilt file in
  `lib/assets/`.
- **New commands** need a method on both `Ios` and `Android` (or, if they only
  read the screen, code in `lib/screen.js` on top of `snapshot()`), plus a line
  in the `switch` in `bin/simdrive.js`, plus a row in this README and, if agents
  should use it, a line in `skills/simdrive/SKILL.md`. If one platform
  can't support a command, throw a `UsageError` that explains why (see iOS
  `back`).
- **New Xcode:** check `ls`, `tap`, `type`, `swipe` and `shot` on a simulator.
  The iOS helper depends on private framework APIs that Apple can change.
- The package is `"private": true` so nobody publishes it to npm by accident.
  Remove that once a registry has been chosen.
