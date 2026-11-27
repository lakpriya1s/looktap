---
name: looktap
description: Drive iPhone and Android devices (simulators, emulators or real phones), Wear OS watches and Apple Watch simulators from the shell with looktap — read the screen, tap, type, swipe, deep-link, screenshot, record, read logs and crashes, and set permissions, location, dark mode and text size. Use when asked to open, navigate, test (or write e2e flow tests for), reproduce a bug in, or take screenshots of a mobile app (the user's own, a system app or any other installed app) running in a simulator, emulator or on a real device.
allowed-tools: Bash(looktap:*) Bash(npx @looktap/cli:*) Bash(npx -y @looktap/cli:*)
---

# See, use and control the apps on a phone with looktap

`looktap` lets you see, use and control the apps on an iPhone or Android device (simulator, emulator or real phone):
the app the user is building, a system app or any other installed app. It reads the screen as text and taps by
label. Every command is one short shell call that prints a few lines of plain text, so what worked can then become a
script or a flow test the user's CI runs. Nothing is installed on simulators, emulators or Android devices unless the user asks for it (`runner install`, `wifi --always`); a real iPhone gets a small test runner (the *looktap runner* app). The helper starts on first use.

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
# steps through screens you've already read: one call, then the screen it ended on
looktap run 'tap General; wait About; tap About' --ls
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
It works on `tap`, `longpress`, `zoom`, `tapxy`, `fill`, `type`, `key`, `paste`, `code`, `hidekb`, `swipe`,
`back`, `home`, `open`, `launch`, `bio`, `rotate`, `fold` and `scrollto`. It waits for the screen to change (up to
1.5 s, 6 s for `launch`/`open`), then for it to stop changing.

**`--ls` stops at a loading skeleton too.** If it shows a heading but none of the content, run
`looktap wait "<text you expect>"` rather than acting on the placeholder. Past a splash screen (a React Native debug
build loading its bundle), `looktap launch --until "<text>"` launches and waits in one call.

A row partly hidden says so after it: `[56% covered by @16 @17]` (something drawn over it: a tab bar, a toast) or
`[30% off screen]`. Tap one that's covered by its uncovered part, or scroll it clear first; `ls --covered` lists only
those rows, a quick layout check.

## React Native development builds

Debug builds put React Native's **LogBox toast** at the bottom of the screen whenever the app logs a warning. Its
invisible container takes every touch around it, so a bottom tab bar under it goes dead, and the toast comes back each
time the warning is logged again. For a whole session with a dev build, set this once in `looktap.config.json`:

```json
{ "dismissLogBox": true }
```

Then every `tap`, `longpress` and `tapxy` closes the toast first. Without it:

- `tap` on an element the toast covers closes the toast, finds the target again and taps it, with a note saying so.
- `looktap dismiss logbox --until-gone` closes it, and again each time it comes back, until it stays gone for a second.
- `ls` notes when the toast is up. For long sessions, ask the developer for `LogBox.ignoreAllLogs()` in test builds.

**Android debug builds load their bundle from Metro.** When Metro is running on this Mac, `launch` runs
`adb reverse tcp:8081` first (a real phone has no other way to reach it), and `launch --ls` waits through the splash
screen while the bundle loads ("bundle loading from Metro…", 30–60 s on a phone the first time; up to 120 s, or
`--wait`). `launch --until "<text>"` waits as long.

## Calls: fewest turns, no guessing

Each call costs a turn (you read the output, then write the next command), and a turn takes longer than any
looktap command. Make each call count, without acting on screens you haven't read:

1. **A screen you haven't read yet: one action per call, with `--ls`.** Read what it prints before writing the next
   step. Never put a label in a command unless you saw it in looktap's output.
2. **Screens you've already read: one `run`.** Between steps, `wait "<a label on the next screen>"` instead of
   `--ls` (it returns as soon as that label shows). `--ls` on the `run` prints the screen it ended on. The first
   step that fails stops it and is named:
   `looktap run 'tap General; wait About; tap About; expect "iOS Version"' --ls`
3. **Never chain looktap commands with `;` or newlines in one shell call.** A failed step doesn't stop the next,
   which then acts on whatever screen is up: on a real app that tap does something. Put them in `run`. `&&` stops
   at a failed command but not at a wrong screen (`ls` and `--ls` exit 0 whatever is shown): check with
   `wait`/`expect`. If you chain them anyway, looktap skips every action and wait after a failed action in that
   call (`skipped: an earlier command in this script failed …`): read the screen and send the next steps for it.
4. **A failure shows the screen.** After `not found`, an ambiguous label or a failed `expect` (a `run` step's too),
   the screen as it is follows the error, with fresh `@ref`s. Fix the step from it; no `ls` first. Don't retry the
   same label: each not-found waits 3 s (`--wait`) first. A failed `run` also lists the steps it didn't reach
   (`not run: 3. tap Internet · 4. …`): the app went another way, so send a new `run` with the steps that fit the
   screen it shows, not the old ones again.
5. **Name the device once.** A command with no `-d` uses the device the last command used (for 10 min, while it's
   up); `boot` and `-d` set it. Driving two devices at once (or with another agent)? Pass `-p` and `-d` on every
   command.

## Navigating an app

Most runs that go wrong do so because the agent no longer knows which screen it is on, not because a command
failed. Keep track of that at every step:

1. **Check that each screen change landed.** After a `tap --ls` that should open a screen, check for something only
   that screen has before you act on it: `looktap expect "Order details"`. If it fails, don't press on: `shot`
   and look.
2. **A tap that changed nothing is a failure, not a pause.** Find out why before tapping again, in this order:
   something drawn on top (a toast, a sheet, React Native's LogBox: `tap` names it), the keyboard covering the
   target, the element disabled or still loading, or the wrong one of two same-named elements.
3. **Development builds: set `"dismissLogBox": true`** (see "React Native development builds" above). React
   Native's warning toast blocks taps across the bottom of the screen, a tab bar included, and keeps coming back.
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
11. **The same app can have two layouts.** A big screen (an iPad, an unfolded iPhone Duo, landscape) often shows a
    sidebar beside the detail pane, so a label can be in both ("General" as a sidebar row and as the pane's heading):
    tap the row by `@ref`, and check the pane changed. After `rotate` or `fold`, read the screen before acting.

## The commands you'll use most

```bash
looktap ls                            # the screen; --all: unlabelled elements too; --json
looktap tap "Sign in" --ls            # a label (--exact) or an @ref from the last screen read
looktap tapxy 205 874                 # a point, last resort: for what ls doesn't list
looktap fill "Email" sam@example.com  # focus, clear, type, read it back
looktap type "@example.com"           # into the focused field (check it with expect)
looktap code 540390                   # a row of one-time-code boxes
looktap key return                    # also: delete, selectall, escape …
looktap hidekb                        # dismiss the keyboard
looktap swipe 200 700 200 250         # scroll down: the finger moves up
looktap scrollto "Privacy & Security" # swipe until it's on screen; --up
looktap back                          # also: home
looktap wait "Welcome"                # until it's on screen (--gone: off it); wait --settle for pages with no labels
looktap expect "Email" = sam@example.com  # check, exit 1 if not; --gone
looktap launch com.example.myapp --ls # restart it; --resume: back to where it was
looktap open "myapp://orders/42" --ls # a deep link
looktap run 'tap General; wait About; tap About' --ls
looktap shot home --scale 0.5         # a screenshot; only open it to see layout or colours
looktap logs --errors                 # what's new in the app's log; crashes: its crashes
looktap devices                       # what's running or connected; boot "<name>" starts one
```

`-p ios|android` and `-d <udid|serial>` choose the device when more than one is up; `--app <id>` (or
`looktap.config.json`) the app; `--wait <s>` how long a target is waited for (3 s). **Exit codes:** `0` OK · `2`
usage or not found (bad arguments, an unknown option, no such element, no device) · `1` anything else. On exit 2, read the message and
the screen printed after it, then adjust. Don't retry the same command blindly.

## More, when the task needs it

These sit next to this file in `references/`. Read one only when the task calls for it; if you can't open files
here, `looktap skill <name>` prints it.

| File | Read it for |
|---|---|
| [references/commands.md](references/commands.md) | every command and option: gestures, typing, screenshots and video, installing and resetting apps, permissions, dark mode, text size, location, rotation, folding, network, push, reading notifications, the config file |
| [references/flows.md](references/flows.md) | flow files as tests for CI (`test`), recording a flow (`codegen`), signing in, pages with no labels, handing over to the user (`handoff`) |
| [references/devices.md](references/devices.md) | booting, choosing or setting up a device; watches (Wear OS, Apple Watch simulators); a real phone that isn't ready, is on Wi-Fi, runs iOS 16 or older, or is stuck; Metro and `adb reverse`; other agents using the same device (`who`, `release`); the user watching every device in a browser (`live`); the looktap runner app on an Android phone (`runner`) |
| [references/debugging.md](references/debugging.md) | a crash or an error: logs (following them live, marks), crash reports, performance (`perf`, `launch --time`), the app's files and saved settings (`prefs`) |
| [references/location.md](references/location.md) | location, geofence and background features: moving the device (`route`), the app killed or in the background (`kill`, `background`), the system's geofences, battery and network use |

## Targeting elements

- **`@N` refs** come from the most recent `ls`/`--ls` on that device. Use them for unlabelled buttons and
  duplicate labels. A ref whose element moved or vanished is an error, never a wrong tap: run `ls` again.
- **Labels** match exactly first, then a unique prefix or substring. An ambiguous label is an error that lists
  the matches: use more of the label, `--exact`, or a ref. When one button, switch or cell matches and the other
  matches are only groups around it (an iOS group's label is all its children's labels run together), the control is
  the target; a switch also answers to its spoken name (`tap "Driving, On"`). Two or more controls are ambiguous. The same label in two separate places (a section
  heading and a tab, both "Library") is ambiguous too, even with `--exact`: tap the one you mean by `@ref`. A
  form's label over its own field (both "Email") is not: the label is plain text, so the field is the target.
- **Android text fields** are named by their label or hint, as on iOS, with what's typed as their value
  (`EditText … Search contacts… = pizza`): `fill "Search contacts…"` and `expect "Search contacts…" = pizza` work
  once the field holds text.
- **`fill` checks the field afterwards**, on every platform: it types again key by key if a character went
  missing (then, on the iOS simulator, pastes), and exits 1 naming what the field holds if it still doesn't
  match. A password field shows dots, so it checks the length (`holds 6 characters`). Don't type a password in
  pieces to work around a failure: report the error.
- **One-time codes go in with `code <digits>`** (a test account's code, see Rules), not `fill` or one `tap`+`type`
  per box: boxes that move focus on their own put digits a box off when each one is tapped too. `code` exits 1
  listing what each box holds if they don't read the code, or if another field changed. A code in a single field
  is just `fill`.
- **Paste with `paste "<text>"`, not `xcrun simctl pbcopy` and `key paste`.** On Xcode 27 the simulator's
  clipboard follows the Mac's, so pbcopy alone can leave an old clipboard there to be pasted. `paste` checks the
  clipboard holds the text before pasting, and exits 1 if it can't put it there.
- **`tapxy x y`** is the last resort, for things `ls` doesn't list.
- **Read one value for a script with `looktap value "<label>"`**: it prints the value alone (a switch: `1` or `0`).
- **After `rotate` or `fold`, read the screen again.** Old refs and coordinates are stale.

## Rules

- **Never type real credentials, OTPs or card numbers.** A person signs in, then you take over. `fill` and `code`
  are for a test account the user gave you (its password, its fixed or staging code) and for testing the form
  itself, never for a real account's one-time code.
- **Never `burst` or `record` a sign-in or passcode screen.** The frames capture what's typed.
- **A recording for a person to watch: `touches on` first**, so the video shows what was tapped and swiped, and
  `touches off` after (on an iOS simulator it restarts the home screen once: launch the app after it, not before).
  For a single picture, `shot <name> --mark "<label>"` draws the pointer where the tap would land. A real iPhone
  can't show the pointer on the phone (iOS lets no app draw over another); `looktap live` draws it on its page.
- **"paused on the iPhone" or "paused on the phone" means stop.** The person holding the phone turned Allow
  control off in the looktap runner app. Don't retry, and don't work around it (no adb or simctl input): tell the
  user, and carry on only after they turn it back on. Reading the screen (`ls`, `shot`) still works.
- **The user may be watching or driving from `looktap live`**, the web page with every device on it: each looktap
  command you run shows there as you run it. A device "in use by live (driven from the browser)" is the user
  touching it on that page: wait for them, don't `release` it. To let the user watch, suggest they run
  `looktap live` in their own terminal: it runs until Ctrl+C, so don't start it in yours (and MCP can't run it).
- **Against a live backend every tap is real.** Use the smallest amounts, and undo what you create.
- **`reset` signs the user out** of most apps: ask before resetting an app someone else signed in to.
- **Set back what you change.** Appearance, text size, the status bar, the orientation, a foldable's fold and the
  network stay as you leave them, for the next person and for other apps. On Android, turn the orientation back with the app in
  front: a turn made from the home screen doesn't last.
- **Not sure a command works on this device?** `looktap capabilities` says what it can't do, and why. A command
  that can't run exits 2 with the reason, so don't retry it.
- **Let a screen settle before typing into it.** Add `--ls` to the tap that opens it: some screens (search
  screens especially) clear their field just after they open, taking the first letters with them. `fill` reads
  the field back and retypes it, but `type` doesn't check: after `type`, confirm with `expect "<field>" = …`.
- **A field that moves when tapped** (a search bar that opens into a sheet) is typed into where it lands: `tap` it
  with `--ls`, then `type`, then `expect "<field>" = …`. `fill` aims at where it was.
- **Some simulators are slow** (the iPhone Duo, any just after boot): `launch --ls` can come back before the app is
  in front. Follow it with `wait "<text you expect>"` instead of acting on the home screen.
- **App-state and condition commands need the app id.** They never act on whatever happens to be on screen.
- **`tap` aims at a part of the target nothing covers.** When a toast or bar hides its middle, it taps the
  uncovered part and says `off-centre`. If it warns that another element covers the point, nothing of the target
  was left clear and the tap probably hit that: dismiss it (React Native's LogBox toast: `looktap dismiss logbox`),
  then tap again.
- **After `textsize` or `appearance` on Android**, a note that the app restarted means every ref is stale: `ls`.
- **If `ls` says only the status bar is readable**, a system prompt (passcode, permission, alert) is on top.
  `shot` to see it. Never enter a passcode unless the user gave it to you for this device.
- **Start with `looktap devices`**: it says which devices are real phones, and what the user must do for one that
  isn't ready ([references/devices.md](references/devices.md)).
- **Use looktap, not adb or simctl, for device and app state:** `boot` instead of polling for boot completion,
  `apps <id>` instead of `simctl listapps` or `pm list packages` to check an app is installed, `install`, `reverse`,
  `metro`, `ps <app>` and `logs` instead of `adb install`, `adb reverse`, `pidof` and `adb logcat`. The names other
  tools use work too: `terminate` is `stop`, `screenshot` is `shot`.
- **A device that doesn't answer** fails within 15 s with what's wrong (the adb server, the USB link, the device).
  Run `looktap doctor -d <serial>` and follow its steps; never `adb kill-server` or `pkill adb` yourself, which cuts
  off other sessions' log captures (`doctor --fix` restarts adb safely). `device busy: …` means another session is
  driving the device: tell the user, don't loop. `looktap who` shows who's using it
  ([references/devices.md](references/devices.md)).
- **If a command says the device is locked** (Android phones too: `devices` shows `locked`, or `screen off`), ask the user to unlock it. Don't retry in a loop, and never enter a
  passcode unless they gave it to you for this device. `looktap devices` shows `locked` up front; in a long
  sequence, `--wait-unlock 60` lets the user unlock it while the command waits.
- **If `hidekb` exits 2** (iOS search keyboards have no Done key), tap the screen's close or cancel control.
- **Log lines can contain tokens or personal data.** Quote only the lines that matter.
- **Keep coordinates out of what you write.** looktap prints `location set`, distances and redacted values instead of
  coordinates; don't copy coordinates into notes, scripts or messages (start a route `--from-current` or
  `--offset-from-pref` where you can).
- **Test "the app was killed" with `kill`, never `stop`.** On Android `stop` force-stops it, which removes its
  geofences, alarms and jobs, as no real phone does on its own ([references/location.md](references/location.md)).

## Installation

If `looktap` isn't on the PATH, use `npx @looktap/cli` in every command (or `npx -y @looktap/cli` to skip the
prompt). Installing a global package may need the user's approval:

```bash
npm install -g @looktap/cli
looktap doctor
```

Needs Node 18+. iOS: macOS with Xcode and a simulator (`looktap boot` starts one) or a paired iPhone. Android: adb, with
an emulator (`looktap boot` starts one) or a device.
