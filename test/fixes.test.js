import assert from 'node:assert/strict';
import { test } from 'node:test';

import { element } from '../lib/android.js';
import { formatRow, holdsTyped, tapPoint, visibleRows } from '../lib/screen.js';
import { UsageError, pickMatch } from '../lib/util.js';

const el = (label, type, x, y, w, h, more = {}) => ({ label, type, x, y, w, h, ...more });

test('one label in two separate places is ambiguous, even with --exact; nested copies are one place', () => {
  const heading = el('Library', 'View', 20, 529, 81, 32), tab = el('Library', 'View', 72, 568, 72, 48);
  for (const exact of [false, true])
    assert.throws(() => pickMatch([heading, tab], 'Library', { exact }), (e) => e instanceof UsageError && /in 2 places: View at 20,529 81x32; View at 72,568 72x48/.test(e.message));
  const row = el('Apps', 'FrameLayout', 0, 400, 360, 60), text = el('Apps', 'TextView', 80, 405, 45, 28);
  assert.equal(pickMatch([row, text], 'Apps', { exact: true }), row);
  // Android nodes ({ x1 … y2 }) too
  assert.throws(() => pickMatch([{ label: 'A', x1: 0, y1: 0, x2: 10, y2: 10 }, { label: 'A', x1: 0, y1: 50, x2: 10, y2: 60 }], 'A'), /2 places/);
});

test('labels match whatever the whitespace', () => {
  assert.equal(pickMatch([el('Search orders', 'EditText', 0, 0, 10, 10)], 'Search orders').type, 'EditText');
});

test('tap aims at the part of the target a toast leaves uncovered', () => {
  const button = el('Maybe later', 'Button', 24, 560, 312, 40);
  const toast = el('Copied to clipboard', 'ViewGroup', 10, 557, 340, 22);
  const p = tapPoint([button, toast], button);
  assert.deepEqual(p.covers, []);
  assert.equal(p.avoided[0], toast);
  assert.ok(p.at[1] > 581 && p.at[1] < 600, `y ${p.at[1]}`);
  // Nothing over it: the centre. Covered all over: the centre, and what covers it.
  assert.deepEqual(tapPoint([button], button).at, [180, 580]);
  const sheet = el('Sheet', 'View', 0, 563, 360, 33);
  assert.deepEqual(tapPoint([button, sheet], button), { at: [180, 580], covers: [sheet], avoided: [] });
});

test('ls lists a field rather than a container with its label; ls --all folds an svg drawing', () => {
  const box = el('Search orders', 'ViewGroup', 20, 101, 320, 44), field = el('Search orders', 'EditText', 20, 101, 320, 44, { field: true });
  assert.deepEqual(visibleRows([box, field]), [field]);
  const svg = el('', 'SvgView', 24, 43, 129, 18, { svg: true });
  const parts = [1, 2, 3].map((i) => el('', 'PathView', 24 + i, 43, 10, 10, { svg: true }));
  const rows = visibleRows([svg, ...parts, el('', 'TextView', 0, 100, 10, 10)], { all: true });
  assert.equal(rows.length, 2);
  assert.match(formatRow(rows[0], 1), /SvgView .* \(svg, 3 shapes\)$/);
});

test('an Android field is named by its hint, with what is typed as its value', () => {
  const n = { label: 'pizza', text: 'pizza', hint: 'Search contacts…', editable: true, cls: 'android.widget.EditText', x1: 0, y1: 0, x2: 10, y2: 10 };
  assert.deepEqual([element(n).label, element(n).value, element(n).field], ['Search contacts…', 'pizza', true]);
  assert.equal(element({ ...n, label: 'Contact', text: 'pizza' }).label, 'Contact'); // a content description wins
  assert.equal(element({ ...n, text: undefined, label: 'Search contacts…' }).value, undefined); // empty: shows its hint
  assert.equal(element({ ...n, password: true }).label, 'pizza');
  // No hint or description: no label, the text its value (a web page's one-digit code box)
  assert.deepEqual([element({ ...n, label: '4', text: '4', hint: undefined }).label, element({ ...n, label: '4', text: '4', hint: undefined }).value], ['', '4']);
  assert.equal(element({ ...n, cls: 'com.horcrux.svg.PathView', editable: false }).svg, true);
});

test('holdsTyped: formatting may add characters, a lost one fails', () => {
  assert.ok(holdsTyped('pizza', 'pizza'));
  assert.ok(holdsTyped('(415) 555-1234', '4155551234'));
  assert.ok(holdsTyped('PIZZA', 'pizza'));
  assert.ok(!holdsTyped('izza', 'pizza'));
  assert.ok(!holdsTyped('305', '302005'));
});

test('a target under the LogBox toast container is covered, with the toast\'s × to dismiss it', () => {
  const tab = el('Library', 'View', 72, 568, 72, 48);
  const wrapper = el('', 'ViewGroup', 10, 519, 340, 101), card = el('', 'ViewGroup', 10, 543, 340, 48);
  const row = el('!, Open debugger to view warnings.', 'ViewGroup', 10, 557, 340, 22);
  const p = tapPoint([tab, wrapper, card, row], tab);
  assert.deepEqual(p.at, [108, 592]);
  assert.deepEqual(p.covers[0].close, [336, 567]);
  assert.deepEqual(tapPoint([el('Total', 'View', 20, 100, 100, 30), wrapper, card, row], { label: 'x' }).covers, []);
});

test("a toast's card counts, not just its labelled row (LogBox's row is 22 points inside a 48-point card)", () => {
  const tab = el('Library', 'View', 72, 568, 72, 48);
  const card = el('', 'ViewGroup', 10, 543, 340, 48), row = el('!, Open debugger to view warnings.', 'ViewGroup', 10, 557, 340, 22);
  const toast = el('Saved', 'ViewGroup', 10, 557, 340, 22);
  const p = tapPoint([tab, card, toast], tab);
  assert.ok(p.at[1] >= 594, `y ${p.at[1]}`);
  assert.equal(p.avoided[0].label, 'Saved');
});

import { parseStuck } from '../lib/android.js';
import { scrollTo } from '../lib/screen.js';

test('parseStuck reads the frozen / crashed app dialog from dumpsys, whatever the language', () => {
  assert.deepEqual(parseStuck('  mCurrentFocus=Window{9f1 u0 Application Not Responding: com.example.app}\n'), { app: 'com.example.app', why: "isn't responding" });
  assert.equal(parseStuck('  mCurrentFocus=Window{9f1 u0 Application Error: com.example.app}').why, 'crashed (keeps stopping)');
  assert.equal(parseStuck('  mCurrentFocus=Window{b10 u0 com.example.app/com.example.MainActivity}'), null);
});

test('scrollto swipes above the keyboard, and stops when it leaves no room', async () => {
  const swipes = [];
  let y = 700;
  const d = {
    keyboardTop: async () => 330,
    snapshot: async () => ({ screen: { w: 360, h: 640 }, elements: [el('Search orders', 'EditText', 20, y, 320, 44)] }),
    swipe: async (x1, y1, x2, y2) => (swipes.push([y1, y2]), (y -= 200), true),
  };
  const hit = await scrollTo(d, 'Search orders');
  assert.ok(swipes.every(([a, b]) => a < 330 && b < 330), JSON.stringify(swipes));
  assert.ok(hit.y + hit.h <= 330, `found under the keyboard: y ${hit.y}`);
  await assert.rejects(scrollTo({ ...d, keyboardTop: async () => 60 }, 'Nowhere'), /keyboard leaves no room/);
});

import { appGone } from '../lib/screen.js';

test('an app under its own "keeps stopping" dialog counts as gone, even before its process ends', async () => {
  const before = { key: 'com.example:41', id: 'com.example', pid: 41 };
  const d = { frontApp: async () => ({ key: 'android:9', id: 'android', pid: 9 }), stuck: async () => ({ app: 'com.example', why: 'crashed' }), alive: async () => true, appId: (f) => f.id };
  assert.equal(await appGone(d, before), 'com.example');
  assert.equal(await appGone({ ...d, stuck: async () => null }, before), null);
});
