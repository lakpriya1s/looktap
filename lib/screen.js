// Platform-neutral screen logic on top of a driver's snapshot(): the `ls` view, element refs (@N),
// waiting for elements, scrolling to them, and settling after an action. Drivers only report elements.
//
// Element: { label, type, x, y, w, h, id?, value? } in iOS points / Android dp.
import { join } from 'node:path';

import { HOME, NotFound, UsageError, readJson, sleep, writeJson } from './util.js';

const contains = (a, b) => a.x <= b.x && a.y <= b.y && a.x + a.w >= b.x + b.w && a.y + a.h >= b.y + b.h;

const KEY_IDS = new Set(['shift', 'delete', 'space', 'more', 'emoji', 'dictation']);

/**
 The on-screen keyboard's area, from its keys (iOS keys with stable identifiers, plus every button in the
 band they span), or null when no keyboard is up.
 */
export function keyboardArea(elements) {
  const right = Math.max(...elements.map((e) => e.x + e.w));
  const bottom = Math.max(...elements.map((e) => e.y + e.h));
  // The layout view (UIKeyboardLayoutStar…) is there for every layout, number pads included.
  const layout = elements.find((e) => e.id?.startsWith('UIKeyboardLayout'));
  if (layout) return { x: 0, y: layout.y, w: right, h: bottom - layout.y };
  const anchors = elements.filter((e) => KEY_IDS.has(e.id));
  if (!anchors.some((e) => e.id === 'shift' || e.id === 'delete' || e.id === 'space')) return null;
  // Letter keys sit in rows above the anchors: single-character buttons within ~3 key heights.
  const keyH = Math.max(...anchors.map((e) => e.h));
  const anchorTop = Math.min(...anchors.map((e) => e.y));
  const keys = elements.filter(
    (e) => e.type === 'Button' && (KEY_IDS.has(e.id) || e.label.length <= 1) && e.y >= anchorTop - 3.5 * keyH,
  );
  const top = Math.min(anchorTop, ...keys.map((e) => e.y));
  return { x: 0, y: top, w: right, h: bottom - top };
}

const inside = (r, e) => e.y >= r.y - 1 && e.x >= r.x - 1 && e.y + e.h <= r.y + r.h + 1;
const statusBar = (e) => e.y + e.h <= 50 && e.type !== 'Button';

/**
 What `ls` lists: labelled elements, plus unlabelled buttons (agents tap those by ref). A label repeated
 on a nested element (a row and its own text, say) is listed once, as the outermost. The on-screen keyboard
 is one row instead of forty keys, and status-bar readouts (clock, battery) are left out — status-bar
 buttons such as "Return to <app>" stay. `all` keeps everything.
 */
export function visibleRows(elements, { all = false } = {}) {
  const kb = all ? null : keyboardArea(elements);
  const out = [];
  for (const e of elements) {
    if (!(e.w > 0 && e.h > 0)) continue;
    if (!all) {
      if (!e.label && !/Button/.test(e.type)) continue;
      if (statusBar(e)) continue;
      if (kb && (e.type === 'Button' || e.id?.startsWith('UIKeyboardLayout')) && inside(kb, e)) continue;
      if (e.label && out.some((o) => o.label === e.label && (contains(o, e) || contains(e, o)))) continue;
    }
    out.push(e);
  }
  if (kb) out.push({ label: 'Keyboard (type with: looktap type)', type: 'Keyboard', ...kb });
  return out;
}

export function formatRow(e, ref) {
  const label = e.label ? e.label.slice(0, 90) : '(no label)';
  const value = e.value && e.value !== e.label ? `  = ${e.value.slice(0, 40)}` : '';
  return `@${String(ref).padEnd(3)} ${e.type.slice(0, 14).padEnd(14)} ${String(e.x).padStart(4)},${String(e.y).padStart(4)} ${e.w}x${e.h}  ${label}${value}`;
}

const refsFile = (device) => join(HOME, 'refs', `${device.replace(/[^\w.-]/g, '_')}.json`);

/** Remember what @1…@N meant in the last listing for this device, and which app was in front. */
export function saveRefs(device, rows, front = null) {
  writeJson(refsFile(device), { at: Date.now(), front, rows: rows.map(({ label, type, x, y, w, h }) => ({ label, type, x, y, w, h })) });
}

/** The app that was in front at the last listing on this device (a frontApp(), with `at`), if known. */
export function lastFront(device) {
  const saved = readJson(refsFile(device), null);
  return saved?.front ? { ...saved.front, at: saved.at } : null;
}

/** Forget which app was in front: looktap itself just replaced or removed it (launch, reset, uninstall). */
export function forgetFront(device) {
  const saved = readJson(refsFile(device), null);
  if (saved?.front) writeJson(refsFile(device), { ...saved, front: null });
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
  if (!r) throw new UsageError(`${ref} is not in the last listing — run: looktap ls`);
  const now = elements.find((e) => e.label === r.label && Math.abs(e.x - r.x) <= 1 && Math.abs(e.y - r.y) <= 1 && Math.abs(e.w - r.w) <= 1 && Math.abs(e.h - r.h) <= 1);
  if (!now) throw new NotFound(`${ref} (${JSON.stringify(r.label || r.type)} at ${r.x},${r.y}) is no longer on screen — run: looktap ls`);
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
 The screen once an action has taken effect. With `before` (the screen before the action), first wait
 up to `changeTimeout` for it to differ — a launch or deep link takes a while to replace the old screen,
 and an unchanged screen would otherwise pass for settled. Then read ~150 ms apart until two agree
 (max ~2.5 s). An action that changes nothing costs `changeTimeout`.
 */
export async function settle(d, { all = false, before = null, changeTimeout = 1500 } = {}) {
  let prev;
  if (before) {
    const until = Date.now() + changeTimeout;
    do {
      await sleep(150);
      prev = await d.snapshot({ all });
    } while (signature(prev) === signature(before) && Date.now() < until);
  } else {
    await sleep(200);
    prev = await d.snapshot({ all });
  }
  const until = Date.now() + 2500;
  while (Date.now() < until) {
    await sleep(150);
    const next = await d.snapshot({ all });
    // Two equal reads mid-slide aren't settled: a push can pause part-way while the new screen draws.
    if (signature(next) === signature(prev) && !sliding(next)) return next;
    prev = next;
  }
  return prev;
}

/**
 A page-wide element pushed past a side edge: a screen sliding in or out. Inset rows stay on screen and
 carousel cards are narrower, so neither counts.
 */
export function sliding({ screen, elements }) {
  const W = screen?.w;
  return W > 0 && elements.some((e) => e.w >= W * 0.9 && (e.x < -1 || e.x + e.w > W + 1));
}

/**
 Elements that may cover the tap point of `target`: ones listed after it (drawn later, so usually on
 top) that contain the point but are neither inside the target nor around it — a toast over a tab
 bar, a floating toolbar over a list row.
 */
export function coveringAt(elements, target, [x, y]) {
  const i = elements.indexOf(target);
  return visibleRows(elements.slice(i + 1)).filter(
    (e) => x >= e.x && x <= e.x + e.w && y >= e.y && y <= e.y + e.h && !contains(target, e) && !contains(e, target),
  );
}

/**
 The id of the app that was in front (`before`, from frontApp()) if it has since died — left the front
 and has no process — else null. An app that was only switched away from (home, another app) is alive,
 and one uninstalled meanwhile isn't reported.
 */
export async function appGone(d, before) {
  if (!before) return null;
  const now = await d.frontApp().catch(() => null);
  if (now?.key === before.key) return null;
  if (await d.alive(before)) return null;
  // An app that can't be named any more was uninstalled or replaced, not crashed.
  return d.appId(before);
}

/** True when everything listed sits in the status bar: the app is likely under a system prompt. */
export function onlyStatusBar(elements) {
  const rows = elements.filter((e) => e.label && e.w > 0 && e.h > 0);
  return rows.length > 0 && rows.every((e) => e.y + e.h <= 60);
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
