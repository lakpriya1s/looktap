# Logs, crashes and performance

## Logs and crashes

```bash
# the app's log since your last `logs` (first time: the last minute); at most 80 lines, newest kept
looktap logs
looktap logs --errors
looktap logs --grep checkout
looktap logs --since 5m --lines 200
# iOS: keep Apple-framework messages too
looktap logs --all
# a real iPhone keeps no log history: the first logs (or launch) starts collecting, so run logs (or launch) before
# reproducing the problem, then logs again
# a mark before an action, then only what came after it (crashes --since takes marks too)
looktap logs mark before-tap
looktap logs --since before-tap
# as it comes, until Ctrl+C or --for: the app's lines, and its process starting and ending between them
# (Android: why the system started it, e.g. a broadcast). --grep/--errors narrow it
looktap logs com.example.myapp --follow --grep "upload|region" --for 10m
# Android logcat filters: one buffer (main, system, crash, events, all), or only some tags
looktap logs com.example.app --buffer main --since 5m
looktap logs com.example.app --tag ReactNativeJS,OkHttp
# empty the device's log (logcat -c). When logs comes back empty, looktap checks the device's newest log line against
# its clock: a warning that it is hours old means a stale buffer or a stopped logd, and the empty answer means nothing
looktap logs --clear
# a capture into a file that outlives this terminal; it re-attaches by itself after an adb restart and records the gap
looktap logs com.example.app --follow --file logs/app.log --for 30m
# the app's process: pid, how long it has run, in front or in the background
looktap ps com.example.app
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
# the app's saved settings as key = value: UserDefaults (a real iPhone: development builds) or SharedPreferences
# (Android: debuggable builds; --file picks the file). Coordinate-like values are redacted; --redact hides more keys.
# Keys asked for that aren't set: exit 1. --json for scripts
looktap prefs com.example.myapp
looktap prefs com.example.myapp onboardingDone lastSyncAt
looktap prefs com.example.myapp --file settings --redact home,work --json
# Android: the app's battery use since --reset (geofences and battery: location.md)
looktap battery com.example.myapp
looktap geofences com.example.myapp
# what this device can't do (or only in part) and why; --json lists every command's status
looktap capabilities
```

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

## When the app misbehaves

- **`launch` fails with "exited right after it started"?** The app crashed at launch: `looktap crashes <app>`
  shows the report. A crash just after `launch` returns is named by the next `ls`.
- **`launch` says an app isn't installed?** Some simulator runtimes ship without Maps, Photos and the like (the
  iPhone Duo's iOS 27.1 has Safari and Settings). `looktap apps --all` lists what's there; don't install system apps.
- **Measure performance with `perf` and `launch --time`, not by eye.** Simulator numbers are the Mac's CPU and
  memory: compare builds or screens against each other, and say so when you report them. Run `perf --for` while
  the screen does the thing being measured (a scroll, a load), and `perf --frames` just before and right after it.

## Where an app's log lines come from

- **Swift's `print()` never reaches a real iPhone's log**, and `idevicesyslog` or Console.app don't see it either:
  it writes to the process's standard output, which only Xcode's console shows. `NSLog` and `os_log`/`Logger` do
  reach the log. When `logs` on a device finds nothing from the app's own code in a development build, it says so;
  ask the developer to log what you need with `Logger` (or `NSLog`) in that build. On the simulator, `print()` goes
  to the app's standard output too, not to the unified log `logs` reads.
- **React Native's `console.*`** is in the log on every platform (iOS `com.facebook.react.log`, Android `ReactNativeJS`).
- **Android:** everything the app's uid writes to logcat (`Log.d`, `println`, React Native) is there.

