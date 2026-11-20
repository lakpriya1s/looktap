// Notifications the device holds: what the user would see in Notification Center (iOS) or the notification shade
// (Android). Each platform keeps them differently, so each has its own reader; all give the same shape:
//   { app, title, subtitle?, body, time, ... }  newest first. `time` is a Date, or the text a real iPhone shows ("2m ago").
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { unarchive } from './bplist.js';

/**
 Android: `dumpsys notification --noredact`. Each posted notification is a NotificationRecord block with its
 package, flags and extras (android.title=String (…)); a value can run over several lines.
 */
export function parseAndroidNotifications(text) {
  const start = text.indexOf('Notification List:');
  if (start < 0) return [];
  // The list ends at the next section header (two spaces in, then a name).
  const rest = text.slice(start + 'Notification List:'.length);
  const end = rest.search(/\n {2}\S/);
  const list = end < 0 ? rest : rest.slice(0, end);
  const out = [];
  for (const block of list.split(/\n\s+NotificationRecord\(/).slice(1)) {
    const head = block.slice(0, block.indexOf('\n') + 1 || undefined);
    const field = (re) => re.exec(block)?.[1];
    const extra = (name) => {
      const m = new RegExp(`\\n\\s+${name.replace(/\./g, '\\.')}=([\\s\\S]*?)(?=\\n\\s+[\\w.]+=|\\n\\s+\\}|$)`).exec(block);
      if (!m || m[1].trim() === 'null') return '';
      const typed = /^[\w.$\[\]]+ \(([\s\S]*)\)\s*$/.exec(m[1]);
      return (typed ? typed[1] : m[1]).trim();
    };
    const flags = field(/\n\s+flags=(\S+)/) || '';
    if (/GROUP_SUMMARY/.test(flags)) continue; // the group's children are listed themselves
    const title = extra('android.title');
    const body = extra('android.bigText') || extra('android.text');
    if (!title && !body) continue;
    const ms = Number(field(/mUpdateTimeMs=(\d+)/) || field(/mCreationTimeMs=(\d+)/) || field(/postTime=(\d+)/) || field(/\bwhen=(\d+)/) || 0);
    out.push({
      app: /pkg=(\S+)/.exec(head)?.[1] || '',
      title,
      ...(extra('android.subText') ? { subtitle: extra('android.subText') } : {}),
      body,
      time: ms ? new Date(ms) : null,
      ongoing: /ONGOING_EVENT|FOREGROUND_SERVICE|NO_CLEAR/.test(flags),
      channel: /channel=(\S+)/.exec(head)?.[1] || '',
      key: field(/\n\s+key=(\S+)/) || '',
    });
  }
  return newestFirst(out);
}

/**
 The iOS simulator: SpringBoard keeps what Notification Center shows in Library/UserNotifications, one
 DeliveredNotifications.plist (NSKeyedArchiver) per app, in a folder Library.plist names (iOS 18+: a UUID;
 before: the bundle id). `home` is the simulator's data folder.
 */
export function iosSimNotifications(home) {
  const dir = join(home, 'Library/UserNotifications');
  if (!existsSync(dir)) return [];
  const folders = new Map();
  try {
    for (const [app, folder] of Object.entries(unarchive(readFileSync(join(dir, 'Library.plist'))) || {}))
      if (typeof folder === 'string') folders.set(app, folder);
  } catch {}
  for (const name of readdirSync(dir)) if (name.includes('.') && !name.endsWith('.plist') && !folders.has(name)) folders.set(name, name);
  const out = [];
  for (const [app, folder] of folders) {
    const file = join(dir, folder, 'DeliveredNotifications.plist');
    let list;
    try {
      if (statSync(file).size < 150) continue; // an empty archive
      list = unarchive(readFileSync(file));
    } catch {
      continue;
    }
    for (const n of Array.isArray(list) ? list : []) out.push(fromSimRecord(app, n));
  }
  return newestFirst(out);
}

/** One record of DeliveredNotifications.plist → a notification. */
export function fromSimRecord(app, n) {
  const time = n.AppNotificationCreationDate instanceof Date ? n.AppNotificationCreationDate : null;
  return {
    app,
    title: n.AppNotificationTitle || '',
    ...(n.AppNotificationSubtitle ? { subtitle: n.AppNotificationSubtitle } : {}),
    body: n.AppNotificationMessage || '',
    time,
    id: n.AppNotificationIdentifier || '',
    ...(n.AppNotificationBadgeNumber != null ? { badge: Number(n.AppNotificationBadgeNumber) } : {}),
    ...(n.SBSPushStoreNotificationThreadKey ? { thread: n.SBSPushStoreNotificationThreadKey } : {}),
    ...(n.SBSPushStoreNotificationCategoryKey ? { category: n.SBSPushStoreNotificationCategoryKey } : {}),
    trigger: n.UNNotificationTriggerType || '',
    payload: n.UNNotificationUserInfo || {},
  };
}

/**
 A real iPhone: the runner reads SpringBoard's screen. Each platter comes with the label of the cell around it
 ("APP, time, title, body"), the label of its own button ("time, title, body"), its texts (title, subtitle)
 and its body. App names are the ones shown (HEALTH), times as shown (2m ago, Yesterday, 23:44). iOS 16 and older
 give only the label: title and body can't be told apart there, so all of it after the time is the body.
 */
export function fromPlatters(items) {
  const out = [];
  const seen = new Set();
  for (const p of [...items].sort((a, b) => (a.y ?? 0) - (b.y ?? 0))) {
    const header = p.header || '';
    const inner = p.inner || '';
    if (!p.texts?.length && !p.body && !p.inner) {
      const n = fromLabel(header);
      if (n) out.push(n);
      continue;
    }
    const [title = '', subtitle = ''] = p.texts || [];
    const body = p.body || '';
    let app = header.endsWith(`, ${inner}`) && inner ? header.slice(0, -inner.length - 2) : header.split(', ')[0];
    app = app.replace(/, Grouped$/, '');
    const first = title || body.split('\n')[0];
    const at = first ? inner.indexOf(`, ${first}`) : -1;
    const time = at > 0 ? inner.slice(0, at) : '';
    if (!title && !body) continue;
    const n = { app, title, ...(subtitle ? { subtitle } : {}), body, time };
    const key = JSON.stringify(n);
    if (seen.has(key)) continue; // a stack draws the ones behind its top one too
    seen.add(key);
    out.push(n);
  }
  return out;
}

/** "MESSAGES, Grouped, Yesterday 22:38, mRoaming, Dear customer, …" → app, time, and the rest as the body. */
function fromLabel(label) {
  const parts = label.split(', ');
  if (parts.length < 3) return null;
  const app = parts.shift();
  if (parts[0] === 'Grouped') parts.shift();
  let time = parts.shift() || '';
  // "Yesterday, 23:44" or "Tuesday, 9:41": a day, then its time
  if (/^\d{1,2}[:.]\d{2}/.test(parts[0] || '') && !/\d[:.]\d{2}/.test(time)) time += `, ${parts.shift()}`;
  const body = parts.join(', ');
  return body ? { app, title: '', body, time } : null;
}

const newestFirst = (list) => list.sort((a, b) => (b.time?.getTime?.() ?? 0) - (a.time?.getTime?.() ?? 0));

/** Does the notification's text (title, subtitle, body) contain `text`, case and spacing aside? */
export function notificationMatches(n, text) {
  const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const want = norm(text);
  return [n.title, n.subtitle, n.body, [n.title, n.subtitle, n.body].filter(Boolean).join(' ')].some((s) => norm(s).includes(want));
}

/** Is it from `app`? Part of the id or the shown name, either way round ("com.example.shop" ↔ "SHOP"). */
export function fromApp(n, app, name) {
  const q = String(app).toLowerCase();
  const a = String(n.app || '').toLowerCase();
  return a.includes(q) || Boolean(name && a === String(name).toLowerCase());
}

/** One line: when, app, title · subtitle: body. */
export function formatNotification(n, now = Date.now()) {
  const when = n.time instanceof Date ? ago(now - n.time.getTime()) : n.time || '';
  const head = [n.title, n.subtitle].filter(Boolean).join(' · ');
  const text = [head, n.body].filter(Boolean).join(': ').replace(/\s*\n\s*/g, ' ↵ ');
  return [when.padEnd(8), n.app, text, n.ongoing ? '(ongoing)' : ''].filter((s) => s !== '').join('  ').trimEnd();
}

const ago = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

/** For --json: dates as ISO strings, big numbers as numbers. */
export const notificationJson = (list) => JSON.stringify(list, (k, v) => (typeof v === 'bigint' ? Number(v) : v));
