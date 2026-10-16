# Benchmark: looktap and every other agent mobile tool

Measured on 2026-10-16 on one Mac (Apple M3 Pro, macOS 26.5.2). Every tool did the same steps in the same system
app, 10 runs each. A neutral checker, not the tool, decided whether each step worked.

The full results for each platform, step by step, with p90s, calls, bytes and notes, are in separate reports:

- **iOS:** [bench/results/ios.md](bench/results/ios.md) (raw data: [ios.json](bench/results/ios.json))
- **Android:** [bench/results/android.md](bench/results/android.md) (raw data: [android.json](bench/results/android.json))

## The tools

| Tool | Version | Platforms | How it was driven |
|---|---|---|---|
| **looktap**, CLI | 0.2.1 | iOS, Android | one shell command per step, as an agent runs it |
| **looktap**, MCP | 0.2.1 | iOS, Android | MCP over stdio (`looktap mcp`) |
| [mobile-mcp](https://github.com/mobile-next/mobile-mcp) | 1.0.11 | iOS, Android | MCP over stdio |
| [Maestro](https://maestro.dev) MCP | Maestro 2.11.0 | iOS, Android | MCP over stdio (`maestro mcp`), steps as inline flows |
| [Appium MCP](https://github.com/appium/appium-mcp) | 1.97.1 | iOS, Android | MCP over stdio |
| Appium | 3.5.2 (xcuitest 12.1.0, UiAutomator2 8.1.0) | iOS, Android | W3C HTTP, the same install Appium MCP uses |
| [ios-simulator-mcp](https://github.com/joshuayoes/ios-simulator-mcp) | 2.1.0 | iOS | MCP over stdio |
| [MobileBuildMCP](https://www.npmjs.com/package/mobilebuildmcp) | 2.7.1 | iOS | MCP over stdio, simulator and ui-automation workflows on |
| idb | fb-idb 1.7.3, idb-companion 1.7.3 | iOS | the CLI, the raw baseline under ios-simulator-mcp |
| adb | platform-tools 36.0.0 | Android | `uiautomator dump` + `input`, the raw baseline |

## Results

**Devices:** iPhone 14 simulator (iOS 26.0) and Pixel 9a emulator (Android 16).

**App:** the system Settings app (no sign-in, nothing real is changed).

**Steps:** launch app, read the screen, tap by label, back, tap x,y, swipe, scroll to a label, fill a field,
screenshot, home, open a URL, terminate the app.

The tables below total the steps every tool on that platform can do, so the totals compare like with like: 8 on iOS,
11 on Android.

- **Reaction time:** until the result was on screen (medians, summed over those steps).
- **Agent time:** the reaction time plus 2 s for each tool call. Each call is one more model round trip, and needing
  fewer calls matters more to an agent than a few milliseconds per call.

### iOS (8 steps: launch, read, tap by label, back, swipe, scroll to label, fill, screenshot)

| Tool | Reaction time | Agent time | Calls | Text returned | Screenshot | Passed | Setup | Tool definitions | RAM peak / mean |
|---|---:|---:|---:|---:|---|---:|---:|---:|---:|
| **looktap CLI** | 5.2 s | **21 s** | **8** | **747 B** | path to a file | 100/100 | 0.5 s | none | 117 / 40 MB |
| **looktap MCP** | 8.5 s | 25 s | **8** | 3.2 KB | 74 KB inline | 100/100 | 0.5 s | 9.7 KB | 148 / 76 MB |
| Maestro MCP | 12 s | 30 s | 9 | 17 KB | 236 KB inline | 120/120 | 18 s | 9.7 KB | 650 / 287 MB |
| Appium MCP | 16 s | 36 s | 10 | 102 KB | 268 KB inline | 120/120 | 29 s | 42 KB | 657 / 275 MB |
| Appium | 17 s | 37 s | 10 | 41 KB | 218 KB inline | 120/120 | 19 s | none | 641 / 239 MB |
| mobile-mcp | 11 s | 39 s | 14 | 24 KB | 41 KB inline | 120/120 | 7.6 s | 29 KB | 226 / 86 MB |
| ios-simulator-mcp | **4.5 s** | 44 s | 20 | 17 KB | path to a file | 106/110 | 1.5 s | 11 KB | 234 / 65 MB |
| MobileBuildMCP | 24 s | 50 s | 13 | 36 KB | 43 KB inline | 100/100 | 3.4 s | 224 KB | 327 / 131 MB |
| idb | 5.4 s | 59 s | 27 | 73 KB | path to a file | 104/120 | **0.2 s** | none | **55 / 17 MB** |

### Android (11 steps: all but terminate)

| Tool | Reaction time | Agent time | Calls | Text returned | Screenshot | Passed | Setup | Tool definitions | RAM peak / mean | On the device |
|---|---:|---:|---:|---:|---|---:|---:|---:|---:|---:|
| **looktap CLI** | **4.4 s** | **28 s** | 12 | **1.2 KB** | path to a file | 110/110 | 0.9 s | none | 93 / 21 MB | 35 MB |
| **looktap MCP** | 13 s | 37 s | 12 | 7.9 KB | 104 KB inline | 110/110 | 0.7 s | 9.7 KB | 102 / 47 MB | 35 MB |
| Appium MCP | 19 s | 49 s | 15 | 126 KB | 230 KB inline | 109/120 | 21 s | 42 KB | 228 / 95 MB | 70 MB |
| Appium | 21 s | 51 s | 15 | 52 KB | 225 KB inline | 112/120 | 17 s | none | 168 / 69 MB | 71 MB |
| Maestro MCP | 38 s | 60 s | **11** | 14 KB | 186 KB inline | 117/120 | 22 s | 9.7 KB | 1569 / 225 MB | 72 MB |
| mobile-mcp | 24 s | 62 s | 19 | 51 KB | 39 KB inline | 120/120 | 11 s | 29 KB | 1361 / 96 MB | not detected |
| adb | 29 s | 63 s | 17 | 154 KB | path to a file | 119/120 | 6.3 s | none | **33 / 12 MB** | 37 MB |

"Passed" counts every step the tool can do, terminate included. "On the device" is the peak RAM of the helpers a tool
keeps inside the emulator.

## What it shows

- **For an agent, the looktap CLI does best on both platforms.** It has the lowest agent time and the least text: 747 B
  for the whole iOS scenario, against 17–102 KB for the MCP servers. It needs the fewest calls on iOS (8); on Android
  Maestro MCP needs one fewer (11 to 12), because its fill is one call. It passed every step it can do, and it is ready
  in under a second.
- **The raw device time is closer.**
  - On iOS, ios-simulator-mcp is faster in total (4.5 s against 5.2 s): its fill takes 0.5 s against looktap's 1.8 s.
    But it needs 20 calls where looktap needs 8, and its swipes sometimes do nothing (7/10).
  - On Android, the looktap CLI is fastest in total. Reading the screen takes 108 ms, against 1.6–5.6 s for the
    others.
- **The looktap MCP is slower per action than the CLI.** Each action waits for the screen to settle and returns it
  (`ls: false` turns that off). That saves a call, but it costs 0.7–1.9 s an action, and on Android it makes the MCP's
  total 13 s against the CLI's 4.4 s. That is the clearest thing for looktap to improve.
- **Screenshots:**
  - The looktap MCP sends a half-size PNG (74–104 KB, about 0.9k image tokens on Android).
  - mobile-mcp sends a smaller JPEG (39–41 KB).
  - Appium and Maestro send full-size images (186–268 KB).
  - The CLIs save a file and return its path.
- **looktap can't do two of the steps.** It has no way to stop an app (`launch` restarts it), and on iOS no home
  button.
- **Some tools reported success when the step didn't happen.**
  - On Android, Appium's `terminateApp` answered success, but Settings was still running 8 s later: 0/10 through Appium
    MCP, 2/10 raw. Maestro's `stopApp` did the same in 2 of 10 runs.
  - On iOS, idb's swipes often did nothing (2/10 raw, 7/10 through ios-simulator-mcp).
- **Setup and footprint:**
  - Appium and Maestro need 17–29 s before the first command, and up to 660 MB of RAM on iOS.
  - On Android, mobile-mcp and Maestro peaked at 1.4–1.6 GB.
  - MobileBuildMCP's tool definitions are 224 KB, sent to the model in every session.

## How it was measured, and how fair it is

- **One scenario, one checker.** Every tool did the same steps. Whether a step worked was decided by a neutral oracle,
  not by the tool: `idb ui describe-all` on iOS; on Android, `dumpsys` (the resumed activity, the fragments, the view
  tree, and the search screen's result list).
- **Driven like an agent.** MCP servers ran over stdio with `tools/call`, and CLIs ran once per step. When a tool can't
  act on a label, the step reads the screen first and acts on what it found, and that read counts as a call.
- **Two times per step.** *Answered in* is until the tool call returned; *reaction time* is until the oracle saw the
  result on screen.
- **Same start for every tool.**
  - Before each tool, the simulator or emulator was rebooted (with its window open), whatever the previous tool left
    running was killed, and the Mac was back at its idle load.
  - On Android, before every run, the device was also back below a load of 1.0.
  - Resets between steps used plain `simctl`/`adb` and were not timed.
- **CPU and RAM:**
  - `ps` every 250 ms on the Mac, over each tool's whole process tree and the helpers it leaves running.
  - On Android, also the device's own `ps` once a second, for helpers inside the emulator.
  - The runner's own commands are left out.
- **Re-runs only for benchmark mistakes.** Four times a step failed because of the benchmark, not the tool. Those
  steps were fixed and run again, and each report lists them with the reason. A step was never re-run because a tool
  failed it.
- **Limits:**
  - looktap's author wrote this benchmark and every adapter (in [`bench/`](bench)), and looktap was developed on this
    app. Corrections from the other tools' authors are welcome.
  - It covers one system app on a simulator and an emulator, not a real app on a real device.
  - The Mac had other apps open; every tool waited for the same idle level before it started.

## Reproduce

```sh
# iOS: one booted simulator; Appium needs a WebDriverAgent built once (xcodebuild build-for-testing ... -derivedDataPath bench/out/wda)
BENCH_IOS_UDID=<udid> BENCH_APPIUM_HOME=<dir with appium + drivers> BENCH_WDA_DERIVED_DATA=$PWD/bench/out/wda \
  node bench/run.mjs ios 10
# Android: one emulator (BENCH_ANDROID_SERIAL, default emulator-5554)
BENCH_APPIUM_HOME=<dir with appium + drivers> node bench/run.mjs android 10
# Tables
node bench/report.mjs ios && node bench/report.mjs android
```

The runner takes a third argument, a comma-separated list of tools (for example `looktap,mobile-mcp`). It also needs
idb with idb-companion, Maestro, and Appium with the xcuitest and UiAutomator2 drivers; the MCP servers come through
`npx`. A full run takes about 1.5 hours per platform.
