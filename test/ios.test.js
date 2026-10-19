import assert from 'node:assert/strict';
import { test } from 'node:test';

import { appVersion, simApps } from '../lib/ios.js';

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
