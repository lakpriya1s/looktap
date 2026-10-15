// Platform-neutral screen logic on top of a driver's snapshot(): the `ls` view, element refs (@N),
// waiting for elements, scrolling to them, and settling after an action. Drivers only report elements.
//
// Element: { label, type, x, y, w, h, id?, value? } in iOS points / Android dp.
import { join } from 'node:path';

import { HOME, NotFound, UsageError, readJson, sleep, writeJson } from './util.js';

const contains = (a, b) => a.x <= b.x && a.y <= b.y && a.x + a.w >= b.x + b.w && a.y + a.h >= b.y + b.h;

/**
 What `ls` lists: labelled elements, plus unlabelled buttons (agents tap those by ref). A label repeated
 on a nested element (a row and its own text, say) is listed once, as the outermost. `all` keeps everything.
 */
export function visibleRows(elements, { all = false } = {}) {
  const out = [];
  for (const e of elements) {
    if (!(e.w > 0 && e.h > 0)) continue;
    if (!all) {
      if (!e.label && !/Button/.test(e.type)) continue;
      if (e.label && out.some((o) => o.label === e.label && (contains(o, e) || contains(e, o)))) continue;
    }
    out.push(e);
  }
  return out;
}

export function formatRow(e, ref) {
  const label = e.label ? e.label.slice(0, 90) : '(no label)';
  const value = e.value && e.value !== e.label ? `  = ${e.value.slice(0, 40)}` : '';
  return `@${String(ref).padEnd(3)} ${e.type.slice(0, 14).padEnd(14)} ${String(e.x).padStart(4)},${String(e.y).padStart(4)} ${e.w}x${e.h}  ${label}${value}`;
}

const refsFile = (device) => join(HOME, 'refs', `${device.replace(/[^\w.-]/g, '_')}.json`);

/** Remember what @1…@N meant in the last listing for this device. */
export function saveRefs(device, rows) {
  writeJson(refsFile(device), { at: Date.now(), rows: rows.map(({ label, type, x, y, w, h }) => ({ label, type, x, y, w, h })) });
}

export const isRef = (s) => /^@\d+$/.test(s);

/**
 The element @N from the last `ls`, if it is still on screen at the same place. A ref is never
 re-aimed at something else: a stale ref is an error, so a changed screen can't be tapped blind.
 */
export function resolveRef(device, ref, elements) {
  const saved = readJson(refsFile(device), null);
  const n = Number(ref.slice(1));
  const r = saved?.rows?.[n - 1];
  if (!r) throw new UsageError(`${ref} is not in the last listing — run: simdrive ls`);
  const now = elements.find((e) => e.label === r.label && Math.abs(e.x - r.x) <= 1 && Math.abs(e.y - r.y) <= 1 && Math.abs(e.w - r.w) <= 1 && Math.abs(e.h - r.h) <= 1);
  if (!now) throw new NotFound(`${ref} (${JSON.stringify(r.label || r.type)} at ${r.x},${r.y}) is no longer on screen — run: simdrive ls`);
  return now;
}

export const center = (e) => [Math.round(e.x + e.w / 2), Math.round(e.y + e.h / 2)];

/** Elements whose label (or iOS identifier) matches: exact first, else substring. For wait/scrollto. */
export function matches(elements, label) {
  const exact = elements.filter((e) => e.label === label || e.id === label);
  return exact.length ? exact : elements.filter((e) => e.label?.includes(label));
}

const signature = (s) => s.elements.map((e) => `${e.label}|${e.x},${e.y},${e.w},${e.h}`).join('\n');

/**
 The screen once it stops changing after an action: reads ~150 ms apart until two agree (max ~2.5 s).
 Starts after a short pause, since a tap's effect begins a frame or two after the tap returns.
 */
export async function settle(d, { all = false } = {}) {
  await sleep(200);
  let prev = await d.snapshot({ all });
  const until = Date.now() + 2500;
  while (Date.now() < until) {
    await sleep(150);
    const next = await d.snapshot({ all });
    if (signature(next) === signature(prev)) return next;
    prev = next;
  }
  return prev;
}

/** Wait until `label` (or @ref) is on screen, or with `gone`, until it isn't. */
export async function waitFor(d, device, target, { gone = false, timeout = 10000 } = {}) {
  const until = Date.now() + timeout;
  for (;;) {
    const { elements } = await d.snapshot();
    let hit = null;
    try {
      hit = isRef(target) ? resolveRef(device, target, elements) : matches(elements, target)[0] || null;
    } catch (e) {
      if (!(e instanceof NotFound)) throw e;
    }
    if (gone ? !hit : hit) return hit;
    if (Date.now() >= until) throw new NotFound(gone ? `still on screen after ${timeout / 1000} s: ${target}` : `not on screen after ${timeout / 1000} s: ${target}`);
    await sleep(150);
  }
}

/**
 Swipe until `label` is fully on screen. Default scrolls the content down (finger moves up); `up`
 scrolls back. Stops at the end of the list — when a swipe no longer changes the screen.
 */
export async function scrollTo(d, label, { up = false, maxSwipes = 15 } = {}) {
  let snap = await d.snapshot();
  for (let i = 0; ; i++) {
    const { w, h } = snap.screen;
    const hit = matches(snap.elements, label).find((e) => e.y >= 0 && e.y + e.h <= h && e.x >= 0 && e.x + e.w <= w);
    if (hit) return hit;
    if (i >= maxSwipes) throw new NotFound(`not found after ${maxSwipes} swipes: ${label}`);
    const x = Math.round(w / 2), a = Math.round(h * 0.7), b = Math.round(h * 0.35);
    await d.swipe(x, up ? b : a, x, up ? a : b, 300);
    const next = await settle(d);
    if (signature(next) === signature(snap)) throw new NotFound(`reached the ${up ? 'top' : 'end'} without finding: ${label}`);
    snap = next;
  }
}
