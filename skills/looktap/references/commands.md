# Every command and option

The full list, by what it does (`looktap --help` prints it in short). Logs, crashes and performance are in
[debugging.md](debugging.md); `run`, `test`, `codegen` and `handoff` in [flows.md](flows.md); devices and setup in
[devices.md](devices.md).

## Look

```bash
looktap ls
# include elements without a label
looktap ls --all
# structured: {screen, elements: [{ref, label, type, x, y, w, h, value, covered, coveredBy, offScreen}]}
looktap ls --json
# only the rows partly hidden: under something drawn over them, or past the screen's edge
looktap ls --covered
# until it's on screen (10 s by default; --wait 30 for longer), or until it's gone
looktap wait "Welcome"
looktap wait "Loading" --gone
# check the screen (waits up to --wait, 3 s); fails with exit 1 and what's there instead
looktap expect "Welcome"
looktap expect "Email" = sam@example.com
looktap expect "Error" --gone
# a web page or canvas with no labels to wait for (a sign-in page): until the screen, picture included, holds
# still for 1 s (--for 2s for longer); 10 s at most, or --wait
looktap wait --settle
looktap wait --settle --for 2s
# swipe until it's fully on screen (above the keyboard, when it's up); fails at the end of the list
looktap scrollto "Privacy & Security"
looktap scrollto "General" --up
```

## Tap and press

```bash
# a label: exact first, else the one label that starts with / contains it (ambiguous is an error)
looktap tap "General"
looktap tap "Messages" --exact
# a row from the last ls on this device
looktap tap @7
# a point, in the units ls prints; for things ls doesn't list
looktap tapxy 205 874
# React Native's LogBox toast (dev builds) takes the taps around it: close it
looktap dismiss logbox
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

## Type

```bash
# focus the field, clear it, type, read it back (a password field: its length); empty text just clears
looktap fill "Email" sam@example.com
looktap fill @4 ""
# into the focused field
looktap type "@example.com"
# put text on the device's clipboard, check it's there, paste it into the focused field
looktap paste "540390"
# a one-time code into its row of digit boxes: every box is checked afterwards
looktap code 540390
# return escape delete tab space selectall paste home; Android also back KEYCODE_*
looktap key return
looktap key selectall delete
# dismiss the keyboard; exits 2 if it's still up
looktap hidekb
```

## Swipe and navigate

```bash
# scroll down: the finger moves up (optional 5th argument: duration in ms)
looktap swipe 200 700 200 250
# a slow drag (a bottom sheet's handle): the same as a 5th argument of 800
looktap swipe 192 600 192 300 --duration 800
# deep link
looktap open "myapp://orders/42"
# (re)start the app
looktap launch
looktap launch com.example.myapp
# bring it back to the front as it was (a real iPhone too): no restart, no lost screen
looktap launch com.example.myapp --resume
# past the splash screen: until the text is on screen (up to --wait, default 30 s)
looktap launch com.example.myapp --until "Welcome"
looktap stop com.example.myapp   # terminate it; waits until the process is gone
# Face ID / fingerprint
looktap bio match
looktap bio nomatch
```

## Screenshots and video

```bash
# saves <out>/<name>.png and prints the path; --scale 0.5 is a quarter of the image tokens
looktap shot checkout
looktap shot checkout --scale 0.5
# one pixel per point (iOS) or dp (Android): a spot you pick in the image is tapxy's x y as it is
looktap shot checkout --points
# Android emulators capture FLAG_SECURE screens by default; --plain shows them black, as on a device
looktap shot payment --plain
# a frame each time the screen changes, for 3 s; duplicates dropped (start it in the background)
looktap burst ./frames 3 &
# a video of everything between start and stop (Android: at most 3 min)
looktap record start checkout
looktap record stop
```

- **`shot` says how the image maps to the screen** (on stderr): `216x384 px = 360x640 dp: tapxy x y = image x y ×
  1.667`. Multiply a point read off the image by that factor for `tapxy`, or take it with `--points`, where the
  factor is 1.

## App state

```bash
# is it installed, and which build? A filter matches part of the id or name (system apps included); exit 1 if none
looktap apps
looktap apps com.example
looktap apps --all --json
# a simulator .app, a device .app/.ipa (real iPhone) or an .apk (keeps the app's data; --grant: every runtime
# permission); prints the app id. A failure says why (storage full, a downgrade, another signature) and what to do
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

## Conditions

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
# a foldable simulator (iPhone Duo): closed (the outer screen), half or open (the inner one); ls, taps, shots
# and recordings follow the screen it shows (closing takes a few seconds; fold waits). No argument prints which
# screen is in use
looktap fold open --ls
looktap fold
# Android only: airplane mode
looktap network offline
looktap network online
# iOS only: a remote notification; plain text, '{json}', or a .json file
looktap push com.example.myapp "Your order has shipped"
looktap push com.example.myapp '{"aps":{"alert":"Hi"},"orderId":7}'
```

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
# a locked device: wait up to 60 s for the user to unlock it, then carry on (default: fail at once)
looktap --wait-unlock 60 launch com.example.myapp
# every command and option: -h or --help · the version: -v or --version
looktap --help
looktap --version
```

Put the app id in `looktap.config.json` at the repo root, so you don't have to pass it every time.
looktap uses the nearest one, walking up from the current folder:

```json
{ "out": "shots", "wait": 3, "ios": { "app": "com.example.myapp" }, "android": { "app": "com.example.myapp" } }
```

Command-line options beat `LOOKTAP_*` environment variables, which beat the config file. With no `-d`, a command
uses the device the last one used (for 10 min, while it's up), without listing devices again.

**Exit codes:** `0` OK · `2` usage or not found (bad arguments, no such element, no device) · `1` anything else.
On exit 2, read the message and the screen printed after it, then adjust. Don't retry the same command blindly.
