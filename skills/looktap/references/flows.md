# Batches, flow tests and sign-in

Once you have read the screens a path goes through, run it as one `run` (see "Calls" in the skill). This file
covers the rest: flow files as tests for CI, recording a flow, signing in, and handing over to the user.

## Batch

```bash
# several steps in one call; stops at the first failure and names it; --ls: then the screen it ended on
looktap run 'tap General; wait About; tap About; wait "iOS Version"' --ls
# one step per line from stdin, # for comments
looktap run - < steps.txt
# flow files (run scripts) as tests: a line per flow, exit 1 if any fails. A failure saves the screen, a
# screenshot, error logs and crashes in <out>/failures/<flow>/. --junit: a report for CI
looktap test flows/ --junit results/junit.xml -o results
# Android: the user uses the phone and each touch is saved as a step (a person drives this one, not you)
looktap codegen flows/checkout.txt com.example.app
# steps for flows: a fixed wait, for what has nothing to wait on (prefer wait or wait --settle)
looktap pause 1.5
# the person's turn (a consent screen, a second factor): shows the message and a notification, then carries on
# once the label is on screen (--gone: off it), up to 5 min or --wait. Without --until: when they press Enter
looktap handoff "Approve the sign-in on the phone" --until "Home"
looktap handoff "Enter the code from the email" --until "Verify" --gone
```

## Example: turn what worked into a test

Once a flow works by hand, save its steps as a file the user's CI can run, with `expect` where it should check:

```bash
# flows/sign-in.txt
launch com.example.app
fill Email sam@example.com
tap "Sign in"
wait Welcome
expect "Sign in" --gone
```

Then `looktap test flows/`. Steps are the same commands, one per line, `#` for comments, and `${NAME}` reads an
environment variable (for a test account's password: never write one into the file). A flow that fails names
the step, prints its output, and leaves its evidence under `<out>/failures/`. An app that dies fails the flow.

## Example: sign in and check the home screen

```bash
looktap launch --ls
looktap fill "Email" sam@example.com
looktap fill "Password" "$TEST_PASSWORD"
looktap tap "Sign in"
# a verification code, if the test account asks for one: only a code the user gave you for it
looktap wait "Verification code"
looktap code 540390 --ls
looktap wait "Home"
looktap shot home --scale 0.5
```

Only with a test account the user gave you. Never type real credentials (see the Rules in SKILL.md). The same commands work in a
web sign-in inside an app (a web view): if `fill` or `code` exits 1, read what it says the field holds and report
it, rather than typing around it.

## Pages with no labels, and the user's turn

- **Sign-in pages with no labels** (Google's, most web sign-ins): `wait --settle` after each tap, and `handoff` for
  what only the user can do (consent, a second factor). Don't guess with `pause`.
