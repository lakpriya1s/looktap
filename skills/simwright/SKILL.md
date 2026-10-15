---
name: simwright
description: Drive an iOS simulator or Android emulator from the shell with simwright — read the screen, tap, type, swipe, deep-link, screenshot. Use when asked to open, navigate, test, reproduce a bug in, or take screenshots of a mobile app running in a simulator or emulator.
---

# simwright

`simwright` drives a booted iOS simulator or Android emulator. Every command is one short shell call that
prints a few lines of text. Nothing is installed on the device. Its helper starts on first use.

## The loop

1. **Look:** `simwright ls` lists what's on screen, one row per element:

   ```
   @1   Button           16, 285 358x54  General
   @2   Button           16, 339 358x54  Accessibility
   @3   TextField        33, 773 324x38  Search  = Search
   ```

   The columns are: ref, type, x,y, width×height (iOS points / Android dp), label, and `= value` for fields.
2. **Act, and see the result in the same call** with `--ls`:

   ```bash
   simwright tap @1 --ls            # tap the row from the last ls, then print the settled screen
   simwright tap "General" --ls     # or by label
   simwright fill @3 "wifi" --ls
   ```

3. Repeat. Read the `--ls` output instead of running `ls` again.

## Choosing a target

- **`@N` refs** come from the most recent `ls`/`--ls` on that device. Use them for unlabelled buttons and
  duplicate labels. A ref whose element moved or vanished is an error, never a wrong tap. If that happens, run `ls` again.
- **Labels** match exactly first, then a unique prefix/substring. An ambiguous label is an error: use more
  of the label, `--exact`, or a ref.
- **`tapxy x y`** is the last resort, for things `ls` doesn't list. Use the units `ls` prints.

## Don't sleep, wait

```bash
simwright wait "Welcome"               # until it appears (10 s default; --wait 30 for longer)
simwright wait "Loading" --gone        # until it disappears
simwright scrollto "Privacy & Security"   # swipe until it's fully on screen (--up to go back)
```

`tap`, `fill` and `back` already wait up to 3 s for their target.

**After an action that loads data, wait for what you expect.** `--ls` returns once the screen stops
changing, and a loading skeleton (grey placeholder bars) stops changing too. If `--ls` shows a heading but
none of the content, run `simwright wait "<text you expect>"` rather than acting on the placeholder.

## Several known steps in one call

```bash
simwright run 'tap General; tap About; wait "iOS Version"; ls'
```

`run` stops at the first failing step and names it. Use it for paths you already know. Explore one step at a
time.

## Screenshots

`simwright shot <name>` saves a PNG and prints its path. Don't open the image unless you need to *see* it
(layout, colours, images). `ls` already tells you what's on screen. When you do look, use
`--scale 0.5`: it's a quarter of the image tokens and still readable.

## When something goes wrong

```bash
simwright logs --errors        # the app's errors since your last `logs` (first time: the last minute)
simwright logs --grep checkout # everything it logged that matches; --since 5m for a fixed window
simwright crashes              # crash reports / ANRs / low-memory kills since your last `crashes`
simwright app                  # which app is in front, and its pid
```

- **Each `logs` shows only what's new**, so run it right after the step that misbehaved. You don't have to
  remember timestamps.
- **A warning that the app "is no longer running"** means it crashed or was killed. It comes after an
  action or at the next `ls`. Run the `crashes` command it names. On iOS, run it again a minute later for the
  full report.
  - On Android, `LOW_MEMORY` means the system killed the app. That's not a bug in the app; relaunch it.
- The app defaults to `--app`/config, else the one in front. Pass the id when the app is gone: `simwright crashes com.example`.
- Log lines can contain tokens or personal data. Quote only the lines that matter.

## Starting from a known state

```bash
simwright install build/MyApp.app        # or an .apk; prints the app id
simwright reset com.example.app          # fresh-install state: data and permissions cleared
simwright permission grant location com.example.app   # also revoke / reset; camera, photos, microphone, …
```

Conditions: `location <lat> <lon>` · `appearance dark|light` · `textsize xxl|ax2|default` ·
`statusbar clean|live` (9:41 for screenshots) · `push <app> "text"` (iOS only) ·
`rotate landscape|right|portrait` · `network offline|online` (Android only).

- **Set back what you change.** Appearance, text size, the status bar, the orientation and the network stay as
  you leave them, for the next person and for other apps.
- **After `rotate`, read the screen again.** `ls`, taps and shots follow the turned screen, so old @refs and
  coordinates are stale. If the app doesn't support the orientation, `rotate` says so and nothing turns.
- **`reset` signs the user out** of most apps: ask before resetting an app someone else signed in to.
- These commands need the app id. They never act on whatever happens to be on screen.

## Other commands

`longpress <label|@ref|x y> [ms]` · `zoom in|out [x y]` (two-finger pinch) · `type <text>` (into the focused field) · `key return|escape|delete|tab|space` · `hidekb` · `swipe x1 y1 x2 y2 [ms]` · `back` · `open <url>` (deep
link) · `launch [app]` · `bio match|nomatch` · `burst <dir> <seconds>` (frames of a transient state) ·
`record start [name]` … `record stop` (a video of what happens in between) · `devices` · `doctor`. Pass `-p ios|android` and `-d <id>` when more than one device is booted. Run
`simwright --help` for everything.

## Rules

- **Never type real credentials, OTPs or card numbers.** A person signs in, then you take over.
- **Never `burst` or `record` a sign-in or passcode screen.** The frames capture what's typed.
- Against a live backend every tap is real. Use the smallest amounts, and undo what you create.
- `hidekb` exits 2 if the keyboard is still up (iOS search keyboards have no Done key). Tap the
  screen's close/cancel control instead.
- `tap` prints a **warning** when another element covers the tap point (a toast, a dev-warning banner,
  a floating bar). The tap probably hit that instead: dismiss it, then tap again.
- If `ls` says **only the status bar is readable**, a system prompt (passcode, permission, alert) is on
  top. `shot` to see it. Never enter a passcode unless the user gave it to you for this device.
- Exit code 2 means "not found / usage". Read the message, run `ls`, adjust. Don't retry the same command blindly.
