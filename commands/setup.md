---
description: Set up looktap - install the CLI, check the toolchain, and get a simulator, emulator or iPhone ready
argument-hint: "[ios | android | iphone]"
allowed-tools: Bash(looktap:*) Bash(npx -y @looktap/cli:*) Bash(npm view @looktap/cli version) Bash(command -v looktap) Bash(xcrun simctl list:*)
---

Get looktap ready to drive a device on this machine. The user asked for: $ARGUMENTS (empty means: whatever is
available; `ios` means a simulator, `android` an emulator or phone, `iphone` a real iPhone).

Work through these steps in order. Keep each message short and tell the user what you found.

## 1. The CLI

- Run `command -v looktap`, then `looktap --version`, and compare with `npm view @looktap/cli version`.
- If it's missing or older, **ask the user** before running `npm install -g @looktap/cli`. Say why: the skill
  can use `npx -y @looktap/cli` instead, but every command is then a little slower.
- If they say no, use `npx -y @looktap/cli` in place of `looktap` for the rest of this setup and from then on.

## 2. The toolchain

Run `looktap doctor`. Each line starting with ✗ ends with a fix after `→`. For each one, explain it in a sentence:

- **Xcode, the Android SDK, adb:** don't install these yourself. Tell the user what to install (Xcode from the
  App Store, then `xcode-select --install`; Android Studio or the SDK platform-tools) and wait.
- **No booted simulator:** list them with `looktap devices --all`, suggest a recent iPhone, and **ask** before
  running `looktap boot "<name>"` (it waits until the simulator is ready and opens its window). From Xcode 27.1
  the window is Device Hub, which shows one device at a time: tell the user to pick the simulator in its sidebar.
  For testing a foldable, Xcode 27.1's iPhone Duo folds with `looktap fold closed|half|open`.
- **No Android device:** suggest an emulator from `looktap devices --all` (`looktap boot <AVD name>`) or connecting
  a phone with USB or wireless debugging. **Ask** first.

Skip what the user didn't ask for: with `ios`, an adb ✗ doesn't matter, and the other way round.

## 3. What's connected

Run `looktap devices`. It lists booted simulators, emulators and real phones, with each one's model, OS version and
connection. A phone marked "not ready" says what the user has to do (accept the USB debugging prompt, tap Trust,
turn on Developer Mode): tell them, and run it again once they have.

## 4. A real iPhone (only if asked for, or one is listed)

Walk the user through what only they can do, one step at a time:

1. Xcode → Settings → Accounts: sign in with an Apple ID. A free one is enough.
2. Pair the iPhone with the Mac (cable once, tap Trust) and turn on Settings → Privacy & Security → Developer Mode.
3. Unlock the iPhone, then run `looktap -d <hardware UDID> ls`. The first run builds and installs a small test
   runner, which takes about a minute.
4. With a free Apple ID, the iPhone then asks to trust the developer: Settings → General → VPN & Device
   Management → the Apple ID → Trust. Run the command again.

If looktap says Xcode has more than one team, ask which to use and set `LOOKTAP_TEAM=<team id>`. A free Apple ID
can have only 3 of its apps on a device at once; if the device is full, looktap names the apps and the user
deletes one. Never ask for or type an Apple ID password.

## 5. Prove it works

Run `looktap ls` on the device that's ready (add `-d <id>` when more than one is up) and show the first few rows.
Finish with one line on what's ready, and suggest a first command such as `looktap launch <bundle id> --ls`.

Throughout: don't change system settings or install system software without asking, and follow the looktap
skill's safety rules.
