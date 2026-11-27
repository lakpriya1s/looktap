# Devices: choosing, booting and real phones

## Devices and setup

```bash
# what's running or connected: simulator, emulator or real phone (model, OS, USB/Wi-Fi), window or headless,
# and what the user must do for a phone that isn't ready. --all: also what boot can start. --json: structured
looktap devices --all
# boot one by name (UDID or AVD too), wait until it's ready; --window (default) or --headless.
# (Xcode 27.1 shows simulators in Device Hub, one at a time: the user picks it there to watch)
# One that's still starting (devices says so) is waited for: use boot, not an adb/simctl polling loop
looktap boot "iPhone 16 Pro" --window
looktap boot Pixel_9a --headless
# for the person, not for you: every running simulator, emulator and connected phone live in one web page (a real
# iPhone as video on a cable, as screenshots on Wi-Fi), where they
# can watch what you do on each device and (with the page's Control switch) tap, swipe and type themselves. It runs
# until Ctrl+C, so it needs a terminal of its own: suggest it, don't run it in yours. --port picks the port (default
# the first free from 4470); --host 0.0.0.0 shares it on the network, watch-only unless --control. The page lists
# every looktap command you run as you run it (from ~/.looktap/activity.jsonl), so the person sees what you're doing
looktap live
looktap live --port 4480 --host 0.0.0.0 --control
# Android, only when the user asks for it: the looktap runner app, a screen on the phone showing what you do there,
# with Allow control (the person can pause you) and Show touches switches. It installs com.looktap.app
looktap runner install
looktap runner remove
looktap shutdown Pixel_9a
# an Android phone on USB: connect it over Wi-Fi too, then the cable can come out (--tcpip: adb tcpip, any Android)
looktap wifi
# keep it on after restarts and on rejoining Wi-Fi: installs looktap's small Wi-Fi keeper app (ask the user first);
# --off removes it and turns Wireless debugging off
looktap wifi --always
looktap wifi --off
# no cable: the code from Developer options → Wireless debugging → Pair device with pairing code
looktap pair 482913
# no cable and no code: the address a Wear OS watch shows under Developer options → Debug over Wi-Fi (or any
# device after adb tcpip; port 5555 if left out). Waits while the device asks "Allow debugging?" (the user taps OK)
looktap connect 192.168.1.96:5555
looktap devices
looktap doctor
# the way to one device: a real iPhone's tunnel, usbmuxd, lock screen, which routes its runner answers on
looktap doctor -d 00008120-001A2B3C4D5E6F70
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

## Watches

A Wear OS watch (a real one over Wi-Fi with `connect`, or an emulator) and an Apple Watch simulator take the same
commands as a phone, on a small screen. `looktap capabilities` says what a watch does differently.

```bash
# an Apple Watch simulator (devices --all lists them as watchOS); -d picks it when an iPhone simulator runs too
looktap boot "Apple Watch Series 12 (46mm)"
# the crown: to the watch face
looktap home
# a watch takes no hardware keyboard: open its keyboard by tapping the field, then type taps its keys (letters and
# spaces; it capitalizes and corrects as for a person). key delete, key space and key return (Done) tap its keys too
looktap tap "Create Message" --ls
looktap type "on my way"
looktap key return
```

- **Back** on an Apple Watch taps the back button, else swipes in from the left edge.
- **A Wear OS watch dims** to its always-on face after a few idle seconds, with nothing to read: commands that act on
  the screen wake it first; after `ls` says it has dimmed, `looktap key WAKEUP`.
- **Not on a watch:** rotation, fingerprint/Face ID; on an Apple Watch also paste, appearance, text size, the
  status bar and reading notifications (swipe down on the watch face and `ls` instead).
- A real Apple Watch can't be driven (it's reached only through its iPhone): use the simulator.

## A phone that's stuck, and sharing devices with other agents

Every adb call looktap makes has a timeout (15 s, `LOOKTAP_ADB_TIMEOUT` in seconds), and each device command first
probes the way to the device (cached 10 s). A stuck link fails at once and names the layer that failed: the adb
server on this computer, the USB link, the device, the app or looktap's helper. It's never reported as "not
installed".

```bash
# the way to one Android device, layer by layer: the adb server (version, pid) and every adb process on this
# computer, the device's state and round-trip time, its USB path (a warning when it goes through hubs), the
# adb reverse rules, the lock screen, and whether --app is installed. Prints the recovery steps when one fails
looktap doctor -d R83Y30R6V6M --app com.example.app
# restart the adb server: lists who it will cut off first and asks; --yes doesn't ask. Puts adb reverse back after
looktap doctor -d R83Y30R6V6M --fix
# who is using the devices: looktap commands (and their log captures), and adb or idevicesyslog processes started
# by anything else, with how long each has run
looktap who
looktap who R83Y30R6V6M
# clear a hold whose process died (one still running: --force, which asks first)
looktap release R83Y30R6V6M
```

If the phone is stuck, in this order: 1. `looktap doctor -d <serial> --fix` (restarts the adb server), 2. replug the
USB cable straight into the computer, not a hub, 3. toggle USB debugging off and on, and accept the prompt again,
4. reboot the phone. **Never `adb kill-server` or `pkill adb` yourself:** that cuts off every other session's log
capture without a word. `doctor --fix` names them first, warns looktap ones (their captures re-attach and record
the gap), and puts the reverse rules back.

A command that changes the device (tap, type, launch, install, stop, location) holds it alone while it runs; another
agent's command waits up to 10 s (`--busy-wait <s>`) and then fails with `device busy: <owner> running "<command>"
for 2m14s`. Don't loop on that: tell the user another session is using the device. Reading the screen, screenshots
and log streams share it. Set `LOOKTAP_OWNER` to name your session in `who`.

```bash
# Metro on this computer, the reverse rule (added if missing), and whether the device reaches it
looktap metro
# any other port: the device's localhost:<port> reaches this computer's
looktap reverse 9090
looktap reverse 9090:3000
looktap reverse --list
looktap reverse remove all
```

## Real phones

- **Start with `looktap devices`** to see which devices are real phones and which are simulators or emulators.
  A phone that is `locked` (or has its `screen off`) takes no screen commands: ask the user to unlock it first.
  An Android phone on both USB and Wi-Fi is one row (`USB + Wi-Fi`) and is driven over USB.
  A phone marked "not ready" needs the user: tell them exactly what it says (accept the USB debugging prompt, tap
  Trust, turn on Developer Mode). One marked "still starting" needs no one: `looktap boot <name>` waits for it.
  An action that fails with "paused on the iPhone" or "paused on the phone" was stopped by the person holding it
  (the looktap runner app's Allow control switch): stop acting on it and tell the user; reading the screen still works.
- **looktap runner on an Android phone** (opt-in, for the person holding it): a screen showing what looktap does
  there, with switches for Allow control and Show touches, as a real iPhone's runner app has. It installs an app,
  so only when the user asks: `looktap runner install` (and `looktap runner remove`); `looktap runner` says whether
  it's on and paused.
- **An Android phone off the cable:** with it plugged in, `looktap wifi` connects it over Wi-Fi too (Wireless
  debugging on Android 11+, else adb tcpip; `--tcpip` forces that); then the cable can come out and `-d <its USB serial>`
  still finds it. With no cable, the user opens Developer options → Wireless debugging → Pair device with pairing code
  and tells you the code: `looktap pair 123456` (add the host:port shown under it if looktap can't find the phone).
  The phone turns Wireless debugging off when it restarts; `devices` then says the Wi-Fi connection dropped.
  If the user wants it to stay on, `looktap wifi --always` (Android 11+) installs a small looktap app on the phone
  (downloaded from looktap's GitHub releases the first time)
  that turns it back on after restarts and on joining Wi-Fi. It installs an app, so only when the user agrees.
- **A real iPhone on Wi-Fi that doesn't answer:** looktap says within ~20 s that the runner is up but out of reach,
  and what each route answered. Ask the user to plug in a USB cable (looktap moves to it by itself) and run the
  command again; `looktap doctor -d <UDID>` shows each step. Don't `teardown` first: the runner keeps running.
- **An iPhone on iOS 16 or older** (`devices` shows `through lockdown`): Xcode 27 doesn't support it, so looktap
  sets it up itself. With Developer Mode off, `looktap setup -d <UDID>` turns it on when the phone has no passcode
  (the phone restarts; warn the user first); with a passcode it asks the user to turn it on. The first command may also ask to enter the passcode once
  for "Enable UI Automation"; relay that and wait. If it says the runner's profile doesn't include the phone, the
  user has to add its UDID to their team at developer.apple.com; you can't.
