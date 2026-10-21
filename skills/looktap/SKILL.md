---
name: looktap
description: Drive iPhone and Android devices (simulators, emulators or real phones) from the shell with looktap — read the screen, tap, type, swipe, deep-link, screenshot, record, read logs and crashes, and set permissions, location, dark mode and text size. Use when asked to open, navigate, test (or write e2e flow tests for), reproduce a bug in, or take screenshots of a mobile app running in a simulator, emulator or on a real device.
allowed-tools: Bash(looktap:*) Bash(npx @looktap/cli:*) Bash(npx -y @looktap/cli:*)
---

# Mobile app automation with looktap

`looktap` drives iPhone and Android devices: simulators, emulators and real phones. Every command is one short shell call that
prints a few lines of plain text. Nothing is installed on simulators, emulators or Android devices; a real iPhone gets a small test runner. The helper starts on first use.

## Quick start

```bash
# check the toolchain, and see what's running or connected (real phones, simulators, emulators)
looktap doctor
looktap devices
# nothing up? boot one by name (looktap devices --all lists them)
looktap boot "iPhone 16 Pro"
# start the app (id from --app or looktap.config.json)
looktap launch com.example.myapp --ls
# act by label or by @ref from the last screen read, and read the new screen in the same call
looktap tap "Sign in" --ls
looktap fill "Email" sam@example.com --ls
looktap tap @8 --ls
# wait for what the next screen should show, instead of sleeping
looktap wait "Welcome"
# screenshot (only open it when you need to see layout or colours)
looktap shot home --scale 0.5
```

## The loop

Look, act, read the result. `ls` prints one row per element:

```
@1   Button           16, 285 358x54  General
@2   Button           16, 339 358x54  Accessibility
@3   TextField        33, 773 324x38  Search  = Search
```

The columns are: ref, type, x,y, width×height (iOS points / Android dp), label, and `= value` for fields (a switch or checkbox: `1` on, `0` off).

Add **`--ls`** to an action and it prints the screen once it has settled, so you don't need a separate `ls`.
It works on `tap`, `longpress`, `zoom`, `tapxy`, `fill`, `type`, `key`, `hidekb`, `swipe`, `back`, `home`,
`open`, `launch`, `bio`, `rotate` and `scrollto`. It waits for the screen to change (up to 1.5 s, 6 s for
`launch`/`open`), then for it to stop changing.

**`--ls` stops at a loading skeleton too.** If it shows a heading but none of the content, run
`looktap wait "<text you expect>"` rather than acting on the placeholder.

## Navigating an app

Most runs that go wrong do so because the agent no longer knows which screen it is on, not because a command
failed. Keep track of that at every step:

1. **Check that each screen change landed.** After a `tap --ls` that should open a screen, check for something only
   that screen has before you act on it: `looktap expect "Order details"`. If it fails, don't press on: `shot`
   and look.
2. **A tap that changed nothing is a failure, not a pause.** Find out why before tapping again, in this order:
   something drawn on top (a toast, a sheet, React Native's LogBox: `tap` names it), the keyboard covering the
   target, the element disabled or still loading, or the wrong one of two same-named elements.
3. **Development builds: dismiss LogBox at the start.** `ls` notes when React Native's warning toast is up. It
   blocks taps across the bottom of the screen, a tab bar included: tap its × (`tap` prints the exact `tapxy`).
   For long sessions ask the developer for `LogBox.ignoreAllLogs()` in test builds.
4. **Mind the keyboard.** Hide it (`hidekb`) before tapping anything in the lower half of the screen. `scrollto`
   swipes above it on its own and stops with a message if it leaves no room. `hidekb` also takes focus from the
   field, which runs validation and can close a search: do it on purpose, not as a reflex.
5. **Tab bars: tap by `@ref`.** A tab often has the same name as a heading on the screen.
6. **Count your way back.** One `back` too many leaves the app. Prefer the screen's own back control, and after
   each one check that you landed where you expected.
7. **When everything is "not found", check the app before the label.** looktap reports a system "isn't
   responding" / "keeps stopping" dialog; a crash or a lock screen looks like an empty screen. Run `looktap app`
   and `looktap crashes`, and only then try again.
8. **Don't hammer a debug build.** Leave a second or two between repeated actions (searches, fills, refreshes) on a
   React Native debug build, especially on a small emulator: a burst of them can make the app stop responding.
9. **The app can come back somewhere else.** A low-memory kill, `textsize`, `appearance` or a crash can restart it
   on its first screen or lock screen. After any of them, read the screen again and expect the entry point.
10. **Get back to the app without restarting it:** `looktap launch <app> --resume`. Plain `launch` restarts it
    from its first screen (and its lock screen), losing where you were.

## Commands

### Look

```bash
looktap ls
# include elements without a label
looktap ls --all
# structured: {screen, elements: [{ref, label, type, x, y, w, h, value}]}
looktap ls --json
# until it's on screen (10 s by default; --wait 30 for longer), or until it's gone
looktap wait "Welcome"
looktap wait "Loading" --gone
# check the screen (waits up to --wait, 3 s); fails with exit 1 and what's there instead
looktap expect "Welcome"
looktap expect "Email" = sam@example.com
looktap expect "Error" --gone
# swipe until it's fully on screen (above the keyboard, when it's up); fails at the end of the list
looktap scrollto "Privacy & Security"
looktap scrollto "General" --up
```

### Tap and press

```bash
# a label: exact first, else the one label that starts with / contains it (ambiguous is an error)
looktap tap "General"
looktap tap "Messages" --exact
# a row from the last ls on this device
looktap tap @7
# a point, in the units ls prints; for things ls doesn't list
looktap tapxy 205 874
# hold (default 800 ms): context menus, drag handles, edit modes
looktap longpress "Photo"
looktap longpress @4 1500
looktap longpress 120 470
# two-finger pinch around the centre or a point; --scale is how far the fingers travel (default 2.5)
looktap zoom in
looktap zoom out 200 400 --scale 4
# Android: system Back · iOS: the navigation bar's back button
looktap back
# the Home button: to the home screen, the app keeps running in the background
looktap home
```

### Type

```bash
# focus the field, clear it, type; empty text just clears
looktap fill "Email" sam@example.com
looktap fill @4 ""
# into the focused field
looktap type "@example.com"
# return escape delete tab space selectall paste home; Android also back KEYCODE_*
looktap key return
looktap key selectall delete
# dismiss the keyboard; exits 2 if it's still up
looktap hidekb
```

### Swipe and navigate

```bash
# scroll down: the finger moves up (optional 5th argument: duration in ms)
looktap swipe 200 700 200 250
# deep link
looktap open "myapp://orders/42"
# (re)start the app
looktap launch
looktap launch com.example.myapp
# bring it back to the front as it was (simulator, emulator, Android phone): no restart, no lost screen
looktap launch com.example.myapp --resume
looktap stop com.example.myapp   # terminate it; waits until the process is gone
# Face ID / fingerprint
looktap bio match
looktap bio nomatch
```

### Screenshots and video

```bash
# saves <out>/<name>.png and prints the path; --scale 0.5 is a quarter of the image tokens
looktap shot checkout
looktap shot checkout --scale 0.5
# Android emulators capture FLAG_SECURE screens by default; --plain shows them black, as on a device
looktap shot payment --plain
# a frame each time the screen changes, for 3 s; duplicates dropped (start it in the background)
looktap burst ./frames 3 &
# a video of everything between start and stop (Android: at most 3 min)
looktap record start checkout
looktap record stop
```

### Logs and crashes

```bash
# the app's log since your last `logs` (first time: the last minute); at most 80 lines, newest kept
looktap logs
looktap logs --errors
looktap logs --grep checkout
looktap logs --since 5m --lines 200
# iOS: keep Apple-framework messages too
looktap logs --all
# crashes, ANRs and low-memory kills since your last `crashes` (first time: the last hour)
looktap crashes
looktap crashes com.example.myapp --since 1h
# CPU (100% = one core), memory and threads of the app (iOS: the footprint Xcode shows; Android: PSS, heaps);
# --for samples once a second, then prints avg/max. --frames: frames and jank since the last --frames (iOS:
# counted from the screen, a real iPhone over its USB cable; the first call only starts counting, so call it
# before the action too).
# A real iPhone goes through Instruments: 10-25 s a reading, --for about every 8 s
looktap perf
looktap perf com.example.myapp --for 10s
looktap perf --frames --json
# cold start, timed: until the app is in front and until its first screen settled (Android: also TotalTime)
looktap launch com.example.myapp --time
# which app is in front, and whether the given one is running
looktap app
looktap app com.example.myapp
# where its files are: iOS the bundle, data folder and app groups (paths on the Mac, so read them directly);
# Android its APKs and data folder (readable with adb shell run-as on debuggable builds)
looktap app com.example.myapp --paths
# what this device can't do (or only in part) and why; --json lists every command's status
looktap capabilities
```

### App state

```bash
# is it installed, and which build? A filter matches part of the id or name (system apps included); exit 1 if none
looktap apps
looktap apps com.example
looktap apps --all --json
# a simulator .app or an .apk (keeps the app's data; --grant: every runtime permission); prints the app id
looktap install build/MyApp.app
looktap install app-debug.apk --grant
looktap uninstall com.example.myapp
# as if freshly installed: data and permissions cleared (iOS keeps the keychain)
looktap reset com.example.myapp
# camera microphone location location-always photos contacts calendar notifications motion all
# (Android also android.permission.*)
looktap permission grant location com.example.myapp
looktap permission revoke photos com.example.myapp
looktap permission reset camera com.example.myapp
```

### Conditions

```bash
# simulated GPS (Android: emulators); `clear` on iOS
looktap location 51.5072 -0.1276
looktap location clear
# no argument prints the current value
looktap appearance dark
looktap appearance light
# xs s m l xl xxl xxxl ax1…ax5 (default l)
looktap textsize ax2
# 9:41, full battery and signal, for screenshots; `live` to undo
looktap statusbar clean
looktap statusbar live
# portrait landscape left right upsidedown; ls, taps and shots follow the turned screen
looktap rotate landscape --ls
# Android only: airplane mode
looktap network offline
looktap network online
# iOS only: a remote notification; plain text, '{json}', or a .json file
looktap push com.example.myapp "Your order has shipped"
looktap push com.example.myapp '{"aps":{"alert":"Hi"},"orderId":7}'
```

### Batch

```bash
# several steps in one call; stops at the first failure and names it
looktap run 'tap General; tap About; wait "iOS Version"; ls'
# one step per line from stdin, # for comments
looktap run - < steps.txt
# flow files (run scripts) as tests: a line per flow, exit 1 if any fails. A failure saves the screen, a
# screenshot, error logs and crashes in <out>/failures/<flow>/. --junit: a report for CI
looktap test flows/ --junit results/junit.xml -o results
# Android: the user uses the phone and each touch is saved as a step (a person drives this one, not you)
looktap codegen flows/checkout.txt com.example.app
```

### Devices and setup

```bash
# what's running or connected: simulator, emulator or real phone (model, OS, USB/Wi-Fi), window or headless,
# and what the user must do for a phone that isn't ready. --all: also what boot can start. --json: structured
looktap devices --all
# boot one by name (UDID or AVD too), wait until it's ready; --window (default) or --headless.
# (Xcode 27.1 shows simulators in Device Hub, one at a time: the user picks it there to watch)
# One that's still starting (devices says so) is waited for: use boot, not an adb/simctl polling loop
looktap boot "iPhone 16 Pro" --window
looktap boot Pixel_9a --headless
looktap shutdown Pixel_9a
looktap devices
looktap doctor
# start the helper ahead of time (Android: also adb reverse tcp:8081 for Metro); teardown undoes it
looktap setup
looktap teardown
# serve the same commands over MCP, for clients without a shell; --config prints a client config
looktap mcp --config
# print this guide, or install it for every coding agent on this machine (Claude Code, Codex, Cursor, Gemini CLI,
# Copilot, OpenCode, …); run it again after upgrading looktap, and doctor says when a copy is out of date
looktap skill --install
# only some agents; or into this repo (.claude/skills and .agents/skills by default) to share it with the team
looktap skill --install --agents claude,cursor
looktap skill --install --project
# which agents looktap knows, which are on this machine, what's installed where; and taking it out again
looktap skill --list
looktap skill --uninstall
```

## Options and config

```bash
# with more than one booted device, name the platform (-p, --platform) and/or the device (-d, --device)
looktap -p android ls
looktap -p ios -d 42E41FA7-EA40-45C1-8C6E-13A70BAF1FD6 ls
# where screenshots and videos go (-o, --out; default ./shots)
looktap -o out/run1 shot home
# the app for launch / open / logs / crashes / reset …
looktap --app com.example.myapp launch
# how long tap / fill / back wait for their target (default 3 s)
looktap --wait 10 tap "Continue"
# every command and option: -h or --help · the version: -v or --version
looktap --help
looktap --version
```

Put the app id in `looktap.config.json` at the repo root, so you don't have to pass it every time.
looktap uses the nearest one, walking up from the current folder:

```json
{ "out": "shots", "wait": 3, "ios": { "app": "com.example.myapp" }, "android": { "app": "com.example.myapp" } }
```

Command-line options beat `LOOKTAP_*` environment variables, which beat the config file. Passing both `-p` and
`-d` makes every command about 0.2 s faster.

**Exit codes:** `0` OK · `2` usage or not found (bad arguments, no such element, no device) · `1` anything else.
On exit 2, read the message, run `ls`, adjust. Don't retry the same command blindly.

## Targeting elements

- **`@N` refs** come from the most recent `ls`/`--ls` on that device. Use them for unlabelled buttons and
  duplicate labels. A ref whose element moved or vanished is an error, never a wrong tap: run `ls` again.
- **Labels** match exactly first, then a unique prefix or substring. An ambiguous label is an error that lists
  the matches: use more of the label, `--exact`, or a ref. The same label in two separate places (a section
  heading and a tab, both "Library") is ambiguous too, even with `--exact`: tap the one you mean by `@ref`.
- **Android text fields** are named by their label or hint, as on iOS, with what's typed as their value
  (`EditText … Search contacts… = pizza`): `fill "Search contacts…"` and `expect "Search contacts…" = pizza` work
  once the field holds text. `fill` reads the field back, types again key by key if a character went missing,
  and exits 1 naming what the field holds if it still doesn't match.
- **`tapxy x y`** is the last resort, for things `ls` doesn't list.
- **After `rotate`, read the screen again.** Old refs and coordinates are stale.

## Example: sign in and check the home screen

```bash
looktap launch --ls
looktap fill "Email" sam@example.com
looktap fill "Password" "$TEST_PASSWORD"
looktap tap "Sign in"
looktap wait "Home"
looktap shot home --scale 0.5
```

Only with a test account the user gave you. Never type real credentials (see Rules).

## Example: reproduce a bug and collect the evidence

```bash
looktap open "myapp://cart" --ls
looktap tap "Pay" --ls
# right after the step that misbehaved: only what's new is shown
looktap logs --errors
# "warning: … is no longer running" after an action means it crashed or was killed
looktap crashes
looktap shot pay__error
```

On iOS the full crash report is written up to a minute later; run `crashes` again. On Android, `LOW_MEMORY`
means the system killed the app, which isn't a bug in it.

## Example: turn what worked into a test

Once a flow works by hand, save its steps as a file the user's CI can run, with `expect` where it should check:

```bash
# flows/sign-in.txt
launch com.example.app
fill Email sam@example.com
tap "Sign in"
wait Welcome
expect "Sign in" --gone
```

Then `looktap test flows/`. Steps are the same commands, one per line, `#` for comments, and `${NAME}` reads an
environment variable (for a test account's password: never write one into the file). A flow that fails names
the step, prints its output, and leaves its evidence under `<out>/failures/`. An app that dies fails the flow.

## Example: screenshots in dark mode with large text

```bash
looktap statusbar clean
looktap appearance dark
looktap textsize ax2
looktap launch --ls
looktap shot home__dark_ax2
# set back what you changed
looktap textsize l
looktap appearance light
looktap statusbar live
```

## Example: start from a clean install

```bash
looktap install build/MyApp.app
looktap reset com.example.myapp
looktap permission grant location com.example.myapp
looktap launch --ls
```

## Example: catch a toast or a spinner

```bash
looktap burst ./frames 5 &
looktap swipe 200 250 200 700
wait
```

Then look at the few frames that matter, not all of them.

## Rules

- **Never type real credentials, OTPs or card numbers.** A person signs in, then you take over.
- **Never `burst` or `record` a sign-in or passcode screen.** The frames capture what's typed.
- **Against a live backend every tap is real.** Use the smallest amounts, and undo what you create.
- **`reset` signs the user out** of most apps: ask before resetting an app someone else signed in to.
- **Set back what you change.** Appearance, text size, the status bar, the orientation and the network stay as
  you leave them, for the next person and for other apps. On Android, turn the orientation back with the app in
  front: a turn made from the home screen doesn't last.
- **Not sure a command works on this device?** `looktap capabilities` says what it can't do, and why. A command
  that can't run exits 2 with the reason, so don't retry it.
- **Let a screen settle before typing into it.** Add `--ls` to the tap that opens it: some screens (search
  screens especially) clear their field just after they open, taking the first letters with them. `fill` reads
  an Android field back and retypes it, but `type` doesn't check: after `type`, confirm with `expect "<field>" = …`.
- **App-state and condition commands need the app id.** They never act on whatever happens to be on screen.
- **`tap` aims at a part of the target nothing covers.** When a toast or bar hides its middle, it taps the
  uncovered part and says `off-centre`. If it warns that another element covers the point, nothing of the target
  was left clear and the tap probably hit that: dismiss it (React Native's LogBox toast: its ×), then tap again.
- **`hidekb` also takes focus from the field** (Android too), so validate-on-blur errors appear after it.
- **After `textsize` or `appearance` on Android**, a note that the app restarted means every ref is stale: `ls`.
- **`shot` says how the image maps to the screen** (on stderr): `216x384 px = 360x640 dp: tapxy x y = image x y ×
  1.667`. Multiply a point read off the image by that factor for `tapxy`.
- **If `ls` says only the status bar is readable**, a system prompt (passcode, permission, alert) is on top.
  `shot` to see it. Never enter a passcode unless the user gave it to you for this device.
- **Measure performance with `perf` and `launch --time`, not by eye.** Simulator numbers are the Mac's CPU and
  memory: compare builds or screens against each other, and say so when you report them. Run `perf --for` while
  the screen does the thing being measured (a scroll, a load), and `perf --frames` just before and right after it.
- **Start with `looktap devices`** to see which devices are real phones and which are simulators or emulators.
  An Android phone on both USB and Wi-Fi is one row (`USB + Wi-Fi`) and is driven over USB.
  A phone marked "not ready" needs the user: tell them exactly what it says (accept the USB debugging prompt, tap
  Trust, turn on Developer Mode). One marked "still starting" needs no one: `looktap boot <name>` waits for it.
- **Use looktap, not adb or simctl, for device and app state:** `boot` instead of polling for boot completion,
  `apps <id>` instead of `simctl listapps` or `pm list packages` to check an app is installed.
- **If a command says the device is locked**, ask the user to unlock it. Don't retry, and never enter a passcode
  unless they gave it to you for this device.
- **If `hidekb` exits 2** (iOS search keyboards have no Done key), tap the screen's close or cancel control.
- **Log lines can contain tokens or personal data.** Quote only the lines that matter.

## Installation

If `looktap` isn't on the PATH, use `npx @looktap/cli` in every command (or `npx -y @looktap/cli` to skip the
prompt). Installing a global package may need the user's approval:

```bash
npm install -g @looktap/cli
looktap doctor
```

Needs Node 18+. iOS: macOS with Xcode and a simulator (`looktap boot` starts one) or a paired iPhone. Android: adb, with
an emulator (`looktap boot` starts one) or a device.
