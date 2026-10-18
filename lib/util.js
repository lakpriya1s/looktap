import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export class UsageError extends Error {}

/** What every command that needs the screen says while the lock screen is up. */
export const LOCKED = 'the device is locked: unlock it, then run the command again';
/** The thing asked for isn't on screen (yet) — the only error `waitFor` retries. */
export class NotFound extends UsageError {}

/** Retry `fn` while it throws NotFound, for up to `ms`. Ambiguity and real errors fail at once. */
export async function waitFor(fn, ms = 0) {
  const until = Date.now() + ms;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof NotFound) || Date.now() >= until) throw e;
      await new Promise((r) => setTimeout(r, 150));
    }
  }
}

export const HOME = process.env.LOOKTAP_HOME || join(homedir(), '.looktap');

/** Run a command, return stdout as text. Throws with stderr on failure unless `allowFail`. */
export function run(cmd, args, { allowFail = false, timeout = 30000, env, input, binary = false } = {}) {
  const r = spawnSync(cmd, args, {
    encoding: binary ? 'buffer' : 'utf8',
    timeout,
    env: env ? { ...process.env, ...env } : process.env,
    input,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) {
    if (allowFail) return binary ? Buffer.alloc(0) : '';
    if (r.error.code === 'ENOENT') throw new UsageError(`'${cmd}' not found on PATH`);
    throw r.error;
  }
  if (r.status !== 0 && !allowFail) {
    const err = (binary ? r.stderr.toString() : r.stderr) || '';
    throw new Error(`${cmd} ${args.join(' ')} failed (${r.status}): ${err.trim()}`);
  }
  return r.stdout;
}

export function has(cmd) {
  try {
    execFileSync('which', [cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 adb: on PATH, else in the Android SDK (ANDROID_HOME, ANDROID_SDK_ROOT, or the default SDK folder) —
 apps that start looktap (an MCP client) often run with a minimal PATH.
 */
export const ADB = (() => {
  if (has('adb')) return run('which', ['adb'], { allowFail: true }).trim() || 'adb';
  const sdks = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT, join(homedir(), 'Library', 'Android', 'sdk'), join(homedir(), 'Android', 'Sdk')];
  for (const sdk of sdks.filter(Boolean)) {
    const p = join(sdk, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
    if (existsSync(p)) return p;
  }
  return 'adb';
})();

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

/** Nearest looktap.config.json from cwd upwards — per-project defaults (app ids, out dir). */
export function loadConfig(start = process.cwd()) {
  let dir = resolve(start);
  for (;;) {
    const p = join(dir, 'looktap.config.json');
    if (existsSync(p)) return { ...readJson(p, {}), _path: p };
    const up = dirname(dir);
    if (up === dir) return {};
    dir = up;
  }
}

export function portFree(port) {
  return new Promise((res) => {
    const s = createServer();
    s.once('error', () => res(false));
    s.once('listening', () => s.close(() => res(true)));
    s.listen(port, '127.0.0.1');
  });
}

export async function freePort(from = 8100) {
  for (let p = from; p < from + 200; p++) if (await portFree(p)) return p;
  throw new Error('no free port found');
}

/**
 * Choose the element a label refers to. Exact match wins. Otherwise a prefix match, then a
 * contains match, is used only when it names a single distinct label — a fuzzy match that could
 * mean two different things is an error, never a guess. `exact` disables the fuzzy tiers.
 * Nodes are { label, ... }; returns the chosen node.
 */
export function pickMatch(nodes, label, { exact = false } = {}) {
  const labelled = nodes.filter((n) => n.label);
  const hit = labelled.find((n) => n.label === label);
  if (hit) return hit;
  if (!exact) {
    for (const pred of [(l) => l.startsWith(label), (l) => l.includes(label)]) {
      const hits = labelled.filter((n) => pred(n.label));
      const distinct = [...new Set(hits.map((n) => n.label))];
      if (distinct.length === 1) return hits[0];
      if (distinct.length > 1)
        throw new UsageError(
          `"${label}" is ambiguous — matches ${distinct.length} labels: ${distinct.slice(0, 5).map((l) => JSON.stringify(l.slice(0, 50))).join(', ')}${distinct.length > 5 ? ', …' : ''}`,
        );
    }
  }
  throw new NotFound(`not found: ${label}${exact ? ' (exact match)' : ''}`);
}

export function shotPath(outDir, name) {
  mkdirSync(outDir, { recursive: true });
  return join(outDir, name.endsWith('.png') ? name : `${name}.png`);
}

/**
 Split a script into steps (`;` or newline) of shell-like words; quotes and backslashes work as in sh. With `env`,
 `${NAME}` outside single quotes is replaced by that variable (unset is an error), as in a flow file's secrets.
 */
export function splitScript(text, { env = null } = {}) {
  const steps = [];
  let words = [], word = null, quote = null;
  const endWord = () => {
    if (word !== null) words.push(word);
    word = null;
  };
  const endStep = () => {
    endWord();
    if (words.length && !words[0].startsWith('#')) steps.push(words);
    words = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const name = env && quote !== "'" && c === '$' ? /^\$\{([A-Za-z_]\w*)\}/.exec(text.slice(i))?.[1] : null;
    if (name) {
      if (env[name] == null) throw new UsageError(`\${${name}} is not set: export ${name}=… before running the flow`);
      word = (word ?? '') + env[name];
      i += name.length + 2;
    } else if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < text.length) word += text[++i];
      else word += c;
    } else if (c === '"' || c === "'") (quote = c), (word ??= '');
    else if (c === '\\' && i + 1 < text.length) word = (word ?? '') + text[++i];
    else if (c === ';' || c === '\n') endStep();
    else if (/\s/.test(c)) endWord();
    else word = (word ?? '') + c;
  }
  if (quote) throw new UsageError('run: unterminated quote');
  endStep();
  return steps;
}
