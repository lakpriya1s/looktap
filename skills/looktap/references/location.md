# Location, geofences and the app in the background

For features that run when nobody is looking: a geofence that fires when the user walks away, a trip recorded in the
background, uploads batched to save battery. Simulate movement, put the app where the system would (background,
killed), and read what happened from its log, its saved settings and the system's own records.

**Coordinates stay out of your context.** `location` prints `location set`, `route` prints distance and time,
`prefs` and `geofences` redact coordinates, and a failure prints `failed: <reason>` without them. Don't undo that by
echoing coordinates yourself (in `run` scripts, notes or messages): pass the user's start point with `--from`, or start
where the app or the device already is (`--offset-from-pref`, `--from-current`).

## Move the device

```bash
# one point; Android phones (12+) through the shell's test providers, nothing installed
looktap location 51.5072 -0.1276
# walk east 630 m at walking pace, a fix every 5 s, then stay at the end for 7 minutes (a geofence's dwell, or the
# system's exit delay). Ctrl+C stops it where it is
looktap route --from 51.5072,-0.1276 --bearing 90 --distance 630m --speed 1.4 --step 5s --then-still 7m
# start where the device already is (Android: its last fix; iOS: where looktap last put it)
looktap route --from-current --bearing 0 --distance 600m
# start at the place the app saved (its own "home" keys), without the coordinates ever being printed
looktap route --offset-from-pref com.example.app:homeLat,homeLon --distance 600m --bearing 180
# a GPX track at its own pace, twice as fast
looktap route --gpx walk.gpx --speed-scale 2
# in the background: returns at once; then act, read logs, and stop it
looktap route --from-current --distance 1.2km --speed 4 --background
looktap route status
looktap route stop
# the real GPS again (Android: removes the test providers and gives the shell back its mock-location setting)
looktap location clear
```

- **iOS simulator:** `simctl location start` plays the points inside the simulator at one speed, so the app sees
  speed and course. **iPhone on iOS 16 or older:** the developer image's simulated location, one fix per step (iOS
  works out speed and course). A newer iPhone can't be moved: use a simulator.
- **Android:** looktap allows the shell mock locations (`appops`), adds the `gps` and `network` test providers, checks
  each add took (an add that hasn't taken fails as "gps provider is not a test provider"), enables them, and feeds
  both every step, so the fused provider and Play services' geofencing see it. Android 16's shell can't put speed or
  bearing on a fix: apps derive them from successive fixes. An app that checks `Location.isMock` sees mock fixes.
- A route that finishes leaves the device at its end. `route stop` or `location clear` ends that.
- Location must be on, and the app needs the location permission (`looktap permission grant location-always <app>`
  for background location).

## Put the app where the system would

```bash
# Home, then check it is in the background and still running (pid)
looktap background com.example.app
# end it as the system does under memory pressure: Home, then am kill (Android) or SIGKILL (iOS, as jetsam)
looktap kill com.example.app
```

**`kill` is not `stop`.** On Android `stop` is a force-stop: the system then treats the app as stopped by the user,
removes its geofences, alarms and jobs, and won't start it for broadcasts until it's opened again. That's never what a
user's phone does on its own, so testing "the app was killed" with `stop` tests nothing. `kill` keeps all of it, and the
system may start the app again in the background when an event comes (a geofence transition, an alarm). On iOS,
`kill` is jetsam's SIGKILL, not a swipe up in the app switcher (after which iOS won't relaunch the app for most
background events until the user opens it).

## See what happened

```bash
# put a mark before the action, then read only what came after it
looktap logs mark before-exit
looktap route --from-current --bearing 90 --distance 630m --then-still 5m
looktap logs com.example.app --since before-exit --grep "geofence|region|upload"
# or watch as it happens: the app's lines, and its process starting and ending as events
looktap logs com.example.app --follow --grep "geofence|region|upload" --for 15m
#   ── com.example.app ended (pid 4211)
#   ── com.example.app relaunched in the background, pid 4388 (broadcast …)
# what the system holds for it (Android): geofences, coordinates redacted
looktap geofences com.example.app
# what the app saved (coordinate-like keys redacted; --redact names more)
looktap prefs com.example.app
looktap prefs com.example.app trackingEnabled lastUploadAt
looktap prefs com.example.app --file tracking --redact home,work
```

- **`logs --follow`** on Android follows the app's uid, so a process the system started again is followed too, and the
  system's own line says why it started (`broadcast` for a geofence's PendingIntent). On iOS a new pid is reported as a
  relaunch. Run it in the background (`&`, or `--for`) while you drive the route, or use `logs mark` and `--since`.
- **`geofences`** on Android shows whether Play services is geofencing for the app (its location request on the app's
  behalf, and when that was added or removed), plus each geofence's id, radius and transitions where the Play services
  build lists them (current builds don't). **iOS** doesn't show another process an app's monitored regions: ask the
  developer to log `CLLocationManager().monitoredRegions` (the count and each `identifier`) with `os_log` or `NSLog`
  at launch and after registering, then `looktap logs <app> --grep region`.
- **`prefs`** reads UserDefaults (iOS simulator; a real iPhone: development builds, over house_arrest) and
  SharedPreferences (Android: debuggable builds, through `run-as`). React Native's AsyncStorage and MMKV keep their data
  elsewhere, so they're not there.

## Cost of background work (Android)

```bash
# start a measurement; a phone on USB is told it's unplugged so batterystats counts
looktap battery com.example.app --reset
looktap route --from-current --distance 2km --speed 1.4 --step 10s
looktap battery com.example.app
looktap battery --restore
# how the app's uploads came out over 5 minutes: bytes each way, and in how many bursts
looktap network com.example.app --for 5m
```

iOS keeps both to itself: Xcode's Energy and Network gauges, or Instruments, while debugging.
