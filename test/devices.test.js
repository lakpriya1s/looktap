import assert from 'node:assert/strict';
import { test } from 'node:test';

import { formatDevice, iosEntry, parseAdbLine } from '../lib/devices.js';

test('adb lines: ready, waiting for the USB debugging prompt, and noise', () => {
  assert.deepEqual(parseAdbLine('emulator-5554          device product:sdk_gphone model:sdk_gphone device:emu'), { id: 'emulator-5554', state: 'device', rest: ' product:sdk_gphone model:sdk_gphone device:emu' });
  assert.equal(parseAdbLine('R83Y30R6V6M    unauthorized usb:1-1 transport_id:3').state, 'unauthorized');
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
