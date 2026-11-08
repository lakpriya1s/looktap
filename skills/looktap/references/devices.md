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

## Real phones

- **Start with `looktap devices`** to see which devices are real phones and which are simulators or emulators.
  An Android phone on both USB and Wi-Fi is one row (`USB + Wi-Fi`) and is driven over USB.
  A phone marked "not ready" needs the user: tell them exactly what it says (accept the USB debugging prompt, tap
  Trust, turn on Developer Mode). One marked "still starting" needs no one: `looktap boot <name>` waits for it.
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
