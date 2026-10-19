import assert from 'node:assert/strict';
import { test } from 'node:test';

import { duration, formatFrames, formatReading, formatSamples, memoryJson, parseFootprint, readingJson, uptimes, parseGfxinfo, parseMeminfo, procTicks, psTime } from '../lib/perf.js';

test('psTime reads ps CPU time, with or without hours', () => {
  assert.equal(psTime('  0:08.54\n'), 8.54);
  assert.equal(psTime('12:01.50'), 721.5);
  assert.equal(psTime('1:02:03.25'), 3723.25);
  assert.equal(psTime(''), null);
});

test('parseFootprint takes the footprint and its peak in bytes', () => {
  const text = 'Preferences [45010]: 64-bit    Footprint: 98 MB (16384 bytes per page)\n    phys_footprint: 102960032 B\n    phys_footprint_peak: 105008032 B\n';
  assert.deepEqual(parseFootprint(text), { footprint: 102960032, peak: 105008032 });
  assert.deepEqual(parseFootprint(''), { footprint: null, peak: null });
});

test('procTicks adds utime and stime, even when the process name has spaces', () => {
  assert.equal(procTicks('4816 (ndroid.settings) S 436 436 0 0 -1 4194624 11725 0 815 0 55 81 0 0 10 -10 27'), 136);
  assert.equal(procTicks('77 (a b) c) R 1 1 0 0 -1 0 0 0 0 0 7 3 0 0 20 0 1'), 10);
});

test('parseMeminfo reads the summary, in bytes', () => {
  const text = [
    '  Native Heap    14804    14672       64       45    15504    27296    21053     1787',
    '           Java Heap:    10368                          31760',
    '         Native Heap:    14672                          15504',
    '           TOTAL PSS:    74402            TOTAL RSS:   176432       TOTAL SWAP PSS:      874',
  ].join('\n');
  assert.deepEqual(parseMeminfo(text), { pss: 74402 * 1024, rss: 176432 * 1024, java: 10368 * 1024, native: 14672 * 1024 });
});

test('parseGfxinfo reads frames, jank, percentiles and causes', () => {
  const text = [
    'Total frames rendered: 49', 'Janky frames: 9 (18.37%)', 'Janky frames (legacy): 9 (18.37%)',
    '50th percentile: 17ms', '90th percentile: 53ms', '95th percentile: 80ms', '99th percentile: 150ms',
    'Number High input latency: 2', 'Number Slow UI thread: 3', 'Number Frame deadline missed: 9', '50th gpu percentile: 6ms',
  ].join('\n');
  assert.deepEqual(parseGfxinfo(text), { frames: 49, janky: 9, p50: 17, p90: 53, p95: 80, p99: 150, slowUiThread: 3, missedDeadline: 9, highInputLatency: 2 });
});

test('uptimes reads /proc/uptime lines among other output', () => {
  assert.deepEqual(uptimes('8081.52 30120.40\n4816 (x) S 1\n8082.03 30121.11\nThreads:\t27\n'), [8081.52, 8082.03]);
});

test('frames: no percentiles when nothing was drawn', () => {
  assert.equal(parseGfxinfo('Total frames rendered: 0\n50th percentile: 4950ms').p50, null);
  assert.match(formatFrames('a.b', parseGfxinfo('Total frames rendered: 0\n50th percentile: 4950ms')).join('\n'), /no frames rendered/);
  assert.match(formatFrames('a.b', { frames: 50, janky: 1, p50: 16, p90: 17, p95: 17, p99: 30, slowUiThread: 0, missedDeadline: 1, highInputLatency: 0 })[0], /50 frames .* 1 janky \(2\.0%\)/);
});

test('memory as JSON uses camelCase keys', () => {
  assert.deepEqual(memoryJson([['pss', 1], ['java heap', 2], ['native heap', 3]]), { pss: 1, javaHeap: 2, nativeHeap: 3 });
});

test('a reading as JSON rounds CPU to one decimal', () => {
  assert.deepEqual(readingJson({ pid: 1, ms: 500, cpu: 124.04580152671744, memory: [['footprint', 5]], threads: 2 }), { pid: 1, ms: 500, cpu: 124, memory: { footprint: 5 }, threads: 2 });
  assert.equal(readingJson({ cpu: 7.25, memory: [] }).cpu, 7.3);
});

test('duration: 10s, 1m, 500ms, bare seconds', () => {
  assert.equal(duration('10s'), 10000);
  assert.equal(duration('1m'), 60000);
  assert.equal(duration('500ms'), 500);
  assert.equal(duration('3'), 3000);
  assert.ok(Number.isNaN(duration('soon')));
});

test('a reading and a series format as short lines', () => {
  const r = { pid: 9, ms: 500, cpu: 12.4, memory: [['footprint', 75 * 1048576], ['peak', 80 * 1048576]], threads: 18 };
  assert.deepEqual(formatReading('a.b', r), ['a.b  pid 9', 'cpu      12%  (over 0.5 s; 100% is one core)', 'memory   footprint 75.0 MB · peak 80.0 MB', 'threads  18']);
  const samples = [{ ...r, at: 0, ms: 1000, cpu: 10 }, { ...r, at: 1500, ms: 1000, cpu: 30, memory: [['footprint', 90 * 1048576]] }];
  assert.match(formatSamples('a.b', samples).at(-1), /^over 2\.5 s \(2 readings\): cpu avg 20% · max 30% \| footprint start 75\.0 MB · max 90\.0 MB · end 90\.0 MB$/);
});
