import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.SIMDRIVE_HOME = mkdtempSync(join(tmpdir(), 'simdrive-test-'));
const { coveringAt, formatRow, matches, onlyStatusBar, resolveRef, saveRefs, visibleRows } = await import('../lib/screen.js');
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
