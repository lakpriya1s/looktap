import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ORIENTATIONS, coordinates, pushPayload, rotation, sizeForScale, textSize } from '../lib/conditions.js';

test('coordinates: "lat lon", "lat,lon", negatives, range checked', () => {
  assert.deepEqual(coordinates(['51.5072', '-0.1276']), [51.5072, -0.1276]);
  assert.deepEqual(coordinates(['51.5072,-0.1276']), [51.5072, -0.1276]);
  assert.throws(() => coordinates(['95', '0']), /usage/);
  assert.throws(() => coordinates(['london']), /usage/);
});

test('text sizes: aliases, iOS names, nearest Android scale', () => {
  assert.equal(textSize('xxl'), 'extra-extra-large');
  assert.equal(textSize('default'), 'large');
  assert.equal(textSize('accessibility-large'), 'accessibility-large');
  assert.throws(() => textSize('huge'), /text size/);
  assert.equal(sizeForScale(1), 'large');
  assert.equal(sizeForScale(1.32), 'extra-extra-large');
});

test('push payloads: text, inline JSON, files; custom data gets aps', () => {
  assert.deepEqual(pushPayload('Shipped'), { aps: { alert: 'Shipped', sound: 'default' } });
  assert.deepEqual(pushPayload('{"orderId": 7}'), { aps: { 'content-available': 1 }, orderId: 7 });
  const f = join(mkdtempSync(join(tmpdir(), 'sw-')), 'p.json');
  writeFileSync(f, '{"aps":{"alert":"Hi"}}');
  assert.deepEqual(pushPayload(f), { aps: { alert: 'Hi' } });
  assert.throws(() => pushPayload('{bad'), /not a JSON object/);
  assert.throws(() => pushPayload(JSON.stringify({ aps: {}, x: 'y'.repeat(5000) })), /4096/);
});

test('rotation: names → quarter turns counter-clockwise; landscape is left', () => {
  assert.equal(rotation('portrait'), 0);
  assert.equal(rotation('landscape'), 1);
  assert.equal(rotation('Left'), 1);
  assert.equal(rotation('upside-down'), 2);
  assert.equal(rotation('right'), 3);
  assert.equal(ORIENTATIONS[3], 'landscape right');
  assert.throws(() => rotation('sideways'), /usage/);
});
