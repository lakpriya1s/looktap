// What looktap did on each device, and when: one line per command in ~/.looktap/activity.jsonl, written by every
// looktap process (a terminal, an agent's shell, MCP, the live page). `looktap live` follows it, so whoever watches the
// devices sees what is driving them ("tap Sign in", 0.4 s, failed: not on screen).
//
// The file stays small: past MAX_BYTES it is cut to its newer half. Text that was typed is never written, only how
// long it was: it can be a password or a one-time code.
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { HOME } from './util.js';

export const ACTIVITY = join(HOME, 'activity.jsonl');
const MAX_BYTES = 512 * 1024;

/** Commands whose arguments are text typed into the device: only their length is kept. */
const SECRET = { type: 0, paste: 0, code: 0, fill: 1 };

/** A command and its arguments → a line to show, with typed text left out. */
export function summary(cmd, args = []) {
  const keep = SECRET[cmd];
  if (keep == null) {
    const text = [cmd, ...args.map((a) => (/\s/.test(a) ? `"${a}"` : a))].join(' ');
    return text.length > 120 ? `${text.slice(0, 119)}…` : text;
  }
  const typed = args.slice(keep).join(' ');
  return [cmd, ...args.slice(0, keep), typed ? `(${typed.length} character${typed.length === 1 ? '' : 's'})` : ''].filter(Boolean).join(' ');
}

/** Write one entry. Never throws: a full disk or a read-only home mustn't fail the command it describes. */
export function record({ device, cmd, args, ok, ms, error, via = 'cli', touch }, path = ACTIVITY) {
  if (!device || !cmd) return;
  const entry = { t: Date.now(), device, cmd, what: summary(cmd, args), ok: Boolean(ok), ms: Math.round(ms || 0), via };
  // Where it touched (shares of the screen): looktap live draws it over a real iPhone's picture.
  if (Array.isArray(touch) && touch.length) entry.touch = touch.slice(0, 20);
  if (!ok && error) entry.error = String(error).split('\n')[0].slice(0, 160);
  try {
    appendFileSync(path, `${JSON.stringify(entry)}\n`);
    if (statSync(path).size > MAX_BYTES) trim(path);
  } catch {}
}

/** Keep the newer half, from a line's start. Written aside and moved in, so a reader never sees half a file. */
function trim(path) {
  const text = readFileSync(path, 'utf8');
  const from = text.indexOf('\n', text.length - MAX_BYTES / 2) + 1;
  writeFileSync(`${path}.${process.pid}`, text.slice(from));
  renameSync(`${path}.${process.pid}`, path);
}

/** Lines of JSON → entries, skipping any that isn't whole. */
export function parse(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const e = JSON.parse(line);
      if (e && e.t && e.device && e.cmd) out.push(e);
    } catch {}
  }
  return out;
}

/** The last `n` entries. */
export function recent(n = 100, path = ACTIVITY) {
  try {
    return parse(readFileSync(path, 'utf8')).slice(-n);
  } catch {
    return [];
  }
}

/**
 Follow the file: `onEntry(entry)` for each one written from now on. Polls its size (twice a second), which works
 the same for every writer and costs a stat. Returns stop().
 */
export function follow(onEntry, { path = ACTIVITY, every = 500 } = {}) {
  let at = existsSync(path) ? statSync(path).size : 0, last = Date.now(), rest = '';
  const timer = setInterval(() => {
    let size;
    try {
      size = statSync(path).size;
    } catch {
      return;
    }
    if (size < at) (at = 0), (rest = ''); // cut to its newer half: read it again, skipping what was seen (by time)
    if (size === at) return;
    const buf = Buffer.alloc(size - at);
    let fd;
    try {
      fd = openSync(path, 'r');
      readSync(fd, buf, 0, buf.length, at);
    } catch {
      return;
    } finally {
      if (fd != null) closeSync(fd);
    }
    at = size;
    const text = rest + buf.toString('utf8');
    const cut = text.lastIndexOf('\n') + 1;
    rest = text.slice(cut);
    for (const e of parse(text.slice(0, cut))) if (e.t >= last) (last = e.t), onEntry(e);
  }, every);
  timer.unref();
  return () => clearInterval(timer);
}
