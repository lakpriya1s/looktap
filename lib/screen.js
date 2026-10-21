// Platform-neutral screen logic on top of a driver's snapshot(): the `ls` view, element refs (@N),
// waiting for elements, scrolling to them, and settling after an action. Drivers only report elements.
//
// Element: { label, type, x, y, w, h, id?, value?, field?, svg? } in iOS points / Android dp.
// A driver's snapshot({ fresh }) may serve reads from a cache (Android's node cache); fresh reads ask the app itself.
import { join } from 'node:path';

import { HOME, NotFound, UsageError, normLabel, readJson, sleep, writeJson } from './util.js';

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
 on a nested element (a row and its own text, say) is listed once, as the outermost — or as the text field,
 when one of them is the field itself. The on-screen keyboard is one row instead of forty keys, and status-bar
 readouts (clock, battery) are left out — status-bar buttons such as "Return to <app>" stay. `all` keeps
 everything, except that a react-native-svg drawing is one row (`shapes`: how many it folds in) plus any
 labelled part of it.
 */
export function visibleRows(elements, { all = false } = {}) {
  const kb = all ? null : keyboardArea(elements);
  const out = [];
  for (let i = 0; i < elements.length; i++) {
    const e = elements[i];
    if (!(e.w > 0 && e.h > 0)) continue;
    if (!all) {
      if (!e.label && !/Button/.test(e.type)) continue;
      if (statusBar(e)) continue;
      if (kb && (e.type === 'Button' || e.id?.startsWith('UIKeyboardLayout')) && inside(kb, e)) continue;
      const twin = e.label ? out.findIndex((o) => o.label === e.label && (contains(o, e) || contains(e, o))) : -1;
      if (twin >= 0) {
        if (e.field && !out[twin].field) out[twin] = e;
        continue;
      }
    } else if (e.svg && e.type === 'SvgView') {
      // Its shapes follow it in tree order, inside its box.
      let n = 0;
      const labelled = [];
      for (let j = i + 1; j < elements.length && elements[j].svg && elements[j].type !== 'SvgView' && contains(e, elements[j]); j++, n++)
        if (elements[j].label && elements[j].w > 0 && elements[j].h > 0) labelled.push(elements[j]);
      out.push(n ? { ...e, shapes: n } : e, ...labelled);
      i += n;
      continue;
    }
    out.push(e);
  }
  if (kb) out.push({ label: 'Keyboard (type with: looktap type)', type: 'Keyboard', ...kb });
  return out;
}

export function formatRow(e, ref) {
  const svg = e.shapes ? `(svg, ${e.shapes} shape${e.shapes === 1 ? '' : 's'})` : '';
  const label = e.label ? e.label.slice(0, 90) + (svg && ` ${svg}`) : svg || '(no label)';
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

/** Elements whose label (or iOS identifier) matches: exact first, else substring; whitespace differences don't count. For wait/scrollto. */
export function matches(elements, label) {
  const want = normLabel(label);
  const exact = elements.filter((e) => e.id === label || (e.label && normLabel(e.label) === want));
  return exact.length ? exact : elements.filter((e) => e.label && normLabel(e.label).includes(want));
}

/**
 Reads for a loop that polls the screen: from the driver's cache, except that the second read and then one a second
 come from the app itself — a cache that lags behind the app must not keep a wait or a lookup from seeing the screen.
 */
export function poller(d, { all = false } = {}) {
  let reads = 0, lastFresh = 0;
  return () => {
    const fresh = reads++ === 1 || (reads > 2 && Date.now() - lastFresh >= 1000);
    if (fresh) lastFresh = Date.now();
    return d.snapshot({ all, fresh });
  };
}

export const signature = (s) => s.elements.map((e) => `${e.label}|${e.x},${e.y},${e.w},${e.h}`).join('\n');

/**
 The screen once an action has taken effect. With `before` (the screen before the action), first wait
 up to `changeTimeout` for it to differ — a launch or deep link takes a while to replace the old screen,
 and an unchanged screen would otherwise pass for settled. Then read ~150 ms apart until two agree
 (max ~2.5 s). An action that changes nothing costs `changeTimeout`.
 A cache can go on serving the screen the app just left (Android, when an app's change events lag), so a screen
 that still looks as it did before the action is confirmed with a read from the app itself.
 */
export async function settle(d, { all = false, before = null, changeTimeout = 1500 } = {}) {
  // Reads start at least 150 ms apart. A read that itself takes that long (a real iPhone's take ~0.4 s) needs no
  // pause after it.
  let last = Date.now();
  const read = async (gap = 150, fresh = false) => {
    await sleep(Math.max(0, last + gap - Date.now()));
    last = Date.now();
    const snap = await d.snapshot({ all, fresh });
    return fresh ? { ...snap, fresh } : snap;
  };
  let prev;
  if (before) {
    const until = Date.now() + changeTimeout;
    do prev = await read();
    while (signature(prev) === signature(before) && Date.now() < until);
    // Still the screen from before the action: make sure the app agrees (a fresh read costs ~0.2 s, so only here).
    if (signature(prev) === signature(before)) prev = await read(0, true);
  } else {
    prev = await read(200);
  }
  const until = Date.now() + 2500;
  while (Date.now() < until) {
    const next = await read();
    // Two equal reads mid-slide aren't settled: a push can pause part-way while the new screen draws.
    if (signature(next) === signature(prev) && !sliding(next)) {
      // Settled back on the screen from before: confirm it, as above.
      if (!before || prev.fresh || signature(next) !== signature(before)) return next;
      const app = await read(0, true);
      if (signature(app) === signature(next)) return app;
      prev = app;
      continue;
    }
    prev = next;
  }
  return prev;
}

/**
 A page-wide element pushed past one side edge: a screen sliding in or out. Inset rows stay on screen and
 carousel cards are narrower, so neither counts; nor does a background overhanging both edges (iOS 26 draws
 grouped-list sections 16 pt wider than the screen on each side), which would otherwise never look settled.
 */
export function sliding({ screen, elements }) {
  const W = screen?.w;
  return W > 0 && elements.some((e) => e.w >= W * 0.9 && (e.x < -1) !== (e.x + e.w > W + 1));
}

/**
 Elements that may cover `target`: ones listed after it (drawn later, so usually on top) that overlap it but are
 neither inside the target nor around it — a toast over a tab bar, a floating toolbar over a list row.
 */
function overlays(elements, target) {
  const i = elements.indexOf(target);
  if (i < 0) return [];
  const later = elements.slice(i + 1);
  // A row's own box can be smaller than what's drawn and takes touches: React Native's LogBox toast labels a 22-point
  // row inside its 48-point card. Grow it to the largest unlabelled box around it (up to 3× its size), never one
  // that wraps the target too.
  const card = (e) =>
    later
      .filter((o) => !o.label && o.w * o.h <= 3 * e.w * e.h && contains(o, e) && !contains(o, target))
      .reduce((big, o) => (o.w * o.h > big.w * big.h ? { ...e, x: o.x, y: o.y, w: o.w, h: o.h } : big), e);
  return visibleRows(later)
    .map(card)
    .filter((e) => e.x < target.x + target.w && target.x < e.x + e.w && e.y < target.y + target.h && target.y < e.y + e.h && !contains(target, e) && !contains(e, target));
}

// Within a point of an element's box: bounds are rounded down to whole points/dp, and touch targets reach a bit past
// what's drawn.
const over = (e, [x, y]) => x >= e.x - 1 && x <= e.x + e.w + 1 && y >= e.y - 1 && y <= e.y + e.h + 1;

/** The elements from overlays() that cover the point [x, y]. */
export function coveringAt(elements, target, at) {
  return overlays(elements, target).filter((e) => over(e, at));
}

export const LOGBOX = /Open debugger to view (warnings|errors)/;

/**
 React Native's LogBox toast (dev builds), when it sits over `target`: its card, with `close` (the × at its right end,
 as [x, y]). The toast's container spans the bottom ~100 points around the card and takes every touch there, so a tab
 bar under it is dead all over while the toast shows, not just where the card is drawn.
 */
export function logBoxOver(elements, target) {
  const i = elements.indexOf(target);
  if (i < 0) return null;
  const later = elements.slice(i + 1);
  const row = later.find((e) => LOGBOX.test(e.label || ''));
  if (!row) return null;
  const around = later.filter((o) => !o.label && contains(o, row) && o.h <= 160 && o.w < 1.2 * row.w + 40);
  const hit = (o) => o.x < target.x + target.w && target.x < o.x + o.w && o.y < target.y + target.h && target.y < o.y + o.h;
  if (!hit(row) && !around.some(hit)) return null;
  const card = around.filter((o) => o.w * o.h <= 3 * row.w * row.h).reduce((big, o) => (o.w * o.h > big.w * big.h ? o : big), row);
  return { ...row, x: card.x, y: card.y, w: card.w, h: card.h, close: [card.x + card.w - 14, Math.round(card.y + card.h / 2)] };
}

/**
 Where a tap on `target` lands on it: its centre, unless something drawn over the target covers that — then the
 middle of the biggest part left uncovered (the lower half of a button a toast hides the top of). { at, covers,
 avoided }: `covers` are what still covers `at` (only when no usable part is left: the tap may hit those);
 `avoided` what covered the centre, when the tap moved off it.
 */
export function tapPoint(elements, target) {
  const mid = center(target);
  const box = logBoxOver(elements, target);
  if (box) return { at: mid, covers: [box], avoided: [] };
  const tops = overlays(elements, target);
  const onMid = tops.filter((e) => over(e, mid));
  if (!onMid.length) return { at: mid, covers: [], avoided: [] };
  // Cut the target along every overlay's edges (with the point of margin) and take the roomiest free cell.
  const cuts = (lo, len, edges) => [...new Set([lo, lo + len, ...edges.filter((v) => v > lo && v < lo + len)])].sort((a, b) => a - b);
  const xs = cuts(target.x, target.w, tops.flatMap((e) => [e.x - 2, e.x + e.w + 2]));
  const ys = cuts(target.y, target.h, tops.flatMap((e) => [e.y - 2, e.y + e.h + 2]));
  let best = null;
  for (let i = 0; i + 1 < xs.length; i++)
    for (let j = 0; j + 1 < ys.length; j++) {
      const w = xs[i + 1] - xs[i], h = ys[j + 1] - ys[j];
      const at = [Math.round(xs[i] + w / 2), Math.round(ys[j] + h / 2)];
      if (tops.some((e) => over(e, at))) continue;
      const room = Math.min(w, h);
      if (!best || room > best.room || (room === best.room && w * h > best.area)) best = { at, room, area: w * h };
    }
  // A sliver isn't worth aiming at: a few points to spare either way.
  if (!best || best.room < 6) return { at: mid, covers: onMid, avoided: [] };
  return { at: best.at, covers: [], avoided: onMid };
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
  // The system's "keeps stopping" / "isn't responding" dialog about it is up: its process may not have gone yet,
  // but it has crashed or frozen all the same. (The system's dialogs belong to package "android".)
  if (now?.id === 'android' && d.stuck) {
    const stuck = await d.stuck().catch(() => null);
    if (stuck?.app === d.appId(before)) return stuck.app;
  }
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
  const look = poller(d);
  for (;;) {
    const { elements } = await look();
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
 What `expect` checks on one screen read: { ok, hit, why }. `target` matches as for wait (exact, else
 substring; `exact` allows only the first). `want`: a match's value must equal it. `gone`: nothing may match.
 */
export function check(elements, target, { want = null, gone = false, exact = false, device = null } = {}) {
  let hits = [];
  if (isRef(target)) {
    try {
      hits = [resolveRef(device, target, elements)];
    } catch (e) {
      if (!(e instanceof NotFound)) throw e;
    }
  } else {
    const live = elements.filter((e) => e.w > 0 && e.h > 0);
    hits = exact ? live.filter((e) => e.id === target || (e.label && normLabel(e.label) === normLabel(target))) : matches(live, target);
  }
  const name = (e) => JSON.stringify(e.label || e.type);
  if (gone) return hits.length ? { ok: false, hit: hits[0], why: `still on screen: ${name(hits[0])} at ${center(hits[0]).join(',')}` } : { ok: true };
  if (!hits.length) return { ok: false, why: `not on screen: ${target}` };
  if (want == null) return { ok: true, hit: hits[0] };
  const hit = hits.find((e) => e.value === want);
  if (hit) return { ok: true, hit };
  // A switch and its own text share a label: report the one that has a value.
  const e = hits.find((h) => h.value != null) || hits[0];
  return { ok: false, hit: e, why: `${name(e)} is ${e.value != null ? JSON.stringify(e.value) : 'empty (no value)'}, expected ${JSON.stringify(want)}` };
}

/** Read the screen until `check` passes, or `timeout` ms pass; the last result either way. */
export async function expectOn(d, device, target, { timeout = 3000, ...rest } = {}) {
  const until = Date.now() + timeout;
  const look = poller(d);
  for (;;) {
    const r = check((await look()).elements, target, { ...rest, device });
    if (r.ok || Date.now() >= until) return r;
    await sleep(150);
  }
}

/**
 Swipe until `label` is fully on screen. Default scrolls the content down (finger moves up); `up`
 scrolls back. Stops at the end of the list — when a swipe no longer changes the screen.
 Each swipe holds still before lifting, so the list stops where the finger did: a read then shows it, where
 a fling would coast for seconds (and on a real device every read waiting for it costs ~0.4 s). A second read
 confirms it stopped, and if it hasn't (a real iPhone), it waits. Where a swipe can't hold (Android without its
 helper), it waits for the screen to settle instead.
 */
export async function scrollTo(d, label, { up = false, maxSwipes = 15 } = {}) {
  let snap = await d.snapshot();
  let kbTop = null; // where the keyboard starts, as of the last swipe: what's under it isn't on screen to tap
  const fit = (s) => {
    const { w } = s.screen;
    const h = Math.min(s.screen.h, kbTop ?? Infinity);
    return matches(s.elements, label).find((e) => e.y >= 0 && e.y + e.h <= h && e.x >= 0 && e.x + e.w <= w);
  };
  // Swipes stay above the keyboard: one started on its keys would type (glide typing), not scroll.
  const band = async (s) => {
    const { h } = s.screen;
    const kb = (await d.keyboardTop?.()) ?? keyboardArea(s.elements)?.y ?? null;
    const bottom = kb != null && kb > 0 && kb < h ? kb : h;
    if (bottom < 100)
      throw new UsageError(`the keyboard leaves no room to scroll (it starts at y ${bottom}) — hide it first: looktap hidekb`);
    return bottom;
  };
  for (let i = 0; ; i++) {
    const hit = fit(snap);
    if (hit) {
      // Found on a read taken right after a swipe: make sure it isn't still moving (a bounce at the end of a list).
      if (i === 0) return hit;
      const again = await d.snapshot();
      const still = fit(again);
      // A list may still nudge a point or two as it comes to rest: close enough to tap.
      if (still && Math.abs(still.x - hit.x) <= 2 && Math.abs(still.y - hit.y) <= 2) return still;
      snap = await settle(d);
      continue;
    }
    if (i >= maxSwipes) throw new NotFound(`not found after ${maxSwipes} swipes: ${label}`);
    const { w } = snap.screen;
    const h = (kbTop = await band(snap));
    const x = Math.round(w / 2), a = Math.round(h * 0.75), b = Math.round(h * 0.25);
    const held = await d.swipe(x, up ? b : a, x, up ? a : b, 300, { hold: 150 });
    let next = held ? await d.snapshot() : await settle(d);
    // On a real iPhone a held swipe can still be moving when it's read: the target can be missing mid-scroll (and the
    // next swipe carries it off the top), or a bounce at the end looks like more list. A second read that differs
    // means it's moving: wait for it to stop.
    if (held && signature(await d.snapshot()) !== signature(next)) next = await settle(d);
    // An unchanged screen is the end of the list only if the app agrees: a cache can miss a scroll.
    if (signature(next) === signature(snap)) next = await d.snapshot({ fresh: true });
    if (signature(next) === signature(snap)) throw new NotFound(`reached the ${up ? 'top' : 'end'} without finding: ${label}`);
    snap = next;
  }
}
