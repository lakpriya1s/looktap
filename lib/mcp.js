// `looktap mcp`: the same commands as an MCP server over stdio, for AI clients without a shell (Claude
// Desktop, Cursor, …). JSON-RPC 2.0, one message per line. Tool calls run the CLI's own code in-process,
// one at a time, and keep each device's helper connection open between calls. Zero dependencies.
import { createInterface } from 'node:readline';

const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const INSTRUCTIONS = `looktap drives iPhone and Android devices, real or simulated.
Loop: ls (what's on screen, one row per element with an @ref) → act (tap / fill / type / swipe …) → read the
screen the action returns. Actions return the settled screen unless ls: false.
Targets: a label (exact, else a unique prefix/substring) or an @ref from the last listing.
Use wait instead of guessing delays. Use screenshot only to see layout or colours; ls is usually enough.
After something misbehaves: logs (only what's new since the last call), crashes.
For speed or memory, measure with perf instead of guessing: frames before and after the action, or for: seconds while it runs.
First, "devices" (through the looktap tool): which are real phones, simulators or emulators, and what the user must do
for a phone that isn't ready. Not every command works on every device: "capabilities" says what this one can't do.
If a command says the device is locked, ask a person to unlock it; don't retry.
Never type real credentials, OTPs or card numbers: a person signs in, then you continue.
Against a live backend every tap is real.`;

const device = {
  platform: { type: 'string', enum: ['ios', 'android'], description: 'When both an iOS and an Android device are booted. Remembered for later calls' },
  device: { type: 'string', description: 'Simulator UDID or adb serial, when several are booted. Remembered for later calls' },
};
const look = { ls: { type: 'boolean', description: 'Return the settled screen afterwards (default true)' } };
const target = { type: 'string', description: 'A label (exact, else unique prefix/substring) or an @ref from the last listing' };

const tool = (name, description, properties = {}, required = [], extra = {}) => ({
  name,
  description,
  inputSchema: { type: 'object', properties: { ...properties, ...device }, required, additionalProperties: false },
  ...extra,
});
const readOnly = { annotations: { readOnlyHint: true } };

export const TOOLS = [
  tool('ls', 'List what is on screen: @ref, type, x,y, width×height, label, = value.', { all: { type: 'boolean', description: 'Include unlabelled elements' } }, [], readOnly),
  tool('tap', 'Tap an element by label or @ref. Returns the settled screen.', { target, exact: { type: 'boolean' }, ...look }, ['target']),
  tool('tap_xy', 'Tap a point (iOS points / Android dp, the units ls prints).', { x: { type: 'number' }, y: { type: 'number' }, ...look }, ['x', 'y']),
  tool('long_press', 'Hold a touch on an element (or a point) for ms (default 800).', { target, x: { type: 'number' }, y: { type: 'number' }, ms: { type: 'number' }, ...look }),
  tool('fill', 'Focus a text field (by label or @ref), clear it, type text, and check the field holds it (a password field: its length). Retypes slowly if not, and fails if it still does not.', { target, text: { type: 'string' }, ...look }, ['target', 'text']),
  tool('paste', "Put text on the device's clipboard, check it is there, and paste it into the focused field.", { text: { type: 'string' }, ...look }, ['text']),
  tool('code', 'Enter a one-time code into its row of digit boxes: tap the first, type each digit, check every box (pastes the code if typing did not fill them).', { code: { type: 'string' }, ...look }, ['code']),
  tool('type', 'Type into the focused field.', { text: { type: 'string' }, ...look }, ['text']),
  tool('key', 'Press keys: return, escape, delete, tab, space, selectall, paste, home (Android also back).', { keys: { type: 'array', items: { type: 'string' } }, ...look }, ['keys']),
  tool('hide_keyboard', 'Dismiss the on-screen keyboard and take focus from the field (blur validation runs). Fails if it is still up.', { ...look }),
  tool('swipe', 'Drag from one point to another (scroll: finger moves up to go down).', {
    x1: { type: 'number' }, y1: { type: 'number' }, x2: { type: 'number' }, y2: { type: 'number' }, ms: { type: 'number' }, ...look,
  }, ['x1', 'y1', 'x2', 'y2']),
  tool('scroll_to', 'Swipe until the element is fully on screen (swipes above the keyboard when it is up).', { target: { type: 'string' }, up: { type: 'boolean', description: 'Scroll back up' } }, ['target']),
  tool('back', 'Android system Back; iOS navigation-bar back button.', { ...look }),
  tool('home', 'The Home button: go to the home screen, leaving the app running.', { ...look }),
  tool('wait', 'Wait until a label (or @ref) is on screen — or, with gone, until it is not. With settle and no target: until the '
    + 'screen, its picture included, holds still for a second, for web pages with no labels to wait for (a sign-in page loading).', {
    target: { type: 'string' }, gone: { type: 'boolean' }, settle: { type: 'boolean' }, seconds: { type: 'number', description: 'Timeout (default 10)' },
  }, [], readOnly),
  tool('screenshot', 'A PNG of the screen, returned as an image (scale 0.5 by default: fewer tokens).', { scale: { type: 'number', description: '0–1' } }, [], readOnly),
  tool('logs', "The app's log since the last logs call (first call: the last minute).", {
    app: { type: 'string' }, errors: { type: 'boolean' }, grep: { type: 'string' }, since: { type: 'string', description: 'e.g. 5m' },
  }, [], readOnly),
  tool('crashes', 'Crash reports, ANRs and low-memory kills since the last crashes call.', { app: { type: 'string' }, since: { type: 'string' } }, [], readOnly),
  tool('perf', "The app's CPU (100% = one core), memory and threads; or, with frames, frames drawn since the last frames call: "
    + 'janky share, p50–p99 frame time, fps (iOS counts what the screen shows; its first frames call only starts counting, so call '
    + 'it before the action too). Simulator numbers are the Mac\'s: compare runs, not phones. A real iPhone reads through Instruments, 10–25 s a reading.', {
    app: { type: 'string', description: 'App id (default: the configured app, else the app in front)' },
    frames: { type: 'boolean', description: 'Frame and jank stats instead of CPU and memory' },
    for: { type: 'number', description: 'Seconds to sample, a reading each second, then avg/max' },
    json: { type: 'boolean', description: 'Structured output' },
  }, [], readOnly),
  tool('looktap', 'Any other looktap command line, or several separated by ";" — e.g. "launch com.example.app --ls", "stop com.example.app", '
    + '"open myapp://home", "expect Welcome", "zoom in", "appearance dark", "rotate landscape", "fold open", "record start demo" … "record stop", '
    + '"permission grant location com.example.app", "perf com.example.app --for 10s", "launch com.example.app --time", "apps com.example" (is it installed?), "app com.example.app --paths" (its data folder), '
    + '"devices --all", "boot Pixel_9a" (also waits for one still starting), "shutdown Pixel_9a", "dismiss logbox" (React Native\'s toast), '
    + '"shot sign-in --points" (pixels = tapxy units), "doctor -d <device>", "--wait-unlock 60 launch com.example.app", '
    + '"handoff \\"Approve the sign-in on the phone\\" --until Home" (the user\'s turn: waits for that label). See: help.', {
    command: { type: 'string' },
  }, ['command']),
];

const flag = (on, name) => (on ? [name] : []);
const lsFlag = (a) => flag(a.ls !== false, '--ls');
// A label or text that starts with "-" goes after --, flags first, so it isn't read as an option.
const free = (cmd, words, flags) => (words.some((w) => String(w).startsWith('-')) ? [cmd, ...flags, '--', ...words] : [cmd, ...words, ...flags]);

/** A tool call → looktap words (as typed on the command line). */
export function toWords(name, a) {
  switch (name) {
    case 'ls': return ['ls', ...flag(a.all, '--all')];
    case 'tap': return free('tap', [a.target], [...flag(a.exact, '--exact'), ...lsFlag(a)]);
    case 'tap_xy': return ['tapxy', String(a.x), String(a.y), ...lsFlag(a)];
    case 'long_press': {
      const where = a.target != null ? [a.target] : a.x != null && a.y != null ? [String(a.x), String(a.y)] : null;
      if (!where) throw new Error('long_press needs a target, or x and y');
      return free('longpress', [...where, ...(a.ms ? [String(a.ms)] : [])], lsFlag(a));
    }
    case 'fill': return free('fill', [a.target, a.text], lsFlag(a));
    case 'paste': return free('paste', [a.text], lsFlag(a));
    case 'code': return free('code', [a.code], lsFlag(a));
    case 'type': return free('type', [a.text], lsFlag(a));
    case 'key': return ['key', ...a.keys, ...lsFlag(a)];
    case 'hide_keyboard': return ['hidekb', ...lsFlag(a)];
    case 'swipe': return ['swipe', ...[a.x1, a.y1, a.x2, a.y2].map(String), ...(a.ms ? [String(a.ms)] : []), ...lsFlag(a)];
    case 'scroll_to': return free('scrollto', [a.target], flag(a.up, '--up'));
    case 'back': return ['back', ...lsFlag(a)];
    case 'home': return ['home', ...lsFlag(a)];
    case 'wait': {
      const until = a.seconds ? ['--wait', String(a.seconds)] : [];
      if (a.settle) return ['wait', '--settle', ...until];
      if (a.target == null) throw new Error('wait needs a target, or settle: true');
      return free('wait', [a.target], [...flag(a.gone, '--gone'), ...until]);
    }
    case 'logs': return ['logs', ...(a.app ? [a.app] : []), ...flag(a.errors, '--errors'), ...(a.grep ? ['--grep', a.grep] : []), ...(a.since ? ['--since', a.since] : [])];
    case 'crashes': return ['crashes', ...(a.app ? [a.app] : []), ...(a.since ? ['--since', a.since] : [])];
    case 'perf':
      if (a.frames && a.for != null) throw new Error('perf takes frames or for, not both');
      return ['perf', ...(a.app ? [a.app] : []), ...flag(a.frames, '--frames'), ...(a.for != null ? ['--for', `${a.for}s`] : []), ...flag(a.json, '--json')];
    default: throw new Error(`unknown tool: ${name}`);
  }
}

/**
 Serve MCP on stdin/stdout. `exec(words, { platform, device })` runs one looktap command and resolves
 to { text, error }; `script(text, …)` runs a ";"-separated command line; `shot(scale, …)` resolves to
 { path, png }.
 */
export function serveMcp({ version, exec, script, shot }) {
  const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  let queue = Promise.resolve();

  async function call(name, a = {}) {
    const where = { platform: a.platform, device: a.device };
    if (name === 'screenshot') {
      const { path, png, error } = await shot(a.scale ?? 0.5, where);
      if (error) return { content: [{ type: 'text', text: error }], isError: true };
      return { content: [{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }, { type: 'text', text: path }] };
    }
    const r = name === 'looktap' ? await script(a.command, where) : await exec(toWords(name, a), where);
    return { content: [{ type: 'text', text: r.text || (r.error ? '' : 'ok') }], ...(r.error ? { isError: true } : {}) };
  }

  async function handle(msg) {
    const { id, method, params = {} } = msg;
    if (id === undefined) return; // a notification (initialized, cancelled): nothing to answer
    try {
      if (method === 'initialize') {
        const protocolVersion = PROTOCOLS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOLS[0];
        return send({ id, result: { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'looktap', version }, instructions: INSTRUCTIONS } });
      }
      if (method === 'ping') return send({ id, result: {} });
      if (method === 'tools/list') return send({ id, result: { tools: TOOLS } });
      if (method === 'tools/call') {
        if (!TOOLS.some((t) => t.name === params.name)) return send({ id, error: { code: -32602, message: `unknown tool: ${params.name}` } });
        // One device, one finger: calls run one after another, in the order they arrived.
        const result = await (queue = queue.then(() => call(params.name, params.arguments).catch((e) => ({ content: [{ type: 'text', text: e.message }], isError: true }))));
        return send({ id, result });
      }
      send({ id, error: { code: -32601, message: `method not found: ${method}` } });
    } catch (e) {
      send({ id, error: { code: -32603, message: e.message } });
    }
  }

  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return send({ id: null, error: { code: -32700, message: 'parse error' } });
    }
    for (const m of Array.isArray(msg) ? msg : [msg]) handle(m);
  });
  return new Promise((resolve) => rl.on('close', resolve));
}
