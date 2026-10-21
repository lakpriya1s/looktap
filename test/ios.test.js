import assert from 'node:assert/strict';
import { test } from 'node:test';

import { activeScreen, appVersion, simApps } from '../lib/ios.js';

test('simApps: name, version and whether Apple ships it, from simctl listapps', () => {
  const apps = simApps({
    'com.apple.Maps': { ApplicationType: 'System', CFBundleDisplayName: 'Maps', CFBundleVersion: '2911.30' },
    'dev.looktap.testapp': { ApplicationType: 'User', CFBundleName: 'SwTest', CFBundleShortVersionString: '1.4', CFBundleVersion: '212' },
  });
  assert.deepEqual(apps, [
    { id: 'com.apple.Maps', name: 'Maps', version: '2911.30', system: true },
    { id: 'dev.looktap.testapp', name: 'SwTest', version: '1.4 (212)', system: false },
  ]);
});

test('appVersion shows the build only when it says more', () => {
  assert.equal(appVersion('1.4', '212'), '1.4 (212)');
  assert.equal(appVersion('1.4', '1.4'), '1.4');
  assert.equal(appVersion(undefined, '7'), '7');
  assert.equal(appVersion(), '');
});

test('activeScreen: the lit built-in screen from devicectl, and how its interface is turned', () => {
  const screen = (name, displayId, active, currentOrientation, nativeSize) =>
    ({ name, displayId, active, currentOrientation, nativeSize, bounds: [[0, 0], nativeSize], type: { integrated: {} } });
  const json = (...displays) => JSON.stringify({ result: { displays: [...displays, { name: 'TVOut', displayId: 2, active: true, type: { external: {} } }] } });
  // The iPhone Duo open: the inner screen, mounted sideways (rot90 upright: landscape right).
  assert.deepEqual(activeScreen(json(screen('LCD', 1, false, 'rot0', [1398, 2034]), screen('LCD-1', 3, true, 'rot90', [2007, 2853]))),
    { id: 3, name: 'LCD-1', w: 2007, h: 2853, turn: 4 });
  // Closed, turned landscape left.
  assert.deepEqual(activeScreen(json(screen('LCD', 1, true, 'rot270', [1398, 2034]), screen('LCD-1', 3, false, 'rot90', [2007, 2853]))),
    { id: 1, name: 'LCD', w: 1398, h: 2034, turn: 3 });
  assert.equal(activeScreen(json(screen('LCD', 1, false, 'rot0', [1398, 2034]))), null);
});
