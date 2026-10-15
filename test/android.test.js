import assert from 'node:assert/strict';
import { test } from 'node:test';

import { escapeInput, parseDensity, parseNodes, parseRotation } from '../lib/android.js';

test('parseDensity prefers the override and converts to px per dp', () => {
  assert.equal(parseDensity('Physical density: 420\n'), 2.625);
  assert.equal(parseDensity('Physical density: 420\nOverride density: 160\n'), 1);
  assert.equal(parseDensity('garbage'), 1);
});

test('escapeInput encodes spaces and shell metacharacters', () => {
  assert.equal(escapeInput('Photo album (2)'), 'Photo%salbum%s\\(2\\)');
  assert.equal(escapeInput("it's $1"), "it\\'s%s\\$1");
});

test('parseNodes reads labels and scales bounds to dp', () => {
  const xml = `<?xml version='1.0' ?><hierarchy>
    <node text="" content-desc="Messages, 2 unread" class="android.view.ViewGroup" bounds="[42,105][168,210]" focused="false">
      <node text="Tom &amp; Jerry" content-desc="" class="android.widget.EditText" bounds="[0,0][420,84]" focused="true" />
    </node></hierarchy>`;
  const [a, b] = parseNodes(xml, 2.625);
  assert.deepEqual(a, { label: 'Messages, 2 unread', x1: 16, y1: 40, x2: 64, y2: 80, cls: 'android.view.ViewGroup', focused: false });
  assert.equal(b.label, 'Tom & Jerry');
  assert.equal(b.focused, true);
  assert.equal(b.x2, 160);
});

test('parseRotation reads the display rotation from dumpsys, in quarter turns', () => {
  assert.equal(parseRotation('      mCurrentRotation=ROTATION_90\n'), 1);
  assert.equal(parseRotation('    mRotation=3 mDeferredRotationPauseCount=0\n'), 3);
  assert.equal(parseRotation('nothing here'), 0);
});
