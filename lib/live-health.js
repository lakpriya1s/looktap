// How each device is doing, for `looktap live`'s details panel: battery, heat, storage, and the app in front with
// its CPU and memory. On a worker thread of its own, like the device list: adb and simctl are asked synchronously, and
// the server's thread has frames to pass on meanwhile.
//
// Only what is cheap to read is read. A real iPhone's app CPU and memory come from Instruments (looktap perf), a
// recording that takes seconds and loads the phone: the panel says so instead.
import { parentPort } from 'node:worker_threads';

import { Android } from './android.js';
import { Ios } from './ios.js';
import { lockdown } from './lockdown.js';
import { memoryJson } from './perf.js';
import { ADB, run } from './util.js';

/** `dumpsys battery` → { level %, charging, temp °C }. */
export function parseBattery(text) {
  const n = (k) => Number(new RegExp(`^\\s*${k}: (-?\\d+)`, 'm').exec(text || '')?.[1]);
  const level = n('level'), scale = n('scale') || 100;
  if (!Number.isFinite(level)) return null;
  const powered = /^\s*(AC|USB|Wireless|Dock) powered: true/m.test(text);
  const status = n('status'); // 2 charging, 5 full
  const temp = n('temperature');
  return { level: Math.round((level / scale) * 100), charging: status === 2 || (powered && status !== 3), full: status === 5, ...(Number.isFinite(temp) && { temp: temp / 10 }) };
}

/** `df -k <dir>` → { free, total } in bytes, from its last line. */
export function parseDf(text) {
  const cols = (text || '').trim().split('\n').at(-1)?.trim().split(/\s+/) || [];
  const total = Number(cols[1]) * 1024, free = Number(cols[3]) * 1024;
  return Number.isFinite(total) && Number.isFinite(free) && total > 0 ? { free, total } : null;
}

const THERMAL = ['normal', 'light', 'moderate', 'severe', 'critical', 'emergency', 'shutdown'];
/** `dumpsys thermalservice` → its status as a word (normal … shutdown), null when it doesn't say. */
export function parseThermal(text) {
  const s = Number(/Thermal Status: (\d)/.exec(text || '')?.[1]);
  return Number.isFinite(s) ? THERMAL[s] || null : null;
}

/** A perf reading → what the panel shows: CPU (100% is one core) and the first memory figure. */
const appUse = (id, r) => {
  const memory = memoryJson(r.memory);
  const [what, bytes] = r.memory[0] || [];
  return { id, cpu: Math.round(r.cpu * 10) / 10, memory: bytes ?? null, memoryKind: what || null, ...(memory && { all: memory }) };
};

async function android(id) {
  const adb = (...args) => run(ADB, ['-s', id, 'shell', ...args], { allowFail: true, timeout: 5000 });
  const out = { battery: parseBattery(adb('dumpsys', 'battery')), storage: parseDf(adb('df', '-k', '/data')), thermal: parseThermal(adb('dumpsys', 'thermalservice')) };
  const d = new Android(id, {});
  try {
    const front = await d.foreground();
    if (front?.id) out.app = await d.perf(front.id, 500, front.pid).then((r) => appUse(front.id, r), () => ({ id: front.id }));
  } finally {
    d.close?.();
  }
  return out;
}

async function simulator(id) {
  const d = new Ios(id, {});
  const out = {};
  try {
    const front = await d.foreground();
    if (front?.id && !/springboard/i.test(front.id)) out.app = await d.perf(front.id, 500, front.pid).then((r) => appUse(front.id, r), () => ({ id: front.id }));
  } finally {
    d.close?.();
  }
  return out;
}

/** A real iPhone: battery and storage from lockdown (no runner, no Instruments). */
async function iphone(id) {
  const out = {};
  const s = await lockdown(id, 4000);
  try {
    const b = await s.values(null, 'com.apple.mobile.battery').catch(() => null);
    if (b && b.BatteryCurrentCapacity != null) out.battery = { level: b.BatteryCurrentCapacity, charging: Boolean(b.BatteryIsCharging), full: Boolean(b.FullyCharged) };
    const disk = await s.values(null, 'com.apple.disk_usage').catch(() => null);
    if (disk && disk.TotalDataCapacity) out.storage = { free: disk.TotalDataAvailable, total: disk.TotalDataCapacity };
  } finally {
    s.close();
  }
  out.appNote = 'App CPU and memory on a real iPhone come from Instruments: looktap perf in a terminal';
  return out;
}

/** One device's health: whatever could be read, with `error` for a part that couldn't. Never throws. */
export async function health(device) {
  const read = device.platform === 'android' ? android : device.kind === 'simulator' ? simulator : iphone;
  try {
    return { at: Date.now(), ...(await read(device.id)) };
  } catch (e) {
    return { at: Date.now(), error: String(e.message || e).split('\n')[0].slice(0, 160) };
  }
}

parentPort?.on('message', async ({ n, device }) => parentPort.postMessage({ n, health: await health(device) }));
