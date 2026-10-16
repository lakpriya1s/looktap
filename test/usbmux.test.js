import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fromPlist, toPlist } from '../lib/usbmux.js';

test('plist round trip of a usbmuxd request', () => {
  const msg = { MessageType: 'Connect', DeviceID: 7, PortNumber: 0x9756, ProgName: 'a<b&c' };
  assert.deepEqual(fromPlist(toPlist(msg)), msg);
});

test('parses a ListDevices reply', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>DeviceList</key>
	<array>
		<dict>
			<key>DeviceID</key>
			<integer>3705</integer>
			<key>MessageType</key>
			<string>Attached</string>
			<key>Properties</key>
			<dict>
				<key>ConnectionType</key>
				<string>Network</string>
				<key>EscapedFullServiceName</key>
				<string/>
				<key>NetworkAddress</key>
				<data>
				HgIAAAAAAAA=
				</data>
				<key>SerialNumber</key>
				<string>00008110-000A1B2C3D4E5F60</string>
				<key>Paired</key>
				<true/>
			</dict>
		</dict>
	</array>
</dict>
</plist>`;
  const r = fromPlist(xml);
  assert.equal(r.DeviceList[0].DeviceID, 3705);
  assert.equal(r.DeviceList[0].Properties.SerialNumber, '00008110-000A1B2C3D4E5F60');
  assert.equal(r.DeviceList[0].Properties.Paired, true);
  assert.equal(r.DeviceList[0].Properties.EscapedFullServiceName, '');
  assert.equal(r.DeviceList[0].Properties.NetworkAddress, 'HgIAAAAAAAA=');
});

test('reads when a provisioning profile expires', async () => {
  const { expiryOf } = await import('../lib/iosdevice.js');
  const xml = '<dict><key>CreationDate</key><date>2026-10-16T01:09:20Z</date><key>ExpirationDate</key>\n\t<date>2026-10-23T01:09:20Z</date></dict>';
  assert.equal(expiryOf(xml), Date.parse('2026-10-23T01:09:20Z'));
  assert.equal(expiryOf(''), 0);
});
