// `looktap live`: every running device's screen in one web page, as it happens, and (when allowed) driven from it.
//
// A small web server on this computer, Node built-ins only. The page (lib/live.html) lays the devices out on a
// canvas, each in a phone's frame, and plays one stream per device:
//  - Android (emulators and phones): the device's own H.264 encoder (`screenrecord`), cut into frames here and
//    decoded by the browser (WebCodecs). Nothing is re-encoded on the way, so it costs the phone what a recording
//    does and the Mac next to nothing.
//  - iOS simulator: JPEG frames from looktap's helper, one each time the screen changes (its `stream` op).
//  - A real iPhone or iPad: screenshots through its XCUITest runner, a few a second (lib/live-iphone.js). iOS gives
//    the Mac no video of a phone's screen except over a cable to QuickTime's capture device.
//
// Control goes the other way over one WebSocket: a click is a touch going down and up, a drag moves the finger as
// the mouse moves (the helpers' `touch` op), the wheel is a drag, typing is text and keys. While the page drives a
// device it holds that device's exclusive lease, as a looktap command would, so it and an agent don't both act on
// it: whoever came second is told who has it.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { Worker } from 'node:worker_threads';

import { follow, recent, record } from './activity.js';
import { Android } from './android.js';
import { actionValue, actionsFor, runAction } from './live-actions.js';
import { touchesOn } from './touches.js';
import { Helper } from './helper.js';
import { Ios, SIM_BIN } from './ios.js';
import { fileURLToPath } from 'node:url';
import { BusyError, acquire } from './lease.js';
import { ADB, UsageError, portFree, sleep } from './util.js';

const PAGE = new URL('./live.html', import.meta.url);
const WORKER = new URL('./live-devices.js', import.meta.url);
const PHONE = new URL('./live-iphone.js', import.meta.url);
const HEALTH = new URL('./live-health.js', import.meta.url);
const CLI = fileURLToPath(new URL('../bin/looktap.js', import.meta.url));

// ── the stream's wire format ─────────────────────────────────────────────

/** What a packet carries. A stream is packets end to end: 4 bytes of length (big-endian), 1 of kind, the payload. */
export const KIND = { key: 1, delta: 2, reset: 3, error: 4, jpeg: 5, stamp: 6 };

/** How often a stream says when this computer had its frame (ms): the page works out the delay to it from that. */
const STAMP_MS = 500;

export function packet(kind, payload = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const head = Buffer.alloc(5);
  head.writeUInt32BE(body.length + 1);
  head[4] = kind;
  return Buffer.concat([head, body]);
}

/** Does `b` open with an H.264 start code (00 00 01 or 00 00 00 01)? */
export const startsWithCode = (b) => b.length >= 4 && b[0] === 0 && b[1] === 0 && (b[2] === 1 || (b[2] === 0 && b[3] === 1));

const CODE = Buffer.from([0, 0, 1]);

/**
 Raw H.264 (Annex B, as `screenrecord --output-format=h264` writes it) → frames. `push(chunk)` hands each complete
 frame to `onUnit({ key, data })`: `data` is the frame's slice with the parameter sets that came before it (a key
 frame carries SPS and PPS, so a decoder can start at any key frame).

 A NAL unit ends where the next one starts, so the last one in the buffer is held back until more arrives. The
 encoder sends a frame only when the screen changes, which would leave the last frame of every movement unseen:
 `flush()` gives it up as it is, for the caller to call once nothing has come for a moment. That is a guess (the
 rest of that frame may still be on its way), so the caller checks the next chunk with `startsWithCode`.
 */
export function h264Units(onUnit) {
  let buf = Buffer.alloc(0), pending = [];
  const emit = (nal) => {
    const type = nal[nal[2] === 1 ? 3 : 4] & 31;
    pending.push(nal);
    // 5: a key frame's slice · 1: any other frame's. Everything else (7 SPS, 8 PPS, 6 SEI) belongs to the next slice.
    if (type !== 1 && type !== 5) return;
    onUnit({ key: type === 5, data: pending.length === 1 ? nal : Buffer.concat(pending) });
    pending = [];
  };
  const starts = () => {
    const at = [];
    for (let i = buf.indexOf(CODE); i >= 0; i = buf.indexOf(CODE, i + 3)) at.push(i > 0 && buf[i - 1] === 0 ? i - 1 : i);
    return at;
  };
  return {
    push(chunk) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      const at = starts();
      for (let k = 0; k + 1 < at.length; k++) emit(buf.subarray(at[k], at[k + 1]));
      if (at.length) buf = buf.subarray(at.at(-1));
    },
    /** Give up the held-back NAL as complete. True if there was one. */
    flush() {
      if (!startsWithCode(buf) || buf.length < 5) return false;
      emit(buf);
      buf = Buffer.alloc(0);
      return true;
    },
  };
}

// ── WebSocket, the little of it control needs ────────────────────────────

/** The Sec-WebSocket-Accept value for a client's key (RFC 6455). */
export const wsAccept = (key) => createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');

/** A text frame from the server (never masked). */
export function wsEncode(text) {
  const body = Buffer.from(text, 'utf8');
  const head = body.length < 126 ? Buffer.from([0x81, body.length]) : Buffer.from([0x81, 126, body.length >> 8, body.length & 255]);
  if (body.length > 65535) throw new Error('message too long');
  return Buffer.concat([head, body]);
}

/**
 Client frames out of `buf`: { messages: [text…], rest, closed }. Text frames only, unfragmented, under 64 KB: all the
 page sends. Anything else (a ping aside, which is skipped) closes the connection.
 */
export function wsDecode(buf) {
  const messages = [];
  let at = 0, closed = false;
  while (buf.length - at >= 2) {
    const op = buf[at] & 15, fin = buf[at] & 128, masked = buf[at + 1] & 128;
    let len = buf[at + 1] & 127, head = 2;
    if (len === 126) {
      if (buf.length - at < 4) break;
      len = buf.readUInt16BE(at + 2);
      head = 4;
    } else if (len === 127) {
      closed = true; // nothing the page sends is that long
      break;
    }
    if (!masked || !fin) {
      closed = true;
      break;
    }
    if (buf.length - at < head + 4 + len) break;
    const mask = buf.subarray(at + head, at + head + 4), body = Buffer.from(buf.subarray(at + head + 4, at + head + 4 + len));
    for (let i = 0; i < len; i++) body[i] ^= mask[i & 3];
    at += head + 4 + len;
    if (op === 1) messages.push(body.toString('utf8'));
    else if (op === 8) {
      closed = true;
      break;
    } else if (op !== 9 && op !== 10) {
      closed = true;
      break;
    }
  }
  return { messages, rest: buf.subarray(at), closed };
}

// ── who may ask ──────────────────────────────────────────────────────────

const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]'];
export const isLoopback = (host) => LOOPBACK.includes(host) || host === '::1';

/**
 May this request be served? Bound to this computer only, the Host it names must be this computer by one of its
 loopback names: a web page elsewhere that points its own name at 127.0.0.1 is turned away. A request that changes
 something (the control socket) must also come from the page itself: its Origin names the same host.
 */
export function allowed(headers, { host, port, sameOrigin = false }) {
  const named = String(headers.host || '');
  if (isLoopback(host) && !LOOPBACK.some((h) => named === `${h}:${port}`)) return false;
  if (!sameOrigin) return true;
  try {
    return new URL(headers.origin).host === named;
  } catch {
    return false;
  }
}

// ── sources: one per device, shared by everyone watching it ──────────────

/** Viewers of one device: packets go to each; one too slow to keep up is dropped rather than buffered without end. */
class Source {
  constructor(device) {
    this.device = device;
    this.viewers = new Set();
  }

  /** A frame, after a note of when it got here (every STAMP_MS): 8 bytes, this computer's clock in ms. */
  frame(buf) {
    const now = Date.now();
    if (now - (this.stamped || 0) >= STAMP_MS) {
      this.stamped = now;
      const t = Buffer.alloc(8);
      t.writeDoubleBE(now);
      this.send(packet(KIND.stamp, t));
    }
    this.send(buf);
  }

  send(buf) {
    for (const res of this.viewers) {
      if (res.writableLength > 32e6) res.destroy();
      else res.write(buf);
    }
  }

  add(res) {
    this.viewers.add(res);
    for (const p of this.backlog()) res.write(p);
    if (this.viewers.size === 1) this.start();
  }

  remove(res) {
    this.viewers.delete(res);
    // A reload is a viewer leaving and coming straight back: don't stop for that.
    if (!this.viewers.size) setTimeout(() => !this.viewers.size && this.stop(), 1500).unref();
  }

  fail(text) {
    this.send(packet(KIND.error, text));
  }
}

/** How long nothing may arrive before the held-back end of the stream is taken as a whole frame (ms). */
const FLUSH_MS = 80;
/** `screenrecord` stops by itself after this long (s); it's started again, with a blink. Its own maximum. */
const RECORD_S = 180;
/** How often an Android device's rotation is checked while someone watches it (ms). */
const TURN_MS = 1500;

/** `dumpsys input`'s first display viewport → its rotation in quarter turns (0…3), null when it doesn't say. */
export function displayTurns(text) {
  const m = /\borientation=([0-3])\b/.exec(text || '') || /SurfaceOrientation: ([0-3])/.exec(text || '');
  return m ? Number(m[1]) : null;
}

class AndroidSource extends Source {
  constructor(device) {
    super(device);
    this.gop = []; // packets since the last key frame: what someone who starts watching now needs first
    this.fails = 0;
  }

  backlog() {
    return this.gop;
  }

  /**
   `screenrecord` keeps the size it started with: when the device turns, the picture turns inside it, letterboxed,
   and the page's touches land in the wrong place. So the rotation is watched, and a turn starts the recorder again
   at the new shape.
   */
  watchTurns() {
    if (this.turnTimer) return;
    const check = () => {
      if (this.checking || !this.viewers.size) return;
      this.checking = true;
      let out = '';
      const p = spawn(ADB, ['-s', this.device.id, 'shell', 'dumpsys input | grep -m1 -E "orientation=|SurfaceOrientation"'], { stdio: ['ignore', 'pipe', 'ignore'] });
      p.stdout.on('data', (d) => (out += d));
      const late = setTimeout(() => p.kill(), 5000);
      p.on('close', () => {
        clearTimeout(late);
        this.checking = false;
        const turns = displayTurns(out);
        if (turns == null) return;
        const was = this.turns;
        this.turns = turns;
        if (was != null && turns !== was && this.rec) this.restart();
      });
    };
    check();
    this.turnTimer = setInterval(check, TURN_MS);
    this.turnTimer.unref();
  }

  start() {
    if (this.rec || this.stopped) return;
    this.watchTurns();
    this.gop = [];
    const started = Date.now();
    let err = '', flushed = false, timer = null, got = false;
    // The shell's pid first (on stderr), so this recorder can be stopped by itself: `looktap record` on the same
    // device is a screenrecord too.
    const rec = (this.rec = spawn(ADB, ['-s', this.device.id, 'exec-out', `echo $$ >&2; exec screenrecord --output-format=h264 --bit-rate 4000000 --time-limit ${RECORD_S} -`], { stdio: ['ignore', 'pipe', 'pipe'] }));
    const units = h264Units(({ key, data }) => {
      const p = packet(key ? KIND.key : KIND.delta, data);
      if (key) this.gop = [p];
      else if (this.gop.length) this.gop.push(p);
      // A key frame hasn't come for a long while (the encoder's choice): start again rather than keep it all.
      if (this.gop.length > 3000) return this.restart();
      this.frame(p);
    });
    rec.stderr.on('data', (d) => {
      err += d;
      const pid = /^(\d+)\s/.exec(err);
      if (pid && !this.pid) this.pid = pid[1];
    });
    rec.stdout.on('data', (chunk) => {
      if (rec !== this.rec) return;
      got = true;
      // The last flush took the stream's end for a whole frame. If this doesn't open a new one, it wasn't: half a
      // frame went out, and every picture after it would build on that. Start over, from a key frame.
      if (flushed && !startsWithCode(chunk)) return this.restart();
      flushed = false;
      units.push(chunk);
      clearTimeout(timer);
      timer = setTimeout(() => (flushed = units.flush()), FLUSH_MS);
    });
    rec.on('close', () => {
      clearTimeout(timer);
      if (rec !== this.rec) return;
      this.rec = this.pid = null;
      if (this.stopped || !this.viewers.size) return;
      // It ran its time (or the screen turned off and on): carry on. It never gave a picture: say why, and stop
      // asking after a few tries.
      this.fails = got ? 0 : this.fails + 1;
      // After a few tries, say why, and keep trying more slowly: a sleeping phone wakes, a second recording ends.
      if (this.fails >= 3) this.fail(recorderProblem(err, Date.now() - started));
      else this.send(packet(KIND.reset));
      setTimeout(() => this.viewers.size && !this.stopped && this.start(), got ? 100 : this.fails >= 3 ? 5000 : 1000).unref();
    });
  }

  /** Stop this recorder and start another: the picture begins again from a key frame. */
  restart() {
    this.send(packet(KIND.reset));
    this.kill();
    this.start();
  }

  kill() {
    const { rec, pid } = this;
    this.rec = this.pid = null;
    if (!rec) return;
    rec.kill();
    // adb's end is gone, but the recorder on the device only notices at its next frame: tell it.
    if (pid) spawn(ADB, ['-s', this.device.id, 'shell', 'kill', '-INT', pid], { stdio: 'ignore' }).unref();
  }

  stop() {
    this.kill();
    this.gop = [];
    clearInterval(this.turnTimer);
    this.turnTimer = null;
  }
}

/** Why `screenrecord` gave no picture, from what it printed. */
export function recorderProblem(stderr, ms) {
  const said = stderr.split('\n').map((l) => l.trim()).filter((l) => l && !/^\d+$/.test(l)).slice(-1)[0];
  if (/not found|inaccessible/.test(said || '')) return "this device has no screenrecord (Android 4.4+ has it; some watches and TVs don't)";
  if (/unauthorized|offline|no devices|not found/.test(said || '')) return `adb can't reach it: ${said}`;
  return `the device's screen recorder stopped after ${Math.round(ms / 100) / 10} s without a picture${said ? `: ${said}` : ' (a locked or sleeping screen, or another recording running)'}`;
}

class SimSource extends Source {
  backlog() {
    return this.last ? [this.last] : [];
  }

  async start() {
    if (this.helper || this.starting) return;
    this.starting = true;
    try {
      const d = new Ios(this.device.id, {});
      // The driver's own connection is for commands; the stream gets one to itself (it never answers until it ends).
      if (!(await d.helper())) throw new Error(d.startError || "looktap's simulator helper did not start");
      d.close();
      const h = (this.helper = await Helper.open(d.socket, 2000));
      h.call('stream', { scale: 0.5, quality: 0.6, fps: 30 }, { timeout: 2 ** 31 - 1, onFrame: (_, body) => this.frame((this.last = packet(KIND.jpeg, body))) })
        .catch(() => {})
        .finally(() => {
          if (this.helper !== h) return;
          this.helper = null;
          // The simulator shut down, or the helper was replaced by a newer one: try again while someone watches.
          if (this.viewers.size) setTimeout(() => this.viewers.size && this.start(), 1500);
        });
    } catch (e) {
      // Say why, and try again in a moment: a helper being replaced by a newer one is away for a second or two.
      this.fail(e.message.split('\n')[0]);
      setTimeout(() => this.viewers.size && !this.stopped && this.start(), 3000).unref();
    } finally {
      this.starting = false;
    }
  }

  stop() {
    const h = this.helper;
    this.helper = null;
    h?.close();
  }
}

/**
 A real iPhone: one worker thread (lib/live-iphone.js) that takes its screenshots and sends it gestures, shared by the
 device's stream and its control.
 */
class Phone {
  constructor(device, team) {
    this.waiting = new Map();
    this.n = 0;
    this.worker = new Worker(PHONE, { workerData: { id: device.id, team } });
    this.worker.unref();
    this.worker.on('message', (m) => {
      if (m.type === 'frame') return this.onFrame?.(Buffer.from(m.body.buffer, m.body.byteOffset, m.body.byteLength));
      if (m.type === 'error') return this.onError?.(m.text);
      if (m.type === 'runner') return void (this.runner = m.runner);
      const w = this.waiting.get(m.n);
      this.waiting.delete(m.n);
      if (m.error) w?.fail(new Error(m.error));
      else w?.ok(m);
    });
    this.worker.on('error', (e) => this.onError?.(e.message));
  }

  /** Ask the worker to act; settles when the phone has done it (or couldn't). */
  ask(m) {
    return new Promise((ok, fail) => {
      const n = ++this.n;
      this.waiting.set(n, { ok, fail });
      this.worker.postMessage({ ...m, n });
    });
  }

  watch(on) {
    this.worker.postMessage({ type: 'watch', on });
  }

  close() {
    this.worker.terminate();
  }
}

/** How long the screen feed may take to give its first picture (ms): the capture device shows up slowly. */
const FEED_WAIT_MS = 25000;
/** After the feed ended (the phone locked, the cable moved), before it is tried again (ms). */
const FEED_RETRY_MS = 15000;

/** The feed helper's stdout → its JPEGs: each is 4 bytes of length (big-endian), then the picture. */
export function feedFrames(onFrame) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= 4) {
      const len = buf.readUInt32BE(0);
      if (buf.length < 4 + len) break;
      onFrame(buf.subarray(4, 4 + len));
      buf = buf.subarray(4 + len);
    }
  };
}

/**
 A real iPhone's picture. On a cable, the screen feed (the Mac helper's --feed: the capture device QuickTime uses), as
 video. Otherwise, and until the feed's first picture, and whenever the feed stops, screenshots through the runner.
 */
class PhoneSource extends Source {
  constructor(device, phone) {
    super(device);
    this.phone = phone;
    phone.onFrame = (jpeg) => this.fed || this.frame((this.last = packet(KIND.jpeg, jpeg)));
    // Why there is no picture (locked, the runner being built): the worker keeps trying, so this is news, not the end.
    phone.onError = (text) => this.fed || this.fail(text);
  }

  backlog() {
    return this.last ? [this.last] : [];
  }

  start() {
    this.wanted = true;
    this.phone.watch(true);
    if (this.device.wired) this.feed();
  }

  feed() {
    if (this.child || !this.wanted) return;
    const child = (this.child = spawn(SIM_BIN, ['--feed', this.device.name, '0.5', '0.6', '30'], { stdio: ['ignore', 'pipe', 'ignore'] }));
    const late = setTimeout(() => this.fed || child.kill(), FEED_WAIT_MS);
    child.stdout.on(
      'data',
      feedFrames((jpeg) => {
        if (child !== this.child) return;
        // The feed is here: the screenshots have done their job.
        if (!this.fed) (this.fed = true), this.phone.watch(false);
        this.frame((this.last = packet(KIND.jpeg, Buffer.from(jpeg))));
      }),
    );
    child.on('close', () => {
      clearTimeout(late);
      if (child !== this.child) return;
      this.child = null;
      this.fed = false;
      if (!this.wanted) return;
      // Back to screenshots, and the feed again in a while: a phone that locked is unlocked, QuickTime is closed.
      this.phone.watch(true);
      this.again = setTimeout(() => this.device.wired && this.feed(), FEED_RETRY_MS);
      this.again.unref();
    });
  }

  stop() {
    this.wanted = this.fed = false;
    clearTimeout(this.again);
    const child = this.child;
    this.child = null;
    child?.kill();
    this.phone.watch(false);
  }
}

// ── control: one queue per device ────────────────────────────────────────

/** How long after the page's last action its hold on the device is given up (ms). */
const LEASE_IDLE_MS = 2000;

/** What a control message may say; anything else is dropped. */
const KEYS = new Set(['return', 'delete', 'tab', 'escape', 'space']);
export function controlMessage(text) {
  let m;
  try {
    m = JSON.parse(text);
  } catch {
    return null;
  }
  if (!m || typeof m.id !== 'string' || m.id.length > 128) return null;
  const share = (v) => typeof v === 'number' && v >= 0 && v <= 1;
  if (m.type === 'touch' && ['down', 'move', 'up', 'cancel'].includes(m.phase) && share(m.x) && share(m.y)) return { id: m.id, type: 'touch', phase: m.phase, x: m.x, y: m.y };
  if (m.type === 'key' && KEYS.has(m.key)) return { id: m.id, type: 'key', key: m.key };
  if (m.type === 'text' && typeof m.text === 'string' && m.text.length && m.text.length <= 2000) return { id: m.id, type: 'text', text: m.text };
  if (m.type === 'button' && ['home', 'back'].includes(m.name)) return { id: m.id, type: 'button', name: m.name };
  if (m.type === 'action' && typeof m.name === 'string' && actionValue(m.name, m.value) != null) return { id: m.id, type: 'action', name: m.name, value: actionValue(m.name, m.value) };
  if (m.type === 'boot' || m.type === 'shutdown') return { id: m.id, type: m.type };
  return null;
}

class Control {
  constructor(device, say) {
    this.device = device;
    this.say = say; // (text) → everyone at the page
    this.queue = [];
    this.driver = this.open();
  }

  /** The driver the page's actions go through (a subclass with another way to the device has none). */
  open() {
    return this.device.platform === 'ios' ? new Ios(this.device.id, {}) : new Android(this.device.id, {});
  }

  /** Take the message in turn. A move waiting behind another move replaces it: only where the finger is now matters. */
  push(m) {
    const last = this.queue.at(-1);
    if (m.type === 'touch' && m.phase === 'move' && last?.type === 'touch' && last.phase === 'move') this.queue[this.queue.length - 1] = m;
    else this.queue.push(m);
    if (!this.running) this.drain();
  }

  async drain() {
    this.running = true;
    for (let m; (m = this.queue.shift()); ) {
      const t0 = Date.now();
      try {
        const said = await this.act(m);
        if (typeof said === 'string') this.say(said, 'ok');
        this.log(m, true, Date.now() - t0);
      } catch (e) {
        this.refused = m.type === 'touch'; // the rest of this gesture goes nowhere
        this.down = false;
        const why = e instanceof BusyError ? e.message.replace(/ \(looktap who.*$/, '') : e.message.split('\n')[0].slice(0, 200);
        this.say(why);
        this.log(m, false, Date.now() - t0, why);
      }
    }
    this.running = false;
  }

  /**
   The page's actions go in the activity log like any looktap command's, so the feed shows who did what. A finger is
   one entry when it lifts: a tap, a long press or a swipe, from where it went down.
   */
  log(m, ok, ms, error) {
    let cmd, args = [];
    if (m.type === 'touch') {
      if (m.phase === 'down') return void (this.pressed = { x: m.x, y: m.y, t: Date.now() });
      if (m.phase !== 'up' && ok) return;
      const from = this.pressed || m, held = Date.now() - (this.pressed?.t || Date.now());
      this.pressed = null;
      const pct = (p) => `${Math.round(p.x * 100)}%,${Math.round(p.y * 100)}%`;
      const far = Math.hypot(m.x - from.x, m.y - from.y) > 0.02;
      cmd = far ? 'swipe' : held >= 500 ? 'longpress' : 'tap';
      args = far ? [pct(from), '→', pct(m)] : [pct(m)];
      ms = held;
    } else if (m.type === 'action') (cmd = m.name), (args = [m.value]);
    else if (m.type === 'button') cmd = m.name;
    else if (m.type === 'key') (cmd = 'key'), (args = [m.key]);
    else if (m.type === 'text') (cmd = 'type'), (args = [m.text]);
    else return;
    record({ device: this.device.id, cmd, args, ok, ms, error, via: 'live' });
  }

  /** The device's exclusive lease while the page acts on it, given up once it has been idle a moment. */
  async hold() {
    clearTimeout(this.idle);
    if (!this.lease) {
      this.lease = await acquire(this.device.id, { kind: 'exclusive', command: 'live (driven from the browser)', wait: 0 });
      // The glow says an agent is driving: not for a person here (who still gets the pointer). Android's helper is
      // told per touch; the simulator's apps for as long as the page holds the device.
      this.driver?.quietTouches?.(true);
    }
    this.idle = setTimeout(() => this.down || this.release(), LEASE_IDLE_MS);
    this.idle.unref();
  }

  release() {
    clearTimeout(this.idle);
    if (this.lease) this.driver?.quietTouches?.(false);
    this.lease?.release();
    this.lease = null;
  }

  async act(m) {
    if (m.type !== 'touch') return await this.hold(), await this.other(m);
    if (m.phase === 'down') this.refused = false;
    else if (this.refused || !this.down) return;
    await this.hold();
    this.down = m.phase === 'down' || m.phase === 'move';
    await this.touch(m);
    if (!this.down) await this.hold(); // the idle clock starts when the finger lifts
  }

  /** One phase of the finger: straight to the helper, so the finger on the screen moves as the mouse does. */
  touch(m) {
    if (m.phase === 'down') this.driver._show = undefined; // `touches on|off` since the last gesture: read it again
    return this.driver.liveTouch(m.phase, m.x, m.y);
  }

  other(m) {
    const d = this.driver;
    if (m.type === 'action') return runAction(d, m.name, m.value);
    if (m.type === 'key') return d.keys([m.key]);
    if (m.type === 'text') return d.type(m.text);
    if (m.name === 'home') return d.home();
    if (m.name === 'back') return d.back();
  }

  /** The page went away: lift a finger it left down, and let the device go. */
  async close() {
    if (this.down) this.push({ id: this.device.id, type: 'touch', phase: 'cancel', x: 0, y: 0 });
    for (let i = 0; i < 20 && (this.running || this.queue.length); i++) await sleep(50);
    this.release();
    this.driver?.close?.();
  }
}

/**
 A real iPhone takes whole gestures, not a finger that moves: where the press began and ended, and how long it took,
 go to the phone when the mouse is released (lib/live-iphone.js makes a tap, a long press or a swipe of them).
 */
class PhoneControl extends Control {
  constructor(device, say, phone) {
    super(device, say);
    this.phone = phone;
  }

  open() {
    return null;
  }

  touch(m) {
    const at = { x: m.x, y: m.y };
    if (m.phase === 'down') return void ((this.from = this.to = at), (this.since = Date.now()));
    if (m.phase === 'move') return void (this.to = at);
    if (m.phase !== 'up' || !this.from) return void (this.from = null);
    const g = { type: 'gesture', from: this.from, to: at, ms: Date.now() - this.since };
    this.from = null;
    return this.phone.ask(g);
  }

  async other(m) {
    if (m.type === 'button' && m.name !== 'home') return; // iOS has no system Back
    return (await this.phone.ask(m)).said;
  }
}

// ── the server ───────────────────────────────────────────────────────────

/** A simulator's or Android device's screen as PNG bytes, at full size. */
async function picture(device) {
  const d = device.platform === 'ios' ? new Ios(device.id, {}) : new Android(device.id, {});
  try {
    return await d.picture(1);
  } finally {
    d.close?.();
  }
}

/**
 Start serving. `host`: the address to listen on (this computer only unless told otherwise) · `port`: 0 picks the
 first free one from 4470 · `control`: may the page drive the devices · `team`: the Apple developer team a real
 iPhone's runner is signed with (as for any command on one). Returns { url, port, control, close() }.
 */
export async function serveLive({ host = '127.0.0.1', port = 0, control = true, team = null, log = () => {} } = {}) {
  if (!port) for (port = 4470; port < 4670 && !(await portFree(port)); port++);
  else if (!(await portFree(port))) throw new UsageError(`port ${port} is in use: pass another with --port, or leave it out for the first free one`);

  let devices = [], off = [], have = false, asked = 0, waiting = [];
  const worker = new Worker(WORKER);
  worker.unref();
  worker.on('message', (answer) => {
    const list = answer?.list;
    if (list) (devices = list), (off = answer.off);
    have = true;
    for (const done of waiting.splice(0)) done(devices);
    if (!list) return;
    // A cable going in or coming out changes how a phone is shown: its stream starts over the other way.
    for (const d of list) {
      const s = sources.get(d.id);
      if (!s) continue;
      const changed = Boolean(s.device.wired) !== Boolean(d.wired);
      s.device = d;
      if (changed && s.viewers.size) s.stop(), s.start();
    }
    // A device that went away: its stream ends, and whoever was watching is let go.
    for (const [id, s] of sources) {
      if (list.some((d) => d.id === id && d.live)) continue;
      s.stopped = true;
      s.stop();
      for (const res of s.viewers) res.end();
      sources.delete(id);
      controls.get(id)?.close();
      controls.delete(id);
      phones.get(id)?.close();
      phones.delete(id);
    }
  });
  worker.on('error', (e) => log(`looktap: live: listing devices failed: ${e.message}`));
  /**
   The devices, listed on another thread (simctl and adb take a while, and frames mustn't wait for them). The list in
   hand is answered at once, and a fresh one asked for when it is over 3 s old; only the first call waits.
   */
  const list = () => {
    if (Date.now() - asked > 3000) (asked = Date.now()), worker.postMessage('list');
    if (have) return Promise.resolve(devices);
    return new Promise((done) => {
      waiting.push(done);
      setTimeout(() => done(devices), 10000).unref();
    });
  };

  const sources = new Map(), controls = new Map(), sockets = new Set(), phones = new Map();

  // How each device is doing (lib/live-health.js), on its own thread; a device's reading is shared for 5 s.
  const healthWorker = new Worker(HEALTH);
  healthWorker.unref();
  const readings = new Map(), asking = new Map();
  let healthN = 0;
  healthWorker.on('message', ({ n, health }) => asking.get(n)?.(health));
  const health = (device) => {
    const had = readings.get(device.id);
    if (had && (had.pending || Date.now() - had.at < 5000)) return had.pending || Promise.resolve(had);
    const n = ++healthN;
    const pending = new Promise((done) => {
      asking.set(n, done);
      setTimeout(() => done({ at: Date.now(), error: 'took too long to answer' }), 20000).unref();
    }).then((h) => {
      asking.delete(n);
      readings.set(device.id, h);
      return h;
    });
    readings.set(device.id, { ...had, pending });
    healthWorker.postMessage({ n, device });
    return pending;
  };

  // The activity log: what looktap did on each device, from any terminal, agent or this page. Followed for the
  // pages listening on /events.
  const listeners = new Set();
  const stopFollowing = follow((entry) => {
    const line = `data: ${JSON.stringify(entry)}\n\n`;
    for (const res of listeners) res.write(line);
  });
  const phone = (device) => {
    if (!phones.has(device.id)) phones.set(device.id, new Phone(device, team));
    return phones.get(device.id);
  };
  const source = (id) => {
    const device = devices.find((d) => d.id === id && d.live);
    if (!device) return null;
    if (!sources.has(id)) sources.set(id, device.slow ? new PhoneSource(device, phone(device)) : device.platform === 'ios' ? new SimSource(device) : new AndroidSource(device));
    return sources.get(id);
  };
  const tell = (m) => {
    const frame = wsEncode(JSON.stringify(m));
    for (const s of sockets) s.write(frame);
  };

  /**
   Start a simulator or emulator, or shut one down, from the page: looktap's own boot and shutdown, in a child process
   (a boot takes up to a minute, and frames go on meanwhile). Started headless: it's watched here. Shutting down takes
   the device's lease first, so an agent's command isn't cut off: the page is told who has it instead.
   */
  const powering = new Set();
  const power = async (type, device) => {
    if (powering.has(device.id)) return;
    powering.add(device.id);
    const t0 = Date.now(), say = (state, text) => tell({ id: device.id, type: 'power', state, text, name: device.name });
    let lease = null;
    try {
      if (type === 'shutdown') {
        controls.get(device.id)?.release(); // this page's own hold from its last touch
        lease = await acquire(device.id, { kind: 'exclusive', command: 'live (shutting it down)', wait: 0 });
      }
      say(type === 'boot' ? 'starting' : 'stopping', type === 'boot' ? `starting ${device.name}…` : `shutting down ${device.name}…`);
      const args = type === 'boot' ? ['boot', device.id, '--headless', ...(device.platform ? ['-p', device.platform] : [])] : ['shutdown', device.id];
      const out = await new Promise((done) => {
        let text = '';
        const child = spawn(process.execPath, [CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LOOKTAP_CONTINUE_AFTER_FAILURE: '1' } });
        child.stdout.on('data', (d) => (text += d));
        child.stderr.on('data', (d) => (text += d));
        child.on('close', (code) => done({ code, text: text.trim() }));
      });
      if (out.code) throw new Error(out.text.split('\n').filter(Boolean).pop()?.replace(/^looktap: /, '') || `${type} failed`);
      record({ device: device.id, cmd: type, args: [device.name], ok: true, ms: Date.now() - t0, via: 'live' });
      asked = 0;
      list(); // a fresh listing: the device's tile comes or goes
      say('done', type === 'boot' ? `${device.name} is running` : `${device.name} is shut down`);
    } catch (e) {
      const why = e instanceof BusyError ? e.message.replace(/ \(looktap who.*$/, '') : e.message.split('\n')[0].slice(0, 200);
      record({ device: device.id, cmd: type, args: [device.name], ok: false, ms: Date.now() - t0, error: why, via: 'live' });
      say('failed', why);
    } finally {
      lease?.release();
      powering.delete(device.id);
    }
  };

  const server = createServer(async (req, res) => {
    if (!allowed(req.headers, { host, port })) return res.writeHead(403).end('looktap live serves this computer only');
    const url = new URL(req.url, 'http://x');
    const plain = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
    if (req.method !== 'GET') return res.writeHead(405).end();
    if (url.pathname === '/') return res.writeHead(200, { ...plain, 'content-type': 'text/html; charset=utf-8' }).end(readFileSync(PAGE));
    if (url.pathname === '/devices') {
      const shown = (await list()).map((d) => ({ ...d, actions: actionsFor(d), touches: touchesOn(d.id), ...(phones.get(d.id)?.runner && { runner: phones.get(d.id).runner }) }));
      // `now`: this computer's clock, for the page to line its own up with the streams' stamps.
      // startable: what the page's Start picker offers (only with control: starting one is acting on this computer).
      return res.writeHead(200, { ...plain, 'content-type': 'application/json' }).end(JSON.stringify({ control, now: Date.now(), devices: shown, startable: control ? off.filter((d) => !powering.has(d.id)) : [] }));
    }
    if (url.pathname === '/events') {
      // Server-sent events: the activity so far (the last 60), then each entry as it is written.
      res.writeHead(200, { ...plain, 'content-type': 'text/event-stream', connection: 'keep-alive' });
      for (const e of recent(60)) res.write(`data: ${JSON.stringify(e)}\n\n`);
      listeners.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      return req.on('close', () => (clearInterval(ping), listeners.delete(res)));
    }
    const [, route, id] = /^\/(stream|health|shot)\/([\w.:-]+)$/.exec(url.pathname) || [];
    if (!id) return res.writeHead(404).end();
    if (!have) await list();
    const device = devices.find((d) => d.id === id && d.live);
    if (route === 'health') {
      if (!device) return res.writeHead(404).end('no such running device');
      const h = await health(device);
      return res.writeHead(200, { ...plain, 'content-type': 'application/json' }).end(JSON.stringify({ ...h, ...(phones.get(id)?.runner && { runner: phones.get(id).runner }) }));
    }
    if (route === 'shot') {
      // The screen at full size, as a PNG to save: what `looktap shot` takes, not the stream's smaller frames.
      if (!device) return res.writeHead(404).end('no such running device');
      try {
        const png = device.slow ? (await phone(device).ask({ type: 'shot' })).body : await picture(device);
        const name = `${device.name.replace(/[^\w.-]+/g, '-')}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.png`;
        record({ device: id, cmd: 'shot', args: [], ok: true, ms: 0, via: 'live' });
        return res.writeHead(200, { ...plain, 'content-type': 'image/png', 'content-disposition': `attachment; filename="${name}"` }).end(Buffer.from(png));
      } catch (e) {
        return res.writeHead(500, plain).end(e.message.split('\n')[0]);
      }
    }
    const s = source(id);
    if (!s) return res.writeHead(404).end('no such running device');
    res.writeHead(200, { ...plain, 'content-type': 'application/octet-stream' });
    res.socket?.setNoDelay(true);
    s.add(res);
    req.on('close', () => s.remove(res));
  });

  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (req.url !== '/control' || !key || !control || !allowed(req.headers, { host, port, sameOrigin: true })) return socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${wsAccept(key)}\r\n\r\n`);
    socket.setNoDelay(true);
    sockets.add(socket);
    const mine = new Set(); // devices this page has a finger on
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      const r = wsDecode(buf.length ? Buffer.concat([buf, chunk]) : chunk);
      buf = r.rest;
      for (const text of r.messages) {
        const m = controlMessage(text);
        if (m?.type === 'boot') {
          const target = off.find((d) => d.id === m.id);
          if (target) power('boot', target);
          continue;
        }
        const device = m && devices.find((d) => d.id === m.id && d.live);
        if (!device) continue;
        if (m.type === 'shutdown') {
          if (device.kind === 'simulator' || device.kind === 'emulator') power('shutdown', device);
          continue;
        }
        const say = (text, level = 'warn') => tell({ id: m.id, type: 'note', text, level });
        if (!controls.has(m.id)) controls.set(m.id, device.slow ? new PhoneControl(device, say, phone(device)) : new Control(device, say));
        if (m.type === 'touch') m.phase === 'down' || m.phase === 'move' ? mine.add(m.id) : mine.delete(m.id);
        controls.get(m.id).push(m);
      }
      if (r.closed || buf.length > 1e6) socket.destroy();
    });
    const gone = () => {
      sockets.delete(socket);
      for (const id of mine) controls.get(id)?.push({ id, type: 'touch', phase: 'cancel', x: 0, y: 0 });
    };
    socket.on('close', gone);
    socket.on('error', gone);
  });

  await new Promise((ok, fail) => server.once('error', fail).listen(port, host, ok));
  list();
  const shown = isLoopback(host) || host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  return {
    port, control, url: `http://${shown}:${port}/`,
    async close() {
      stopFollowing();
      for (const res of listeners) res.end();
      for (const s of sources.values()) (s.stopped = true), s.stop();
      await Promise.all([...controls.values()].map((c) => c.close()));
      for (const p of phones.values()) p.close();
      for (const s of sockets) s.destroy();
      server.closeAllConnections?.();
      server.close();
      await worker.terminate();
      await healthWorker.terminate();
    },
  };
}

/** Another address this computer answers on, for the line that says where others can open the page. */
export function lanAddress(interfaces) {
  for (const list of Object.values(interfaces)) for (const a of list || []) if (a.family === 'IPv4' && !a.internal) return a.address;
  return null;
}
