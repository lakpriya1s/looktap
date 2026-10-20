# Changelog

## Unreleased

### Fixed

- **Android: `--ls` (and `wait`, `tap`, `scrollto`) could read the screen an app had just left.** The helper's node
  cache can lag behind an app (seen after a React Navigation screen change in a React Native app). A screen that
  still looks as it did before the action is now confirmed with a read from the app itself (only then, since that
  read costs ~0.2 s), and polling loops (`wait`, `expect`, a `tap` lookup) read fresh at most once a second after a
  miss.
- **`tap` aims at a part of the target nothing covers.** A toast over part of a button took the tap with no warning:
  the toast's labelled row is smaller than the card that's drawn and takes touches. The tap now goes to the middle of
  the largest uncovered part, counting the whole card, and warns when nothing is left clear. React Native's LogBox
  toast blocks taps across the bottom of the screen (a whole tab bar), so there `tap` warns and prints the `tapxy`
  for its ×.
- **One label in two separate places is ambiguous**, with or without `--exact` (a heading and a tab, both "Library"),
  instead of tapping the first. The error lists both, to choose by `@ref`. Label matching ignores whitespace
  differences (no-break spaces).
- **Android text fields are named by their label or hint, with what's typed as their value**, as on iOS: `ls` lists
  the field rather than a container with the same label, and `fill`, `expect` and `tap` find a field by its hint once
  it holds text.
- **Android `fill` reads the field back.** It waits for the field to hold still before typing (a React Native field
  echoing its clear could wipe the first keys), types again key by key on a mismatch, and exits 1 naming what the field
  holds if a character is still missing. Formatting the field adds (spaces, currency, capitals) still passes.
- **Android `hidekb` takes focus from the field**, so validate-on-blur forms show their errors, as on iOS.

- **`scrollto` swipes above the keyboard.** With the keyboard up its swipes started on the keys, which glide-typed
  into the focused field instead of scrolling. It now swipes in the part of the screen the keyboard leaves, counts
  only what's above the keyboard as found, and stops with a message when the keyboard leaves no room.

- **The crash warning after an action no longer misses a crash caught mid-way.** When the system's "keeps stopping"
  / "isn't responding" dialog about the app is already up but its process hasn't ended yet, the action still warns
  that the app is no longer running (and `test` fails the flow).

### Added

- **The skill installs for every coding agent, not just Claude Code.** `looktap skill --install` finds the agents on
  the machine (Claude Code, Codex, Cursor, Gemini CLI, GitHub Copilot, OpenCode, Antigravity, Kiro, Grok Build,
  Hermes, Pi, Mistral Vibe, Qoder, Rovo Dev, Trae) and writes the skill into each one's skills folder, with the
  frontmatter that agent accepts. `--agents` picks them, `--project` writes into the repo for the team,
  `--list` shows what's installed where, `--uninstall` takes it out. Each copy carries looktap's version, and
  `doctor` says when one is out of date.
- `launch --resume` brings a running app back to the front as it was, without restarting it (simulators and
  Android).
- `ls`, and a `tap` that can't find its target, say when a system "isn't responding" / "keeps stopping"
  dialog is on screen. `ls` also notes React Native's LogBox toast, which blocks taps around it.
- The skill has a "Navigating an app" section: check each screen change, what a tap that changed nothing means,
  the keyboard, tab bars, getting back, frozen apps.
- `ls --all` folds a react-native-svg drawing into one row: `SvgView … (svg, 9 shapes)`.
- `textsize` and `appearance` note when Android restarted the app in front for the change (refs are stale).
- `shot` prints how the image maps to the screen on stderr: `216x384 px = 360x640 dp: tapxy x y = image x y × 1.667`.

## 0.6.1

### Added
- **MCP: a `perf` tool.** CPU, memory and threads, or with `frames: true` the frames and jank since the last call, and
  `for: <seconds>` to sample. It was reachable through the general `looktap` tool; as its own tool, clients show it to
  the model by name. The server's instructions now say to measure with it rather than guess.
- **`@looktap/mcp` 0.6.1** requires `@looktap/cli` 0.6.1, so an MCP client that cached an older pair picks up `perf`.

### Changed
- The website's address is https://lakpriya.com/looktap/ everywhere: the package pages, the MCP registry entry, the
  Claude plugin, the README, and the site's own canonical and preview links (the old address redirects there).

## 0.6.0

### Added
- **`perf [app]`** reads the app's CPU (100% is one core), memory and threads. On the iOS simulator it reads the
  memory footprint Xcode's gauge shows and its peak, from the Mac's own tools; on Android PSS, RSS, Java and native
  heap. On a real iPhone it reads CPU, footprint and threads through Instruments' Activity Monitor (`xcrun xctrace`,
  part of Xcode): 10–25 s a reading. `--for 10s` takes a reading each second (a real iPhone: about every 8 s), then
  prints the average and maximum. `--json` for scripts.
- **`perf --frames`**: frames since the last call, the janky share and p50–p99 frame time. Android reads the app's
  own render times and why frames were late (slow UI thread, missed deadline, input latency). The iOS simulator
  counts frames as its screen shows them: the helper watches the framebuffer, snapped to the 60 Hz display, and adds
  fps while moving and the longest stall (Instruments' Animation Hitches doesn't support the simulator). A real
  iPhone does the same from its USB screen feed (the capture device QuickTime uses), compared frame by frame;
  refreshes the feed itself skipped are reported as unknown.
- **`launch --time`** times a cold start, from the start command (after the old copy is stopped) until the app is in
  front and until its first screen settled. Android adds the system's own `TotalTime`. When screen reads are slow
  (right after a launch they can take a second), it says how much sooner the screen may have settled.

- **An Android phone on both USB and Wi-Fi is one phone.** adb lists it twice, so `devices` showed two rows and
  every command without `-d` stopped with "2 android devices". Now it's one row (`USB + Wi-Fi`), commands drive it
  over USB, and `-d` with the Wi-Fi id still picks Wi-Fi. `--json` keeps that id as `wifiId`.

### Fixed
- **Android: a phone that was unplugged (or lost its Wi-Fi connection) read as "app is not installed"** or "not
  running", because adb's "device not found" came back as an empty answer. Every Android command now says the device
  isn't connected any more.

### Changed
- iOS simulator `launch` stops the old copy first, then starts the app (it was one `simctl` call).

## 0.5.1

### Added
- **`apps [filter] [--all] [--json]`** lists the installed apps: id, name (iOS) and version, with `--all` the system's
  own apps too. A filter matches part of the id or name and exits 1 when nothing matches, so `looktap apps com.example`
  answers "is it installed?" without `simctl listapps` or `pm list packages`.
- **`app [app] --paths`** prints where the app's files are. iOS simulator: its bundle, data folder and app groups, as
  paths on the Mac. Android: its APKs and data folder, and whether `run-as` can read it (debuggable builds only).

### Fixed
- **`boot` waits for a simulator or emulator that's still starting** instead of returning at once or starting a second
  copy: an emulator adb still lists offline, one whose Android hasn't finished booting, a simulator still booting.
- **`devices` lists a starting emulator as starting,** not as an offline phone to reconnect.
- **iOS: web pages could be missing from `ls`.** Web content is drawn by another process, and looktap hit-tested only
  three points down the middle of the screen to decide whether to look for it. A short page whose content sat near the
  top or to one side wasn't seen at all, and a field on it read back empty. The check now also probes a sparse
  grid, counting only content another process draws, so the full scan still runs only for web pages and sheets:
  other screens cost a few milliseconds more per read.
- **iOS simulator: `fill` could lose text in a web field.** WebKit drops keys typed while it applies an autocorrection,
  so `sam_kim@example.com` could end up as `sam_kim`. `fill` now reads the field back and, if it doesn't hold the text,
  pastes it instead, then empties the clipboard again.

## 0.5.0

### Added
- **`expect`** checks the screen: `expect "Welcome"` (on screen), `expect "Email" = sam@example.com` (its value),
  `expect "Error" --gone`. It waits up to `--wait` (3 s) for it to come true, and fails with exit 1 and what's
  there instead: `expect failed: "Email" is "sam@example.com", expected "kim@example.com"`.
- **`test <flow|dir> …`** runs flow files (`run` scripts, one step per line) as tests: a line per flow and the totals,
  exit 1 if any fails. A failed flow prints its output and leaves `error.txt`, `output.txt`, `screen.txt`,
  `screen.png`, and the app's error logs and crashes in `<out>/failures/<flow>/`. An app that dies during a flow fails
  it. `--junit <file>` writes a JUnit XML report for CI. The README has GitHub Actions jobs for iOS and Android.

- **`codegen <flow-file> [app]`** (Android) records a flow while you use the phone: it restarts the app, then saves
  each touch as the step that replays it — a tap by label (or `tapxy` where no label leads back), one `fill` per field
  with its final text, `scrollto` for a scroll that brought a row into view, `longpress`, `zoom`, and the navigation
  bar's or gesture navigation's `back` and `home`. Commands typed while it records (`expect …`) are run and saved;
  `undo` drops the last step. Text typed into a password field is saved as `${NAME}`, read from the environment.
  `LOOKTAP_DEBUG=1` prints each touch it sees.
- Flow files run by `test` can read environment variables: `${NAME}` (not inside single quotes).
- The Android helper reports which nodes are clickable, editable or password fields, a field's hint, and the
  on-screen windows (`codegen` uses them).

### Fixed
- `ls` after `stop` no longer warns that the stopped app is no longer running.
- **Android `launch` could come back on another app's screen:** a screen from another package left in the app's task
  (Settings' search is one) came back on top after the restart. The app now starts in a fresh task.

## 0.4.1

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
