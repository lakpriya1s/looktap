import assert from 'node:assert/strict';
import { test } from 'node:test';

import { codeBoxes, describeValue, fieldVerdict, keyboardArea, sameField, visibleRows } from '../lib/screen.js';
import { UsageError, pickMatch } from '../lib/util.js';

const el = (label, type, x, y, w, h, more = {}) => ({ label, type, x, y, w, h, ...more });

test("a form's label over its own field names the field; two controls stay ambiguous", () => {
  const label = el('Email', 'StaticText', 20, 80, 300, 22), field = el('Email', 'TextField', 20, 106, 340, 40);
  assert.equal(pickMatch([label, field], 'Email'), field);
  // Android nodes: a TextView label over an EditText
  const tv = { label: 'Email', cls: 'android.widget.TextView', x1: 0, y1: 0, x2: 100, y2: 20 };
  const edit = { label: 'Email', cls: 'android.widget.EditText', x1: 0, y1: 30, x2: 100, y2: 70 };
  assert.equal(pickMatch([tv, edit], 'Email'), edit);
  const button = el('Email', 'Button', 20, 300, 100, 44);
  assert.throws(() => pickMatch([label, field, button], 'Email'), (e) => e instanceof UsageError && /in 3 places/.test(e.message));
});

test('a field is found again after a web page scrolls it', () => {
  const was = el('Password', 'TextField', 169, 242, 570, 40);
  const now = [el('Email', 'TextField', 169, 118, 570, 40), el('Password', 'TextField', 169, 201, 570, 40), el('Digit 1', 'TextField', 169, 284, 54, 40)];
  assert.equal(sameField(now, was), now[1]);
  // No label to go by: the nearest field of its size
  assert.equal(sameField([el('', 'EditText', 18, 150, 356, 40, { field: true }), el('', 'EditText', 18, 300, 57, 41, { field: true })], el('', 'EditText', 18, 190, 356, 40, { field: true })).y, 150);
});

test('fieldVerdict: a password by its length, formatting passes, a lost key fails', () => {
  assert.equal(fieldVerdict('Pass@123#4', 'Pass@123#4'), 'exact');
  assert.equal(fieldVerdict('••••••••••', 'Pass@123#4'), 'exact');
  assert.equal(fieldVerdict('••••••', 'Pass@123#4'), 'wrong');
  assert.equal(fieldVerdict('(415) 555-1234', '4155551234'), 'formatted');
  assert.equal(fieldVerdict('sam_kim', 'sam_kim@example.com'), 'wrong');
  assert.equal(fieldVerdict(undefined, 'x'), 'unknown');
  assert.equal(describeValue('••••••'), '6 characters');
  assert.equal(describeValue('sam'), '"sam"');
});

test('codeBoxes: the row of small fields, left to right; a lone field or a short row is none', () => {
  const boxes = [3, 0, 5, 1, 4, 2].map((i) => el(`Digit ${i + 1}`, 'TextField', 169 + i * 60, 284, 54, 40, i ? {} : { value: '5' }));
  const row = codeBoxes([el('Email', 'TextField', 169, 118, 570, 40), ...boxes]);
  assert.deepEqual(row.map((b) => b.label), ['Digit 1', 'Digit 2', 'Digit 3', 'Digit 4', 'Digit 5', 'Digit 6']);
  assert.equal(codeBoxes(boxes.slice(0, 3)), null);
  // A narrow screen wraps the last box onto the next line
  const wrapped = [0, 1, 2, 3, 4].map((i) => el(`Digit ${i + 1}`, 'TextField', 28 + i * 60, 313, 54, 40)).concat(el('Digit 6', 'TextField', 28, 371, 54, 40));
  assert.deepEqual(codeBoxes(wrapped).map((b) => b.label), ['Digit 1', 'Digit 2', 'Digit 3', 'Digit 4', 'Digit 5', 'Digit 6']);
  assert.equal(codeBoxes([el('Email', 'TextField', 169, 118, 570, 40)]), null);
  // Android: editable nodes with no label
  assert.equal(codeBoxes([0, 1, 2, 3].map((i) => el('', 'EditText', 18 + i * 62, 344, 57, 41, { field: true }))).length, 4);
});

test('ls lists unlabelled text fields (code boxes), not other unlabelled elements', () => {
  const rows = visibleRows([el('', 'TextField', 20, 300, 44, 52), el('', 'Other', 0, 0, 10, 10), el('Go', 'Button', 0, 400, 80, 40)]);
  assert.deepEqual(rows.map((r) => r.type), ['TextField', 'Button']);
});

test("iOS 27's number pad is a keyboard when a field is on screen, and an app's PIN pad isn't", () => {
  const pad = [...'1234567890'].map((d, i) => el(d, 'Button', 5 + (i % 3) * 153, 421 + Math.floor(i / 3) * 56, 153, 56));
  const field = el('', 'TextField', 20, 286, 44, 52);
  assert.equal(keyboardArea([field, ...pad, el('Delete', 'Button', 311, 589, 153, 56)]).y, 421);
  assert.equal(keyboardArea([el('Enter PIN', 'StaticText', 20, 100, 200, 22), ...pad]), null);
});
