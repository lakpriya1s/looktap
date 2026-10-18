<div align="center">

<img src="https://raw.githubusercontent.com/lakpriya1s/looktap/main/assets/looktap-logo.svg" alt="looktap — hands on the phone, for AI agents" width="560">

**Let AI agents drive iPhone and Android devices from the shell**<br>
Read the screen, tap, type, swipe, screenshot, and read logs and crashes. No server to start and no dependencies.

[![npm](https://img.shields.io/npm/v/@looktap/cli.svg?color=cb3837&logo=npm)](https://www.npmjs.com/package/@looktap/cli)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](https://github.com/lakpriya1s/looktap/blob/main/LICENSE)
[![Node ≥ 18](https://img.shields.io/badge/node-%E2%89%A518-339933.svg?logo=node.js&logoColor=white)](#requirements)
[![iOS simulator](https://img.shields.io/badge/iOS-simulator%20%7C%20device-000000.svg?logo=apple&logoColor=white)](#how-it-works)
[![Android](https://img.shields.io/badge/Android-emulator%20%7C%20device-3DDC84.svg?logo=android&logoColor=white)](#how-it-works)
[![Dependencies: 0](https://img.shields.io/badge/dependencies-0-16a34a.svg)](https://github.com/lakpriya1s/looktap/blob/main/package.json)

[Website](https://lakpriya1s.github.io/looktap/) · [Quick start](#quick-start) · [Commands](#commands) · [For AI agents](#for-ai-agents) · [Benchmark](BENCHMARK.md) · [Troubleshooting](#troubleshooting)

</div>

---

`looktap` is a small command-line tool for driving a mobile app on an iPhone or Android device, real or simulated.
Each command does one thing and prints a few lines of plain text:

<p align="center">
  <img src="https://raw.githubusercontent.com/lakpriya1s/looktap/main/assets/looktap-demo.gif" alt="An agent drives a demo app with looktap: it reads the sign-in screen as a list of labelled elements, taps, fills in an email address, and scrolls and zooms a map, while the phone beside the terminal reacts to each command" width="760">
</p>

That makes it a good fit for an AI coding agent (Claude Code, Cursor, Codex, opencode, …) that needs to **see and
use the app it's building**:
- **Small output.** A screen read is about 1 KB of text, where other agent tools return 4–125 KB. A screenshot is a
  file path, where most MCP servers put 40–270 KB of image into the context.
- **One call per step.** Add `--ls` to an action and its result comes back in the same call.
- **Fast.** Screen reads take about 0.1 s and taps 0.1–0.2 s on both platforms, and the first command comes back in
  under a second, with no session to set up. Against eight other agent tools on the same devices, it had the lowest
  agent time on both iPhone and Android ([How it compares](#how-it-compares)).

It's just as handy by hand, or in a shell script for screenshot sweeps and bug repros. And the steps that worked
can be saved as **flow files that run as tests in CI**: `expect` checks the screen, and `looktap test` runs the flows
and reports each one ([Test flows in CI](#test-flows-in-ci)). On Android, `looktap codegen` writes a flow while you
use the phone ([Record a flow](#record-a-flow-codegen)).

---

## Contents

- [What you get](#what-you-get): everything looktap does today
- [How it compares](#how-it-compares): the measured comparison with every other agent mobile tool
- [Quick start](#quick-start): install, boot a device, first commands
- [🤖 Kickstart with your AI agent](#-kickstart-with-your-ai-agent): one prompt and your agent takes it from there
- [Requirements](#requirements)
- [How it works](#how-it-works)
- [Examples](#examples): tap by label, forms, waiting, scrolling, debugging, bursts and video, several devices,
  [tests in CI](#test-flows-in-ci)
- [For AI agents](#for-ai-agents)
- [Commands](#commands) · [Platform support](#platform-support) · [Options & config](#options-environment-variables-config-file)
- [Troubleshooting](#troubleshooting) · [FAQ](#faq) · [Roadmap](#roadmap)
- [Safety rules](#safety-rules) · [Contributing](#contributing) · [License](#license)

## What you get

| | What you get |
|---|---|
| 👀 | **Read the screen as text.** `ls` lists what's visible, one row per element: `@ref  type  x,y  w×h  label  = value`. It reads native screens, React Native screens and web content (Safari, in-app browsers, web views) |
| 👆 | **Tap by label.** Exact match first, then a prefix or substring that names exactly one label. An ambiguous match is an error, never a guess. Also by `@ref` from the last `ls`, or by `x y` coordinates |
| ⌨️ | **Type and fill.** `type` into the focused field, `fill` to clear a field and type, `key return\|escape\|delete\|tab\|selectall\|paste\|…` (the same names on both platforms), and `hidekb`, which never reports success while the keyboard is still up |
| 🧭 | **Navigate and gesture.** `swipe`, `scrollto <label>`, `back`, `home` (the Home button, the app keeps running), `open <deep link>`, `launch <app>`, `stop <app>`, `longpress`, and two-finger `zoom in\|out` |
| ⏱️ | **Wait instead of sleep.** `wait "Welcome"`, `wait "Loading" --gone`. Actions already wait up to 3 s for their target |
| 🧪 | **Tests in CI.** `expect "Welcome"`, `expect "Email" = sam@example.com`, `expect "Error" --gone` check the screen. `test flows/` runs flow files as tests, one line per flow, and a failure leaves its screen, screenshot, error logs and crashes behind. `--junit` for CI reports. On Android, `codegen` records a flow while you use the phone |
| 📸 | **Screenshots.** `shot` saves a PNG and prints its path, with `--scale 0.5` for fewer image tokens. On Android emulators it also captures `FLAG_SECURE` screens |
| 🎞️ | **Burst capture and video.** `burst` saves a frame each time the screen changes, to catch spinners, toasts and transitions. `record start` … `record stop` saves an MP4 of everything in between |
| 🪵 | **Logs.** `logs` shows the app's log since your last look. `--errors` and `--grep` narrow it, and on iOS Apple-framework chatter is filtered out |
| 💥 | **Crashes.** `crashes` reads iOS crash reports (exception, reason, top frames) and Android crashes, ANRs and **low-memory kills**, so "the app vanished" always comes with a reason |
| 🫆 | **Biometrics.** `bio match\|nomatch` simulates Face ID or a fingerprint |
| 🌍 | **Simulated conditions.** `location <lat> <lon>`, `appearance dark`, `textsize xxl` (Dynamic Type / font scale), `statusbar clean` (9:41 for screenshots), `rotate landscape` (`ls`, taps and screenshots follow the turned screen), Android `network offline`, and iOS `push` notifications |
| 🧹 | **App state for repros.** `install` a build, `reset` an app to a fresh install, `uninstall`, and `permission grant\|revoke\|reset camera\|location\|photos\|…`, with the same names on both platforms |
| 📱 | **Devices on demand.** `boot "iPhone 16 Pro"` or `boot Pixel_9a` starts a simulator or emulator by name and waits until it's ready, with a window or `--headless`; `shutdown` stops it. `devices` tells real phones from simulators and emulators (model, OS, USB or Wi-Fi), and says what to do for a phone that isn't ready yet |
| 🤖 | **Built for agents.** `--ls` on any action, `run` to batch steps, `--json`, `capabilities` to check what the device in use can and can't do, and a [Claude Code skill](#for-ai-agents) you install with one command |
| 🧩 | **Nothing to install on simulators, emulators or Android phones**, no server to run, no npm dependencies. The helpers start on first use. A real iPhone gets a small test runner, built for you |
| ⚠️ | **Honest failures.** A tap that's covered by a toast prints a warning, a stale `@ref` is an error rather than a wrong tap, a system prompt over the app is reported as one, a locked device is reported as locked (never typed into), and **an app that dies is named the moment looktap notices** |

## How it compares

Every agent mobile tool we could run on one Mac was given the same 12 steps in the Settings app, 10 runs each, on an
iPhone simulator and an Android emulator:
looktap (CLI and MCP), mobile-mcp, Maestro MCP, Appium MCP, raw Appium, ios-simulator-mcp, MobileBuildMCP, raw
idb and raw adb. A neutral checker decided whether each step worked. These are the totals over the steps every tool
can do:

| | **looktap CLI** | **looktap MCP** | Next best for an agent | Others |
|---|---|---|---|---|
| Agent time (iOS · Android)¹ | **21 s · 28 s** | 25 s · 37 s | 30 s Maestro MCP · 49 s Appium MCP | 36–63 s |
| Tool calls (iOS · Android) | **8** · 12 | **8** · 12 | 9 · **11** Maestro MCP | 10–27 |
| Text returned (iOS · Android) | **747 B · 1.2 KB** | 3.2 KB · 7.9 KB | 17 KB · 14 KB Maestro MCP | 17–154 KB |
| Steps passed | **100%** of what it can do | **100%** | | 87–100% |
| Setup before the first command | **under 1 s** | **under 1 s** | | 0.2–29 s |

¹ The device's reaction time plus 2 s per tool call for the model's round trip.

**On real phones** (iPhone 14 Pro and Samsung Galaxy A06 over USB, looktap 0.4.0, all 12 steps), the looktap CLI again
had the lowest agent time (87 s and 38 s, against 104–114 s and 45–89 s) and returned the least text (1.7 KB and
1.0 KB, against 8.9–191 KB). Four of the iOS tools can't drive a real iPhone at all: ios-simulator-mcp, MobileBuildMCP,
idb and Maestro.

Where looktap loses:
- On raw device time, others are faster in total: ios-simulator-mcp on the iOS simulator (4.5 s against 5.2 s, with
  20 calls to looktap's 8), mobile-mcp and raw Appium on the real iPhone (60 s and 62 s against 63 s), and raw Appium
  on the Samsung (11 s against 12 s).
- The looktap MCP waits for the screen to settle after every action, which makes it slower per action than the CLI.
  On the real iPhone that takes 6–11 s a tap and puts it last for agent time.
- In the simulator and emulator runs, looktap 0.2.1 couldn't stop an app or press Home on iOS; 0.3.0 added `stop` and
  `home`.

Method, every device's tables and what else they show are in **[BENCHMARK.md](BENCHMARK.md)**.

**Where Appium is still the better choice:** it plugs into existing WebDriver test suites and CI grids, and supports
many more platforms. looktap's tests are flow files of plain commands: good for smoke tests and agent-written flows,
not a replacement for a large suite in code.

## Quick start

```bash
# 1. install (Node 18+; zero dependencies)
npm install -g @looktap/cli

# 2. check the toolchain
looktap doctor

# 3. boot a device: an iOS simulator or an Android emulator, by name
looktap devices --all                         # what's running, and what you can boot
looktap boot "iPhone 16 Pro"                  # or an AVD: looktap boot Pixel_9a

# 4. drive it
looktap launch com.apple.Preferences --ls     # (Android: com.android.settings)
looktap tap "General" --ls
looktap shot general
```

Or try it without installing anything: `npx @looktap/cli doctor` (any command works the same way).

To teach Claude Code how to use looktap, install the plugin. In Claude Code:

```
/plugin install looktap --marketplace lakpriya1s/looktap
```

It adds the looktap skill. Then run `/looktap:setup`: it installs the CLI, checks your
toolchain and gets a device ready. Or copy the skill in by hand:

```bash
looktap skill --install      # → ~/.claude/skills/looktap/SKILL.md
```

<details>
<summary><strong>Other ways to install</strong></summary>

The latest from GitHub, ahead of the npm release:

```bash
npm install -g github:lakpriya1s/looktap
```

From a checkout:

```bash
git clone https://github.com/lakpriya1s/looktap.git
cd looktap && npm install -g .
```

As a tarball you can hand to someone (it includes both prebuilt helpers):

```bash
npm pack                                  # → looktap-cli-<version>.tgz
npm install -g looktap-cli-<version>.tgz  # on their machine
```

Without installing: `node bin/looktap.js --help`.

Uninstall: `npm uninstall -g @looktap/cli && rm -rf ~/.looktap`.
</details>

## 🤖 Kickstart with your AI agent

Paste this into your AI coding agent (Claude Code, Cursor, Codex, opencode, …) and let it set things up and
start using the app with you:

```text
Install looktap (https://github.com/lakpriya1s/looktap) so you can drive
my app in the iOS simulator / Android emulator:

1. Run `npm install -g @looktap/cli`, then `looktap doctor`,
   and fix anything it reports. If no device is up, boot one: `looktap devices --all` lists them, `looktap boot "<name>"` starts one.
2. Run `looktap skill --install` and read the skill it installs.
3. Find my app's bundle id / package name in this repo and write a
   looktap.config.json with it at the repo root.
4. Launch the app with `looktap launch --ls` and tell me what screen it's on.

Rules: never type real credentials, OTPs or card numbers. When the app needs a
sign-in, stop and let me do it, then continue from there.
```

## Requirements

| For | You need |
|---|---|
| Everything | **Node 18+** (`node -v`) |
| iOS | A Mac with **Xcode** (command-line tools selected) and at least one simulator runtime. Apple Silicon or Intel. `looktap boot` starts a simulator |
| Android | **Android SDK platform-tools** (`adb` on your `PATH`), and an emulator (AVD) or a USB-debugging device. `looktap boot` starts an emulator (it needs the SDK's Emulator package) |
| A real iPhone or iPad | The iOS row, plus an **Apple ID signed in to Xcode** (a free one works) and the device paired with the Mac, with Developer Mode on. See [Using a real iPhone](#using-a-real-iphone) |

Tested with Xcode 26 / iOS 26 (iPhone 14 simulator) and Android 16 / API 36 (Pixel 9a emulator).

## How it works

looktap ships its own small helper for each platform. **Nothing is installed on simulators, emulators or Android
devices.** A real iPhone or iPad is the exception: it gets a small test runner ([Using a real iPhone](#using-a-real-iphone)).

| | iOS simulator | Android emulator / device |
|---|---|---|
| Read the screen | `looktap-sim`, a macOS helper that reads the simulator's accessibility tree through Apple's simulator frameworks (CoreSimulator, AccessibilityPlatformTranslation). Web content is found by probing the screen | `looktap-server.jar`, a 10 KB helper pushed to `/data/local/tmp` and run with `app_process`. It keeps one UiAutomation connection open |
| Tap, type, swipe, keys | The same helper, as touch and keyboard events through SimulatorKit | The same helper, as input events through UiAutomation |
| Screenshots, `burst` | The simulator display's framebuffer, read in-process | Emulators: the emulator's gRPC API, which also gets past `FLAG_SECURE`. Devices: the helper |
| Video (`record`) | `simctl io recordVideo` | `screenrecord` on the device |
| Orientation (`rotate`) | The orientation event Simulator.app sends to the guest. Coordinates and frames are converted, so everything looktap prints and takes is as the user sees the screen | `settings` (user rotation, auto-rotate off). The helper reports the turned display size |
| Logs, crashes | `log show` inside the simulator, and its `.ips` crash reports | `logcat` (by app uid), the crash buffer, and `dumpsys activity exit-info` |
| Home button, `stop` | The helper sends the hardware Home button; `simctl terminate` | `KEYCODE_HOME`; `am force-stop` |
| Deep links, launch, biometrics | `xcrun simctl` | `adb` and the emulator console |

Each helper starts on first use, keeps running in the background, and is replaced automatically when looktap is
upgraded. `looktap setup` starts it ahead of time, and `looktap teardown` stops it. The CLI talks to it over a
local socket, using JSON lines.

<details>
<summary><strong>iOS: private frameworks and Xcode versions</strong></summary>

The iOS helper uses Apple's private simulator frameworks, the same ones `idb` uses. They can change between Xcode
releases. `looktap doctor` checks they're present and shows which input path applies:

- **Xcode 26 and earlier** (CoreSimulator below 1155.4): touches, keys and the Home button go through SimulatorKit's HID client
  ("indigo"). Tested.
- **Xcode 27** (CoreSimulator 1155.4 and later): touches, keys and the Home button go as XPC messages to the simulator's
  `dtuhidd` service ("dtuhid"), the same way idb does it. **Implemented, not yet tested against Xcode 27.**
  Reading the screen and screenshots don't depend on it.

`LOOKTAP_IOS_HID=indigo|dtuhid` overrides the choice. It applies when the helper starts, so run
`looktap teardown` first.
</details>

### Using a real iPhone

A simulator can be driven from the Mac with nothing installed in it; a real iPhone or iPad can't. So the first
command aimed at one builds a small XCUITest runner (`native/ios-device`), signs it with your Apple ID, and installs
it. It reads the screen and taps, types and swipes through XCUITest, and looktap reaches it through usbmuxd, over
USB or Wi-Fi. Every looktap user signs the runner with their own Apple ID. A free one is enough; the paid
Developer Program isn't needed.

**Once per Mac and device:**

1. In Xcode → Settings → Accounts, sign in with your Apple ID. That gives you a "Personal Team".
2. Pair the device with the Mac (connect it with a cable once and tap Trust; Wi-Fi works after that), and turn on
   **Developer Mode** on it: Settings → Privacy & Security → Developer Mode.
3. Unlock the device and run any command against it, for example `looktap -d <hardware UDID> ls`
   (`looktap devices` lists the UDID, and says what to do if the device isn't ready yet: Trust, Developer Mode). The first run builds the runner, which takes about a minute.
4. With a free Apple ID, the device asks you to trust the developer the first time: Settings → General →
   VPN & Device Management → your Apple ID → Trust. Then run the command again.

If Xcode is signed in to more than one team, choose the one to sign with:
`LOOKTAP_TEAM=<team id>`, or `{"ios": {"team": "<team id>"}}` in `looktap.config.json`. The error message
lists your teams and their ids.

**Picking the device:** `-d <hardware UDID>` always picks it. Without `-d`, a paired device is used only when no
simulator or emulator is running, so nothing changes for simulator workflows.

**Signing expiry:** a runner signed with a free Apple ID stops launching after **7 days**, and one signed with a
paid team after a year. looktap reads the expiry date and builds and signs the runner again before it lapses. If
iOS refuses to launch it anyway (for example, after a certificate was revoked), looktap rebuilds it once and
retries. Free Apple IDs have Apple's own limits too: about 3 devices and 10 app ids per 7 days, and **at most 3 apps
signed by the free account installed on one device at a time**. The runner counts as one, so if the device is full,
looktap names the apps it found and you delete one.

**What works on a device:** everything except `location`, `network`, `push`, `statusbar`, `textsize`, `bio`,
`record`, `permission`, `reset`, `logs` and `crashes`, which say so; `zoom` works around the screen's centre only.
[Platform support](#platform-support) has the reasons, and `looktap capabilities` prints them. A command takes about 1–1.5 s, slower than on a simulator, because XCUITest takes longer to read the screen.

The device must be unlocked while the runner starts. It keeps running until `looktap teardown`, or until the
device is restarted. While the device is locked, commands that need the screen stop with "the device is locked"
(`stop` still works). A runner can lose its permission to drive the screen while it keeps running (seen after the
device sat idle); looktap then starts a fresh one, once, and carries on.

<details>
<summary><strong>Android: the fallback path</strong></summary>

If the helper can't start (for example, another tool holds UiAutomation), looktap falls back to plain `adb` +
`uiautomator dump`. That works everywhere but takes about 2.5 s per screen read. `LOOKTAP_ANDROID_HELPER=0`
forces that path.
</details>

## Examples

### Look, then act

```bash
looktap ls
```

```
@1   Button           16, 285 358x54  General
@2   Button           16, 339 358x54  Accessibility
@3   TextField        33, 773 324x38  Search  = Search
```

Each row shows a **ref** (`@1`), the element type, its **x,y** position and **width×height** (iOS points /
Android dp, the units `tapxy` and `swipe` take), its **label**, and `= value` for fields that hold text and for switches and checkboxes (`1` on, `0` off). Unlabelled
buttons are listed too, as `(no label)`, so you can tap them by ref. The on-screen keyboard is a single row.

### Tap by label, not by coordinates

```bash
looktap tap "Open menu"              # exact label (or identifier on iOS)
# tapped "Open menu" at 30,62
looktap tap "Messages"               # no exact match → the one label starting with it
# tapped "Messages, 2 unread" at 342,62
looktap tap "Wi"                     # matches two different labels → refuses
# looktap: "Wi" is ambiguous — matches 2 labels: "Wi-Fi", "Wi-Fi hotspot"
looktap tap --exact "Messages"       # exact only
looktap tap @7                       # row @7 of the last ls
looktap tapxy 205 874                # when ls doesn't list it at all
```

- **A ref works only while its element is still where `ls` saw it.** If the screen changed, `tap @7` fails
  ("no longer on screen — run: looktap ls") rather than tapping something else.
- **If another element covers the tap point** (a toast, a dev-warning banner, a floating bar), `tap` prints a
  warning, because the tap probably landed on the cover instead.

### Long press and pinch-zoom

```bash
looktap longpress "Photo"               # context menus, drag handles, "edit" modes (default 800 ms)
looktap longpress @4 1500               # by ref, held 1.5 s
looktap longpress 120 470               # a point, e.g. to drop a pin on a map
looktap zoom in                         # two fingers spreading at the screen centre (maps, photos, PDFs)
looktap zoom out 200 400 --scale 4      # pinch around a point; --scale is how far the fingers travel
```

`zoom` is a real two-finger gesture on both platforms. On Android it needs looktap's helper, because
`adb input` has no multi-touch.

### Fill a form and capture its validation errors

```bash
looktap fill "Email" not-an-email
looktap fill "Name" ""               # empty: just clears the field
looktap hidekb
looktap shot profile__validation
```

`fill` finds the field by its label (on iOS also its identifier), or else the first field at or below a matching
label. It clears the field and types. On Android it also presses Enter, because React Native fields only show
validation on blur.

`hidekb` tries, in order:
1. the keyboard's Done/Return key;
2. on iOS, the ✓ on a web form's Previous/Next bar;
3. a tap on plain text above the keyboard.

It checks after each. If the keyboard is still up, it **exits 2** rather than reporting success.

### Wait instead of sleeping, and scroll

```bash
looktap wait "Welcome"                  # until it's on screen (default up to 10 s; --wait 30)
looktap wait "Loading" --gone           # until it's gone
looktap scrollto "Privacy & Security"   # swipe until fully on screen; fails at the end of the list
looktap scrollto "General" --up
looktap swipe 200 700 200 250           # scroll down (finger moves up); optional 5th arg: ms
looktap back                            # Android: system Back · iOS: the navigation bar's back button
looktap home                            # the Home button: home screen, the app keeps running
```

### Debug: logs, crashes, "where did my app go?"

```bash
looktap tap "Pay"                       # something goes wrong…
looktap logs --errors                   # the app's errors since the last `logs`
# 15:41:06.700 E [com.example:api] POST /payments failed: 422 amount_too_small
looktap logs --grep payment             # everything it logged that matches
looktap app --app com.example           # is it still running?
# front: com.android.launcher3  pid 1205
# com.example: not running — if it was, check: looktap crashes
looktap crashes
# com.example (pid 14001) exited at 14:56:06.724 while in the background: LOW_MEMORY — killed by the system to free memory, not a crash
```

**When the app dies, looktap says so.** After an action, and at the next `ls`, looktap checks whether the
app that was in front still has its process. If not, it prints:

```
looktap: warning: com.example is no longer running — it crashed or was killed. See: looktap crashes com.example
```

- It also catches an Android app that crashed and was restarted at once, because the check is by process id.
- Switching to another app, going home, or uninstalling doesn't trigger it.
- On iOS the crash report is written up to a minute after the crash. Until then, `crashes` already shows the
  signal (e.g. `SIGTRAP`) and says the full report is coming.

**Each `logs` call starts where the previous one ended**, so a loop of *act → `logs`* only ever shows what's new.
`--since 5m` sets a fixed window instead.

**What's in the log:**
- **iOS:** what the app's own code logged, plus errors and faults from anything in its process. The simulator's
  own noise (low-level networking, the keyboard) is hidden. `--all` shows everything, Apple frameworks included.
  A read takes about 1–2 s.
- **Android:** everything logcat has for the app's uid, so restarts are covered. A read takes about 0.1 s.

**What `crashes` reports:**
- **iOS:** each crash report as exception, reason (such as an uncaught `NSException`), the crashed thread's top
  frames, and the path to the full `.ips` report.
- **Android:** Java crashes, native tombstones, ANRs, and exits that leave no crash report, low-memory kills above
  all.

**React Native:** in development builds, JS `console.*` output and uncaught JS errors are in `logs` on both
platforms:
- **iOS:** as `[com.facebook.react.log:javascript]` lines.
- **Android:** as `ReactNativeJS` lines.

A red box is also on screen, so `ls` reads its message and call stack.

**Swift:** `print()` writes to stdout, not to the log. Use `os.Logger` or `NSLog` for messages `logs` should see.

### Catch a spinner, toast, or transition (`burst`)

Start the burst **in the background**, then trigger the action:

```bash
looktap burst ./frames 5 &              # 5 s: a frame each time the screen changes
looktap swipe 200 250 200 700           # pull to refresh
wait
# 61 frames, 23 distinct, in ./frames
```

For a video of a whole flow, record it. The recording runs in the background between the two commands:

```bash
looktap record start checkout           # → ./shots/checkout.mp4
looktap tap "Add to cart" --ls
looktap tap "Checkout" --ls
looktap record stop                     # prints the path and the length
```

- **Android** records with the device's `screenrecord`: at most 3 minutes, and `FLAG_SECURE` screens come out
  black.
- **iOS** records with `simctl io recordVideo`. A recording started in landscape is marked to play turned.

### Start from a clean state: install, reset, permissions

```bash
looktap install build/MyApp.app          # iOS: a simulator build · Android: an .apk (keeps the app's data)
# installed com.example.myapp
looktap reset com.example.myapp          # as if freshly installed: data and permissions cleared
looktap permission grant location com.example.myapp    # no prompt
looktap permission revoke photos com.example.myapp     # test the "denied" path
looktap permission reset camera com.example.myapp      # it asks again on next use
looktap stop com.example.myapp          # end it; prints "stopped" once its process is gone
looktap uninstall com.example.myapp
```

- **`reset`:**
  - **iOS:** looktap copies the app's own bundle aside, uninstalls it and installs the copy, so documents,
    caches, app groups and permissions all go. The **keychain survives**, just as it does on a real iPhone, so
    an app that keeps its sign-in token there may still be signed in.
  - **Android:** `pm clear`.
- **Permission names** are the same on both platforms: `camera`, `microphone`, `location`, `location-always`,
  `photos`, `contacts`, `calendar`, `notifications`, `motion`, `all`.
  - Android also takes any `android.permission.*`, and acts only on permissions the app declares. A `reset` also
    clears "don't ask again".
  - The iOS simulator can't set `camera` or `notifications`; looktap says so.
- **These commands never guess the app from the screen.** `stop`, `uninstall`, `reset` and `permission` take the app id
  as an argument, or from `--app` / `looktap.config.json`.

### Simulated conditions: location, dark mode, text size, orientation, network, push

```bash
looktap location 51.5072 -0.1276        # GPS (Android: emulators) · `location clear` on iOS
looktap appearance dark                 # or light; no argument prints the current one
looktap textsize ax2                    # Dynamic Type / font scale: xs s m l xl xxl xxxl ax1…ax5
looktap statusbar clean                 # 9:41, full battery and Wi-Fi, for screenshots · `statusbar live`
looktap rotate landscape --ls           # or left, right, upsidedown, portrait; no argument prints it
looktap network offline                 # Android: airplane mode · `network online`
looktap push com.example.myapp "Your order has shipped"          # iOS: an alert
looktap push com.example.myapp '{"aps":{"alert":"Hi"},"orderId":7}'   # or any payload / a .json file
```

- **`textsize`** uses the iOS Dynamic Type sizes. On Android each size maps to the nearest font scale, from 0.8
  to 2.0, the default being `l` / `large` on both.
- **`statusbar clean`** uses iOS status-bar overrides, and Android's System UI demo mode.
- **`rotate`** turns the device the way Simulator's Rotate Left/Right does, or locks Android's rotation.
  `landscape` is `left`: the device turned counter-clockwise. `ls` coordinates, taps and screenshots follow
  the turned screen, so read the screen again afterwards. An app that doesn't support the orientation stays
  as it is, and `rotate` says so. On Android it leaves auto-rotate off.
- **`network offline`** turns on Android's airplane mode and waits until the device has no route out. The iOS
  simulator shares the Mac's network, so it can't go offline or slow by itself.
- **`push`** delivers a remote notification the way APNs would. The app needs notification permission, as on a
  device.
  - A payload without `"aps"` is sent as a silent (background) push carrying that data.
  - **Android pushes can't be simulated locally.** They come through Firebase (FCM), so send them from your
    backend or the Firebase console.

### Biometrics

```bash
looktap bio match       # iOS: Face ID success · Android: enrolled finger 1
looktap bio nomatch     # iOS: Face ID failure · Android: unknown finger
```

On Android, enrol a fingerprint once first: Settings → Security → Fingerprint, using a screen-lock PIN, and touch
with `looktap bio match` when it asks.

### Same screen on several devices

```bash
looktap boot "iPhone 14" --headless && looktap boot "iPhone 16 Pro" --headless
looktap devices
# ios      42E41FA7-…  iPhone 14 · simulator · iOS 26.0 · headless
# ios      F9213EDC-…  iPhone 16 Pro · simulator · iOS 26.0 · headless
# android  emulator-5554  Pixel_9a · emulator · Android 16 · window

for d in 42E41FA7-EA40-45C1-8C6E-13A70BAF1FD6 F9213EDC-180D-412B-B24C-2FD69A37D3AC; do
  looktap -d $d open myapp://home
  looktap -d $d wait "Home"
  looktap -d $d shot -o shots/$d home
done
```

Passing **both** `-p` and `-d` (or exporting `LOOKTAP_PLATFORM` and `LOOKTAP_DEVICE`) makes every command about
0.2 s faster, because looktap then skips listing devices.

### A repeatable screenshot sweep

```bash
#!/bin/sh
set -e
looktap launch
for route in home search messages profile settings; do
  looktap open "myapp://$route" --ls > /dev/null
  looktap shot "$route"
  looktap swipe 200 700 200 250
  looktap shot "${route}__scrolled"
done
```

### Record a flow (`codegen`)

On Android you can write a flow by using the app. `codegen` restarts the app, then turns each touch into the step
that replays it:

```console
$ looktap codegen flows/about.txt com.android.settings
+ stop com.android.settings
+ launch com.android.settings
+ wait Settings
recording com.android.settings to flows/about.txt — use the phone. …
+ scrollto "About phone"
+ tap "About phone"
+ back
+ tap "Search settings"
+ fill Search wifi
expect "Wi-Fi"
ok: "Wi-Fi" at 107,148
+ expect Wi-Fi
saved 9 steps to flows/about.txt — run it: looktap test flows/about.txt
```

- **Taps are saved by label**: a tap anywhere on a row is a tap on the row's label, when `tap` with that label finds
  the same row again. Where no label does (an icon with no accessibility label), it's saved as `tapxy`, with a note.
- **Typing is one `fill`**, with the field's name and its final text. Text typed into a password field isn't saved:
  the step reads it from an environment variable instead (`fill Password "${PASSWORD}"`).
- **Scrolling that brought a row into view becomes `scrollto`**, which replays on any screen size. Other swipes (a
  carousel, a map) stay swipes. The navigation bar's Back and Home, and gesture navigation, become `back` and `home`.
- **Checks:** type a command into the terminal while it records, e.g. `expect "Welcome"`. It's run, and saved if it
  passes. `undo` drops the last step.

It reads the touchscreen through `adb shell getevent`, so it records real fingers (not taps sent by looktap itself).
It isn't available on iOS yet: write the flow by hand there, or record it on Android if the app is the same.

### Test flows in CI

A flow file is a `run` script: one looktap command per line, `#` for comments. Use `wait` where the app takes
time and `expect` where the flow should check something:

```bash
# flows/sign-in.txt
launch com.example.myapp
wait "Sign in"
fill Email sam@example.com
tap "Continue"
wait Welcome
expect "Sign in" --gone
```

```console
$ looktap test flows/ -o results --junit results/junit.xml
✓ flows/browse.txt  9 steps · 6.1 s
✗ flows/checkout.txt  3.4 s
    step 5 (expect Total = €4.20): expect failed: "Total" is "€0.00", expected "€4.20" (waited 3 s)
    │ $ tap "Add to bag"
    │ tapped "Add to bag" at 195,612
    │ …
    evidence: results/failures/flows-checkout
✓ flows/sign-in.txt  6 steps · 4.8 s
looktap: 3 flows: 2 passed, 1 failed · 14.3 s · results/junit.xml
```

Flows run in order on one device, each from wherever the last one left the app, so start each with `launch` (or
`reset <app>` and `launch` for a fresh install). Steps wait for their targets, but
a flow that depends on a backend can still be slow: raise `--wait` rather than adding sleeps.

Flow files live in your repo, so never put real credentials in one. Sign in with a test-only account, and keep its
password out of the file: `test` replaces `${NAME}` with that environment variable (a CI secret), e.g.
`fill Password "${PASSWORD}"`.

In GitHub Actions, iOS runs on a macOS runner and Android on a Linux runner with KVM:

```yaml
jobs:
  ios:
    runs-on: macos-15
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm install -g @looktap/cli
      - run: xcodebuild -scheme MyApp -sdk iphonesimulator -derivedDataPath build build
      - run: looktap boot "iPhone 16" --headless
      - run: looktap install build/Build/Products/Debug-iphonesimulator/MyApp.app
      - run: looktap test flows/ -o results --junit results/junit.xml
      - uses: actions/upload-artifact@v4
        if: always()
        with: { name: ios-results, path: results }

  android:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm install -g @looktap/cli
      - run: ./gradlew assembleDebug
      - name: Enable KVM
        run: |
          echo 'KERNEL=="kvm", GROUP="kvm", MODE="0666", OPTIONS+="static_node=kvm"' | sudo tee /etc/udev/rules.d/99-kvm4all.rules
          sudo udevadm control --reload-rules
          sudo udevadm trigger --name-match=kvm
      - uses: reactivecircus/android-emulator-runner@v2
        with:
          api-level: 34
          arch: x86_64
          script: |
            looktap -p android install app/build/outputs/apk/debug/app-debug.apk --grant
            looktap -p android test flows/ -o results --junit results/junit.xml
      - uses: actions/upload-artifact@v4
        if: always()
        with: { name: android-results, path: results }
```

Upload `results/` even when the job fails: that's where the failed flows' screenshots and logs are.

### Android screenshots of secure screens

Apps that set `FLAG_SECURE` (common in banking and payment apps) make normal Android screenshots come out black. On
emulators, `looktap shot` takes the frame from the emulator itself, which gets past that. `--plain` takes a normal
on-device screenshot, for example to check that a screen *is* secure.

## For AI agents

Pick the route that fits your agent:

| Your agent | Use | Set up |
|---|---|---|
| **Claude Code** | The plugin: the CLI plus a skill that teaches the loop | `/plugin install looktap --marketplace lakpriya1s/looktap`, then `/looktap:setup` ([details](#claude-code-plugin)) |
| **Other agents with a shell** (Codex, Cursor's agent, opencode, …) | The CLI plus the skill file | `looktap skill --install` (or `looktap skill` prints it) |
| **Chat apps without a shell** (Claude Desktop, …) | The MCP server | `npx -y @looktap/mcp` ([details](#mcp-server-for-clients-without-a-shell)) |

An agent spends seconds per turn, so **turns** matter more than milliseconds. looktap is built to save them: in the
[benchmark](BENCHMARK.md) the CLI needed 8 calls for a scenario that took other tools 9–27 on iOS, and 12 where they
took 11–19 on Android.

- **`--ls` on any action** prints the screen once it has settled, so acting and looking take one turn instead of two:

  ```bash
  looktap tap @3 --ls
  looktap fill "Email" a@b.co --ls
  ```

- **`wait`** instead of guessing `sleep`s. After an action that loads data, `--ls` can return a loading skeleton,
  so wait for the text you expect.
- **`run`** batches steps you already know into one call and one process. It prints each step as `$ <step>`, stops
  at the first failure, and names it:

  ```bash
  looktap run 'tap General; wait About; tap About --ls'
  looktap run - < steps.txt          # one step per line, # for comments
  ```

- **`logs` / `crashes`** after a step that misbehaved. Each `logs` shows only what's new since the last one.
- **`ls --json`** for structured output: `{screen, elements: [{ref, label, type, x, y, w, h, value}]}`.
- **`shot --scale 0.5`** costs a quarter of the image tokens when the agent needs to *see* the screen (layout,
  colours, images). Usually `ls` is enough and the PNG is never opened.
- **Hints when the screen isn't what it seems.** When a passcode or permission prompt covers the app, `ls`
  prints a hint rather than an empty list.

### Claude Code plugin

In Claude Code, run:

```
/plugin install looktap --marketplace lakpriya1s/looktap
```

- **What it adds:**
  - the looktap skill, which teaches Claude the look-act loop, how to pick targets, when to wait, when a
    screenshot is worth it, how to debug a crash, and the safety rules;
  - **`/looktap:setup`**, which gets the machine ready: it installs the CLI (asking first), runs `looktap doctor`
    and explains each fix, offers to boot a simulator or emulator, walks you through a real iPhone's one-time
    steps, and finishes with a working `ls`. Add `ios`, `android` or `iphone` to set up just that.
- **What it doesn't install:** Xcode, the Android SDK and the Apple ID sign-in are yours to do; `/looktap:setup`
  tells you exactly what's missing.
- **What it costs:** about 150 tokens per session for the skill's description, and about 4.5k tokens each time
  Claude loads the skill.
- **Staying current:** every push to this repo is a new plugin version. Claude Code doesn't auto-update
  third-party plugins unless you turn it on (`/plugin` → Marketplaces → looktap → Enable auto-update); otherwise
  run `/plugin marketplace update looktap` now and then.
- **The CLI:** the skill runs `looktap` commands. Install them with `npm install -g @looktap/cli`, or the skill
  falls back to `npx @looktap/cli`.
- **No MCP server inside, on purpose:** with a shell, the CLI and the skill do the same job with fewer tokens, and
  an MCP server would add its 16 tool definitions to every session. Add `@looktap/mcp` separately if you want it
  anyway.

### MCP server, for clients without a shell

Agents with a shell (Claude Code, Codex, Cursor's agent, …) are best served by the CLI and the skill above.
For **chat apps and other clients without a shell**, such as Claude Desktop, looktap is also an MCP server,
published as [`@looktap/mcp`](https://www.npmjs.com/package/@looktap/mcp) and listed in the
[MCP Registry](https://registry.modelcontextprotocol.io) as `io.github.lakpriya1s/looktap`. Nothing to install first:

```json
{ "mcpServers": { "looktap": { "command": "npx", "args": ["-y", "@looktap/mcp"] } } }
```

If your client can't find `npx` (desktop apps start servers with a minimal `PATH`), install the CLI and let it
write the config with absolute paths:

```bash
looktap mcp --config      # prints a ready-to-paste client config with absolute paths
```

```json
{
  "mcpServers": {
    "looktap": {
      "command": "/path/to/node",
      "args": ["/path/to/looktap/bin/looktap.js", "mcp"],
      "env": { "PATH": "/path/to/node/bin:/path/to/Android/sdk/platform-tools:/usr/bin:/bin" }
    }
  }
}
```

- **Where to paste it:**
  - Claude Desktop: `~/Library/Application Support/Claude/claude_desktop_config.json`
  - Cursor: `~/.cursor/mcp.json`
  - Claude Code: `claude mcp add looktap -- npx -y @looktap/mcp` (no install needed: it runs the latest
    version from npm). Or the absolute paths: `claude mcp add looktap -- <node> <looktap.js> mcp`
- **Why absolute paths:** desktop apps start servers with a minimal `PATH`. `looktap` also finds `adb` in the
  Android SDK by itself.
- **The tools:**
  - `ls`, `tap`, `tap_xy`, `long_press`, `fill`, `type`, `key`, `hide_keyboard`, `swipe`, `scroll_to`, `back`,
    `home` and `wait`;
  - `screenshot`, which returns the image itself;
  - `logs` and `crashes`;
  - `looktap`, for any other command line, or several separated by `;`.
- **Actions return the settled screen** unless `ls: false`. That saves the agent a separate `ls`, but each action
  then waits for the screen to stop moving, 0.7–1.9 s in the [benchmark](BENCHMARK.md). Pass `ls: false` when you
  don't need to see the result.
- **The device is remembered:** name a `platform` (or `device`) once when both an iPhone and an Android are
  booted.
- **Speed:** the server keeps each device's helper connection open, so a warm `ls` comes back in 40–70 ms.

Why a CLI first? Any agent with a shell can use it with no configuration, and its output is already as small as
it gets. In the benchmark the CLI beat the MCP server on both platforms, mostly because it doesn't wait for the screen
to settle unless asked (`--ls`).

## Commands

| Command | What it does |
|---|---|
| **Look** | |
| `looktap ls [--all] [--json]` | Visible elements with a label, plus unlabelled buttons, each with an `@ref`. `--all` includes everything. `--json` prints `{screen, elements}`. While the screen is still loading (nothing labelled yet), waits up to `--wait` |
| `looktap wait <label\|@ref> [--gone]` | Until it's on screen (with `--gone`, until it isn't). Default up to 10 s, or `--wait`. Exits 2 on timeout |
| `looktap expect <label\|@ref> [= value] [--gone] [--exact]` | Checks it's on screen, with `= value` that its value is exactly that, or with `--gone` that it isn't. Matches like `wait` (`--exact`: the whole label only). Waits up to `--wait` (3 s) for it to come true. Exits 1 with what's there instead: `expect failed: "Email" is "sam@example.com", expected "kim@example.com"` |
| `looktap scrollto <label> [--up]` | Swipes until the element is fully on screen. Each swipe holds still before lifting, so the list stops where it was dragged instead of coasting. Fails at the end of the list, or after 15 swipes |
| `looktap shot <name> [--plain] [--scale f]` | Saves `<out>/<name>.png` and prints its path |
| `looktap burst <dir> <seconds>` | A frame each time the screen changes. Only distinct frames are kept |
| `looktap record start [name]` · `record stop` | An MP4 of everything in between, saved to `<out>/<name>.mp4`; `stop` prints the path and the length. Android: at most 3 minutes, `FLAG_SECURE` screens black |
| **Act** (add `--ls` to print the settled screen afterwards) | |
| `looktap tap <label\|@ref> [--exact]` | `@ref` from the last `ls`, or a label: exact, else a prefix/contains match that names a single label (ambiguous → exit 2). Prints what it tapped |
| `looktap longpress <label\|@ref\|x y> [ms]` | Holds the touch for `ms` (default 800). Same targets as `tap`, or a point |
| `looktap zoom in\|out [x y] [--scale f]` | Two-finger pinch around a point (default: the screen centre). `--scale` sets how far apart the fingers end up (default 2.5) |
| `looktap tapxy <x> <y>` | Taps a point (iOS points / Android dp) |
| `looktap type <text>` | Types into the focused field. Text the keyboard can't type (accents, emoji, CJK) is pasted, which replaces the clipboard |
| `looktap key <name> …` | `return`, `escape`, `delete`, `tab`, `space`, `selectall`, `paste`, `home`. Android also `back`, any `KEYCODE_*` |
| `looktap fill <label\|@ref> <text> [--exact]` | Focuses the field, clears it, types. Empty text just clears |
| `looktap hidekb` | Dismisses the keyboard, checking after each method. Exits 2 if it's still up |
| `looktap swipe <x1> <y1> <x2> <y2> [ms]` | Default 150 ms on iOS, 300 ms on Android |
| `looktap back` | Android system Back · iOS: the navigation bar's back button, else a top-left "Back" button |
| `looktap home` | The Home button: goes to the home screen and checks it's in front; the app keeps running |
| `looktap open <url>` | Opens a deep link |
| `looktap launch [app]` | (Re)starts the app |
| `looktap stop [app]` | Terminates the app and waits until its process is gone |
| `looktap bio match\|nomatch` | Face ID (iOS) or fingerprint (Android) |
| `looktap rotate [portrait\|landscape\|left\|right\|upsidedown]` | Turns the device (`landscape` = `left`, turned counter-clockwise). `ls`, taps and screenshots follow the turned screen. Says so if the app doesn't support the orientation. Without an argument, prints the current one |
| **Debug** (`[app]` defaults to `--app` / config, else the app in front) | |
| `looktap logs [app] [--errors] [--grep re] [--since 5m] [--lines n] [--all]` | The app's log since the last `logs` (the first call covers the last minute). At most 80 lines, newest kept |
| `looktap crashes [app] [--since 1h]` | Crashes, ANRs and low-memory kills since the last `crashes` (the first call covers the last hour) |
| `looktap app [app]` | The app in front and its pid, and whether `[app]` is running |
| `looktap capabilities [--json]` | What this device can't do, or can only in part, and why. `--json`: every command with `supported`, `conditional` or `unsupported` |
| **App state** (`<app>` from the argument or `--app` / config, never the app in front) | |
| `looktap install <path> [--grant]` | iOS: a simulator `.app`. Android: an `.apk`, replacing an installed copy and keeping its data (`--grant`: all runtime permissions). Prints the app id |
| `looktap uninstall <app>` | Removes the app |
| `looktap reset <app>` | As if freshly installed: data and permissions cleared. iOS: the keychain survives |
| `looktap permission grant\|revoke\|reset <name> [app]` | `camera`, `microphone`, `location`, `location-always`, `photos`, `contacts`, `calendar`, `notifications`, `motion`, `all`, … Android also takes `android.permission.*` |
| **Conditions** | |
| `looktap location <lat> <lon>` · `location clear` | Simulated GPS. Android: emulators only, and the emulator keeps its last fix (no `clear`) |
| `looktap appearance [dark\|light]` | Dark mode. Without an argument, prints the current mode |
| `looktap textsize [size]` | Dynamic Type (iOS) / font scale (Android): `xs s m l xl xxl xxxl ax1…ax5`, or iOS names such as `accessibility-large`. Without an argument, prints the current size |
| `looktap statusbar clean\|live` | A screenshot-clean status bar (9:41, full battery and Wi-Fi), or back to live values |
| `looktap network [offline\|online]` | Android only: airplane mode on or off, waiting until the device has lost (or regained) its connection. Without an argument, prints the current state |
| `looktap push <app> <payload>` | iOS: a remote notification. The payload can be a `.json` file, inline JSON, or plain text for an alert |
| **Batch, setup & info** | |
| `looktap mcp [--config]` | Serves these commands over MCP (stdio) for clients without a shell. `--config` prints a client config |
| `looktap run '<cmd>; <cmd> …'` | Several commands in one process. `run -` reads them from stdin. Stops at the first failure and names it |
| `looktap codegen <flow-file> [app]` | Android: restarts the app, then saves each touch on the device as the step that replays it: `tap "<label>"`, `fill <field> <text>`, `scrollto`, `longpress`, `zoom`, `back`, `home`. A command typed while it records (`expect "Welcome"`) is run and saved too; `undo` drops the last step; Enter on an empty line or Ctrl+C ends it. See [Record a flow](#record-a-flow-codegen) |
| `looktap test <flow\|dir> … [--junit file]` | Runs flow files (`run` scripts, one step per line) as tests, folders searched, and prints a line per flow and the totals. Exits 1 if any flow fails. A failed flow prints its output and leaves `error.txt`, `output.txt`, `screen.txt`, `screen.png`, `logs.txt` and `crashes.txt` in `<out>/failures/<flow>/`. An app that dies during a flow fails it. `--junit` writes a JUnit XML report |
| `looktap skill [--install]` | Prints the AI-agent guide, or installs it as a Claude Code skill |
| `looktap devices [--all] [--json]` | What's running or connected, and what each is: simulator, emulator (with its AVD name) or real device (model, OS version, USB or Wi-Fi), and whether it has a window or runs headless. A phone that's connected but not ready is listed with what to do (accept the USB debugging prompt, tap Trust, turn on Developer Mode). `--all` also lists what `boot` can start; `--json` for scripts and agents |
| `looktap boot [name] [--window\|--headless]` | Boots an iOS simulator or Android emulator by name, UDID or AVD name (exact, else a unique prefix or substring; `-p` to choose a platform) and waits until it's ready to drive. Opens its window unless `--headless` (or `LOOKTAP_HEADLESS=1`, or `"headless": true` in the config file). Already running: says so, and `--window` opens a simulator's window. A running device can't drop its window (closing the Simulator app shuts its simulators down; an emulator starts with or without one), so `--headless` then says how to restart it |
| `looktap shutdown [name]` | Shuts down a simulator or emulator (name, UDID, AVD name or serial), and waits until it's gone |
| `looktap doctor` | Checks Node, Xcode and the simulator frameworks, adb, and booted devices |
| `looktap setup` | Starts the helper ahead of time. Android: also `adb reverse tcp:8081` for Metro |
| `looktap teardown` | Stops the helper. Android: also removes `adb reverse` rules |

**`--ls`** works on `tap`, `longpress`, `zoom`, `tapxy`, `fill`, `type`, `key`, `hidekb`, `swipe`, `back`, `home`, `open`, `launch`, `bio`,
`rotate` and `scrollto`. After the action it waits for the screen to change (up to 1.5 s, or 6 s for `launch`/`open`), then for
it to stop changing, then prints it like `ls`.

**Exit codes:** `0` means OK. `2` means a usage problem: bad arguments, element not found, no device, or the
helper can't start. `1` means anything else failed, including an `expect` that didn't hold and a `test` run with a
failed flow. A script can `set -e` and stop at the first missing element.

## Platform support

Every command works on all four kinds of device except the ones below. ⚠️ means it works with the limit shown; ❌
means it doesn't run there and exits 2 with that reason. `looktap capabilities` prints the same for the device in
front of you (`--json` for every command).

<!-- capabilities: generated by npm run docs:capabilities -->
| Command | iOS simulator | iPhone / iPad | Android emulator | Android device |
|---|---|---|---|---|
| `back` | ⚠️ iOS has no system Back: it taps the navigation bar's back button, else a top-left Back button | ⚠️ iOS has no system Back: it taps the navigation bar's back button, else a top-left Back button | ✅ | ✅ |
| `bio` | ✅ | ❌ Face ID needs a real face on a device | ✅ | ❌ fingerprints can only be simulated on an emulator |
| `burst` | ✅ | ✅ | ✅ | ⚠️ FLAG_SECURE screens come out black (emulators bypass it) |
| `codegen` | ❌ recording touches works on Android only, for now: write the flow by hand, or record it on an Android device | ❌ recording touches works on Android only, for now: write the flow by hand, or record it on an Android device | ✅ | ✅ |
| `crashes` | ✅ | ❌ see Xcode → Window → Devices and Simulators → View Device Logs | ✅ | ✅ |
| `location` | ✅ | ❌ a real device uses its own GPS; use a simulator to fake one | ✅ | ❌ a device uses its own GPS (faking it needs a mock-location app) |
| `location clear` | ✅ | ❌ a real device uses its own GPS; use a simulator to fake one | ❌ the emulator keeps its last location: set a new one instead | ❌ a device uses its own GPS (faking it needs a mock-location app) |
| `logs` | ✅ | ❌ use Console.app with the device selected | ✅ | ✅ |
| `network` | ❌ the simulator uses the Mac's own network, so it can't go offline or slow by itself. Network Link Conditioner (Xcode → Open Developer Tool → More Developer Tools → Additional Tools) throttles the whole Mac | ❌ turn on Airplane Mode in Control Center | ✅ | ⚠️ airplane mode: over wireless adb, going offline also drops looktap's connection |
| `permission` | ⚠️ camera and notifications can't be set: simctl privacy has no such service | ❌ change it in the Settings app | ⚠️ contacts-limited, reminders and siri are iOS-only; any android.permission.* works | ⚠️ contacts-limited, reminders and siri are iOS-only; any android.permission.* works |
| `push` | ✅ | ❌ send a real push through APNs | ❌ Android pushes come through Firebase (FCM), so adb can't inject one: send it from your backend or the Firebase console | ❌ Android pushes come through Firebase (FCM), so adb can't inject one: send it from your backend or the Firebase console |
| `record` | ✅ | ❌ use burst for frames, or QuickTime Player for video | ⚠️ at most 3 minutes, and FLAG_SECURE screens record black | ⚠️ at most 3 minutes, and FLAG_SECURE screens record black |
| `reset` | ✅ | ❌ uninstall and install the app again | ✅ | ✅ |
| `rotate` | ✅ | ✅ | ⚠️ turned while the home screen is in front, it doesn't last: the next app reopens in the orientation it was last shown in. Turn it with the app in front | ⚠️ turned while the home screen is in front, it doesn't last: the next app reopens in the orientation it was last shown in. Turn it with the app in front |
| `shot` | ✅ | ✅ | ✅ | ⚠️ FLAG_SECURE screens come out black (emulators bypass it) |
| `statusbar` | ✅ | ❌ only simulators can override the status bar | ✅ | ✅ |
| `textsize` | ✅ | ❌ change it in Settings → Display & Brightness → Text Size | ✅ | ✅ |
| `zoom` | ✅ | ⚠️ around the screen's centre only | ⚠️ only through the Android helper (the default): adb input has no multi-touch | ⚠️ only through the Android helper (the default): adb input has no multi-touch |
<!-- /capabilities -->

## Options, environment variables, config file

| Option | Meaning |
|---|---|
| `-p, --platform ios\|android` | Default: whichever has a booted device. Required when both do |
| `-d, --device <udid\|serial>` | Default: the only booted one |
| `-o, --out <dir>` | Folder for screenshots and videos (default `shots`), and for `test`'s `failures/` |
| `--junit <file>` | `test`: also write a JUnit XML report there |
| `--wait <seconds>` | How long `tap`, `fill`, `back` and `expect` look for their target (default `3`). An ambiguous match fails at once |
| `--app <id>` | App id for `launch`, `stop`, `open`, `logs`, `crashes`, `app`, `uninstall`, `reset` and `permission` |
| `-h, --help` · `-v, --version` | |

| Environment variable | Meaning |
|---|---|
| `LOOKTAP_PLATFORM`, `LOOKTAP_DEVICE`, `LOOKTAP_OUT`, `LOOKTAP_WAIT` | Defaults for `-p`, `-d`, `-o`, `--wait` |
| `LOOKTAP_SCALE` | Override Android's px-per-dp (normally read from `wm density`) |
| `LOOKTAP_ANDROID_HELPER=0` | Plain `adb` + `uiautomator dump` instead of the helper (slower) |
| `LOOKTAP_EMULATOR_GRPC=0` | Don't take emulator frames over gRPC: use the emulator console |
| `LOOKTAP_IOS_HID=indigo\|dtuhid` | Force the iOS input path. Takes effect when the helper starts |
| `LOOKTAP_HOME` | Where sockets, logs and state live (default `~/.looktap`) |
| `LOOKTAP_DEBUG=1` | `codegen` prints each touch it sees: where, on which window, and what was under it |
| `LOOKTAP_HEADLESS=1` | `boot` without a window by default (`=0`: with one). Overrides `"headless"` in the config file |

**Config file.** looktap uses the nearest `looktap.config.json`, walking up from the current folder. Put it at
the root of your app's repo:

```json
{
  "out": "shots",
  "wait": 3,
  "headless": false,
  "ios": { "app": "com.example.myapp" },
  "android": { "app": "com.example.myapp" }
}
```

Precedence: command-line option, then environment variable, then config file, then built-in default.

<details>
<summary><strong>Files looktap writes</strong></summary>

| Path | What |
|---|---|
| `~/.looktap/sim-<udid prefix>.sock`, `.log` | The iOS helper's socket and log |
| `~/.looktap/helpers.json` | Which local port reaches each Android device's helper |
| `~/.looktap/refs/<device>.json` | What `@1`…`@N` meant in the last `ls` on that device |
| `~/.looktap/marks/<device>.json` | Where the last `logs` / `crashes` stopped |
| `~/.looktap/recordings.json` | Recordings in progress, so `record stop` can find them |
| `~/.looktap/rec-<udid prefix>.log` | The iOS recorder's output |
| `~/.looktap/shots/` | Where the MCP server saves screenshots unless `-o` / `LOOKTAP_OUT` / config says otherwise |
| `/data/local/tmp/looktap-server.jar` (device) | The Android helper |
| `/data/local/tmp/looktap-recording.mp4` (device) | An Android recording in progress, removed when it's copied off |
| `<out>/<name>.png`, `<out>/<name>.mp4` | Your screenshots and videos |
</details>

## Troubleshooting

| Symptom | Fix |
|---|---|
| iOS: `SimulatorKit not found …` / `… has no Indigo HID builders` | Run `looktap doctor`. Point `xcode-select` at a full Xcode: `sudo xcode-select -s /Applications/Xcode.app` |
| iOS: `input unavailable (dtuhid): dtuhidd did not answer` | The simulator is still booting, or its input service is restarting. Retry in a few seconds |
| iOS: an element you can see is missing from `ls` | Some containers hide their children from accessibility. looktap probes for them, but `tapxy` is the fallback |
| `only the status bar is readable — a system prompt … may be covering the app` | A passcode, permission or alert prompt drawn by iOS. `looktap shot` to see it |
| `both iOS and Android devices are up — pass -p ios\|android` | Add `-p`, or `export LOOKTAP_PLATFORM=…` |
| `not found: <label>` | Run `looktap ls` and copy the label. If the screen is slow to load, raise `--wait` |
| `"<label>" is ambiguous — matches N labels` | Use more of the label, a `@ref`, or `--exact` |
| `keyboard is still up` (iOS) | Search keyboards have no Done key. Tap the screen's Cancel/close control |
| Android `ls` fails right after boot | Wait until `adb shell getprop sys.boot_completed` prints `1` |
| `device <serial> is not connected` | `adb devices` lists what is. A phone unplugged from USB may still be there over Wi-Fi, under another serial (`adb-…._adb-tls-connect._tcp`) |
| Android `ls` fails after Appium was used | Appium still holds UiAutomation: `adb shell am force-stop io.appium.uiautomator2.server` |
| Appium / `uiautomator` fail after looktap was used | looktap's helper holds UiAutomation: `looktap -p android teardown` |
| `Android helper did not start — falling back to uiautomator dump` | Something else holds UiAutomation (see above). looktap keeps working, just slower |
| Android keyboard never appears | Set `hw.keyboard = no` in the AVD's `config.ini`, then cold-boot the emulator |
| Android screenshot is black | That screen is `FLAG_SECURE`: use `shot` without `--plain` on an emulator. System PIN and biometric sheets stay black in every mode |
| `the device is locked: unlock it, then run the command again` | Unlock the phone (and on an iPhone keep it unlocked while the runner starts). Commands that need the screen stop rather than act on the lock screen; `stop`, `key wakeup` and Android screenshots still work |
| App sits on the splash screen (Android, React Native) | Metro isn't reachable: `looktap setup` (adds `adb reverse tcp:8081`), make sure Metro runs, then `looktap launch` |
| `launch` says `no launchable activity` | The app isn't installed or the id is wrong: `adb shell pm list packages`, or `xcrun simctl listapps booted` |

## FAQ

<details>
<summary><strong>Is this a test framework?</strong></summary>

Not a framework, but it runs tests. `expect` checks the screen, and `looktap test` runs flow files (plain looktap
commands, one per line) and reports them, with a JUnit report and the evidence of each failure. That covers smoke
tests on every build, bug repros, and flows an agent wrote while building a feature: see
[Test flows in CI](#test-flows-in-ci).

Flow files have no variables, loops or shared setup, and looktap doesn't mock the network or shard across devices.
For a large suite that needs those, use XCTest, Espresso, Detox or Maestro.
</details>

<details>
<summary><strong>Does it work on a real iPhone?</strong></summary>

Yes. looktap installs a small XCUITest runner on it, signed with your own Apple ID (a free one works). See
[Using a real iPhone](#using-a-real-iphone) for the one-time setup and what works there.

On Android it works with emulators and with USB-debugging devices. (On a device, screenshots go through the
device, so `FLAG_SECURE` screens are black.)
</details>

<details>
<summary><strong>Does it install anything on my device or in my app?</strong></summary>

Nothing on the iOS simulator. On Android it copies an 8 KB helper to `/data/local/tmp` and runs it with
`app_process`, the way `scrcpy` does. No APK is installed, no app is modified, and there's no SDK to add to your app.
`looktap teardown` stops the helper.
</details>

<details>
<summary><strong>Does it work with React Native, Flutter, SwiftUI, Compose, web views?</strong></summary>

It reads the platform accessibility tree, so anything that exposes accessibility labels works. That includes React
Native (it was built while driving RN apps), SwiftUI, UIKit, Compose and Views. It also reads web content in
Safari, in-app browsers and web views. Flutter isn't tested yet: it exposes elements through its semantics tree,
so it should work wherever that is enabled. Elements without a label show as `(no label)` and can be tapped by `@ref`.
</details>

<details>
<summary><strong>Linux or Windows?</strong></summary>

iOS needs a Mac. The Android side is plain Node + `adb` and should work anywhere they do. It's developed and tested
on macOS.
</details>

<details>
<summary><strong>Will an Xcode update break it?</strong></summary>

It can. The iOS helper uses private simulator frameworks, like `idb` does. `looktap doctor` tells you if something
it needs has moved. Reading the screen and screenshots have held steady. Input changed in Xcode 27, and looktap
already has a path for that, though it isn't tested yet.
</details>

<details>
<summary><strong>Can my agent sign in to my app with it?</strong></summary>

It can type, but it **shouldn't type real credentials**. Have a person sign in (and enter OTPs), then let the agent
continue. The skill tells agents exactly that. See [Safety rules](#safety-rules).
</details>

## Roadmap

- Verified Xcode 27 input (touches, keys and the Home button)
- Rotation verified on iPad simulators

Ideas and votes welcome in [Issues](https://github.com/lakpriya1s/looktap/issues).

## Safety rules

- **Never script a sign-in with real credentials,** whether from a shell script or an AI agent. A person signs in
  and enters OTPs, then looktap takes over.
- **Never `burst` or `record` a sign-in or passcode screen.** The frames capture what's typed.
- **Against a live backend, every tap is real.** Use the smallest amounts, then undo what you created.
- **Logs can contain tokens and personal data.** Quote only the lines that matter, and don't commit screenshots of
  real customer data.

## Contributing

```bash
git clone https://github.com/lakpriya1s/looktap.git
cd looktap
npm test                          # unit tests, no device needed
native/ios/build.sh               # rebuild the iOS helper (needs Xcode)
native/android/build.sh           # rebuild the Android helper (needs the Android SDK + a JDK)
node bin/looktap.js --help      # run from source
npm run site:serve                # build the website and serve it on http://127.0.0.1:4173
```

```
bin/looktap.js        CLI: arguments, device selection, commands
lib/ios.js              iOS driver: helper client, simctl, logs, crash reports
lib/android.js          Android driver: helper client, adb fallback, logcat, exits
lib/screen.js           ls rows, @refs, wait, scrollto, settle (platform-neutral)
lib/logs.js             logs/crashes windows and formatting
lib/helper.js           the JSON-lines socket protocol both helpers speak
lib/emulator.js         Android emulator gRPC frames, no dependencies
lib/mcp.js              the MCP server (stdio)
lib/png.js · lib/mp4.js · lib/util.js · lib/conditions.js · lib/permissions.js
lib/assets/             built helpers (looktap-sim, looktap-server.jar)
native/ios/             iOS helper source (Objective-C)
native/android/         Android helper source (Java)
skills/looktap/       the AI-agent guide
site/                   the website: landing page (site/src) and docs generated from this README,
                        SKILL.md and BENCHMARK.md (site/build.mjs); published by .github/workflows/pages.yml
```

Notes for contributors:
- **Zero dependencies, on purpose.** Use only Node built-ins. The helpers use only what ships with macOS/Xcode
  and Android.
- **Helpers are versioned by content hash.** After you rebuild one, the next command replaces the running copy.
  Commit the rebuilt file in `lib/assets/`.
- **A new command needs:**
  - a method on both `Ios` and `Android`, or, if it only reads the screen, code in `lib/screen.js`;
  - a `case` in `bin/looktap.js`;
  - a row in this README;
  - a line in `skills/looktap/SKILL.md` if agents should use it;
  - a scene that shows it in `site/src/scenes.js` (its `covers` list). `npm run site:build` fails until the
    README row and the scene are there.

Issues and PRs welcome. If looktap saved your agent some tokens, a ⭐ helps others find it.

## License

[AGPL-3.0](./LICENSE) © Lakpriya Senevirathna. You're free to use, modify and self-host it. If you run a
modified version as a service for others, you must publish your changes under the same license.

---

looktap is an independent open-source project, **not affiliated with, endorsed by or sponsored by Apple Inc.,
Google LLC or the Appium project.** iOS, iPhone, Xcode and Face ID are trademarks of Apple Inc. Android is a
trademark of Google LLC.

<div align="center">
<sub>Text in · taps out · looktap</sub>
</div>
