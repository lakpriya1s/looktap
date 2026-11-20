// `looktap prefs`: an app's own key-value settings — UserDefaults on iOS, SharedPreferences on Android — read from the
// outside and printed as key = value, with coordinates redacted so a location an app saved doesn't land in an agent's
// context. The drivers fetch the raw file; this file parses and prints it.
import { parseBplist } from './bplist.js';
import { redact } from './geo.js';
import { UsageError, run } from './util.js';

const unescape = (s) =>
  s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, '&');

/** A SharedPreferences XML file → { key: value }: strings, ints, longs, floats, booleans and string sets. */
export function parseSharedPrefs(xml) {
  const out = {};
  for (const m of xml.matchAll(/<(string|set)\s+name="([^"]*)"\s*(?:\/>|>([\s\S]*?)<\/\1>)/g)) {
    const [, kind, name, body = ''] = m;
    out[unescape(name)] = kind === 'set' ? [...body.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((s) => unescape(s[1])) : unescape(body);
  }
  for (const m of xml.matchAll(/<(int|long|float|boolean)\s+name="([^"]*)"\s+value="([^"]*)"\s*\/>/g)) {
    const [, kind, name, v] = m;
    out[unescape(name)] = kind === 'boolean' ? v === 'true' : Number(v);
  }
  return out;
}

/** A property list's bytes (binary, or XML converted with plutil) → a JS value. */
export function parsePlist(buf) {
  if (buf.subarray(0, 8).toString('latin1') === 'bplist00') return parseBplist(buf);
  return parseBplist(run('plutil', ['-convert', 'binary1', '-o', '-', '-'], { input: buf, binary: true }));
}

/** One value as it prints: strings as they are, structures as compact JSON, data as its size; long ones cut short. */
export function show(v) {
  const s =
    typeof v === 'string' ? v
    : Buffer.isBuffer(v) ? `<data, ${v.length} bytes>`
    : v instanceof Date ? v.toISOString()
    : typeof v === 'bigint' ? String(v)
    : v && typeof v === 'object' ? JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? String(x) : Buffer.isBuffer(x) || x?.type === 'Buffer' ? `<data>` : x))
    : String(v);
  return s.length > 300 ? `${s.slice(0, 300)} … (${s.length} characters)` : s;
}

/** Apple's own keys every app's defaults carry (keyboard, language, web view state): left out unless asked for. */
const SYSTEM_KEY = /^(Apple|NS|AK|WebKit|WebDatabase|com\.apple\.|INNext|PKKeychain|MSVLoggingMasterSwitch|_UI|UIKeyboard|kCFPreferences|SBFolder)/;

/**
 The lines `prefs` prints: `key = value`, sorted, coordinates redacted (`entries`: the same as [key, value], for --json). `keys`: only those (missing ones are reported
 in `missing`). `extra`: more key names to redact. Returns { lines, redacted: [keys], missing: [keys], hidden }.
 */
export function formatPrefs(values, { keys = [], extra = [], all = false } = {}) {
  const redacted = [];
  const names = keys.length ? keys.filter((k) => k in values) : Object.keys(values).filter((k) => all || !SYSTEM_KEY.test(k)).sort();
  const entries = names.map((k) => [k, redact(k, values[k], { extra, hit: (r) => redacted.push(r) })]);
  const lines = entries.map(([k, v]) => `${k} = ${show(v)}`);
  return { lines, entries, redacted, missing: keys.filter((k) => !(k in values)), hidden: keys.length ? 0 : Object.keys(values).length - names.length };
}

/** `--redact lat,lon,home` → lower-cased names. */
export function redactList(text) {
  if (text == null) return [];
  const list = String(text).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!list.length) throw new UsageError('--redact takes key names, e.g. --redact lat,lon');
  return list;
}

/**
 Which SharedPreferences file to read, from the app's shared_prefs listing: `--file` (with or without .xml), else
 the app's default file (<package>_preferences.xml), else the only one. With several and no default, all of them.
 */
export function pickPrefsFiles(files, app, file = null) {
  const xml = files.filter((f) => f.endsWith('.xml'));
  if (file) {
    const want = file.endsWith('.xml') ? file : `${file}.xml`;
    if (!xml.includes(want)) throw new UsageError(`${app} has no shared_prefs/${want}${xml.length ? ` (it has: ${xml.map((f) => f.slice(0, -4)).join(', ')})` : ''}`);
    return [want];
  }
  if (!xml.length) throw new UsageError(`${app} has no SharedPreferences files (shared_prefs/ is empty). React Native's AsyncStorage keeps its data in a database instead`);
  const def = `${app}_preferences.xml`;
  return xml.includes(def) ? [def] : xml;
}
