import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mdnsSerial, parseMdns, parseWifiIp } from '../lib/wifi.js';
import { wifiTwin } from '../lib/android.js';

test('adb mdns services lines → name, type, address', () => {
  const text = 'List of discovered mdns services\nadb-R83Y30R6V6M-qiMEaN\t_adb-tls-connect._tcp\t192.168.1.15:40459\nadb-XYZ-abc\t_adb-tls-pairing._tcp.\t192.168.1.20:37199\n';
  assert.deepEqual(parseMdns(text), [
    { name: 'adb-R83Y30R6V6M-qiMEaN', type: '_adb-tls-connect._tcp', address: '192.168.1.15:40459' },
    { name: 'adb-XYZ-abc', type: '_adb-tls-pairing._tcp', address: '192.168.1.20:37199' },
  ]);
  assert.equal(mdnsSerial('adb-R83Y30R6V6M-qiMEaN'), 'R83Y30R6V6M');
  assert.equal(mdnsSerial('adb-R83Y30R6V6M-qiMEaN._adb-tls-connect._tcp'), 'R83Y30R6V6M');
});

test("the phone's Wi-Fi address, from ip addr or else ip route", () => {
  assert.equal(parseWifiIp('53: wlan0: <UP>\n    inet 192.168.1.15/24 brd 192.168.1.255 scope global wlan0'), '192.168.1.15');
  assert.equal(parseWifiIp('', '192.168.0.0/24 dev wlan0 proto kernel scope link src 192.168.0.7'), '192.168.0.7');
  assert.equal(parseWifiIp('', ''), null);
});

test('-d <usb serial> finds the same phone over Wi-Fi once the cable is out', () => {
  const ids = ['emulator-5554', 'adb-R83Y30R6V6M-qiMEaN._adb-tls-connect._tcp', '192.168.1.20:5555'];
  assert.equal(wifiTwin('R83Y30R6V6M', ids, () => assert.fail('no need to ask')), 'adb-R83Y30R6V6M-qiMEaN._adb-tls-connect._tcp');
  assert.equal(wifiTwin('ABC', ids, (id) => (id === '192.168.1.20:5555' ? 'ABC' : '')), '192.168.1.20:5555');
  assert.equal(wifiTwin('NOPE', ids, () => ''), null);
});

test("the keeper looktap downloads is the version its manifest builds", async () => {
  const { readFileSync } = await import('node:fs');
  const { KEEPER_VERSION } = await import('../lib/wifi.js');
  const manifest = readFileSync(new URL('../native/android-wifi/AndroidManifest.xml', import.meta.url), 'utf8');
  assert.equal(Number(/android:versionCode="(\d+)"/.exec(manifest)[1]), KEEPER_VERSION);
});
