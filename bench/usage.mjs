// Host CPU and RAM of one tool while it runs, sampled from the shell with `ps` every 250 ms.
// A tool's processes: everything this runner spawned for it (its MCP server or CLI calls, and their children), plus
// helpers it leaves running outside that tree (WebDriverAgent, Maestro's driver, …) matched by name. The oracle's own
// commands (direct children carrying ORACLE_MARK) and their subtrees are left out.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execP = promisify(execFile);
// The runner's own commands (oracle, resets, load checks, samplers): left out of every tool's numbers.
export const ORACLE_MARK = /describe-all --udid \S+ --json|button --udid \S+ HOME|simctl (launch|terminate|spawn \S+ launchctl|list|shutdown|boot)|dumpsys|am force-stop|am start -n \S+ -f|input keyevent KEYCODE_HOME|^top -l|^vm_stat|cat \/proc\/loadavg|ps -A -o|getprop|adb -s \S+ (reboot|wait-for-device|get-state)|^pkill|^pgrep|^open -a Simulator/;
const HELPERS = /WebDriverAgentRunner|maestro-driver|dev\.mobile\.maestro|looktap-sim|looktap-server|com\.looktap|io\.appium\.uiautomator2|xcodebuild/;
// Daemons several tools (and the oracle) share, detached from whoever started them: reported apart, never per tool.
const SHARED = /idb_companion|adb .*(fork-server|server)/;

async function snapshot() {
  const { stdout } = await execP('ps', ['-axo', 'pid=,ppid=,rss=,%cpu=,command='], { maxBuffer: 1e8 });
  return stdout.split('\n').filter(Boolean).map((l) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/.exec(l);
    return m && { pid: +m[1], ppid: +m[2], rss: +m[3], cpu: +m[4], cmd: m[5] };
  }).filter(Boolean);
}

export function sampler() {
  const samples = [];
  let timer = null;
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const ps = await snapshot();
      const kids = new Map();
      for (const p of ps) (kids.get(p.ppid) || kids.set(p.ppid, []).get(p.ppid)).push(p);
      const mine = new Set();
      const walk = (pid) => { for (const k of kids.get(pid) || []) if (k.pid !== process.pid && !mine.has(k.pid)) { mine.add(k.pid); walk(k.pid); } };
      for (const child of kids.get(process.pid) || []) {
        if (ORACLE_MARK.test(child.cmd) || /^ps -axo/.test(child.cmd)) continue;
        mine.add(child.pid);
        walk(child.pid);
      }
      for (const p of ps) if (HELPERS.test(p.cmd)) { mine.add(p.pid); walk(p.pid); }
      let rss = 0, cpu = 0, shared = 0;
      for (const p of ps) if (mine.has(p.pid)) { rss += p.rss; cpu += p.cpu; }
      for (const p of ps) if (SHARED.test(p.cmd) && !mine.has(p.pid)) shared += p.rss;
      samples.push({ rss, cpu, shared });
    } catch {}
    busy = false;
  };
  return {
    start() { timer = setInterval(tick, 250); tick(); },
    stop() {
      clearInterval(timer);
      if (!samples.length) return null;
      const cpus = samples.map((s) => s.cpu);
      const rss = samples.map((s) => s.rss / 1024);
      return {
        samples: samples.length,
        peakRssMb: Math.round(Math.max(...rss)),
        meanRssMb: Math.round(rss.reduce((a, b) => a + b, 0) / rss.length),
        meanCpuPct: Math.round(cpus.reduce((a, b) => a + b, 0) / cpus.length),
        peakCpuPct: Math.round(Math.max(...cpus)),
        sharedPeakRssMb: Math.round(Math.max(...samples.map((s) => s.shared)) / 1024),
      };
    },
  };
}

// Host-wide busy % (all cores, from `top`) and reclaimable RAM.
export async function host() {
  const top = (await execP('top', ['-l', '2', '-s', '1', '-n', '0'])).stdout;
  const idle = [...top.matchAll(/([\d.]+)% idle/g)].at(-1)?.[1];
  const vm = (await execP('vm_stat')).stdout;
  const page = Number(/page size of (\d+)/.exec(vm)?.[1] || 16384);
  const pages = (k) => Number(new RegExp(`${k}:\\s+(\\d+)`).exec(vm)?.[1] || 0);
  return {
    busyPct: Math.round(100 - Number(idle ?? 100)),
    freeMb: Math.round(((pages('Pages free') + pages('Pages inactive') + pages('Pages speculative')) * page) / 2 ** 20),
    compressedMb: Math.round((pages('Pages occupied by compressor') * page) / 2 ** 20),
  };
}

// Kill whatever a tool left behind, then wait until the Mac is back near its idle baseline, so every tool starts alike.
export async function settle(baselineBusy = 100, { maxMs = 90000, kill = true } = {}) {
  if (kill) for (const pat of ['appium', 'mobile-mcp', 'ios-simulator-mcp', 'mobilebuildmcp', 'maestro', 'looktap.js mcp', 'looktap-sim', 'xcodebuild.*WebDriverAgent', 'axe '])
    await execP('pkill', ['-f', pat]).catch(() => {});
  const t0 = Date.now();
  let h = await host();
  let calm = 0;
  while (Date.now() - t0 < maxMs) {
    calm = h.busyPct <= baselineBusy + 10 ? calm + 1 : 0;
    if (calm >= 2) break;
    await new Promise((r) => setTimeout(r, 1000));
    h = await host();
  }
  return { ...h, waitedMs: Date.now() - t0 };
}

// Android: tools' helpers run inside the emulator, out of the host's sight. Sample them there with the device's `ps`
// every second: looktap's helper, Appium's UiAutomator2 server, Maestro's driver, and one-shot uiautomator dumps,
// `input` and `screencap` commands. The oracle only uses dumpsys and am, which don't match.
const DEVICE = /com\.looktap|io\.appium\.uiautomator2|dev\.mobile\.maestro|uiautomator|commands\.input|screencap/;
export function deviceSampler(serial) {
  const samples = [];
  let timer = null;
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const { stdout } = await execP('adb', ['-s', serial, 'shell', 'ps', '-A', '-o', 'RSS,%CPU,ARGS'], { maxBuffer: 1e8 });
      let rss = 0, cpu = 0;
      for (const l of stdout.split('\n').slice(1)) {
        const m = /^\s*(\d+)\s+([\d.]+)\s+(.*)$/.exec(l);
        if (m && DEVICE.test(m[3]) && !/\bps -A\b/.test(m[3])) { rss += +m[1]; cpu += +m[2]; }
      }
      samples.push({ rss, cpu });
    } catch {}
    busy = false;
  };
  return {
    start() { timer = setInterval(tick, 1000); tick(); },
    stop() {
      clearInterval(timer);
      if (!samples.length) return null;
      const rss = samples.map((s) => s.rss / 1024);
      return {
        samples: samples.length,
        peakRssMb: Math.round(Math.max(...rss)),
        meanRssMb: Math.round(rss.reduce((a, b) => a + b, 0) / rss.length),
        meanCpuPct: Math.round(samples.reduce((a, s) => a + s.cpu, 0) / samples.length),
      };
    },
  };
}
