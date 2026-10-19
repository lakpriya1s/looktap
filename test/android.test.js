import assert from 'node:assert/strict';
import { test } from 'node:test';

import { androidApps, escapeInput, gone, overWifi, samePhones, keycode, parseDensity, parseNodes, parseRotation } from '../lib/android.js';

test('parseDensity prefers the override and converts to px per dp', () => {
  assert.equal(parseDensity('Physical density: 420\n'), 2.625);
  assert.equal(parseDensity('Physical density: 420\nOverride density: 160\n'), 1);
  assert.equal(parseDensity('garbage'), 1);
});

test('escapeInput encodes spaces and shell metacharacters', () => {
  assert.equal(escapeInput('Photo album (2)'), 'Photo%salbum%s\\(2\\)');
  assert.equal(escapeInput("it's $1"), "it\\'s%s\\$1");
});

test('keycode maps key names to KEYCODE_* (selectall is the Ctrl+A shortcut)', () => {
  assert.equal(keycode('return'), 'KEYCODE_ENTER');
  assert.equal(keycode('Paste'), 'KEYCODE_PASTE');
  assert.equal(keycode('selectall'), 'CTRL+KEYCODE_A');
  assert.equal(keycode('KEYCODE_VOLUME_UP'), 'KEYCODE_VOLUME_UP');
  assert.equal(keycode('menu'), 'KEYCODE_MENU');
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
  assert.equal(a.value, undefined);
});

test("parseNodes reports a switch's state as iOS does: 1 on, 0 off", () => {
  const xml = `<node text="" class="android.widget.Switch" checkable="true" checked="true" bounds="[0,0][10,10]" />
    <node text="" class="android.widget.CheckBox" checkable="true" checked="false" bounds="[0,0][10,10]" />`;
  assert.deepEqual(parseNodes(xml, 1).map((n) => n.value), ['1', '0']);
});

test('parseRotation reads the display rotation from dumpsys, in quarter turns', () => {
  assert.equal(parseRotation('      mCurrentRotation=ROTATION_90\n'), 1);
  assert.equal(parseRotation('    mRotation=3 mDeferredRotationPauseCount=0\n'), 3);
  assert.equal(parseRotation('nothing here'), 0);
});

test('gone: adb saying the device is missing is an error, other stderr is not', () => {
  assert.throws(() => gone('ABC123DEF456', "adb: device 'ABC123DEF456' not found\n"), /ABC123DEF456 isn't connected any more/);
  assert.throws(() => gone('emulator-5554', 'error: device offline'), /isn't connected/);
  assert.doesNotThrow(() => gone('ABC123DEF456', 'Warning: Activity not started, intent has been delivered'));
});

test('androidApps reads pm list packages, with or without version codes', () => {
  assert.deepEqual(androidApps('package:dev.looktap.testapp versionCode:12\npackage:com.android.settings versionCode:36\n'), [
    { id: 'com.android.settings', version: '36' },
    { id: 'dev.looktap.testapp', version: '12' },
  ]);
  assert.deepEqual(androidApps('package:com.android.chrome\r\n'), [{ id: 'com.android.chrome', version: '' }]);
});

test('samePhones: a phone adb lists over USB and Wi-Fi is matched to its USB id', () => {
  const asked = [];
  const serialOf = (id) => (asked.push(id), { '192.168.1.20:5555': 'XYZ789' }[id] || '');
  // Wireless debugging names the serial; adb connect host:port needs the phone asked; Wi-Fi alone pairs with nothing.
  const pairs = samePhones(['ABC123DEF456', 'adb-ABC123DEF456-qiMEaN._adb-tls-connect._tcp', 'XYZ789', '192.168.1.20:5555', 'adb-OTHER1-zz._adb-tls-connect._tcp', 'emulator-5554'], serialOf);
  assert.deepEqual([...pairs], [['adb-ABC123DEF456-qiMEaN._adb-tls-connect._tcp', 'ABC123DEF456'], ['192.168.1.20:5555', 'XYZ789']]);
  assert.deepEqual(asked, ['192.168.1.20:5555']);
  // No USB phone: nothing to match, and nobody is asked.
  asked.length = 0;
  assert.equal(samePhones(['adb-ABC123DEF456-q._adb-tls-connect._tcp', '10.0.0.2:5555'], serialOf).size, 0);
  assert.deepEqual(asked, []);
  assert.equal(overWifi('emulator-5554'), false);
  assert.equal(overWifi('10.0.0.2:5555'), true);
});
