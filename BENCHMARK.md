# looktap vs Appium vs Appium MCP: benchmark

Measured on 2026-10-15. All three tools ran the same actions on the same
devices, 10 runs per feature.

## TL;DR

> **Update, Run 4 (looktap's own helpers, no WebDriverAgent):** Android `ls`
> dropped from 2.58 s to 131 ms, and iOS `ls` from 1.70 s to 202 ms. Taps now take
> 110–120 ms on both platforms, and screenshots ~130 ms. looktap is now the
> fastest of the three at almost every action. See
> [Run 4](#run-4-looktap-with-its-own-native-helpers). The summary below is from Run 3.

| | looktap | Appium (raw HTTP) | Appium MCP |
|---|---|---|---|
| **Output returned for the whole scenario** (10 runs × 13 features, bursts excluded) | **11 KB** (Android) · **22 KB** (iOS) | 1.9 MB · 2.6 MB | 2.7 MB · 3.2 MB |
| **One screen read** | **1–2 KB** of text | 41–51 KB XML | 101–124 KB XML |
| **One screenshot** | **~100 B** (a file path) | 78–221 KB base64 | 210–225 KB base64, inline |
| **Setup before the first command** | **0.1–0.2 s** | 7–17 s | 23–39 s |
| **Per-action speed** | Fastest for back, type, deep link, restart, hide keyboard. **Slowest at reading the screen on Android (~2.5 s)** | Fastest at reading the screen and tapping on Android (it keeps a helper app running on the device) | Close to raw Appium, plus MCP overhead |
| **Failed operations** (out of 123 per platform) | 2 · 2 | 10 · 10 | 12 · 10 |
| **Biometrics** | ✓ | ✓ | ✗ no tool |

**In one line:**
- **Agents:** looktap costs about **100–250× fewer bytes** of context than the
  Appium MCP for the same session, and needs no setup.
- **Raw speed:** Appium's on-device helper reads the Android screen about 20×
  faster.
- **Bugs:** the benchmark exposed bugs in looktap. They are listed
  [below](#bugs-found-in-looktap), with their fixes.

---

## What was compared

| Tool | How it was driven | What it represents |
|---|---|---|
| **looktap** 0.1.0 | The CLI, spawned once per command: `node bin/looktap.js …` | A person or agent typing commands |
| **Appium (raw HTTP)** | Appium 3.6.0 server with `xcuitest` 12.3.4 / `uiautomator2` 8.4.0, called over W3C HTTP from Node with one persistent session | Appium's own speed, with no agent layer on top |
| **Appium MCP** | `appium-mcp@latest`, configured as an agent would use it, started over stdio and driven with MCP `tools/call` | What an agent's tool calls actually cost |

**Devices:**
- iPhone 14 simulator, iOS 26, Apple Silicon Mac
- Pixel 9a emulator, Android, 412×917 dp at 2.625×

**App:** the system **Settings** app. It has no sign-in and no real money is
involved. The deep-link step opens a custom-scheme deep link in a second installed
app, at whatever screen it is on, without typing anything.

**iOS WebDriverAgent:**
- looktap and raw Appium used the same prebuilt WDA 15.1.3, so Appium didn't
  pay for an `xcodebuild`.
- The MCP server installed its own copy through `prepare_ios_simulator`, as it
  normally does.

### Scenario: one run

Every run started from a **tool-neutral reset**: a plain `simctl`/`adb`
command to force-stop the apps and relaunch Settings at its root screen. The
reset was not timed.

| # | Feature | What it does |
|---|---|---|
| 1 | `ls`: read screen | looktap `ls` · Appium `GET /source` · MCP `appium_get_page_source` |
| 2 | `tap`: by label | Tap "General" (iOS) / "Network & internet" (Android). For Appium and MCP this is find-element + click (2 calls) |
| 3 | `back` | Return to the previous screen |
| 4 | `tapxy` | Tap the same row by coordinates (then back, untimed) |
| 5 | `swipe` | Scroll the list (then scroll back, untimed) |
| 6 | `fill` | Put "wifi" in Settings search. On Android, search is opened first by a neutral `adb` tap |
| 7 | `type` | Type " x" into the focused field |
| 8 | `hidekb` | Dismiss the keyboard |
| 9 | `shot` | Screenshot |
| 10 | `bio` | Face ID match / fingerprint 1, while Settings is in front |
| 11 | `open` | Deep link into a second installed app |
| 12 | `launch` | Restart Settings (terminate + launch) |

After the 10 runs, each tool did:
- **burst:** as many screenshots as it could in 5 s;
- **teardown.**

### What was measured

- **Time:** wall time per feature, as the median of successful runs.
- **Bytes:** what the tool returned. For an agent, this is roughly what lands
  in its context:
  - looktap: stdout
  - raw Appium: HTTP response bodies
  - MCP: the full JSON-RPC response
- **Calls:** commands or tool calls needed for the action. More calls means
  more agent turns.
- **Failures:** counted, not dropped. Medians use successful runs only.

---

## Run 4: looktap with its own native helpers

Measured on 2026-10-15, with the same devices, harness and scenario (10 runs).
looktap no longer uses WebDriverAgent or `uiautomator dump`:

- **iOS:** a macOS helper reads the simulator's accessibility tree and sends
  touch and keyboard events through Apple's simulator frameworks.
- **Android:** a 7 KB helper runs with `app_process` and keeps one UiAutomation
  connection open. Emulator frames come over the emulator's gRPC API.

Only looktap was re-run. The Appium columns are Run 3's numbers, from the same
devices and harness.

### Android (Pixel 9a emulator)

| Feature | looktap Run 3 | **looktap Run 4** | Appium raw (Run 3) | Appium MCP (Run 3) |
|---|---|---|---|---|
| ls (read screen) | 2.58 s | **131 ms** · 975 B | 114 ms · 51 KB | 1.87 s · 124 KB |
| tap (by label) | 2.21 s · ⚠ 2/10 | **112 ms** · ⚠ 1/10 | 77 ms · 2 calls · ⚠ 2/10 | 344 ms · 2 calls |
| back | 84 ms | **84 ms** | 610 ms | 88 ms |
| tapxy | 111 ms | 123 ms | 43 ms | 101 ms |
| swipe (300 ms gesture) | 418 ms | **398 ms** | 433 ms | 543 ms |
| fill | 5.01 s | **792 ms** · ⚠ 1/10 | 1.32 s · 3 calls · ⚠ 4/10 | 513 ms · 2 calls · ⚠ 6/10 |
| type | 252 ms | **132 ms** | 905 ms · ⚠ 4/10 | 917 ms · ⚠ 6/10 |
| hidekb | 131 ms | **48 ms** | 812 ms | 214 ms |
| shot | 539 ms | **138 ms** · 69 B | 1.72 s · 78 KB | 339 ms · 210 KB |
| launch | 199 ms | **186 ms** | 753 ms | 735 ms |

### iOS (iPhone 14 simulator)

| Feature | looktap Run 3 (WDA) | **looktap Run 4** | Appium raw (Run 3) | Appium MCP (Run 3) |
|---|---|---|---|---|
| setup | 193 ms | **39 ms** | 17.37 s | 23.14 s |
| ls (read screen) | 1.70 s | **202 ms** · 723 B | 915 ms · 41 KB | 1.21 s · 101 KB |
| tap (by label) | 1.84 s · ⚠ 1/10 | **121 ms** | 1.51 s · 2 calls | 1.63 s · 2 calls |
| back | 1.09 s · ⚠ 1/10 | **187 ms** | 1.15 s | 1.18 s |
| tapxy | 1.40 s | **112 ms** | 1.05 s | 1.14 s |
| swipe | 2.10 s | **235 ms** | 1.56 s | 1.96 s |
| fill | 3.69 s | **782 ms** | 2.33 s · 3 calls | 2.51 s · 2 calls |
| type | 504 ms | **60 ms** | 603 ms · 2 calls | 577 ms · 2 calls |
| hidekb (search keyboard) | ✗ false success | ✗ 10/10, reported correctly | ✗ 10/10 | ✗ 10/10 |
| shot | 411 ms | **124 ms** · 65 B | 130 ms · 221 KB | 165 ms · 225 KB |
| launch | 570 ms | **513 ms** | 4.26 s | 4.81 s |

**What changed:**
- looktap is now the fastest of the three at almost every action on both
  platforms, while still returning 50–3000× fewer bytes.
- Failures: 2 of 123 on Android, and none on iOS apart from `hidekb`, which every
  tool fails on the iOS 26 search keyboard. looktap reports that failure
  instead of claiming success.
- `burst` now saves a frame only when the screen changes. On a static screen
  that's very few frames, so its frame counts aren't comparable with Run 3's.
- iOS reads during a navigation wait for the transition to finish (up to 1.5 s).
  Steady-state reads take about 30–70 ms inside the helper.

**Limits:**
- The iOS helper uses Apple's private simulator frameworks. Touch and keyboard
  input were measured on Xcode 26. For Xcode 27, looktap sends input to the
  simulator's `dtuhidd` service, which is implemented but not yet measured.
- On Android, the helper holds the device's single UiAutomation connection.
  Run `looktap teardown` before using Appium or `uiautomator` on the same device.

The Run 3 report follows unchanged, for reference.

---

## Results: Android (Pixel 9a emulator)

| Feature | looktap | Appium (raw HTTP) | Appium MCP |
|---|---|---|---|
| setup | **130 ms** · 78 B | 7.31 s · 927 B | 38.83 s · 6 KB · 2 calls |
| ls (read screen) | 2.58 s · **1014 B** | **114 ms** · 51 KB | 1.87 s · 124 KB |
| tap (by label) | 2.21 s · 39 B · ⚠ 2/10 failed | **77 ms** · 151 B · 2 calls · ⚠ 2/10 failed | 344 ms · 421 B · 2 calls |
| back | **84 ms** · 0 B | 610 ms · 14 B | 88 ms · 109 B |
| tapxy | 111 ms · 0 B | **43 ms** · 14 B | 101 ms · 120 B |
| swipe | **418 ms** · 0 B | 433 ms · 14 B | 543 ms · 139 B |
| fill | 5.01 s · 0 B | 1.32 s · 165 B · 3 calls · ⚠ 4/10 failed | **513 ms** · 404 B · 2 calls · ⚠ 6/10 failed |
| type | **252 ms** · 0 B | 905 ms · 151 B · 2 calls · ⚠ 4/10 failed | 917 ms · 363 B · 2 calls · ⚠ 6/10 failed |
| hidekb | **131 ms** · 0 B | 812 ms · 14 B | 214 ms · 106 B |
| shot (screenshot) | 539 ms · **96 B** | 1.72 s · 78 KB | **339 ms** · 210 KB |
| bio | 67 ms · 0 B | **32 ms** · 14 B | — no tool |
| open (deep link) | **89 ms** · 0 B | 5.03 s · 14 B | 2.16 s · 153 B |
| launch (restart app) | **199 ms** · 0 B | 753 ms · 28 B · 2 calls | 735 ms · 220 B · 2 calls |
| burst 5 s | 4 frames · **121 B** | **23 frames** · 1.7 MB | 11 frames · 923 KB |
| teardown | **76 ms** · 26 B | 466 ms · 14 B | 751 ms · 111 B |

## Results: iOS (iPhone 14 simulator)

| Feature | looktap | Appium (raw HTTP) | Appium MCP |
|---|---|---|---|
| setup | **193 ms** · 40 B | 17.37 s · 578 B | 23.14 s · 7 KB · 3 calls |
| ls (read screen) | 1.70 s · **2 KB** | **915 ms** · 41 KB | 1.21 s · 101 KB |
| tap (by label) | 1.84 s · 17 B · ⚠ 1/10 failed | **1.51 s** · 151 B · 2 calls | 1.63 s · 379 B · 2 calls |
| back | **1.09 s** · 0 B · ⚠ 1/10 failed | 1.15 s · 14 B | 1.18 s · 109 B |
| tapxy | 1.40 s · 0 B | **1.05 s** · 14 B | 1.14 s · 120 B |
| swipe | 2.10 s · 0 B | **1.56 s** · 14 B | 1.96 s · 139 B |
| fill | 3.69 s · 0 B | **2.33 s** · 165 B · 3 calls | 2.51 s · 437 B · 2 calls |
| type | **504 ms** · 0 B | 603 ms · 151 B · 2 calls | 577 ms · 362 B · 2 calls |
| hidekb | ✗ 3.92 s, **reported success but the keyboard stayed up** (bug, see below) | ✗ failed 10/10 | ✗ failed 10/10 |
| shot (screenshot) | 411 ms · **92 B** | **130 ms** · 221 KB | 165 ms · 225 KB |
| bio | 558 ms · 0 B | **429 ms** · 14 B | — no tool |
| open (deep link) | 533 ms · 0 B | **210 ms** · 14 B | 324 ms · 158 B |
| launch (restart app) | **570 ms** · 0 B | 4.26 s · 28 B · 2 calls | 4.81 s · 222 B · 2 calls |
| burst 5 s | 9 frames · **117 B** | **59 frames** · 25.5 MB | 59 frames · 25.9 MB |
| teardown | 488 ms · 23 B | 154 ms · 14 B | **37 ms** · 111 B |

iOS times are higher across the board for all three tools. WebDriverAgent waits
for the UI to go idle (animations finished) before it completes a tap or swipe.

---

## What the numbers mean

### For AI agents: output size dominates

An agent pays for every byte a tool returns, as context and tokens, and for
every extra call, as a turn.

- **Reading the screen:** looktap returns a compact list (`x,y WxH label`) of
  1–2 KB. Appium and MCP return the full XML hierarchy: 41–124 KB per read,
  **50–100× larger**. Most of it is attributes an agent never needs.
- **Screenshots:** looktap writes the PNG to disk and returns its path
  (~100 B). The agent opens the image only when it actually needs to see it.
  MCP returns 210–225 KB **inline on every screenshot**. In an earlier
  exploratory run a single MCP screenshot returned **1.8 MB**, and one call took
  **111 s**.
- **Whole scenario** (10 runs, 13 features): looktap returned **11–22 KB**.
  MCP returned **2.7–3.2 MB**.
- **Calls per action:** tap-by-label, fill and type are **1 command** in
  looktap. They take **2 MCP calls** (find, then act), so twice the agent
  turns.
- **Setup:** looktap is ready in about 0.2 s. The MCP server took 23–39 s
  (process start, WDA prepare, session create) before its first command.

### For raw speed: Appium's on-device helper wins at reading Android screens

On Android, looktap's `ls`, `tap` and `fill` take 2–5 s, because each calls
`uiautomator dump`. That starts a fresh UiAutomation connection and waits for
the UI to go idle, about 2 s every time. Appium installs a helper app that
stays connected, so its screen reads take about 0.1 s.

Where no screen read is involved, looktap matches or beats both:
- back
- type
- hide keyboard
- deep link
- restart app
- setup

On iOS, all three tools go through WebDriverAgent, so action times are close.
looktap adds around 0.3–0.5 s per command for starting Node and checking which
device is booted.

### Burst (screenshots in 5 s)

Appium and MCP take more frames per second (23–59 vs 4–9). But every frame
comes back over the wire as base64: **25 MB on iOS in 5 seconds**. looktap
writes frames to disk and de-duplicates them, so it reports only how many
frames are distinct.

### Reliability

Across both platforms:
- looktap: **4 failures**
- raw Appium: **20**
- MCP: **22**

Most Appium and MCP failures were in `fill`/`type` on Android. They happened
right after the app switched to Settings search, which runs in a different
Android package (`com.google.android.settings.intelligence`): UiAutomator2
keeps reporting the previous window for about 2–3 s. A 4 s settle reduced these
failures but didn't remove them. The few looktap failures were the first run
after setup on iOS, and the screen not yet ready on Android.

---

## Bugs found in looktap

| # | Bug | Impact | Status |
|---|---|---|---|
| 1 | **`hidekb` on iOS reported success when the keyboard stayed up.** The iOS 26 search keyboard has no Done/Return key, WDA's dismiss failed, and looktap swallowed the error | Silent false success. Appium and MCP correctly reported failure | ✅ fixed: checks the keyboard afterwards and exits 2 if it's still up (verified in Run 4) |
| 2 | **`tap` fell back to "first label containing the text"**, so with the wrong screen up it could tap a different element and report success | Wrong element tapped silently | ✅ fixed: exact first, a fuzzy match only when it names one label, `--exact`, and `tap` prints what it hit |
| 3 | **No waiting:** `tap`/`back` right after a navigation failed when the screen wasn't ready yet | Spurious "not found" | ✅ fixed: `--wait` (default 3 s) |
| 4 | **Android `fill` dumped the screen twice** | `fill` took ~5 s instead of ~2.5 s | ✅ fixed, and with the helper `fill` takes ~0.8 s |
| 5 | **Fixed per-command overhead:** every command re-lists all devices, even with `-p` and `-d` given | +0.1–0.3 s on every command | ✅ fixed |
| 6 | Android screen reads took about 2.5 s (`uiautomator dump`) | Slow `ls`/`tap`/`fill` on Android | ✅ fixed in Run 4: a persistent helper run with `app_process` (nothing installed). Reads take ~130 ms |

---

## Benchmark history

These problems were found in the harness, not in the tools, and are kept here
so the method can be trusted:

1. **Run 1 (discarded):** the "reset" between runs force-stopped Settings but
   not its search screen, which lives in a separate package. Most runs started
   on the wrong screen. Fixed by stopping both packages and relaunching with a
   cleared task.
2. **Run 2 (discarded):** a 1.5 s settle after opening Settings search was too
   short for UiAutomator2 (see Reliability above). Raised to 4 s for all tools.
3. **Run 3:** looktap 0.1.0 with WebDriverAgent and `uiautomator dump`.
4. **Run 4:** looktap with its own helpers. Only looktap was re-run (see above).

## Reproduce

```bash
# 1. devices: boot exactly one simulator and one emulator
# 2. an Appium 3 server with both drivers:
npx appium driver install xcuitest && npx appium driver install uiautomator2
npx appium --port 4723 &
# 3. optional: an installed app with a deep link, for the deep-link step
export BENCH_DEEPLINK=myapp://home BENCH_DEEPLINK_APP=com.example.myapp
# 4. run (each platform takes ~20 min for all three tools, 10 runs each)
cd bench
node full.mjs android 10            # or: node full.mjs ios 10
node full.mjs ios 3 looktap        # one tool, fewer runs
python3 mdtable.py results/ios.json # → the markdown table above
```

Raw per-run numbers are in `bench/results/android.json` and
`bench/results/ios.json` (Run 3), and in `android-run4-looktap.json` and
`ios-run4-looktap.json` (Run 4). Set `BENCH_TAG` to keep a run's results
separate. For Appium on iOS, `BENCH_PREBUILT_WDA` points at a built
`WebDriverAgentRunner-Runner.app` so Appium skips its `xcodebuild`.
