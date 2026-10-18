# Changelog

## Unreleased

### Added
- **Android `ls` shows a switch's or checkbox's state** as `= 1` (on) or `= 0` (off), as iOS does.

### Changed
- **`scrollto` is about twice as fast:** each swipe holds still for a moment before lifting, so the list stops where
  the finger did and one read shows it, instead of waiting for a fling to coast to a stop. Settings' Developer row on
  a real iPhone: 13–21 s, now about 6.5 s; About phone on a Samsung Galaxy A06: 6.3 s, now 3.2 s. Android falls back
  to waiting when its helper isn't running (`input swipe` can't hold).
- Screen reads after an action start at least 150 ms apart rather than sleeping 150 ms after each, which on a real
  device (~0.4 s a read) was dead time; the screen read before an action doubles as the first look for its target.
- `fill` on iOS waits at most half a second for the keyboard to show, however slow each check is: with a keyboard
  XCUITest can't see (a third-party one), it used to wait ~2.4 s on a real iPhone before typing.

### Fixed
- **A command could hang forever after a helper call timed out** (seen once on a busy Android phone: `back` went back
  and never returned). The timed-out connection stayed open and kept the process alive; it is now closed.
- **Actions with `--ls` (and every MCP action) waited the full 2.5 s on iOS 26 screens with grouped lists:** their
  section backgrounds overhang both screen edges, which read as a screen still sliding in. On a real iPhone,
  `tap --ls` took 4.4 s, now 2.9 s; on the simulator, 2.0–2.5 s, now 1.5 s.
- An unplugged Android device is reported as not connected, not as a leftover Appium session.

### Benchmark
- **Real phones:** the benchmark now also runs on a real iPhone and a real Android phone over USB, with the same steps
  and rules. `bench/results/ios-device.md` (iPhone 14 Pro, iOS 26.0) and `bench/results/android-device.md` (Samsung
  Galaxy A06, Android 16) hold the results; `BENCHMARK.md`, the README and the website summarise them, including
  where looktap is slower.
  - On a real iPhone the oracle reads the phone's screen over the USB cable (the capture device QuickTime records
    from) with Apple's text recognition (`bench/eye/eye.swift`), and resets use `xcrun devicectl`: nothing shared with
    the tools under test.
  - A phone isn't rebooted between tools (it would stop at its passcode). Instead, every helper the previous tool left
    behind is stopped, on the Mac and on the phone.
  - Tools that can't run on a device are listed with their error: on the iPhone, ios-simulator-mcp, MobileBuildMCP,
    idb and Maestro.
  - A phone is named in the results by its model; its serial, UDID and name are scrubbed from tool errors.
- The looktap adapters use `home` and `stop` (since 0.3.0) instead of marking those steps n/a.
- Raw Appium on a real iPhone gets the session settings Appium MCP sets for iOS, so only the MCP layer differs between
  the two.

## 0.4.0

### Added
- **`looktap boot [name]`** boots an iOS simulator or Android emulator by name, UDID or AVD name, and waits until
  it's ready to drive (the simulator's boot status; Android's `sys.boot_completed`). It opens the Simulator or
  emulator window unless `--headless`, and says so when the device is already running. `-p` picks a platform.
- **`looktap shutdown [name]`** shuts one down and waits until it's gone.
- **`looktap devices` says what each device is:** simulator, emulator (with its AVD name) or real device, with the
  model, OS version and, for a phone, USB or Wi-Fi; and whether a simulator or emulator has a window or runs headless.
  A phone that's connected but not ready is listed with what to do: accept "Allow USB debugging?", tap Trust, turn on
  Developer Mode. `--all` also lists what `boot` can start, and `--json` gives it all to scripts and agents.
- **Window or headless:** `boot --window` / `--headless`, with a default from `LOOKTAP_HEADLESS=1` or `"headless": true`
  in `looktap.config.json`. `--window` opens a running simulator's window. A running device can't drop its window
  (quitting the Simulator app shuts its simulators down; an emulator starts with or without one), so `--headless`
  then says how to restart it instead of pretending.

### Changed
- `doctor`, the "no booted device" error and the Claude Code `/looktap:setup` command point to `looktap boot`
  instead of `xcrun simctl boot` and `emulator -avd`.

### Docs
- The quick start, the kickstart prompt, the landing page's "Get started", the agent skill and the MCP server's
  instructions boot devices with `looktap boot`, and tell agents to start with `looktap devices`.

## 0.3.0

### Added
- **`looktap stop [app]`** ends an app on both platforms (iOS simulator: `simctl terminate`, Android:
  `am force-stop`, real iPhones: the runner's `XCUIApplication.terminate`, which iOS honours for the app in front). It
  prints "stopped" only once that process is gone, says when the app wasn't running, and names the new process when
  Android starts it again at once (it does for the top screen of another app's task).
- **`looktap home`** presses the Home button on both platforms. On the iOS simulator it's the hardware Home button
  event, which looktap had no way to send before. It prints "home screen" only once the home screen is in front, and
  names the app it left running. `key home` works on iOS too, and `home` takes `--ls`.
- **Android `key selectall` and `key paste`**, as on iOS. Select-all is Ctrl+A; paste uses the focused field's paste
  action (WebViews ignore the paste key) and falls back to the paste key. Without the helper, select-all needs
  Android 13+.
- **`looktap capabilities [--json]`** says what the device in use can't do, or can do only in part, and why. One
  table (`lib/capabilities.js`) drives it, the errors those commands throw, and a new README section, "Platform
  support", comparing the iOS simulator, real iPhones, the Android emulator and Android devices.
- **A locked device says so.** Commands that read or act on the screen stop with "the device is locked: unlock it,
  then run the command again" (exit 2), and `app` names the lock screen. `stop`, `key wakeup` and Android screenshots
  still work while locked.

### Fixed
- **Android acted on the lock screen as if it were the app:** `type` typed into it (a PIN field counts the
  attempts), `launch` opened behind it, and `home` reported the home screen.
- **Android paste into React Native fields:** a React Native `TextInput` reports the accessibility paste action as
  done without pasting, so `type` for text the keyboard can't type (é, emoji, CJK) did nothing there. The helper now
  checks the field changed and otherwise sends the paste key. Checked in native, React Native and WebView fields.
- **Android: a recording stopped right after it started kept no video.** `record start` returned as soon as
  `screenrecord` was running, but it writes nothing for its first ~250 ms (longer on a busy phone). It now returns
  once the file is being written.
- **Real iPhones: a runner that lost permission to drive the UI** ("Not authorized for performing UI testing
  actions") kept being used, so every command failed with that raw XCTest error. looktap now starts a fresh session
  once and retries. A locked iPhone, which gave raw errors or a 3-minute wait for the runner, now answers within
  seconds.
- `bio` on an Android device says it's emulator-only, instead of failing with a raw `adb emu` error.

### Changed
- On Android, `rotate` warns when it's used with the home screen in front: Android 16 doesn't keep that turn, and the
  next app reopens in the orientation it was last shown in.
- The platform table lists the permission names each platform lacks (iOS simulator: camera and notifications).

### Docs
- README, the docs site and the agent skill cover the new commands, a locked device, and three new agent rules: check
  `capabilities`, let a screen settle before typing into it, and turn an Android device back with the app in front.

## 0.2.2

### Benchmark
- **A new benchmark against every agent mobile tool** that runs on one Mac: looktap (CLI and MCP), mobile-mcp, Maestro
  MCP, Appium MCP, raw Appium, ios-simulator-mcp, MobileBuildMCP, raw idb and raw adb. The same 12 steps in the
  Settings app on an iPhone simulator and an Android emulator, 10 runs each.
  - A neutral oracle (`idb`, `dumpsys`) decides whether each step worked, not the tool.
  - Each step records the response time, the reaction time on screen, the tool calls and the bytes returned, along with
    each tool's CPU and RAM on the Mac and on the device.
  - Every tool starts on a rebooted device with the Mac idle.
- `BENCHMARK.md` gives the summary; `bench/results/ios.md` and `bench/results/android.md` hold the full per-step data,
  next to the raw JSON. The old Appium-only benchmark and its scripts are removed.
- The README section and the website's benchmark charts show the new results, including where looktap is slower and
  what it can't do.

### Website
- A "Using Claude Code?" box under the kickstart prompt shows the plugin install and `/looktap:setup`.
- Stylesheet and script links carry a content hash (`styles.css?v=…`), so right after a deploy a browser never
  pairs the new page with a cached stylesheet.

## 0.2.1

### Added
- **Claude Code plugin.** `/plugin install looktap --marketplace lakpriya1s/looktap` installs the looktap skill.
  The repo is its own marketplace.
- **`/looktap:setup`.** It installs the CLI (asking first), runs `looktap doctor` and explains each fix, offers to
  boot a simulator or emulator, walks through a real iPhone's one-time steps, and ends with a working `ls`.
- **`@looktap/mcp`.** The MCP server as its own package (`npx -y @looktap/mcp`), listed in the official MCP
  Registry as `io.github.lakpriya1s/looktap`. `npx -y @looktap/cli mcp` keeps working.

### Changed
- `looktap mcp --config` suggests `npx -y @looktap/mcp` for running without installing.
- The plugin is versioned by git commit, so every push reaches users who update.

### Docs
- README and website: a table of which route fits which agent (plugin, skill file, MCP server), and a Claude Code
  plugin section covering what it adds, its token cost and how it updates.

## 0.2.0

The first release as looktap, renamed from simwright.

### Added
- **Real iPhones and iPads.** A small XCUITest runner, signed with your own Apple ID (a free one works), reached
  over USB or Wi-Fi. It's rebuilt and re-signed before a free account's 7-day profile expires.
- **Android types anything.** Text the keyboard can't type, such as emoji and non-Latin scripts, is pasted.
- A device that already has 3 apps from a free Apple account gets an error naming those apps.

### Changed
- Renamed from simwright: published as `@looktap/cli` (the command is `looktap`), with `LOOKTAP_*` environment
  variables and state in `~/.looktap`.
- Taglines say "iPhone and Android devices" instead of "iOS simulator or Android emulator".
- New preview image and README demo GIF.
