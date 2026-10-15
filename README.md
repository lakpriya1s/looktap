# simdrive

Drive an **iOS simulator** or an **Android emulator** from your terminal. You
can read what's on screen, tap, type, swipe, open deep links, trigger Face
ID/fingerprint, and take screenshots, with **no Appium** involved.

```bash
simdrive setup                    # once per simulator boot
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

| | iOS simulator | Android emulator / device |
|---|---|---|
| Read screen, tap, type, swipe | [WebDriverAgent](https://github.com/appium/WebDriverAgent) (WDA), a small helper app on the simulator that accepts HTTP commands | `adb` + `uiautomator` (built into Android) |
| Screenshots, deep links, launch, biometrics | `xcrun simctl` (built into Xcode) | `adb` and the emulator console |
| One-time setup | `simdrive setup` downloads a prebuilt WDA, installs it with `simctl`, launches it on a free port, and remembers the port | `simdrive setup` forwards Metro (`adb reverse tcp:8081`) |

WDA's source sits under the Appium GitHub organisation, but it's a standalone
app. simdrive uses the prebuilt release directly, with **no Appium server,
drivers, or npm packages**.

The WDA version is **pinned** (15.1.3 by default, known to work with current
simulators). It is downloaded once per Mac into `~/.simdrive/wda/`.

---

## Install

### Requirements

| For | You need |
|---|---|
| Everything | **Node 18+** (`node -v`) |
| iOS | **Xcode** with command-line tools, and at least one simulator runtime. Apple Silicon or Intel Mac |
| Android | **Android SDK platform-tools** with `adb` on your `PATH`, plus an emulator (AVD) or a USB-debugging device |
| iOS first-time setup | `curl` and `unzip` (both ship with macOS) |

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
npm pack                                  # → simdrive-0.1.0.tgz (≈12 kB)
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
rm -rf ~/.simdrive                        # cached WDA + port registry
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
✓ adb (Android)
✗ adb devices: none  → start an emulator
✓ curl + unzip (WebDriverAgent download)
```

### 2a. iOS: boot a simulator and start WDA

```bash
xcrun simctl list devices available            # find a udid
xcrun simctl boot <udid> && open -a Simulator
simdrive setup
# downloading WebDriverAgent 15.1.3 (arm64)…      ← first time only
# WebDriverAgent 15.1.3 ready on http://127.0.0.1:8100
```

Run `simdrive setup` again **after every simulator boot**, because WDA doesn't
survive a shutdown. Running it while WDA is already up does nothing, so it's
safe to call at the top of any script.

### 2b. Android: boot an emulator

```bash
$ANDROID_HOME/emulator/emulator -list-avds
$ANDROID_HOME/emulator/emulator -avd Pixel_9a &
simdrive setup
# adb emulator-5554 ready · scale 2.625 (dp = px ÷ 2.625) · reverse tcp:8081
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
Button           16, 284 358x55  General
Button           16, 339 358x55  Accessibility
StaticText       34, 391 88x29   About
```

Each `ls` row shows the element type, its **x,y** position, its **width×height**,
and its **label**. The positions are in the same units that `tapxy` and `swipe`
take.

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
simdrive tap "Open menu"              # exact accessibility label
# tapped "Open menu"
simdrive tap "Messages"               # no exact match → the one label starting with it
# tapped "Messages, 2 unread" at 342,62
simdrive tap "Wi"                     # matches two different labels → refuses
# simdrive: "Wi" is ambiguous — matches 2 labels: "Wi-Fi", "Wi-Fi hotspot"
simdrive tap --exact "Messages"       # exact only, no fuzzy fallback
simdrive tapxy 205 874                # when an element has no label
```

`tap` always prints what it actually hit. A fuzzy (prefix or contains) match is
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

`fill` finds the field by its label or placeholder, clears it, and types. On
Android it also presses Enter, because React Native fields only blur (and show
validation) on Enter or a focus change. Back just hides the keyboard.

### Scroll

```bash
simdrive swipe 200 700 200 250        # scroll down (finger moves up)
simdrive swipe 200 250 200 700        # scroll up / pull to refresh
simdrive swipe 200 700 200 250 800    # slower: 800 ms
```

### Go back

```bash
simdrive back       # Android: system Back. iOS: taps the navigation bar's back button
```

On iOS, if a screen has no navigation bar (a modal, a bottom sheet), `back`
says so. Tap its close control instead.

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
simdrive burst ./frames 5 &           # 5 s of frames, 0.4 s apart
simdrive swipe 200 250 200 700        # pull to refresh
wait
# 12 frames, 3 distinct, in ./frames   ← duplicates already deleted
```

### Same screen on several devices

Pick the device per command with `-p` and `-d`:

```bash
simdrive devices
# ios      42E41FA7-…  iPhone 14
# ios      F9213EDC-…  iPhone 16 Pro
# android  emulator-5554

for d in 42E41FA7-EA40-45C1-8C6E-13A70BAF1FD6 F9213EDC-180D-412B-B24C-2FD69A37D3AC; do
  simdrive -d $d setup                # each simulator gets its own WDA port
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
Android screenshots come out black. On emulators `simdrive shot` takes the frame from the emulator itself,
which gets past that. Use `--plain` to force a normal `screencap`, for example
on a physical device or to check that a screen *is* secure:

```bash
simdrive -p android shot account__detail          # real content
simdrive -p android shot --plain account__detail  # black if the screen is secure
```

### Using it from an AI agent

Each command is cheap, so an agent can work in a short loop:

1. `simdrive ls` to see what's on screen.
2. `simdrive tap "<label>"` (or `fill` / `swipe`) to act.
3. `simdrive ls` again to check the result.
4. `simdrive shot <name>` to keep evidence. The agent opens the PNG only when it
   needs to *see* the screen.

---

## Command reference

| Command | What it does |
|---|---|
| `simdrive devices` | Lists booted iOS simulators and adb devices |
| `simdrive doctor` | Checks Node, Xcode tools, adb, booted devices, and WDA state |
| `simdrive setup` | **iOS:** installs and starts WDA, records its port (no-op if it's already running). **Android:** `adb reverse tcp:8081` for Metro and reports the density scale |
| `simdrive teardown` | **iOS:** stops WDA. **Android:** removes `adb reverse` rules |
| `simdrive ls [--all]` | Visible elements that have a label. `--all` also includes hidden and unlabelled ones |
| `simdrive tap <label> [--exact]` | Taps the element with that accessibility label. Exact match first. Otherwise a prefix, then contains, match, but only if it names a single label (ambiguous → exit 2). Prints what it tapped. `--exact` turns fuzzy matching off |
| `simdrive tapxy <x> <y>` | Taps a point (iOS points / Android dp, the units `ls` prints) |
| `simdrive type <text>` | Types into the currently focused field |
| `simdrive fill <label> <text> [--exact]` | Focuses the field at `<label>` (same matching as `tap`), clears it, types `<text>`. Empty text just clears |
| `simdrive hidekb` | Dismisses the keyboard with its own Done/Return key, then checks. Prints `keyboard hidden` / `no keyboard`. **Exits 2 if the keyboard is still up** (e.g. an iOS search keyboard has no such key), never a false success |
| `simdrive swipe <x1> <y1> <x2> <y2> [ms]` | Drags from one point to another. Default 150 ms on iOS, 300 ms on Android |
| `simdrive back` | Android system Back. iOS: the navigation bar's back button |
| `simdrive open <url>` | Opens a deep link (e.g. `myapp://…`) |
| `simdrive launch [app-id]` | Restarts the app. Without an id, uses `--app` or the config file |
| `simdrive bio match\|nomatch` | Simulates Face ID (iOS) or a fingerprint (Android) |
| `simdrive shot <name> [--plain]` | Saves `<out>/<name>.png` and prints its path |
| `simdrive burst <dir> <seconds>` | Takes frames every 0.4 s, then deletes consecutive duplicates |

**Exit codes:** `0` means OK, `2` means a usage problem (bad arguments, element
not found, no device, WDA not started), and `1` means anything else failed. A
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
| `SIMDRIVE_WDA_URL` | Use a WDA you started yourself, e.g. `http://127.0.0.1:8100` |
| `SIMDRIVE_WDA_VERSION` | WDA release to download (default `15.1.3`) |
| `SIMDRIVE_HOME` | Where WDA and the port registry live (default `~/.simdrive`) |

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
| `~/.simdrive/wda/<version>/<arch>/WebDriverAgentRunner-Runner.app` | Cached WDA download |
| `~/.simdrive/wda-ports.json` | Which simulator's WDA is on which port |
| `<out>/<name>.png` | Your screenshots |

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `WebDriverAgent is not running on <udid> — run: simdrive setup` | The simulator was rebooted, or setup never ran. Run `simdrive setup` |
| `both iOS and Android devices are up — pass -p ios\|android` | Add `-p`, or `export SIMDRIVE_PLATFORM=…` |
| `2 ios devices — pass -d one of: …` | Add `-d <udid>` (listed in the message) |
| `not found: <label>` | Run `simdrive ls` and copy the label exactly. If the screen is slow to load, raise `--wait` |
| `keyboard is still up — it has no Done/Return key` (iOS) | Search keyboards only have a Search key. Tap outside the field, or the screen's Cancel/close control |
| Android `ls` is empty or fails right after boot | The emulator isn't fully up. Wait until `adb shell getprop sys.boot_completed` prints `1`, then a few more seconds |
| Android `ls` fails after an Appium session was used | Appium's helper still holds UiAutomation: `adb shell am force-stop io.appium.uiautomator2.server` |
| Android `type` fails with `Can't find service: input` | Still booting. Wait and retry |
| Android keyboard never appears | `hw.keyboard = no` in the AVD's `config.ini`, then cold-boot the emulator |
| Android screenshot is black | That screen is `FLAG_SECURE`. Use `shot` without `--plain` on an emulator. System PIN and biometric sheets stay black in every mode |
| `launch` says `no launchable activity` | The app isn't installed on that device, or the id is wrong. Check with `adb shell pm list packages \| grep <your-app>` or `xcrun simctl listapps booted` |
| App sits on the splash screen (Android) | Metro isn't reachable. Run `simdrive setup` (adds `adb reverse tcp:8081`), make sure Metro is running, then `simdrive launch` |
| `"<label>" is ambiguous — matches N labels` | Use more of the label (copy it from `ls`), or `--exact` |
| `type` loses special characters on Android | `adb input text` handles ASCII only. Type non-ASCII text on the device |

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
├── bin/simdrive.js      CLI: argument parsing, device selection, doctor, burst
├── lib/ios.js           WebDriverAgent client + simctl; WDA download/launch
├── lib/android.js       adb + uiautomator; density scaling; emulator screenshots
├── lib/util.js          process helpers, config lookup, free-port search
└── test/                node:test unit tests (no device needed)
```

```bash
npm test                          # unit tests
node bin/simdrive.js --help       # run from source
npm pack                          # build a distributable tarball
```

Notes for contributors:

- **Zero dependencies, on purpose.** Use only Node built-ins (`fetch`,
  `child_process`, `node:test`).
- **New commands** need a method on both `Ios` and `Android`, plus a line in the
  `switch` in `bin/simdrive.js`, plus a row in this README. If one platform
  can't support a command, throw a `UsageError` that explains why (see iOS
  `back`).
- **Upgrading WDA:** bump `WDA_VERSION` in `lib/ios.js` only after checking
  `simdrive setup` + `ls` + `tap` on a simulator. Prefer releases that are a few
  weeks old.
- The package is `"private": true` so nobody publishes it to npm by accident.
  Remove that once a registry has been chosen.
