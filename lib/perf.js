// `looktap perf`: an app's CPU, memory and threads (one reading, or sampled for a while), and on Android its frame
// stats. The drivers read the numbers (ps and footprint on the Mac for a simulator app, /proc and dumpsys on
// Android); this file parses what those tools print and formats the result.

/** `ps -o time=`: "1:02.34" or "1:02:03.45" (h:mm:ss) → seconds of CPU time; null when the process is gone. */
export function psTime(text) {
  const m = /(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)/.exec(text || '');
  return m ? Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}

/** `footprint -f bytes -p <pid>` → { footprint, peak } in bytes (what Xcode's memory gauge shows). */
export function parseFootprint(text) {
  const num = (name) => Number(new RegExp(`^\\s*${name}:\\s*(\\d+)\\s*B`, 'm').exec(text || '')?.[1]) || null;
  return { footprint: num('phys_footprint'), peak: num('phys_footprint_peak') };
}

/** One /proc/<pid>/stat line → CPU ticks used (utime + stime). The name in parentheses may hold spaces. */
export function procTicks(line) {
  const f = line.slice(line.lastIndexOf(')') + 2).split(' ');
  return Number(f[11]) + Number(f[12]); // fields 14 and 15, counted from 3 (the state) after the name
}

/** `dumpsys meminfo <pkg>` → { pss, rss, java, native } in bytes (the summary's numbers, given in KB). */
export function parseMeminfo(text) {
  const kb = (re) => (Number(re.exec(text || '')?.[1]) || 0) * 1024 || null;
  return {
    pss: kb(/TOTAL PSS:\s+(\d+)/),
    rss: kb(/TOTAL RSS:\s+(\d+)/),
    java: kb(/^\s*Java Heap:\s+(\d+)/m),
    native: kb(/^\s*Native Heap:\s+(\d+)/m),
  };
}

/** `dumpsys gfxinfo <pkg>`: frames rendered, janky ones, frame-time percentiles (ms) and why frames were late. */
export function parseGfxinfo(text) {
  const n = (re) => Number(re.exec(text || '')?.[1]) || 0;
  const ms = (p) => n(new RegExp(`^${p}th percentile:\\s*(\\d+)ms`, 'm'));
  return {
    frames: n(/Total frames rendered:\s*(\d+)/),
    janky: n(/^Janky frames:\s*(\d+)/m),
    p50: ms(50), p90: ms(90), p95: ms(95), p99: ms(99),
    slowUiThread: n(/Number Slow UI thread:\s*(\d+)/),
    missedDeadline: n(/Number Frame deadline missed:\s*(\d+)/),
    highInputLatency: n(/Number High input latency:\s*(\d+)/),
  };
}

/** Memory figures as JSON: { footprint, peak } or { pss, rss, javaHeap, nativeHeap }, in bytes. */
export const memoryJson = (memory) => Object.fromEntries(memory.map(([what, bytes]) => [what.replace(/ (\w)/g, (_, c) => c.toUpperCase()), bytes]));

export const MB = (bytes) => (bytes == null ? '?' : `${(bytes / 1048576).toFixed(1)} MB`);
const pct = (v) => (v == null ? '?' : `${Math.round(v)}%`);

/** A duration for --for: 10s, 1m, 500ms (bare numbers are seconds) → ms; NaN when it isn't one. */
export function duration(s) {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m)?$/.exec(String(s ?? ''));
  return m ? Number(m[1]) * { ms: 1, s: 1e3, m: 6e4 }[m[2] || 's'] : NaN;
}

/** One reading as lines: cpu, each memory figure, threads. */
export function formatReading(app, r) {
  return [
    `${app}  pid ${r.pid}`,
    `cpu      ${pct(r.cpu)}  (over ${(r.ms / 1000).toFixed(1)} s; 100% is one core)`,
    `memory   ${r.memory.map(([what, bytes]) => `${what} ${MB(bytes)}`).join(' · ')}`,
    `threads  ${r.threads ?? '?'}`,
  ];
}

/** Readings taken over time → a table row each, then min/avg/max of CPU and the first memory figure. */
export function formatSamples(app, samples) {
  const lead = samples[0].memory[0][0];
  const rows = samples.map((s) => `${`${(s.at / 1000).toFixed(1)}s`.padStart(6)}  ${pct(s.cpu).padStart(5)}  ${MB(s.memory[0][1]).padStart(9)}  ${String(s.threads ?? '?').padStart(7)}`);
  const cpu = samples.map((s) => s.cpu);
  const mem = samples.map((s) => s.memory[0][1]).filter((b) => b != null);
  const span = ((samples.at(-1).at + samples.at(-1).ms) / 1000).toFixed(1);
  return [
    `${app}  pid ${samples[0].pid}`,
    `  time    cpu  ${lead.padStart(9)}  threads`,
    ...rows,
    `over ${span} s (${samples.length} readings): cpu avg ${pct(cpu.reduce((a, b) => a + b, 0) / cpu.length)} · max ${pct(Math.max(...cpu))}` +
      (mem.length ? ` | ${lead} start ${MB(mem[0])} · max ${MB(Math.max(...mem))} · end ${MB(mem.at(-1))}` : ''),
  ];
}

/** Frame stats as lines. With no frames rendered the percentiles mean nothing, so they're left out. */
export function formatFrames(app, f) {
  if (!f.frames) return [`${app}: no frames rendered since the last perf --frames (nothing moved on screen)`];
  return [
    `${app}: ${f.frames} frames since the last perf --frames, ${f.janky} janky (${((f.janky / f.frames) * 100).toFixed(1)}%)`,
    `frame time  p50 ${f.p50} ms · p90 ${f.p90} ms · p95 ${f.p95} ms · p99 ${f.p99} ms`,
    `late frames  slow UI thread ${f.slowUiThread} · missed deadline ${f.missedDeadline} · high input latency ${f.highInputLatency}`,
  ];
}
