// The devices `looktap live` shows, listed on a worker thread: simctl and adb are asked synchronously and take up to
// a second together, and on the server's own thread that would hold every stream's frames back each time.
import { parentPort } from 'node:worker_threads';

import { inventory } from './devices.js';
import { ADB, run } from './util.js';

/** adb's answers for a device's rounded corners and its width → the radius as a share of the width (0: square or unknown). */
export function cornerShare(dumpsysDisplay, wmSize) {
  const radius = Number(/RoundedCorner\{position=TopLeft, radius=(\d+)/.exec(dumpsysDisplay)?.[1] || 0);
  const width = Number(/Physical size: (\d+)x\d+/.exec(wmSize)?.[1] || 0);
  return radius && width ? Math.min(0.25, radius / width) : 0;
}

/**
 An Apple device's screen corners and what its glass has that its framebuffer doesn't, from its name: the radius as a
 share of the screen's width, and an iPhone's `island` (the 14 Pro, and everything from the 15 on) or `notch` (the X
 to the 14). An iPhone SE and the iPads have square or near-square corners and neither.
 */
export function appleShape(name) {
  if (/Watch/.test(name)) return { corner: 0.2 };
  if (/iPad/.test(name)) return { corner: 0.025 };
  if (/SE\b/.test(name)) return { corner: 0 };
  return { corner: 0.12, cutout: /1[5-9]|[2-9]\d|14 Pro|Air|Duo/.test(name) ? 'island' : 'notch' };
}

const corners = new Map();

/** What the page needs of each device: can it be shown live (and if not, why), and its shape. */
export function liveDevices(list, cornerOf = () => 0) {
  return list
    .filter((d) => d.running !== false && !d.samePhoneAs)
    .map((d) => {
      const why = d.ready === false ? d.problem || 'not ready' : null;
      // A real iPhone is named by its owner ("Sam's iPhone"): its model says what it is.
      const shape = d.platform === 'ios' ? appleShape(d.model || d.name) : { corner: why ? 0 : cornerOf(d.id) };
      // A real iPhone has no video the Mac can take without a cable to QuickTime: it is shown as screenshots.
      const slow = d.platform === 'ios' && d.kind !== 'simulator';
      // On a cable it has one after all: the screen feed. Its gestures still go through the runner, whole.
      const wired = slow && d.connection === 'USB';
      return { id: d.id, name: d.name, platform: d.platform, kind: d.kind, os: d.os || '', live: !why, ...(why && { why }), ...(slow && { slow }), ...(wired && { wired }), ...shape };
    });
}

/** Simulators and emulators that aren't running: what the page's Start picker offers. */
export const startable = (list) =>
  list
    .filter((d) => d.running === false && (d.kind === 'simulator' || d.kind === 'emulator'))
    .map((d) => ({ id: d.id, name: d.name, platform: d.platform, kind: d.kind, os: d.os || '' }));

parentPort?.on('message', () => {
  const cornerOf = (id) => {
    if (!corners.has(id)) {
      const adb = (...args) => run(ADB, ['-s', id, 'shell', ...args], { allowFail: true, timeout: 5000 });
      corners.set(id, cornerShare(adb('dumpsys', 'display'), adb('wm', 'size')));
    }
    return corners.get(id);
  };
  // A listing that failed (adb restarting, a device half-way through booting) says nothing about what is running:
  // the server keeps the list it has rather than drop every stream.
  let list = null, off = null;
  try {
    const all = inventory({ all: true });
    list = liveDevices(all, cornerOf);
    off = startable(all);
  } catch {}
  parentPort.postMessage(list && { list, off });
});
