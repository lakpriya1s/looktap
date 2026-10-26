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
