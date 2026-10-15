---
name: simdrive
description: Drive an iOS simulator or Android emulator from the shell with simdrive — read the screen, tap, type, swipe, deep-link, screenshot. Use when asked to open, navigate, test, reproduce a bug in, or take screenshots of a mobile app running in a simulator or emulator.
---

# simdrive

`simdrive` drives a booted iOS simulator or Android emulator. Every command is one short shell call that
prints a few lines of text. Nothing is installed on the device. Its helper starts on first use.

## The loop

1. **Look:** `simdrive ls` lists what's on screen, one row per element:

   ```
   @1   Button           16, 285 358x54  General
   @2   Button           16, 339 358x54  Accessibility
   @3   TextField        33, 773 324x38  Search  = Search
   ```

   The columns are: ref, type, x,y, width×height (iOS points / Android dp), label, and `= value` for fields.
2. **Act, and see the result in the same call** with `--ls`:

   ```bash
   simdrive tap @1 --ls            # tap the row from the last ls, then print the settled screen
   simdrive tap "General" --ls     # or by label
   simdrive fill @3 "wifi" --ls
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
simdrive wait "Welcome"               # until it appears (10 s default; --wait 30 for longer)
simdrive wait "Loading" --gone        # until it disappears
simdrive scrollto "Privacy & Security"   # swipe until it's fully on screen (--up to go back)
```

`tap`, `fill` and `back` already wait up to 3 s for their target.

**After an action that loads data, wait for what you expect.** `--ls` returns once the screen stops
changing, and a loading skeleton (grey placeholder bars) stops changing too. If `--ls` shows a heading but
none of the content, run `simdrive wait "<text you expect>"` rather than acting on the placeholder.

## Several known steps in one call

```bash
simdrive run 'tap General; tap About; wait "iOS Version"; ls'
```

`run` stops at the first failing step and names it. Use it for paths you already know. Explore one step at a
time.

## Screenshots

`simdrive shot <name>` saves a PNG and prints its path. Don't open the image unless you need to *see* it
(layout, colours, images). `ls` already tells you what's on screen. When you do look, use
`--scale 0.5`: it's a quarter of the image tokens and still readable.

## Other commands

`type <text>` (into the focused field) · `key return|escape|delete|tab|space` · `hidekb` · `swipe x1 y1 x2 y2 [ms]` · `back` · `open <url>` (deep
link) · `launch [app]` · `bio match|nomatch` · `burst <dir> <seconds>` (frames of a transient state) ·
`devices` · `doctor`. Pass `-p ios|android` and `-d <id>` when more than one device is booted. Run
`simdrive --help` for everything.

## Rules

- **Never type real credentials, OTPs or card numbers.** A person signs in, then you take over.
- **Never `burst` a sign-in or passcode screen.** The frames capture what's typed.
- Against a live backend every tap is real. Use the smallest amounts, and undo what you create.
- `hidekb` exits 2 if the keyboard is still up (iOS search keyboards have no Done key). Tap the
  screen's close/cancel control instead.
- `tap` prints a **warning** when another element covers the tap point (a toast, a dev-warning banner,
  a floating bar). The tap probably hit that instead: dismiss it, then tap again.
- If `ls` says **only the status bar is readable**, a system prompt (passcode, permission, alert) is on
  top. `shot` to see it. Never enter a passcode unless the user gave it to you for this device.
- Exit code 2 means "not found / usage". Read the message, run `ls`, adjust. Don't retry the same command blindly.
