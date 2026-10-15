---
name: simwright
description: Drive an iOS simulator or Android emulator from the shell with simwright — read the screen, tap, type, swipe, deep-link, screenshot, record, read logs and crashes, and set permissions, location, dark mode and text size. Use when asked to open, navigate, test, reproduce a bug in, or take screenshots of a mobile app running in a simulator or emulator.
allowed-tools: Bash(simwright:*) Bash(npx simwright:*) Bash(npx -y simwright:*)
---

# Mobile app automation with simwright

`simwright` drives a booted iOS simulator or Android emulator. Every command is one short shell call that
prints a few lines of plain text. Nothing is installed on the device; the helper starts on first use.

## Quick start

```bash
# check the toolchain and see what's booted
simwright doctor
# start the app (id from --app or simwright.config.json)
simwright launch com.example.myapp --ls
# act by label or by @ref from the last screen read, and read the new screen in the same call
simwright tap "Sign in" --ls
simwright fill "Email" sam@example.com --ls
simwright tap @8 --ls
# wait for what the next screen should show, instead of sleeping
simwright wait "Welcome"
# screenshot (only open it when you need to see layout or colours)
simwright shot home --scale 0.5
```

## The loop

Look, act, read the result. `ls` prints one row per element:

```
@1   Button           16, 285 358x54  General
@2   Button           16, 339 358x54  Accessibility
@3   TextField        33, 773 324x38  Search  = Search
```

The columns are: ref, type, x,y, width×height (iOS points / Android dp), label, and `= value` for fields.

Add **`--ls`** to an action and it prints the screen once it has settled, so you don't need a separate `ls`.
It works on `tap`, `longpress`, `zoom`, `tapxy`, `fill`, `type`, `key`, `hidekb`, `swipe`, `back`, `open`,
`launch`, `bio`, `rotate` and `scrollto`. It waits for the screen to change (up to 1.5 s, 6 s for
`launch`/`open`), then for it to stop changing.

**`--ls` stops at a loading skeleton too.** If it shows a heading but none of the content, run
`simwright wait "<text you expect>"` rather than acting on the placeholder.

## Commands

### Look

```bash
simwright ls
# include elements without a label
simwright ls --all
# structured: {screen, elements: [{ref, label, type, x, y, w, h, value}]}
simwright ls --json
# until it's on screen (10 s by default; --wait 30 for longer), or until it's gone
simwright wait "Welcome"
simwright wait "Loading" --gone
# swipe until it's fully on screen; fails at the end of the list
simwright scrollto "Privacy & Security"
simwright scrollto "General" --up
```

### Tap and press

```bash
# a label: exact first, else the one label that starts with / contains it (ambiguous is an error)
simwright tap "General"
simwright tap "Messages" --exact
# a row from the last ls on this device
simwright tap @7
# a point, in the units ls prints; for things ls doesn't list
simwright tapxy 205 874
# hold (default 800 ms): context menus, drag handles, edit modes
simwright longpress "Photo"
simwright longpress @4 1500
simwright longpress 120 470
# two-finger pinch around the centre or a point; --scale is how far the fingers travel (default 2.5)
simwright zoom in
simwright zoom out 200 400 --scale 4
# Android: system Back · iOS: the navigation bar's back button
simwright back
```

### Type

```bash
# focus the field, clear it, type; empty text just clears
simwright fill "Email" sam@example.com
simwright fill @4 ""
# into the focused field
simwright type "@example.com"
# return escape delete tab space; Android also back home KEYCODE_*; iOS also selectall paste
simwright key return
simwright key selectall delete
# dismiss the keyboard; exits 2 if it's still up
simwright hidekb
```

### Swipe and navigate

```bash
# scroll down: the finger moves up (optional 5th argument: duration in ms)
simwright swipe 200 700 200 250
# deep link
simwright open "myapp://orders/42"
# (re)start the app
simwright launch
simwright launch com.example.myapp
# Face ID / fingerprint
simwright bio match
simwright bio nomatch
```

### Screenshots and video

```bash
# saves <out>/<name>.png and prints the path; --scale 0.5 is a quarter of the image tokens
simwright shot checkout
simwright shot checkout --scale 0.5
# Android emulators capture FLAG_SECURE screens by default; --plain shows them black, as on a device
simwright shot payment --plain
# a frame each time the screen changes, for 3 s; duplicates dropped (start it in the background)
simwright burst ./frames 3 &
# a video of everything between start and stop (Android: at most 3 min)
simwright record start checkout
simwright record stop
```

### Logs and crashes

```bash
# the app's log since your last `logs` (first time: the last minute); at most 80 lines, newest kept
simwright logs
simwright logs --errors
simwright logs --grep checkout
simwright logs --since 5m --lines 200
# iOS: keep Apple-framework messages too
simwright logs --all
# crashes, ANRs and low-memory kills since your last `crashes` (first time: the last hour)
simwright crashes
simwright crashes com.example.myapp --since 1h
# which app is in front, and whether the given one is running
simwright app
simwright app com.example.myapp
```

### App state

```bash
# a simulator .app or an .apk (keeps the app's data; --grant: every runtime permission); prints the app id
simwright install build/MyApp.app
simwright install app-debug.apk --grant
simwright uninstall com.example.myapp
# as if freshly installed: data and permissions cleared (iOS keeps the keychain)
simwright reset com.example.myapp
# camera microphone location location-always photos contacts calendar notifications motion all
# (Android also android.permission.*)
simwright permission grant location com.example.myapp
simwright permission revoke photos com.example.myapp
simwright permission reset camera com.example.myapp
```

### Conditions

```bash
# simulated GPS (Android: emulators); `clear` on iOS
simwright location 51.5072 -0.1276
simwright location clear
# no argument prints the current value
simwright appearance dark
simwright appearance light
# xs s m l xl xxl xxxl ax1…ax5 (default l)
simwright textsize ax2
# 9:41, full battery and signal, for screenshots; `live` to undo
simwright statusbar clean
simwright statusbar live
# portrait landscape left right upsidedown; ls, taps and shots follow the turned screen
simwright rotate landscape --ls
# Android only: airplane mode
simwright network offline
simwright network online
# iOS only: a remote notification; plain text, '{json}', or a .json file
simwright push com.example.myapp "Your order has shipped"
simwright push com.example.myapp '{"aps":{"alert":"Hi"},"orderId":7}'
```

### Batch

```bash
# several steps in one call; stops at the first failure and names it
simwright run 'tap General; tap About; wait "iOS Version"; ls'
# one step per line from stdin, # for comments
simwright run - < steps.txt
```

### Devices and setup

```bash
simwright devices
simwright doctor
# start the helper ahead of time (Android: also adb reverse tcp:8081 for Metro); teardown undoes it
simwright setup
simwright teardown
# serve the same commands over MCP, for clients without a shell; --config prints a client config
simwright mcp --config
# print this guide, or install it to ~/.claude/skills/simwright/SKILL.md
simwright skill --install
```

## Options and config

```bash
# with more than one booted device, name the platform (-p, --platform) and/or the device (-d, --device)
simwright -p android ls
simwright -p ios -d 42E41FA7-EA40-45C1-8C6E-13A70BAF1FD6 ls
# where screenshots and videos go (-o, --out; default ./shots)
simwright -o out/run1 shot home
# the app for launch / open / logs / crashes / reset …
simwright --app com.example.myapp launch
# how long tap / fill / back wait for their target (default 3 s)
simwright --wait 10 tap "Continue"
# every command and option: -h or --help · the version: -v or --version
simwright --help
simwright --version
```

Put the app id in `simwright.config.json` at the repo root, so you don't have to pass it every time.
simwright uses the nearest one, walking up from the current folder:

```json
{ "out": "shots", "wait": 3, "ios": { "app": "com.example.myapp" }, "android": { "app": "com.example.myapp" } }
```

Command-line options beat `SIMWRIGHT_*` environment variables, which beat the config file. Passing both `-p` and
`-d` makes every command about 0.2 s faster.

**Exit codes:** `0` OK · `2` usage or not found (bad arguments, no such element, no device) · `1` anything else.
On exit 2, read the message, run `ls`, adjust. Don't retry the same command blindly.

## Targeting elements

- **`@N` refs** come from the most recent `ls`/`--ls` on that device. Use them for unlabelled buttons and
  duplicate labels. A ref whose element moved or vanished is an error, never a wrong tap: run `ls` again.
- **Labels** match exactly first, then a unique prefix or substring. An ambiguous label is an error that lists
  the matches: use more of the label, `--exact`, or a ref.
- **`tapxy x y`** is the last resort, for things `ls` doesn't list.
- **After `rotate`, read the screen again.** Old refs and coordinates are stale.

## Example: sign in and check the home screen

```bash
simwright launch --ls
simwright fill "Email" sam@example.com
simwright fill "Password" "$TEST_PASSWORD"
simwright tap "Sign in"
simwright wait "Home"
simwright shot home --scale 0.5
```

Only with a test account the user gave you. Never type real credentials (see Rules).

## Example: reproduce a bug and collect the evidence

```bash
simwright open "myapp://cart" --ls
simwright tap "Pay" --ls
# right after the step that misbehaved: only what's new is shown
simwright logs --errors
# "warning: … is no longer running" after an action means it crashed or was killed
simwright crashes
simwright shot pay__error
```

On iOS the full crash report is written up to a minute later; run `crashes` again. On Android, `LOW_MEMORY`
means the system killed the app, which isn't a bug in it.

## Example: screenshots in dark mode with large text

```bash
simwright statusbar clean
simwright appearance dark
simwright textsize ax2
simwright launch --ls
simwright shot home__dark_ax2
# set back what you changed
simwright textsize l
simwright appearance light
simwright statusbar live
```

## Example: start from a clean install

```bash
simwright install build/MyApp.app
simwright reset com.example.myapp
simwright permission grant location com.example.myapp
simwright launch --ls
```

## Example: catch a toast or a spinner

```bash
simwright burst ./frames 5 &
simwright swipe 200 250 200 700
wait
```

Then look at the few frames that matter, not all of them.

## Rules

- **Never type real credentials, OTPs or card numbers.** A person signs in, then you take over.
- **Never `burst` or `record` a sign-in or passcode screen.** The frames capture what's typed.
- **Against a live backend every tap is real.** Use the smallest amounts, and undo what you create.
- **`reset` signs the user out** of most apps: ask before resetting an app someone else signed in to.
- **Set back what you change.** Appearance, text size, the status bar, the orientation and the network stay as
  you leave them, for the next person and for other apps.
- **App-state and condition commands need the app id.** They never act on whatever happens to be on screen.
- **If `tap` warns that another element covers the point** (a toast, a banner, a floating bar), the tap
  probably hit that: dismiss it, then tap again.
- **If `ls` says only the status bar is readable**, a system prompt (passcode, permission, alert) is on top.
  `shot` to see it. Never enter a passcode unless the user gave it to you for this device.
- **If `hidekb` exits 2** (iOS search keyboards have no Done key), tap the screen's close or cancel control.
- **Log lines can contain tokens or personal data.** Quote only the lines that matter.

## Installation

If `simwright` isn't on the PATH, use `npx simwright` in every command (or `npx -y simwright` to skip the
prompt). Installing a global package may need the user's approval:

```bash
npm install -g simwright
simwright doctor
```

Needs Node 18+. iOS: macOS with Xcode and a booted simulator. Android: adb, with an emulator or a device.
