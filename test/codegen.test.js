import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseTouchscreen } from '../lib/android.js';
import { Recorder, TouchReader, argWords, classify, controlAt, fillLabel, labelFor, mapper, quote, secretName } from '../lib/codegen.js';
import { splitScript } from '../lib/util.js';

const node = (label, x1, y1, x2, y2, extra = {}) => ({ label, x1, y1, x2, y2, cls: 'android.widget.TextView', focused: false, ...extra });

test('parseTouchscreen finds the device that reports multi-touch positions', () => {
  const text = `add device 1: /dev/input/event8
  name:     "fp-keys"
add device 2: /dev/input/event7
  name:     "himax-touchscreen"
    ABS (0003): ABS_MT_SLOT           : value 0, min 0, max 9, fuzz 0, flat 0, resolution 0
                ABS_MT_POSITION_X     : value 0, min 0, max 719, fuzz 0, flat 0, resolution 0
                ABS_MT_POSITION_Y     : value 0, min 0, max 1599, fuzz 0, flat 0, resolution 0
add device 3: /dev/input/event6
  name:     "mt6768-mt6358 Headset Jack"`;
  assert.deepEqual(parseTouchscreen(text), { path: '/dev/input/event7', x: { min: 0, max: 719 }, y: { min: 0, max: 1599 } });
  assert.equal(parseTouchscreen('add device 1: /dev/input/event1\n  name: "keys"'), null);
});

test('mapper: raw panel coordinates to dp, following the rotation', () => {
  const ts = { x: { min: 0, max: 719 }, y: { min: 0, max: 1599 } };
  const portrait = mapper(ts, { w: 720, h: 1600, rotation: 0 }, 1.875);
  assert.deepEqual(portrait(360, 800), [192, 427]);
  // Turned counter-clockwise: the panel's top edge is now on the left.
  const left = mapper(ts, { w: 1600, h: 720, rotation: 1 }, 1);
  assert.deepEqual(left(0, 0), [0, 720]);
  assert.deepEqual(left(719, 0), [0, 1]);
  const right = mapper(ts, { w: 1600, h: 720, rotation: 3 }, 1);
  assert.deepEqual(right(0, 0), [1600, 0]);
});

/** getevent -lt lines for one finger: down at a, moves through `via`, up at the end. */
function finger(t, points, { slot = 0, id = 1 } = {}) {
  const hex = (n) => n.toString(16).padStart(8, '0');
  const out = [`[ ${t.toFixed(6)}] EV_ABS       ABS_MT_SLOT          ${hex(slot)}`, `[ ${t.toFixed(6)}] EV_ABS       ABS_MT_TRACKING_ID   ${hex(id)}`];
  points.forEach(([x, y], i) => {
    const at = (t + i * 0.05).toFixed(6);
    out.push(`[ ${at}] EV_ABS       ABS_MT_POSITION_X    ${hex(x)}`, `[ ${at}] EV_ABS       ABS_MT_POSITION_Y    ${hex(y)}`, `[ ${at}] EV_SYN       SYN_REPORT           00000000`);
  });
  const end = (t + points.length * 0.05).toFixed(6);
  out.push(`[ ${end}] EV_ABS       ABS_MT_TRACKING_ID   ffffffff`, `[ ${end}] EV_SYN       SYN_REPORT           00000000`);
  return out;
}

test('TouchReader: one gesture per touch, from the first finger down to the last up', () => {
  const downs = [], gestures = [];
  const r = new TouchReader({ onDown: (t, x, y) => downs.push([x, y]), onGesture: (g) => gestures.push(g) });
  for (const l of [...finger(100, [[100, 200]]), ...finger(101, [[50, 900], [50, 700], [50, 400]], { id: 2 })]) r.line(l);
  assert.deepEqual(downs, [[100, 200], [50, 900]]);
  assert.equal(gestures.length, 2);
  assert.deepEqual(gestures[1].pointers[0].path.map(([, x, y]) => [x, y]), [[50, 900], [50, 700], [50, 400]]);
  r.line('add device 2: /dev/input/event7'); // noise is ignored
});

test('classify: tap, long press, swipe, zoom, and gesture-navigation Back and Home', () => {
  const g = (ms, ...paths) => ({ t0: 0, t1: ms / 1000, pointers: paths.map((p) => ({ path: p.map(([x, y], i) => [i, x, y]) })) });
  const screen = { w: 384, h: 853 };
  assert.deepEqual(classify(g(80, [[100, 200], [103, 202]]), screen), { kind: 'tap', x: 100, y: 200 });
  assert.deepEqual(classify(g(900, [[100, 200]]), screen), { kind: 'longpress', x: 100, y: 200, ms: 900 });
  assert.equal(classify(g(300, [[190, 700], [190, 300]]), screen).kind, 'swipe');
  assert.deepEqual(classify(g(400, [[150, 400], [100, 400]], [[230, 400], [290, 400]]), screen), { kind: 'zoom', dir: 'in', x: 190, y: 400 });
  assert.equal(classify(g(200, [[3, 400], [120, 410]]), { ...screen, gestureNav: true }).kind, 'back');
  assert.equal(classify(g(200, [[3, 400], [120, 410]]), screen).kind, 'swipe'); // buttons: an edge swipe is a swipe
  assert.equal(classify(g(200, [[190, 845], [190, 600]]), { ...screen, gestureNav: true }).kind, 'home');
});

const settings = [
  node('', 0, 0, 384, 853, { cls: 'android.widget.FrameLayout' }),
  node('Settings', 0, 136, 384, 183),
  node('', 16, 440, 368, 505, { cls: 'android.widget.LinearLayout', clickable: true }), // the Connections row
  node('Connections', 72, 457, 169, 480),
  node('Wi-Fi  •  Bluetooth  •  SIM manager', 72, 480, 269, 498),
  node('', 16, 510, 368, 575, { cls: 'android.widget.LinearLayout', clickable: true }),
  node('Connected devices', 72, 526, 221, 549),
  node('', 300, 600, 340, 640, { cls: 'android.widget.ImageButton', clickable: true }), // no label anywhere
];

test('controlAt and labelFor: a tap anywhere on a row is a tap on its label', () => {
  const row = controlAt(settings, 330, 470); // right of the text, still on the row
  assert.equal(row, settings[2]);
  assert.equal(labelFor(settings, row), 'Connections');
  assert.equal(labelFor(settings, controlAt(settings, 320, 620)), null);
  // Two rows with the same text: the label would tap the first, so the second has no label of its own.
  const twice = [...settings, node('', 16, 700, 368, 765, { clickable: true }), node('Connections', 72, 717, 169, 740)];
  assert.equal(labelFor(twice, controlAt(twice, 100, 730)), null);
});

const form = [
  node('Sign in', 24, 100, 200, 130),
  node('Email', 24, 200, 100, 220),
  node('', 24, 224, 360, 272, { cls: 'android.widget.EditText', editable: true, clickable: true }),
  node('Password', 24, 290, 360, 338, { cls: 'android.widget.EditText', editable: true, clickable: true, password: true, hint: 'Password' }),
];

test('fillLabel: the label fill finds the field by', () => {
  assert.equal(fillLabel(form, form[2]), 'Email'); // no hint: the label above it
  assert.equal(fillLabel(form, form[3]), 'Password'); // its own hint
  assert.equal(fillLabel([node('', 24, 224, 360, 272, { editable: true })], { x1: 24, y1: 224 }), null);
  // Read after the first key went in: the hint still names it, the text doesn't.
  const search = node('w', 60, 50, 330, 100, { cls: 'android.widget.EditText', editable: true, hint: 'Search' });
  assert.equal(fillLabel([node('Search settings', 330, 50, 380, 100), search], search), 'Search');
});

test('quote and secretName write what run reads back', () => {
  for (const s of ['General', 'Oat milk, 1 L', 'say "hi"', 'a\\b', '$5.00', '#tag', '--gone', 'sam@example.com']) {
    assert.deepEqual(splitScript(`tap ${quote(s)}`), [['tap', s]]);
  }
  assert.equal(quote('General'), 'General');
  // Text that starts with "-" goes after --, so it isn't read as an option.
  assert.equal(argWords('Email', 'sam@example.com'), 'Email sam@example.com');
  assert.deepEqual(splitScript(`fill ${argWords('Amount', '-5 off')}`), [['fill', '--', 'Amount', '-5 off']]);
  assert.equal(argWords('Photo', 800), 'Photo 800');
  assert.equal(secretName('Password'), 'PASSWORD');
  assert.equal(secretName('PIN code'), 'PIN_CODE');
});

test('splitScript with env: ${NAME} from the environment, never inside single quotes', () => {
  const env = { PASSWORD: 'p a$s' };
  assert.deepEqual(splitScript('fill Password "${PASSWORD}"', { env }), [['fill', 'Password', 'p a$s']]);
  assert.deepEqual(splitScript("type '${PASSWORD}'", { env }), [['type', '${PASSWORD}']]);
  assert.deepEqual(splitScript('type "\\${PASSWORD}"', { env }), [['type', '${PASSWORD}']]);
  assert.deepEqual(splitScript('type ${PASSWORD}'), [['type', '${PASSWORD}']]); // no env: left as written
  assert.throws(() => splitScript('type ${NOPE}', { env }), /NOPE} is not set/);
});

/** A fake Android driver: screens are swapped by the test, windows are an app and (maybe) a keyboard. */
function fake() {
  const d = {
    screen: settings,
    keyboard: false,
    async nodes() {
      return d.screen;
    },
    async allNodes() {
      return [...d.screen, node('Recents', 42, 805, 126, 853, { clickable: true }), node('Home', 149, 805, 234, 853, { clickable: true }), node('Back', 257, 805, 341, 853, { clickable: true })];
    },
    async windows() {
      const windows = [{ type: 'system', x1: 0, y1: 805, x2: 384, y2: 853 }, ...(d.keyboard ? [{ type: 'keyboard', x1: 0, y1: 550, x2: 384, y2: 805 }] : []), { type: 'app', x1: 0, y1: 0, x2: 384, y2: 853 }];
      return { windows, display: { w: 720, h: 1600, rotation: 0 } };
    },
  };
  return d;
}

async function session(d, play) {
  const steps = [], notes = [];
  const rec = new Recorder(d, { w: 384, h: 853 }, { emit: (s) => steps.push(s), dropLast: () => steps.pop(), note: (m) => notes.push(m) });
  await rec.start({ every: 20 });
  // The recorder's last read before the finger landed: the screen the test has just set up.
  const touch = async (g) => (await rec.look(), rec.gesture(g, rec.down()));
  await play(touch, rec);
  await rec.finish();
  return { steps, notes };
}

test('Recorder: taps by label, a scroll that found a row becomes scrollto, system Back and Home', async () => {
  const d = fake();
  const { steps, notes } = await session(d, async (touch) => {
    await touch({ kind: 'tap', x: 330, y: 470 });
    await touch({ kind: 'swipe', x: 190, y: 700, x2: 190, y2: 300, ms: 300 });
    d.screen = [...settings, node('About phone', 72, 300, 200, 323)];
    await touch({ kind: 'tap', x: 100, y: 310 });
    await touch({ kind: 'tap', x: 300, y: 830 }); // the Back button
    await touch({ kind: 'tap', x: 190, y: 830 }); // Home
    await touch({ kind: 'tap', x: 320, y: 620 }); // no label
    await touch({ kind: 'swipe', x: 50, y: 400, x2: 300, y2: 400, ms: 200 }); // sideways: a carousel, stays a swipe
  });
  assert.deepEqual(steps, ['tap Connections', 'scrollto "About phone"', 'tap "About phone"', 'back', 'home', 'tapxy 320 620', 'swipe 50 400 300 400 200']);
  assert.match(notes.join('\n'), /saved as tapxy/);
});

test('Recorder: typing becomes one fill that replaces the tap that focused the field; passwords are not saved', async () => {
  const d = fake();
  d.screen = form;
  const focused = (i, extra = {}) => form.map((n, j) => (j === i ? { ...n, focused: true, ...extra } : n));
  const { steps, notes } = await session(d, async (touch) => {
    await touch({ kind: 'tap', x: 100, y: 240 });
    d.keyboard = true;
    d.screen = focused(2);
    await touch({ kind: 'tap', x: 40, y: 600 }); // keys…
    d.screen = focused(2, { label: 'sam@example.com' });
    await touch({ kind: 'tap', x: 80, y: 650 });
    d.keyboard = false;
    await touch({ kind: 'tap', x: 100, y: 310 }); // the password field
    d.keyboard = true;
    d.screen = focused(3, { label: 'Password' });
    await touch({ kind: 'tap', x: 40, y: 600 });
    d.screen = focused(3, { label: '••••••' });
    await touch({ kind: 'tap', x: 40, y: 600 });
  });
  assert.deepEqual(steps, ['fill Email sam@example.com', 'fill Password "${PASSWORD}"']);
  assert.match(notes.join('\n'), /reads it from \$\{PASSWORD\}/);
});
