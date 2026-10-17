# Changelog

## Unreleased

- **`looktap stop [app]`** terminates an app on both platforms (iOS simulator: `simctl terminate`, Android:
  `am force-stop`, real iPhones: `devicectl`). It prints "stopped" only once the app's process is gone, and says when
  the app wasn't running.
- **Android `key selectall` and `key paste`**, as on iOS. Select-all is Ctrl+A; paste uses the focused field's paste
  action first (WebViews ignore the paste key), else the paste key. Without the helper, select-all needs Android 13+.
- **`looktap home`** presses the Home button on both platforms; on the iOS simulator it's the hardware Home button
  event, which the simulator had no way to send before. It prints "home screen" only once the home screen is in front,
  and names the app it left running. `key home` now works on iOS too, and `home` takes `--ls`.
- **`looktap capabilities [--json]`** says what the device in use can't do, or can only in part, and why. One table
  (`lib/capabilities.js`) now drives it, the errors those commands throw, and a new README section, "Platform
  support", that compares the iOS simulator, real iPhones, the Android emulator and Android devices.
- `bio` on an Android device now says it's emulator-only, instead of failing with a raw `adb emu` error.

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
