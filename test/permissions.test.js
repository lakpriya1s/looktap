import assert from 'node:assert/strict';
import { test } from 'node:test';

import { androidPermissions, iosService } from '../lib/permissions.js';

test('shared names map to each platform', () => {
  assert.equal(iosService('photos'), 'photos');
  assert.equal(iosService('all'), 'all');
  assert.deepEqual(androidPermissions('microphone'), ['RECORD_AUDIO']);
  assert.deepEqual(androidPermissions('location'), ['ACCESS_FINE_LOCATION', 'ACCESS_COARSE_LOCATION']);
  assert.equal(androidPermissions('all'), 'all');
});

test('raw Android permission names pass through', () => {
  assert.deepEqual(androidPermissions('android.permission.BODY_SENSORS'), ['BODY_SENSORS']);
  assert.deepEqual(androidPermissions('BODY_SENSORS'), ['BODY_SENSORS']);
});

test('what a platform cannot do is a clear error', () => {
  assert.throws(() => iosService('camera'), /can't set "camera"/);
  assert.throws(() => iosService('notifications'), /can't set "notifications"/);
  assert.throws(() => androidPermissions('siri'), /Android has no "siri"/);
  assert.throws(() => iosService('teleport'), /unknown permission: teleport/);
});
