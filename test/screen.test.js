import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.LOOKTAP_HOME = mkdtempSync(join(tmpdir(), 'looktap-test-'));
const { check, coveringAt, formatRow, keyboardArea, matches, onlyStatusBar, resolveRef, saveRefs, visibleRows } = await import('../lib/screen.js');
const { scaleRgb } = await import('../lib/png.js');

const el = (label, type, x, y, w, h, extra = {}) => ({ label, type, x, y, w, h, ...extra });

test('visibleRows keeps labelled elements and unlabelled buttons, once per nested label', () => {
  const rows = visibleRows([
    el('General', 'Button', 16, 285, 358, 54),
    el('General', 'StaticText', 60, 300, 80, 20), // the row's own text: nested duplicate
    el('', 'ImageButton', 340, 40, 40, 40),
    el('', 'FrameLayout', 0, 0, 400, 900),
    el('Hidden', 'Button', 0, 0, 0, 0),
    el('General', 'Button', 16, 600, 358, 54), // same label elsewhere: kept
  ]);
  assert.deepEqual(rows.map((r) => `${r.type}:${r.label}@${r.y}`), ['Button:General@285', 'ImageButton:@40', 'Button:General@600']);
  assert.equal(visibleRows([el('', 'FrameLayout', 0, 0, 1, 1)], { all: true }).length, 1);
});

test('formatRow shows ref, type, frame, label and a differing value', () => {
  assert.equal(formatRow(el('Search', 'TextField', 33, 773, 324, 38, { value: 'wifi' }), 3), '@3   TextField        33, 773 324x38  Search  = wifi');
  assert.equal(formatRow(el('', 'ImageButton', 1, 2, 3, 4), 12), '@12  ImageButton       1,   2 3x4  (no label)');
});

test('refs resolve only while the element is still where ls saw it', () => {
  const rows = [el('General', 'Button', 16, 285, 358, 54), el('About', 'Button', 16, 339, 358, 54)];
  saveRefs('dev-1', rows);
  assert.equal(resolveRef('dev-1', '@2', rows).label, 'About');
  assert.throws(() => resolveRef('dev-1', '@2', [el('About', 'Button', 16, 400, 358, 54)]), /no longer on screen/);
  assert.throws(() => resolveRef('dev-1', '@9', rows), /not in the last listing/);
  assert.throws(() => resolveRef('dev-2', '@1', rows), /not in the last listing/);
});

test('matches prefers exact label or identifier, else substring', () => {
  const els = [el('Wi-Fi', 'Button', 0, 0, 1, 1), el('Wi-Fi hotspot', 'Button', 0, 0, 1, 1), el('x', 'Button', 0, 0, 1, 1, { id: 'BackButton' })];
  assert.deepEqual(matches(els, 'Wi-Fi').map((e) => e.label), ['Wi-Fi']);
  assert.deepEqual(matches(els, 'hotspot').map((e) => e.label), ['Wi-Fi hotspot']);
  assert.equal(matches(els, 'BackButton')[0].label, 'x');
});

test('scaleRgb box-filters to the scaled size', () => {
  // 2×2 RGB → 1×1: the average colour.
  const s = scaleRgb(2, 2, Buffer.from([0, 0, 0, 255, 255, 255, 0, 0, 0, 255, 255, 255]), 3, 0.5);
  assert.equal(s.width, 1);
  assert.deepEqual([...s.pixels], [128, 128, 128]);
  assert.equal(scaleRgb(2, 2, Buffer.alloc(12), 3, 1).width, 2);
});

test('coveringAt flags a later overlay on the tap point, not the target\'s own parts', () => {
  const tab = el('Transactions, tab', 'Button', 312, 761, 78, 49);
  const icon = el('Transactions', 'StaticText', 330, 770, 40, 20); // inside the tab
  const toast = el('!, Open debugger to view warnings.', 'GenericElement', 10, 770, 370, 22);
  const elements = [el('Screen', 'Group', 0, 0, 390, 844), tab, icon, toast];
  assert.deepEqual(coveringAt(elements, tab, [351, 786]).map((e) => e.label), ['!, Open debugger to view warnings.']);
  assert.deepEqual(coveringAt([tab, icon], tab, [351, 786]), []);
  assert.deepEqual(coveringAt([toast, tab], tab, [351, 786]), []); // drawn earlier: underneath
});

test('onlyStatusBar spots a screen where only the status bar is readable', () => {
  const bar = [el('14:39', 'StaticText', 31, 8, 42, 19), el('Return to Settings', 'Button', 12, 31, 57, 13)];
  assert.equal(onlyStatusBar(bar), true);
  assert.equal(onlyStatusBar([...bar, el('General', 'Button', 16, 285, 358, 54)]), false);
  assert.equal(onlyStatusBar([]), false);
});

test('the keyboard collapses to one row; bars above it and status-bar buttons stay', () => {
  const els = [
    el('Email', 'TextField', 49, 166, 292, 40),
    el('Previous', 'Button', 21, 456, 40, 38), // input accessory bar, above the keys
    el('q', 'Button', 7, 560, 38, 54),
    el('a', 'Button', 25, 614, 38, 54),
    el('shift', 'Button', 7, 668, 49, 54, { id: 'shift' }),
    el('delete', 'Button', 336, 668, 49, 54, { id: 'delete' }),
    el(' ', 'Button', 101, 722, 95, 54, { id: 'space' }),
    el('go', 'Button', 291, 722, 95, 54, { id: 'Go' }),
    el('15:01', 'StaticText', 32, 8, 39, 19),
    el('Return to Mail', 'Button', 12, 31, 52, 13),
  ];
  const rows = visibleRows(els);
  assert.deepEqual(rows.map((r) => r.label), ['Email', 'Previous', 'Return to Mail', 'Keyboard (type with: looktap type)']);
  assert.deepEqual(keyboardArea(els), { x: 0, y: 560, w: 386, h: 216 });
  assert.equal(keyboardArea(els.filter((e) => !e.id)), null);
  assert.equal(visibleRows(els, { all: true }).length, els.length);
});

test('sliding: a page-wide element off x = 0 is a transition; narrow cards are not', async () => {
  const { sliding } = await import('../lib/screen.js');
  const screen = { w: 411, h: 923 };
  assert.equal(sliding({ screen, elements: [{ x: 71, y: 54, w: 412, h: 179 }] }), true);
  assert.equal(sliding({ screen, elements: [{ x: 0, y: 54, w: 411, h: 179 }] }), false);
  assert.equal(sliding({ screen, elements: [{ x: 300, y: 54, w: 200, h: 100 }] }), false);
  assert.equal(sliding({ screen, elements: [{ x: 24, y: 684, w: 371, h: 79 }] }), false); // an inset row
  assert.equal(sliding({ screen, elements: [{ x: -300, y: 54, w: 411, h: 179 }] }), true); // sliding out left
  // iOS 26 grouped-list backgrounds overhang both edges at rest; shifted to one side, they slide
  assert.equal(sliding({ screen: { w: 393, h: 852 }, elements: [{ x: -16, y: -55, w: 425, h: 252 }] }), false);
  assert.equal(sliding({ screen: { w: 393, h: 852 }, elements: [{ x: 120, y: -55, w: 425, h: 252 }] }), true);
});

test('check: on screen, gone, and a value, with what is there instead on failure', () => {
  const screen = [
    el('Welcome back, Sam', 'StaticText', 24, 120, 300, 30),
    el('Email', 'TextField', 24, 236, 342, 48, { value: 'sam@example.com' }),
    el('Password', 'SecureTextField', 24, 300, 342, 48),
    el('Loading', 'Spinner', 0, 0, 0, 0), // zero size: not on screen
  ];
  assert.equal(check(screen, 'Welcome').hit.label, 'Welcome back, Sam');
  assert.equal(check(screen, 'Welcome', { exact: true }).why, 'not on screen: Welcome');
  assert.ok(check(screen, 'Loading', { gone: true }).ok);
  assert.equal(check(screen, 'Email', { gone: true }).why, 'still on screen: "Email" at 195,260');
  assert.ok(check(screen, 'Email', { want: 'sam@example.com' }).ok);
  assert.equal(check(screen, 'Email', { want: 'kim@example.com' }).why, '"Email" is "sam@example.com", expected "kim@example.com"');
  assert.equal(check(screen, 'Password', { want: 'x' }).why, '"Password" is empty (no value), expected "x"');
  const flight = [el('Flight mode', 'TextView', 27, 300, 100, 23), el('Flight mode', 'Switch', 304, 290, 48, 56, { value: '0' })];
  assert.equal(check(flight, 'Flight mode', { want: '1' }).why, '"Flight mode" is "0", expected "1"');
  saveRefs('dev-check', [screen[0]]);
  assert.ok(check(screen, '@1', { device: 'dev-check' }).ok);
  assert.ok(check(screen.slice(1), '@1', { device: 'dev-check', gone: true }).ok);
});
