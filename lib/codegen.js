// `looktap codegen`: a person uses the phone, and each touch becomes the looktap step that replays it — a tap by
// label, a fill with the field's final text, a scrollto — kept as a flow file for `looktap test`.
// Android only: touches come from the touchscreen's kernel events (getevent), the screen from the helper, read
// when the finger goes down (before the touch has any effect). Nodes are the driver's: { label, x1, y1, x2, y2,
// cls, focused, value?, clickable?, editable?, password? } in dp.
import { pickMatch } from './util.js';

/** A word as `run` and `test` read it back: bare when it can be, else double-quoted. */
export function quote(s) {
  if (/^[\w@.:/+,=%-]+$/.test(s) && !s.startsWith('#') && !s.startsWith('-')) return s;
  return `"${s.replace(/[\\"$]/g, (c) => `\\${c}`)}"`;
}

/**
 Raw touchscreen coordinates → dp on the screen as the user sees it. `ts`: parseTouchscreen()'s ranges;
 `display`: { w, h } px turned with the screen and its rotation (quarter turns counter-clockwise).
 */
export function mapper(ts, { w, h, rotation = 0 }, scale) {
  const [nw, nh] = rotation % 2 ? [h, w] : [w, h];
  return (rx, ry) => {
    const nx = ((rx - ts.x.min) / (ts.x.max - ts.x.min + 1)) * nw;
    const ny = ((ry - ts.y.min) / (ts.y.max - ts.y.min + 1)) * nh;
    const [px, py] = [[nx, ny], [ny, nw - nx], [nw - nx, nh - ny], [nh - ny, nx]][rotation & 3];
    return [Math.round(px / scale), Math.round(py / scale)];
  };
}

const EVENT = /^\[\s*([\d.]+)\]\s+(?:\S+:\s+)?(EV_\w+)\s+(\w+)\s+(\S+)/;

/**
 Multi-touch (protocol B) events → gestures. `onDown(t, x, y)` fires when the first finger lands, `onGesture(g)` when
 the last one lifts: { t0, t1, pointers: [{ path: [[t, x, y], …] }] } in raw units, seconds.
 */
export class TouchReader {
  constructor({ onDown = () => {}, onGesture }) {
    Object.assign(this, { onDown, onGesture, slot: 0, slots: new Map(), gesture: null });
  }

  line(text) {
    const m = EVENT.exec(text);
    if (!m) return;
    const [, ts, type, code, raw] = m;
    const t = Number(ts);
    const value = parseInt(raw, 16);
    if (code === 'ABS_MT_SLOT') this.slot = value;
    else if (code === 'ABS_MT_TRACKING_ID') {
      if (raw === 'ffffffff') {
        const p = this.slots.get(this.slot);
        if (p) p.up = true;
      } else this.slots.set(this.slot, { path: [], x: null, y: null, fresh: true });
    } else if (code === 'ABS_MT_POSITION_X' || code === 'ABS_MT_POSITION_Y') {
      const p = this.slots.get(this.slot) || this.slots.set(this.slot, { path: [], x: null, y: null, fresh: true }).get(this.slot);
      p[code.endsWith('X') ? 'x' : 'y'] = value;
    } else if (type === 'EV_SYN' && code === 'SYN_REPORT') this.sync(t);
  }

  sync(t) {
    for (const [slot, p] of this.slots) {
      if (p.x != null && p.y != null) {
        if (p.fresh) {
          p.fresh = false;
          if (!this.gesture) {
            this.gesture = { t0: t, pointers: [] };
            this.onDown(t, p.x, p.y);
          }
          this.gesture.pointers.push(p);
        }
        const last = p.path.at(-1);
        if (!last || last[1] !== p.x || last[2] !== p.y) p.path.push([t, p.x, p.y]);
      }
      if (p.up) this.slots.delete(slot);
    }
    if (this.gesture && !this.slots.size) {
      const g = { t0: this.gesture.t0, t1: t, pointers: this.gesture.pointers.map((p) => ({ path: p.path })) };
      this.gesture = null;
      this.onGesture(g);
    }
  }
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/**
 What a gesture (already in dp) was: tap, longpress, swipe, zoom, or with gesture navigation a Back (a swipe in from
 a side edge) or Home (up from the bottom edge). { kind, x, y, … }.
 */
export function classify(g, { w, h, gestureNav = false }) {
  const ms = Math.round((g.t1 - g.t0) * 1000);
  const path = g.pointers[0].path.map(([, x, y]) => [x, y]);
  const [start, end] = [path[0], path.at(-1)];
  if (g.pointers.length >= 2 && g.pointers[1].path.length) {
    const other = g.pointers[1].path.map(([, x, y]) => [x, y]);
    const [d0, d1] = [dist(start, other[0]), dist(end, other.at(-1))];
    const mid = [Math.round((start[0] + other[0][0]) / 2), Math.round((start[1] + other[0][1]) / 2)];
    return { kind: 'zoom', dir: d1 > d0 ? 'in' : 'out', x: mid[0], y: mid[1] };
  }
  const moved = Math.max(...path.map((p) => dist(p, start)));
  if (moved < 10) return ms >= 500 ? { kind: 'longpress', x: start[0], y: start[1], ms } : { kind: 'tap', x: start[0], y: start[1] };
  const [dx, dy] = [end[0] - start[0], end[1] - start[1]];
  if (gestureNav) {
    const fromSide = (start[0] < 16 && dx > 40) || (start[0] > w - 16 && dx < -40);
    if (fromSide && Math.abs(dx) > Math.abs(dy)) return { kind: 'back' };
    if (start[1] > h - 24 && dy < -60) return { kind: 'home' };
  }
  return { kind: 'swipe', x: start[0], y: start[1], x2: end[0], y2: end[1], ms };
}

const inside = (n, x, y) => x >= n.x1 && x <= n.x2 && y >= n.y1 && y <= n.y2;
const within = (outer, n) => n.x1 >= outer.x1 && n.y1 >= outer.y1 && n.x2 <= outer.x2 && n.y2 <= outer.y2;
const area = (n) => (n.x2 - n.x1) * (n.y2 - n.y1);
const middle = (n) => [Math.trunc((n.x1 + n.x2) / 2), Math.trunc((n.y1 + n.y2) / 2)];
const live = (nodes) => nodes.filter((n) => n.x2 > n.x1 && n.y2 > n.y1);
const editable = (n) => n.editable || n.cls?.includes('EditText');
const hasText = (f) => f.label && f.label !== f.hint;
const sameField = (n, f) => Math.abs(n.x1 - f.x1) <= 1 && Math.abs(n.y1 - f.y1) <= 1 && editable(n);

/** The control a finger at (x, y) pressed: the smallest clickable node under it, else the smallest node. */
export function controlAt(nodes, x, y) {
  const under = live(nodes).filter((n) => inside(n, x, y)).sort((a, b) => area(a) - area(b));
  return under.find((n) => n.clickable) || under[0] || null;
}

/**
 A label that `tap` resolves (exact, else a unique prefix/substring) to a node whose centre is inside the control
 the finger pressed: its own label first, then the labels inside it in reading order. Null if none does.
 */
export function labelFor(nodes, control) {
  const all = live(nodes);
  const labels = [control, ...all.filter((n) => n !== control && within(control, n))].map((n) => n.label).filter(Boolean);
  for (const label of new Set(labels)) {
    let hit;
    try {
      hit = pickMatch(all, label);
    } catch {
      continue;
    }
    if (inside(control, ...middle(hit))) return label;
  }
  return null;
}

/**
 The label `fill` finds `field` by on `nodes` (the screen before typing): the field's own label (its hint while
 empty), else the nearest label above it. As fill does: an editable node with exactly that label, else the first
 editable node at or below the label. Null if no label gets back to this field.
 */
export function fillLabel(nodes, field) {
  // On replay the field is empty, so it reads as its hint: look at the screen that way.
  const all = live(nodes).map((n) => (editable(n) && n.hint ? { ...n, label: n.hint } : n));
  const edits = all.filter(editable);
  const same = (n) => n && Math.abs(n.x1 - field.x1) <= 1 && Math.abs(n.y1 - field.y1) <= 1;
  const replay = (label) => {
    const own = edits.find((n) => n.label === label);
    if (own) return own;
    let lab;
    try {
      lab = pickMatch(all, label);
    } catch {
      return null;
    }
    return edits.filter((n) => n.y1 >= lab.y1 - 5).sort((a, b) => a.y1 - b.y1)[0] || lab;
  };
  const above = all.filter((n) => n.label && !edits.includes(n) && n.y1 <= field.y1 && n.y1 >= field.y1 - 120).sort((a, b) => b.y1 - a.y1);
  // Empty, a field reads as its hint: that's the name fill finds it by on replay. Typed-in text is no name at all.
  const own = field.hint || (hasText(field) ? null : field.label);
  for (const label of [own, ...above.map((n) => n.label)].filter(Boolean)) if (same(replay(label))) return label;
  return null;
}

/** An environment variable name for a secret typed into a field labelled `label`: PASSWORD, PIN, … */
export const secretName = (label) => (label || 'secret').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30) || 'SECRET';

/**
 Turns gestures into flow steps. `d` is the Android driver (nodes, windows, allNodes); `screen` the display in dp
 ({ w, h, gestureNav }). `emit(step)` gets each step as it's decided (`dropLast()` takes back the last one).
 Call down() when a finger lands, gesture() when it lifts, and finish() at the end.
 */
export class Recorder {
  constructor(d, screen, { emit, dropLast, note = () => {} }) {
    Object.assign(this, { d, screen, emit, dropLast, note });
    this.typing = null; // { field, before, beforeTap } while keys go to a field
    this.trace = process.env.LOOKTAP_DEBUG ? (m) => this.note(`debug: ${m}`) : () => {};
    this.swipes = []; // swipes not written yet: a following tap may show they were a scrollto
    this.lastTap = null; // { x, y } of the last step, if it was a tap
    this.queue = Promise.resolve();
    this.calls = Promise.resolve();
  }

  /** Run `fn` once the driver's previous call is done: the helper answers one call at a time. */
  ask(fn) {
    const r = this.calls.then(fn);
    this.calls = r.catch(() => {});
    return r;
  }

  /** Read the screen now, and keep reading it until finish(): a touch uses the last read from before it landed. */
  async start({ every = 100 } = {}) {
    await this.look();
    this.running = true;
    this.polling = (async () => {
      while (this.running) {
        const t = Date.now();
        await this.look().catch(() => {});
        await new Promise((r) => setTimeout(r, Math.max(0, every - (Date.now() - t))));
      }
    })();
  }

  /**
   The windows (the keyboard comes and goes), how the display is turned, the active window's nodes, and the system
   bars' buttons. Those are read again only when the windows change or every 2 s: a press re-lays them out (Back
   turns into hide-keyboard), so they're read before it, like the screen.
   */
  async look() {
    const at = Date.now();
    const { windows, display } = await this.ask(() => this.d.windows());
    const nodes = await this.ask(() => this.d.nodes());
    const shape = JSON.stringify(windows);
    let bars = this.latest?.bars;
    if (!bars || shape !== this.latest.shape || at - this.latest.barsAt > 2000) {
      const systems = windows.filter((w) => w.type === 'system');
      const all = await this.ask(() => this.d.allNodes());
      bars = all.filter((n) => n.label && systems.some((w) => within(w, n)));
      this.barsAt = at;
    }
    this.latest = { at, windows, display, nodes, bars, shape, barsAt: this.barsAt ?? at };
    this.display = display;
  }

  /**
   A finger landed: the screen as the last read before it saw it, since a read now would race the touch's effect.
   Only if reads have stalled (over half a second old) is the screen read now.
   */
  down() {
    const last = this.latest;
    if (last && Date.now() - last.at < 500) return Promise.resolve(last);
    return this.look().then(() => this.latest, () => null);
  }

  /** A gesture ended (`at`: what down() returned). Steps are worked out one after another, in order. */
  gesture(g, at) {
    this.queue = this.queue.then(() => this.handle(g, at)).catch((e) => this.note(`couldn't record that touch: ${e.message}`));
    return this.queue;
  }

  async handle(g, seen) {
    const { windows = [], nodes = null, bars = [] } = (await seen) || {};
    const window = windows.find((w) => inside(w, g.x, g.y)) || null;
    this.trace(`${g.kind} at ${g.x},${g.y}${g.x2 != null ? ` → ${g.x2},${g.y2}` : ''} on ${window?.type || 'no window'} · under it: ${nodes ? JSON.stringify(controlAt(nodes, g.x, g.y)?.label ?? null) : 'no screen'}`);
    if (window?.type === 'keyboard') return this.key(nodes);
    await this.endTyping(nodes);
    if (window?.type === 'system') this.system(g, bars);
    else if (g.kind === 'back' || g.kind === 'home') this.step(g.kind);
    else if (g.kind === 'swipe') this.swipes.push({ g, nodes });
    else await this.touch(g, nodes);
  }

  step(s, tap = null) {
    this.flushSwipes();
    this.emit(s);
    this.lastTap = tap;
  }

  /** A touch on the navigation or status bar: Back and Home are steps; anything else isn't recorded. */
  system(g, bars) {
    // A press on a bar button often slides a little: anything that isn't a long swipe is a press where it began.
    const press = g.kind !== 'swipe' || Math.hypot(g.x2 - g.x, g.y2 - g.y) < 40;
    const hit = press ? controlAt(bars, g.x, g.y) : null;
    const label = hit?.label || '';
    if (/^back$/i.test(label)) return this.step('back');
    if (/^home$/i.test(label)) return this.step('home');
    this.note(`not recorded: ${label ? `"${label}"` : 'a touch'} on the system bar`);
  }

  async touch(g, nodes) {
    if (!nodes) return this.note(`not recorded: couldn't read the screen for the ${g.kind} at ${g.x},${g.y}`);
    if (g.kind === 'zoom') return this.step(`zoom ${g.dir} ${g.x} ${g.y}`);
    const control = controlAt(nodes, g.x, g.y);
    const label = control && labelFor(nodes, control);
    if (g.kind === 'longpress') {
      const ms = Math.max(500, Math.round(g.ms / 100) * 100);
      return this.step(label ? `longpress ${quote(label)} ${ms}` : `longpress ${g.x} ${g.y} ${ms}`);
    }
    if (label) this.scrolledTo(label);
    this.step(label ? `tap ${quote(label)}` : `tapxy ${g.x} ${g.y}`, { x: g.x, y: g.y });
    if (!label) this.note(`no label leads back to what was tapped at ${g.x},${g.y}: saved as tapxy, which breaks if the layout moves`);
  }

  /**
   Swipes that only brought `label` into view become `scrollto label`, which replays on any screen size; other
   swipes (a carousel, a map) stay swipes.
   */
  scrolledTo(label) {
    if (!this.swipes.length) return;
    const first = this.swipes[0];
    const vertical = this.swipes.every(({ g }) => Math.abs(g.y2 - g.y) > Math.abs(g.x2 - g.x));
    const shown = (first.nodes || []).some((n) => n.label === label && n.y1 >= 0 && n.y2 <= this.screen.h);
    if (!vertical || shown || !first.nodes) return;
    this.swipes = [];
    this.emit(`scrollto ${quote(label)}${first.g.y2 > first.g.y ? ' --up' : ''}`);
  }

  flushSwipes() {
    for (const { g } of this.swipes.splice(0)) this.emit(`swipe ${g.x} ${g.y} ${g.x2} ${g.y2} ${Math.min(Math.max(g.ms, 100), 2000)}`);
  }

  /** A key on the on-screen keyboard: note which field takes the text; the text itself is read when typing ends. */
  async key(nodes) {
    const t = this.typing;
    if (t) {
      // The text so far (before this key), in case the field is gone when typing ends (Enter submitted the form).
      const now = nodes?.find((n) => sameField(n, t.field));
      if (now) t.text = now.label;
      return;
    }
    if (!nodes) return;
    const field = nodes.find((n) => n.focused && editable(n));
    if (!field) return this.note('not recorded: typing with no text field focused');
    this.typing = { field, before: nodes, beforeTap: this.lastTap, text: null };
  }

  /**
   Typing ended (another touch, or the end): one `fill` with the field's text as it is now, replacing the tap that
   focused it. A password field's text isn't saved: the step reads it from an environment variable.
   */
  async endTyping(nodes) {
    const t = this.typing;
    if (!t) return;
    this.typing = null;
    nodes ||= await this.ask(() => this.d.nodes()).catch(() => null);
    const now = nodes?.find((n) => sameField(n, t.field));
    // Gone already (Enter submitted the form): the last text seen while typing.
    const typed = now ? now.label : t.text ?? '';
    const label = fillLabel(t.before, t.field);
    const secret = now?.password || t.field.password;
    const text = secret ? `\${${secretName(label)}}` : typed;
    const focusedBy = t.beforeTap && inside(t.field, t.beforeTap.x, t.beforeTap.y);
    if (!label) {
      this.note('no label leads back to that text field: saved as tapxy and type');
      if (!focusedBy) this.emit(`tapxy ${middle(t.field).join(' ')}`);
      return this.step(`type ${secret ? `"${text}"` : quote(text)}`);
    }
    if (focusedBy) this.dropLast();
    this.step(`fill ${quote(label)} ${secret ? `"${text}"` : quote(text)}`);
    if (secret) this.note(`a password isn't saved: the step reads it from \${${secretName(label)}} — set it when you run the flow`);
  }

  async finish() {
    this.running = false;
    await this.polling;
    await this.queue;
    await this.endTyping(null);
    this.flushSwipes();
  }
}
