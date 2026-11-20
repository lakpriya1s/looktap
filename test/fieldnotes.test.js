// What a device-testing session of location and geofence features asked for: label matching that prefers a control
// over the groups around it, LogBox handling, movement (route), app preferences with coordinates redacted, and the
// Android dumps behind geofences, battery, network and log following.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.LOOKTAP_HOME = mkdtempSync(join(tmpdir(), 'looktap-test-'));

const { UsageError, pickMatch } = await import('../lib/util.js');
const geo = await import('../lib/geo.js');
const { formatPrefs, parsePlist, parseSharedPrefs, pickPrefsFiles, redactList } = await import('../lib/prefs.js');
const { buildBplist } = await import('../lib/bplist.js');
const android = await import('../lib/android.js');
const { logBoxAround, tapPoint } = await import('../lib/screen.js');
const { readCollected } = await import('../lib/devicelog.js');
const { setMark, sinceOf, startOf } = await import('../lib/logs.js');
const { capability } = await import('../lib/capabilities.js');

// ── 1. label matching ─────────────────────────────────────────────────────

const el = (label, type, x, y, w, h, extra = {}) => ({ label, type, x, y, w, h, ...extra });

test('a switch beats the groups around it whose labels contain the text ("Driving, On")', () => {
  const screen = [
    el('Activities, Walking, On, Driving, On, Cycling, Off', 'Other', 0, 100, 390, 300),
    el('Driving, On, Cycling, Off', 'Other', 0, 200, 390, 200),
    el('Settings, Driving, On', 'Group', 0, 180, 390, 80),
    el('Driving', 'Switch', 300, 200, 60, 40, { value: '1' }),
  ];
  assert.equal(pickMatch(screen, 'Driving, On').type, 'Switch');
  assert.equal(pickMatch(screen, 'Driving').type, 'Switch');
});

test('one button matching by prefix beats containers that only contain the text', () => {
  const screen = [el('Header, Start recording, Help', 'Other', 0, 0, 390, 400), el('Start recording now', 'Button', 20, 300, 200, 44)];
  assert.equal(pickMatch(screen, 'Start recording').type, 'Button');
});

test('two controls that match stay ambiguous, naming the controls', () => {
  const screen = [el('Driving', 'Switch', 300, 200, 60, 40, { value: '1' }), el('Driving history', 'Button', 20, 400, 200, 44), el('Driving, On', 'Other', 0, 180, 390, 300)];
  assert.throws(() => pickMatch(screen, 'Driv'), (e) => e instanceof UsageError && /ambiguous — matches 2 controls/.test(e.message));
});

test('only containers matching is still ambiguous, and untyped nodes keep the old rules', () => {
  const screen = [el('Walking, On', 'Other', 0, 0, 390, 100), el('Walking, On, Driving', 'Other', 0, 200, 390, 100)];
  assert.throws(() => pickMatch(screen, 'Walk'), /ambiguous/);
  assert.throws(() => pickMatch([{ label: 'Wi-Fi' }, { label: 'Wi-Fi hotspot' }], 'Wi'), /ambiguous.*2 labels/);
});

test('an Android clickable ViewGroup counts as a control', () => {
  const screen = [el('Profile, Edit', 'ViewGroup', 0, 0, 400, 300), el('Edit profile', 'ViewGroup', 10, 200, 100, 40, { clickable: true })];
  assert.equal(pickMatch(screen, 'Edit').clickable, true);
});

// ── 2. LogBox ───────────────────────────────────────────────────────────────

const toast = [
  el('Home', 'Button', 0, 780, 100, 64),
  el('', 'Other', 0, 740, 390, 110), // the container that takes every touch around the card
  el('', 'Other', 10, 770, 370, 48), // the card
  el('! Open debugger to view warnings.', 'StaticText', 20, 780, 300, 30),
];

test('a point under the toast\'s container (a tab bar) is the toast\'s, a point on its card is not', () => {
  assert.ok(logBoxAround(toast, 50, 840));
  assert.equal(logBoxAround(toast, 50, 790), null);
  assert.equal(logBoxAround(toast, 50, 200), null);
  assert.equal(logBoxAround(toast.slice(0, 1), 50, 840), null);
});

test('a tap on what the toast covers reports the toast, with its ×', () => {
  const r = tapPoint(toast, toast[0]);
  assert.ok(r.covers.some((c) => c.close));
});

// ── 6, 7. coordinates and movement ─────────────────────────────────────────

test('distances, points and the error that never echoes a location', () => {
  assert.equal(geo.distance('630m'), 630);
  assert.equal(geo.distance('1.2km'), 1200);
  assert.equal(geo.distance(500), 500);
  assert.throws(() => geo.distance('far'), UsageError);
  assert.deepEqual(geo.point('51.5072,-0.1276'), [51.5072, -0.1276]);
  assert.throws(() => geo.point('48.8566,-200.3522'), (e) => e instanceof UsageError && !/48\.8566|200\.3522/.test(e.message));
});

test('destination and haversine agree, and bearing points the way it went', () => {
  const from = [51.5072, -0.1276];
  const to = geo.destination(from, 90, 630);
  assert.ok(Math.abs(geo.haversine(from, to) - 630) < 0.01);
  assert.ok(Math.abs(geo.bearing(from, to) - 90) < 0.1);
});

test('a straight route: fixes every step, the last at the distance, then held still', () => {
  const fixes = geo.straightPlan({ from: [51.5, -0.12], brg: 0, dist: 630, speed: 1.4, step: 5000, still: 420e3 });
  const s = geo.planSummary(fixes);
  assert.equal(Math.round(s.m), 630);
  assert.equal(s.ms, 450000); // 630 m at 1.4 m/s
  assert.equal(s.stillMs, 420000);
  const moving = fixes.filter((f) => !f.still);
  assert.equal(moving.length, 91);
  assert.ok(moving.every((f, i) => !i || f.ms - moving[i - 1].ms <= 5000));
  assert.ok(fixes.filter((f) => f.still).every((f) => f.speed === 0 && f.at === moving.at(-1).at));
  assert.throws(() => geo.straightPlan({ from: [0, 0], dist: 0 }), /--distance/);
  assert.throws(() => geo.straightPlan({ from: [0, 0], dist: 10, step: 10 }), /--step/);
});

test('a GPX track: its points in order, its own pace sped up, or a set speed without times', () => {
  const gpx = `<gpx><wpt lat="1" lon="1"/><trk><trkseg>
    <trkpt lat="51.5000" lon="-0.1200"><time>2026-01-01T10:00:00Z</time></trkpt>
    <trkpt lat="51.5010" lon="-0.1200"><time>2026-01-01T10:02:00Z</time></trkpt>
    <trkpt lat="51.5010" lon="-0.1180"><time>2026-01-01T10:04:00Z</time></trkpt>
  </trkseg></trk></gpx>`;
  const pts = geo.parseGpx(gpx);
  assert.equal(pts.length, 3); // the waypoint isn't a stop on the track
  const fast = geo.gpxPlan(pts, { scale: 2, step: 1000 });
  assert.equal(geo.planSummary(fast).ms, 120000);
  const last = fast.at(-1).at;
  assert.ok(geo.haversine(last, [51.501, -0.118]) < 0.5);
  const untimed = geo.gpxPlan(pts.map(({ at }) => ({ at, t: null })), { speed: 2, step: 1000 });
  assert.ok(Math.abs(geo.planSummary(untimed).ms - (geo.planSummary(untimed).m / 2) * 1000) < 1);
  assert.throws(() => geo.gpxPlan(pts.slice(0, 1)), /at least two/);
});

test('scrubCoords takes out coordinates, signs included, and leaves times and versions', () => {
  const s = geo.scrubCoords('adb shell cmd location providers set-test-provider-location gps --location 51.5072000,-0.1276000 failed at 02:37:12.225 on iOS 16.7.12');
  assert.ok(!/51\.5072|0\.1276/.test(s), s);
  assert.ok(!/-‹/.test(s), 'the minus sign goes too');
  assert.match(s, /02:37:12\.225/);
  assert.match(s, /16\.7\.12/);
});

test('prefs redaction: coordinate keys, JSON in strings, lat,lon pairs, and --redact', () => {
  const hits = [];
  const hit = (k) => hits.push(k);
  assert.equal(geo.redact('homeLat', 51.5, { hit }), '‹redacted›');
  assert.equal(geo.redact('last_lng', '-0.12', { hit }), '‹redacted›');
  assert.equal(geo.redact('locationPermission', 'granted', { hit }), 'granted');
  assert.equal(geo.redact('trip', 'from 51.50720, -0.12760 to home', { hit }), 'from ‹redacted› to home');
  const json = geo.redact('lastFix', JSON.stringify({ latitude: 51.5, longitude: -0.12, accuracy: 5 }), { hit });
  assert.deepEqual(JSON.parse(json), { latitude: '‹redacted›', longitude: '‹redacted›', accuracy: 5 });
  assert.equal(geo.redact('homeAddress', '1 Main St', { extra: ['home'], hit }), '‹redacted›');
  assert.equal(geo.redact('radius', 100, { hit }), 100);
  assert.ok(hits.includes('homeLat') && hits.includes('lastFix.latitude'));
  assert.deepEqual(redactList('Lat, lon'), ['lat', 'lon']);
});

// ── 4. prefs ────────────────────────────────────────────────────────────────

const PREFS_XML = `<?xml version='1.0' encoding='utf-8' standalone='yes' ?>
<map>
    <string name="homeLat">51.5072</string>
    <string name="greeting">Hi &amp; welcome</string>
    <boolean name="trackingEnabled" value="true" />
    <int name="uploads" value="3" />
    <long name="lastUploadAt" value="1763600000000" />
    <float name="radius" value="150.0" />
    <set name="regions"><string>home</string><string>work</string></set>
    <string name="empty"></string>
</map>`;

test('SharedPreferences XML: every type, escapes undone', () => {
  assert.deepEqual(parseSharedPrefs(PREFS_XML), {
    homeLat: '51.5072', greeting: 'Hi & welcome', trackingEnabled: true, uploads: 3, lastUploadAt: 1763600000000, radius: 150, regions: ['home', 'work'], empty: '',
  });
});

test('prefs print key = value, sorted, coordinates redacted; asked-for keys and missing ones', () => {
  const values = parseSharedPrefs(PREFS_XML);
  const r = formatPrefs(values);
  assert.ok(r.lines.includes('homeLat = ‹redacted›'));
  assert.ok(r.lines.includes('trackingEnabled = true'));
  assert.ok(r.lines.includes('regions = ["home","work"]'));
  assert.deepEqual(r.lines, [...r.lines].sort());
  assert.deepEqual(r.redacted, ['homeLat']);
  const some = formatPrefs(values, { keys: ['uploads', 'nope'] });
  assert.deepEqual(some.lines, ['uploads = 3']);
  assert.deepEqual(some.missing, ['nope']);
});

test("iOS defaults: a binary plist, Apple's own keys left out unless --all", () => {
  const values = parsePlist(buildBplist({ AppleLanguages: ['en'], NSInterfaceStyle: 'x', onboardingDone: true, home: { lat: 51.5, lon: -0.12 } }));
  const r = formatPrefs(values);
  assert.deepEqual(r.lines, ['home = {"lat":"‹redacted›","lon":"‹redacted›"}', 'onboardingDone = true']);
  assert.equal(r.hidden, 2);
  assert.equal(formatPrefs(values, { all: true }).lines.length, 4);
});

test('which SharedPreferences file: --file, the default one, else all', () => {
  const files = ['com.example.app_preferences.xml', 'tracking.xml', 'notes.txt'];
  assert.deepEqual(pickPrefsFiles(files, 'com.example.app'), ['com.example.app_preferences.xml']);
  assert.deepEqual(pickPrefsFiles(files, 'com.example.app', 'tracking'), ['tracking.xml']);
  assert.deepEqual(pickPrefsFiles(['a.xml', 'b.xml'], 'com.example.app'), ['a.xml', 'b.xml']);
  assert.throws(() => pickPrefsFiles(files, 'com.example.app', 'nope'), /no shared_prefs\/nope\.xml \(it has: com\.example\.app_preferences, tracking\)/);
  assert.throws(() => pickPrefsFiles([], 'com.example.app'), /AsyncStorage/);
});

// ── 7, 9, 10, 11. Android dumps ───────────────────────────────────────────

test('the lock screen, in each wording a dump gives it', () => {
  assert.equal(android.parseKeyguard('      showing=false\n        mIsShowing=false\n    isKeyguardShowing=false\n    mKeyguardShowing=false'), false);
  assert.equal(android.parseKeyguard('    mKeyguardShowing=true'), true);
  assert.equal(android.parseKeyguard('      showing=true'), true);
  assert.equal(android.parseKeyguard('   KeyguardShowing=true AodShowing=false'), true);
  assert.equal(android.parseKeyguard('   KeyguardShowing=false AodShowing=true'), false);
});

const LOCATION_DUMP = `    network provider:
      last location=null
    fused provider:
      last location=Location[fused 51.500000,-0.120000 hAcc=5.0 et=+7h10m20s895ms mock]
    gps provider [mock]:
      last location=Location[gps 51.400000,-0.110000 hAcc=5.0 et=+7h10m20s895ms mock]
    network provider [mock]:
  Geofence Manager:
    service: unregistered
`;

test('test providers that took, and the last fix (fused first)', () => {
  assert.deepEqual(android.mockProviders(LOCATION_DUMP), ['gps', 'network']);
  assert.deepEqual(android.lastFix(LOCATION_DUMP), [51.5, -0.12]);
  assert.equal(android.lastFix('last location=null'), null);
});

test('ActivityManager lines: why the app started, and its end', () => {
  const app = 'com.example.app';
  assert.deepEqual(android.processEvent('ActivityManager: Start proc 4388:com.example.app/u0a215 for broadcast {com.example.app/com.example.app.geo.GeofenceReceiver}', app), { kind: 'start', pid: 4388, why: 'broadcast GeofenceReceiver' });
  assert.deepEqual(android.processEvent('ActivityManager: Start proc 19059:com.example.app:remote/u0a215 for content provider {com.example.app/com.example.app.Provider}', app), { kind: 'start', pid: 19059, why: 'content provider Provider' });
  assert.deepEqual(android.processEvent('ActivityManager: Process com.example.app (pid 4211) has died: cch+5 CEM ', app), { kind: 'died', pid: 4211, why: 'cch+5 CEM' });
  assert.equal(android.processEvent('ActivityManager: Start proc 1:com.example.apple/u0a1 for service {x/y}', app), null);
});

test("netstats: the uid's untagged buckets summed, other uids and tags left out", () => {
  const dump = `UID stats:
  Complete history:
  ident=[{type=WIFI, ratType=-1}] uid=10215 set=DEFAULT tag=0x0
    NetworkStatsHistory: bucketDuration=7200
      st=1763600000 rb=1000 rp=10 tb=500 tp=5 op=0
      st=1763607200 rb=200 rp=2 tb=100 tp=1 op=0
  ident=[{type=WIFI}] uid=10215 set=FOREGROUND tag=0x0
    NetworkStatsHistory: bucketDuration=7200
      st=1763600000 rb=50 rp=1 tb=50 tp=1 op=0
  ident=[{type=WIFI}] uid=10215 set=DEFAULT tag=0xffffff01
      st=1763600000 rb=9999 rp=9 tb=9999 tp=9 op=0
  ident=[{type=WIFI}] uid=10216 set=DEFAULT tag=0x0
      st=1763600000 rb=7777 rp=7 tb=7777 tp=7 op=0
`;
  assert.deepEqual(android.parseUidNetstats(dump, '10215'), { rb: 1250, rp: 13, tb: 650, tp: 7 });
});

test("batterystats: the app's power estimate and its background-work lines", () => {
  const dump = `Statistics since last charge:
  Time on battery: 12m 3s 0ms (100.0%) realtime
  Estimated power use (mAh):
    UID u0a215: 4.21 ( cpu=1.2 gps=2.9 )
    UID u0a216: 1.00
  u0a215:
    Wake lock *job*/com.example.app/.Sync: 2s 10ms partial (3 times) realtime
    Sensor GPS: 5m 2s 0ms realtime (4 times)
    Job com.example.app/.Upload: 1s 0ms realtime (2 times)
    Random other line
  u0a216:
    Wake lock other: 1s realtime
`;
  const r = android.parseBatteryStats(dump, '10215');
  assert.equal(r.mAh, 4.21);
  assert.equal(r.detail, '( cpu=1.2 gps=2.9 )');
  assert.equal(r.since, '12m 3s 0ms');
  assert.deepEqual(r.lines, ['Wake lock *job*/com.example.app/.Sync: 2s 10ms partial (3 times) realtime', 'Sensor GPS: 5m 2s 0ms realtime (4 times)', 'Job com.example.app/.Upload: 1s 0ms realtime (2 times)']);
});

test("geofences: Play services' request for the app and its history, each fence where listed, no coordinates", () => {
  const gms = `    Location Request History By Package:
        10146/com.google.android.gms[geofencer_provider]/ef66ee00 (FINE) Request[@5m BALANCED_POWER_ACCURACY, minUpdateInterval=5s, THROTTLE_NEVER, WorkSource{10215 com.example.app}]
      last location (fine): {fused, mock, 51.500000,-0.120000±5.0m}
      11-20 02:37:12.225: -client 10146/com.google.android.gms[geofencer_provider]/24110d80
      11-20 02:37:12.227: +client 10146/com.google.android.gms[geofencer_provider]/6488053a -> Request[@5m BALANCED_POWER_ACCURACY, minUpdateInterval=5s, THROTTLE_NEVER, WorkSource{10215 com.example.app}]
      11-20 02:38:12.249: -client 10146/com.google.android.gms[geofencer_provider]/6488053a
      11-20 02:39:00.000: +client 10146/com.google.android.gms[geofencer_provider]/aaaa -> Request[@5m BALANCED_POWER_ACCURACY, WorkSource{10300 com.other.app}]
  Geofences for com.example.app:
    ParcelableGeofence[CIRCLE id:home transitions:3 51.500000, -0.120000 150m, resp=0s, dwell=-1ms, @-1]
    ParcelableGeofence[CIRCLE id:work transitions:4 51.510000, -0.130000 100m, resp=0s, dwell=300000ms, @-1]

  Geofences for com.other.app:
    ParcelableGeofence[CIRCLE id:theirs transitions:1 1.000000, 1.000000 50m]
`;
  const g = android.parseGeofences({ gms, aosp: LOCATION_DUMP }, 'com.example.app');
  assert.equal(g.gmsClient, 'Request[@5m BALANCED_POWER_ACCURACY, minUpdateInterval=5s, THROTTLE_NEVER]');
  assert.deepEqual(g.events, ['11-20 02:37:12 added (@5m BALANCED_POWER_ACCURACY, minUpdateInterval=5s, THROTTLE_NEVER)', '11-20 02:38:12 removed']);
  assert.deepEqual(g.fences, [{ id: 'home', radius: 150, transitions: 'enter+exit' }, { id: 'work', radius: 100, transitions: 'dwell' }]);
  assert.ok(!JSON.stringify(g).includes('51.5'));
  assert.deepEqual(android.parseGeofences({ gms: '', aosp: LOCATION_DUMP }, 'com.example.app'), { fences: [], gmsClient: null, events: [], aosp: 0 });
});

// ── 5, 10. device log and marks ────────────────────────────────────────────

test("device log lines say whether the app's own code wrote them (print() never shows up)", () => {
  const entries = [
    { t: 2000, l: 'Nov 20 10:00:01 iPhone MyApp[123] <Notice>: own line' },
    { t: 2001, l: 'Nov 20 10:00:01 iPhone MyApp(CFNetwork)[123] <Error>: framework error' },
  ];
  const lines = readCollected(null, 'MyApp', 0, { entries });
  assert.deepEqual(lines.map((l) => l.own), [true, false]);
});

test('logs marks: set, then --since <name>; an unknown name says how to set one', () => {
  const t = setMark('dev-1', 'before-exit');
  assert.equal(sinceOf('dev-1', 'before-exit'), t);
  assert.equal(startOf('dev-1', 'logs:x', 'before-exit', 60e3), t);
  assert.throws(() => sinceOf('dev-1', 'never-set'), /logs mark never-set/);
  assert.ok(Math.abs(sinceOf('dev-1', '5m') - (Date.now() - 300e3)) < 1000);
  assert.throws(() => setMark('dev-1', '9lives'), UsageError);
});

// ── capabilities ────────────────────────────────────────────────────────────

test('what each platform can do of the new commands, and why not', () => {
  assert.equal(capability('android-device', 'location').status, 'conditional');
  assert.equal(capability('android-device', 'route').status, 'conditional');
  assert.match(capability('android-device', 'route').why, /speed or bearing/);
  assert.equal(capability('ios-device', 'route').status, 'conditional');
  assert.equal(capability('ios-simulator', 'geofences').status, 'unsupported');
  assert.match(capability('ios-simulator', 'geofences').why, /monitoredRegions/);
  assert.equal(capability('ios-device', 'battery').status, 'unsupported');
  assert.equal(capability('ios-simulator', 'network <app>').status, 'unsupported');
  assert.equal(capability('ios-simulator', 'kill').status, 'supported');
  assert.equal(capability('ios-simulator', 'value').status, 'supported');
});

// ── 3. Metro ────────────────────────────────────────────────────────────────

test('Metro counts as up only when its status page says it is running', async () => {
  const { createServer } = await import('node:http');
  const serve = (body) =>
    new Promise((resolve) => {
      const server = createServer((_, res) => res.end(body)).listen(0, '127.0.0.1', () => resolve(server));
    });
  const up = await serve('packager-status:running');
  const other = await serve('<html>something else</html>');
  try {
    assert.equal(await android.metroUp(up.address().port), true);
    assert.equal(await android.metroUp(other.address().port), false);
  } finally {
    up.close();
    other.close();
  }
  assert.equal(await android.metroUp(1), false); // nothing listening
});

test('fusedFix: the fused fix, its age since boot, and whether it is a mock one', async () => {
  const { fusedFix } = await import('../lib/android.js');
  assert.deepEqual(fusedFix('last location=Location[fused 1.5,2.5 hAcc=5.0 et=+36m13s771ms mock]'), { at: [1.5, 2.5], et: 2173.771, mock: true });
  assert.deepEqual(fusedFix('    last location=Location[fused 1.5,2.5 hAcc=12 et=+1d2h3m4s5ms alt=3 {Bundle[]}]'), { at: [1.5, 2.5], et: 93784.005, mock: false });
  assert.equal(fusedFix('last location=Location[gps 1.5,2.5 hAcc=5]'), null);
});

test('logBoxToast: the toast itself, not a screen-wide container whose combined label includes its text', async () => {
  const { logBoxToast } = await import('../lib/screen.js');
  const els = [
    { label: 'Compass My location Google Maps ! Open debugger to view warnings.', type: 'Group', x: 0, y: 0, w: 375, h: 812 },
    { label: '! Open debugger to view warnings.', type: 'Group', x: 10, y: 725, w: 355, h: 67 },
  ];
  const t = logBoxToast(els);
  assert.equal(t.y, 725);
  assert.deepEqual(t.close, [351, 759]);
});

test('formatCoverage: names what covers a row, and says so when that is not a listed row', async () => {
  const { formatCoverage } = await import('../lib/screen.js');
  assert.equal(formatCoverage({ covered: 0.31, by: ['@3'], off: 0 }), '[31% covered by @3]');
  assert.equal(formatCoverage({ covered: 0.31, by: [], off: 0 }), '[31% covered (by elements ls --all lists)]');
});
