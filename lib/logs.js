// What an agent debugging an app needs besides the screen: the app's log since it last looked, its
// crash reports, and whether it is still running. Drivers fetch; this file picks the window and prints.
//
// Driver methods: foreground() → { id, pid } | null, pidOf(app) → pid | 0,
// readLogs(app, sinceMs, { errors, all }) → [{ t, text }], readCrashes(app, sinceMs) → [{ t, text }].
import { join } from 'node:path';

import { HOME, UsageError, readJson, writeJson } from './util.js';

const markFile = (device) => join(HOME, 'marks', `${device.replace(/[^\w.-]/g, '_')}.json`);

/** `30s`, `5m`, `2h`, `1d`, or anything Date parses → epoch ms. */
export function parseSince(s, now = Date.now()) {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(s);
  if (m) return now - Number(m[1]) * { ms: 1, s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[m[2]];
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new UsageError(`--since takes 30s, 5m, 2h, 1d or a date/time, not: ${s}`);
  return t;
}

/**
 Where this read starts: --since, else where the previous read of the same kind on this device ended
 (so each `logs` shows only what is new), else `fallback` ms ago. Records now as the next start.
 */
export function startOf(device, kind, since, fallback) {
  const now = Date.now();
  const marks = readJson(markFile(device), {});
  const from = since ? parseSince(since, now) : marks[kind] && now - marks[kind] < 3600e3 ? marks[kind] : now - fallback;
  writeJson(markFile(device), { ...marks, [kind]: now });
  return from;
}

export const clock = (t) => new Date(t).toTimeString().slice(0, 8) + '.' + String(t % 1000).padStart(3, '0');

/** The app these commands are about: the argument, --app/config, else whatever is in front. */
export async function whichApp(d, arg) {
  const app = arg || d.app;
  if (app) return app;
  const front = await d.foreground();
  if (!front?.id) throw new UsageError('no app in front — name one: simwright logs <app-id> (or --app / simwright.config.json)');
  return front.id;
}

/** Keep the newest `max` lines; say how many were left out. */
export function tail(lines, max) {
  if (lines.length <= max) return { shown: lines, dropped: 0 };
  return { shown: lines.slice(-max), dropped: lines.length - max };
}

export function grepper(pattern) {
  if (!pattern) return () => true;
  let re;
  try {
    re = new RegExp(pattern, 'i');
  } catch {
    throw new UsageError(`--grep: not a valid regular expression: ${pattern}`);
  }
  return (e) => re.test(e.text);
}
