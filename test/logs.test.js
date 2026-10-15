import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseExits } from '../lib/android.js';
import { summariseIps } from '../lib/ios.js';
import { grepper, parseSince, tail } from '../lib/logs.js';

test('parseSince takes durations and dates', () => {
  const now = 1_000_000_000;
  assert.equal(parseSince('30s', now), now - 30_000);
  assert.equal(parseSince('5m', now), now - 300_000);
  assert.equal(parseSince('2h', now), now - 7_200_000);
  assert.equal(parseSince('2026-10-15T15:00:00Z', now), Date.parse('2026-10-15T15:00:00Z'));
  assert.throws(() => parseSince('yesterday-ish', now), /--since/);
});

test('tail keeps the newest lines and counts the rest', () => {
  assert.deepEqual(tail([1, 2, 3, 4], 2), { shown: [3, 4], dropped: 2 });
  assert.deepEqual(tail([1], 5), { shown: [1], dropped: 0 });
});

test('grepper is case-insensitive and rejects bad patterns', () => {
  assert.equal(grepper('fetch')({ text: 'Fetch failed' }), true);
  assert.equal(grepper('')({ text: 'x' }), true);
  assert.throws(() => grepper('('), /--grep/);
});

const EXITS = `ApplicationExitInfo records:
  package: com.example
    Historical Process Exit for uid=10217
        ApplicationExitInfo #0:
          timestamp=2026-10-15 14:56:06.724 pid=14001 realUid=10217 packageUid=10217 definingUid=10217 user=0
          process=com.example reason=3 (LOW_MEMORY) subreason=0 (UNKNOWN) status=0
          importance=400 pss=0.00 rss=365MB description=null state=empty trace=null
        ApplicationExitInfo #1:
          timestamp=2026-10-15 14:53:12.478 pid=12913 realUid=10217 packageUid=10217 definingUid=10217 user=0
          process=com.example reason=10 (USER REQUESTED) subreason=21 (FORCE STOP) status=0
          importance=100 pss=0.00 rss=679MB description=stop com.example due to from pid 13977 state=empty trace=null
        ApplicationExitInfo #2:
          timestamp=2026-10-15 14:40:00.000 pid=11000 realUid=10217 packageUid=10217 definingUid=10217 user=0
          process=com.example reason=4 (APP CRASH(EXCEPTION)) subreason=0 (UNKNOWN) status=0
          importance=100 pss=0.00 rss=200MB description=crash state=empty trace=null
`;

test('parseExits reports kills and crashes, not requested stops', () => {
  const all = parseExits(EXITS, 'com.example', 0);
  assert.equal(all.length, 2);
  assert.match(all[0].text, /pid 14001\) exited at 14:56:06.724 while in the background: LOW_MEMORY — killed by the system/);
  assert.match(all[1].text, /while in front: APP CRASH\(EXCEPTION\) \(crash\)/);
  assert.equal(parseExits(EXITS, 'com.example', Date.parse('2026-10-15T14:50:00')).length, 1);
});

test('summariseIps names the exception, the reason and the crashed frames', () => {
  const text = summariseIps(
    {
      procName: 'Demo',
      captureTime: '2026-10-15 15:00:00.0000 +0900',
      exception: { type: 'EXC_CRASH', signal: 'SIGABRT' },
      asi: { CoreFoundation: ["*** Terminating app due to uncaught exception 'NSRangeException', reason: 'index 3 beyond bounds'"] },
      faultingThread: 0,
      usedImages: [{ name: 'Demo' }, { name: 'CoreFoundation' }],
      threads: [{ triggered: true, frames: [{ imageIndex: 1, symbol: '__exceptionPreprocess', symbolLocation: 226 }, { imageIndex: 0, imageOffset: 4096 }] }],
    },
    '/tmp/Demo.ips',
  );
  assert.match(text, /^Demo crashed at .* — EXC_CRASH \(SIGABRT\)/);
  assert.match(text, /NSRangeException/);
  assert.match(text, /CoreFoundation\s+__exceptionPreprocess \+ 226/);
  assert.match(text, /Demo\s+\+4096/);
  assert.match(text, /report: \/tmp\/Demo.ips$/);
});

test('iOS exits: signals from runningboardd, deliberate stops left out', async () => {
  const { parseExits: iosExits } = await import('../lib/ios.js');
  const out = [
    '2026-10-15 17:20:15.136 Df runningboardd[23250:2b68a24] [com.apple.runningboard:ttl] [app<com.example((null))>:24814] termination reported by launchd (2, 5, 5)',
    '2026-10-15 17:25:00.000 Df runningboardd[23250:2b68a24] [com.apple.runningboard:ttl] [app<com.example((null))>:24900] termination reported by launchd (2, 9, 9)',
    '2026-10-15 17:26:00.000 Df runningboardd[23250:2b68a24] [com.apple.runningboard:ttl] [app<com.example((null))>:24901] termination reported by launchd (2, 11, 11)',
  ].join('\n');
  const found = iosExits(out, 'com.example', 0);
  assert.equal(found.length, 2);
  assert.match(found[0].text, /com.example \(pid 24814\) crashed at 17:20:15.136 — SIGTRAP/);
  assert.match(found[1].text, /SIGSEGV/);
});
