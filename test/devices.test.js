import assert from 'node:assert/strict';
import { test } from 'node:test';

import { androidDevice, formatDevice, iosEntry, parseAdbLine } from '../lib/devices.js';

test('adb lines: ready, waiting for the USB debugging prompt, and noise', () => {
  assert.deepEqual(parseAdbLine('emulator-5554          device product:sdk_gphone model:sdk_gphone device:emu'), { id: 'emulator-5554', state: 'device', rest: ' product:sdk_gphone model:sdk_gphone device:emu' });
  assert.equal(parseAdbLine('ABC123DEF456    unauthorized usb:1-1 transport_id:3').state, 'unauthorized');
  assert.equal(parseAdbLine('List of devices attached'), null);
  assert.equal(parseAdbLine(''), null);
});

const iphone = (connection, device = {}) => ({
  hardwareProperties: { reality: 'physical', platform: 'iOS', udid: '00008120-001A', marketingName: 'iPhone 14 Pro' },
  deviceProperties: { name: "Sam's iPhone", osVersionNumber: '26.0', developerModeStatus: 'enabled', ...device },
  connectionProperties: { pairingState: 'paired', tunnelState: 'connected', transportType: 'localNetwork', ...connection },
});

test('iPhones: ready over Wi-Fi or USB, or what the user has to do', () => {
  const ready = iosEntry(iphone());
  assert.equal(ready.ready, true);
  assert.equal(ready.connection, 'Wi-Fi');
  assert.equal(iosEntry(iphone({ transportType: 'wired' })).connection, 'USB');
  assert.match(iosEntry(iphone({ pairingState: 'unpaired' })).problem, /tap Trust/);
  assert.match(iosEntry(iphone({}, { developerModeStatus: 'disabled' })).problem, /Developer Mode/);
  const away = iosEntry(iphone({ tunnelState: 'unavailable' }));
  assert.equal(away.connection, undefined);
  assert.match(away.problem, /out of reach/);
  assert.equal(iosEntry({ hardwareProperties: { reality: 'virtual', platform: 'iOS' } }), null);
});

test('one line: id second, then what it is; not-ready says why', () => {
  assert.equal(formatDevice({ ...iosEntry(iphone()) }), "ios      00008120-001A  Sam's iPhone (iPhone 14 Pro) · device · iOS 26.0 · Wi-Fi");
  assert.equal(
    formatDevice({ platform: 'android', kind: 'device', id: 'R83Y', name: 'SM A065F', connection: 'USB', ready: false, problem: 'accept "Allow USB debugging?" on the phone' }),
    'android  R83Y  SM A065F · device · USB  ✗ not ready: accept "Allow USB debugging?" on the phone',
  );
  assert.equal(formatDevice({ platform: 'android', kind: 'emulator', id: 'Pixel_9a', name: 'Pixel_9a', running: false }), 'android  Pixel_9a  Pixel_9a · emulator');
});

test('Android devices: a phone, a Wear OS watch, and one that gives no answer', () => {
  assert.deepEqual(androidDevice('samsung\nSM-A065F\n16\nphone\n'), { name: 'Samsung SM-A065F', os: 'Android 16' });
  assert.deepEqual(androidDevice('samsung\nSM-R860\n11\nnosdcard,watch\n'), { name: 'Samsung SM-R860', os: 'Wear OS (Android 11)', form: 'watch' });
  assert.deepEqual(androidDevice('Google\nPixel 9a\n16\n'), { name: 'Google Pixel 9a', os: 'Android 16' });
  const silentWatch = androidDevice('', ' product:freshbs model:SM_R860 device:freshbs', true);
  assert.equal(silentWatch.ready, false);
  assert.equal(silentWatch.name, 'SM R860');
  assert.match(silentWatch.problem, /wake its screen/);
  const silentPhone = androidDevice('', '', false);
  assert.equal(silentPhone.name, 'Android device');
  assert.match(silentPhone.problem, /reconnect the cable/);
  assert.equal(formatDevice({ platform: 'android', kind: 'device', id: '192.168.1.96:5555', connection: 'Wi-Fi', ready: true, ...androidDevice('samsung\nSM-R860\n11\nwatch\n') }), 'android  192.168.1.96:5555  Samsung SM-R860 · device · Wear OS (Android 11) · Wi-Fi');
});
