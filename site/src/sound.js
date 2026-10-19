// Sound for the landing page's story: the social video's effects (local/video/sound.py), synthesized live with Web
// Audio, so there are no audio files. Off until the reader turns it on; the choice is remembered. Nothing plays
// while the tab is hidden or the demo is scrolled out of view. The phone sits a little to the right, as in the video.
const PHONE = 0.25;
const midi = (m) => 440 * 2 ** ((m - 69) / 12);
const rnd = (a, b) => a + Math.random() * (b - a);

let ac = null;
let master = null;
// The phone's sounds go through their own bus, a little under the terminal's; `bus` is where `outlet` sends a sound.
let phoneBus = null;
let wet = null;
let bus = null;
let on = false;
let inView = true;

/** The audio graph, made on first use: effects → master → (dry + a short room) → a gentle limiter. */
function audio() {
  if (ac) return ac;
  ac = new AudioContext();
  const limiter = ac.createDynamicsCompressor();
  limiter.threshold.value = -10;
  limiter.ratio.value = 6;
  limiter.connect(ac.destination);
  master = ac.createGain();
  master.gain.value = 0.7;
  const room = ac.createConvolver();
  room.buffer = impulse(1.2);
  wet = ac.createGain();
  wet.gain.value = 0.01;
  master.connect(limiter);
  phoneBus = ac.createGain();
  phoneBus.gain.value = 0.2;
  phoneBus.connect(master);
  master.connect(room).connect(wet).connect(limiter);
  return ac;
}

/** A decaying stereo noise burst, the room's echo. */
function impulse(seconds) {
  const n = Math.floor(seconds * ac.sampleRate);
  const b = ac.createBuffer(2, n, ac.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.exp((-i / n) * 5.5);
  }
  return b;
}

let noiseBuf = null;
function noiseSource() {
  if (!noiseBuf) {
    noiseBuf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const s = ac.createBufferSource();
  s.buffer = noiseBuf;
  s.loop = true;
  return s;
}

/** A gain stage panned into the mix: where every sound ends. */
function outlet(gain, pan = 0) {
  const g = ac.createGain();
  g.gain.value = gain;
  const p = ac.createStereoPanner();
  p.pan.value = pan;
  g.connect(p).connect(bus || master);
  return g;
}

/** An envelope on `param`: up in `attack`, then an exponential fall at `rate` per second. */
function decay(param, t, peak, rate, attack = 0.002) {
  param.setValueAtTime(0, t);
  param.linearRampToValueAtTime(peak, t + attack);
  param.setTargetAtTime(0, t + attack, 1 / rate);
}

/** A sine (or other wave) whose pitch can glide from f0 to f1, decaying at `rate`. */
function tone(dest, t, n, { f0, f1, type = 'sine', rate = 40, gain = 1, attack }) {
  const o = ac.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  if (f1) o.frequency.exponentialRampToValueAtTime(f1, t + n);
  const g = ac.createGain();
  decay(g.gain, t, gain, rate, attack);
  o.connect(g).connect(dest);
  o.start(t);
  o.stop(t + n + 0.05);
}

/** Filtered noise: a band-pass that can glide from f0 to f1, with a decay or a smooth swell over `n`. */
function noise(dest, t, n, { f0, f1, q = 1, rate, gain = 1 }) {
  const s = noiseSource();
  const warm = ac.createBiquadFilter();
  warm.type = 'lowpass';
  warm.frequency.value = 3000;
  const bp = ac.createBiquadFilter();
  bp.type = 'bandpass';
  bp.Q.value = q;
  bp.frequency.setValueAtTime(f0, t);
  if (f1) bp.frequency.exponentialRampToValueAtTime(f1, t + n);
  const g = ac.createGain();
  if (rate) decay(g.gain, t, gain, rate);
  else {
    // A swell: rises and falls smoothly, like sin² over the sweep.
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + n / 2);
    g.gain.linearRampToValueAtTime(0, t + n);
  }
  (f1 ? s.connect(warm).connect(bp) : s.connect(bp)).connect(g).connect(dest);
  s.start(t, Math.random() * 0.5);
  s.stop(t + n + 0.05);
}

/** A soft square-ish beep, for errors and warnings. */
function buzz(dest, t, m, n = 0.11, gain = 1) {
  const o = ac.createOscillator();
  o.type = 'square';
  o.frequency.value = midi(m);
  const lp = ac.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 2200;
  const g = ac.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.35 * gain, t + 0.004);
  g.gain.setValueAtTime(0.35 * gain, t + n - 0.03);
  g.gain.linearRampToValueAtTime(0, t + n);
  o.connect(lp).connect(g).connect(dest);
  o.start(t);
  o.stop(t + n + 0.02);
}

/** An FM bell: a sine whose pitch a faster sine bends, the bend fading out. */
function bell(dest, t, m, n = 1.3, gain = 1) {
  const f = midi(m);
  const car = ac.createOscillator();
  car.frequency.value = f;
  const mod = ac.createOscillator();
  mod.frequency.value = f * 3.5;
  const depth = ac.createGain();
  depth.gain.setValueAtTime(2.2 * f, t);
  depth.gain.setTargetAtTime(0, t, 1 / 3);
  mod.connect(depth).connect(car.frequency);
  const g = ac.createGain();
  decay(g.gain, t, gain, 3.2);
  car.connect(g).connect(dest);
  for (const o of [car, mod]) o.start(t), o.stop(t + n);
}

// ── the effects (names and levels as in sound.py) ──

const FX = {

  // A command running: slow, low breaths of one shimmering fifth (C#3-G#3), swelling in over about a second, so it
  // breathes without edges. It holds until the result is in (`hush`), or a few seconds at most; the last breath rings
  // out on its own.
  run() {
    hush();
    const out = outlet(0.05);
    const soft = ac.createBiquadFilter();
    soft.type = 'lowpass';
    soft.frequency.value = 6750;
    soft.connect(out);
    let timer;
    const breathe = () => {
      const t = ac.currentTime;
      for (const m of [49, 56]) glass(soft, t, m, 1.4, { rate: 1 / 0.15, gain: 0.7, attack: 1.195, cents: 21.5 });
      timer = setTimeout(breathe, 1050);
    };
    breathe();
    const stop = () => clearTimeout(timer);
    humming = stop;
    setTimeout(() => humming === stop && hush(), 5000);
  },
  softkey(at = 0) {
    const t = ac.currentTime + at;
    const d = outlet(0.16 * rnd(0.8, 1), 0.3);
    tone(d, t, 0.06, { f0: rnd(1650, 1950), rate: 140 });
    tone(d, t, 0.06, { f0: 320, rate: 90, gain: 0.6 });
    noise(d, t, 0.03, { f0: 4500, q: 0.9, rate: 600, gain: 0.5 });
  },
  // A finger on glass: a short, round knock with a little body under it.
  tap(at = 0, level = 0.4) {
    const t = ac.currentTime + 0.02 + at;
    const d = outlet(level, PHONE);
    tone(d, t, 0.06, { f0: 660, f1: 420, type: 'triangle', rate: 75 });
    tone(d, t, 0.08, { f0: 190, f1: 120, rate: 55, gain: 0.7 });
    noise(d, t, 0.015, { f0: 2400, q: 0.8, rate: 900, gain: 0.25 });
  },
  hold(ms = 800) {
    FX.tap(0, 0.36);
    FX.tap(ms / 1000, 0.22);
  },
  whoosh(n, lo, hi, up = true, level = 0.22, at = 0) {
    const t = ac.currentTime + at;
    [lo, hi] = [Math.max(lo, 180), Math.min(hi, 2600)];
    noise(outlet(level * 2.2, PHONE), t, n, { f0: up ? lo : hi, f1: up ? hi : lo, q: 0.8 });
  },
  swipe: () => FX.whoosh(0.35, 600, 3000),
  pinch: () => FX.whoosh(0.4, 900, 2500, false),
  error(level = 0.32, at = 0, pan = PHONE) {
    const t = ac.currentTime + at;
    const d = outlet(level, pan);
    buzz(d, t, 70);
    buzz(d, t + 0.15, 65);
  },
  crash() {
    const t = ac.currentTime + 0.1;
    const d = outlet(0.6, 0);
    tone(d, t, 0.6, { f0: 128, f1: 40, rate: 5 });
    tone(d, t, 0.6, { f0: 136, f1: 42, rate: 5, gain: 0.4 });
    FX.error(0.32, 0.25);
  },
  chime(notes, gap = 0.11, level = 0.24, n = 1.3) {
    const t = ac.currentTime;
    const d = outlet(level * 0.8, PHONE);
    notes.forEach((m, k) => bell(d, t + k * gap, m, n, 0.85 ** k));
  },
  pop() {
    const t = ac.currentTime;
    const o = ac.createOscillator();
    o.frequency.setValueAtTime(380, t);
    o.frequency.linearRampToValueAtTime(1080, t + 0.07);
    const g = ac.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(1, t + 0.035);
    g.gain.linearRampToValueAtTime(0, t + 0.07);
    o.connect(g).connect(outlet(0.3, PHONE));
    o.start(t);
    o.stop(t + 0.08);
  },
  dim() {
    FX.whoosh(0.9, 220, 2200, false);
    const t = ac.currentTime;
    const o = ac.createOscillator();
    o.frequency.value = 55;
    const g = ac.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.35, t + 0.45);
    g.gain.linearRampToValueAtTime(0, t + 0.9);
    o.connect(g).connect(outlet(0.22, PHONE));
    o.start(t);
    o.stop(t + 0.95);
  },
  stretch: () => FX.whoosh(0.7, 300, 2400, true, 0.28),
  shimmer() {
    FX.whoosh(0.5, 1200, 2600, true, 0.24);
    const d = outlet(0.24 * 0.25, PHONE);
    for (const [f, at] of [[3520, 0.18], [4400, 0.28]]) tone(d, ac.currentTime + at - 0.04, 0.1, { f0: f, rate: 30, attack: 0.04 });
  },
  warn: () => buzz(outlet(0.14), ac.currentTime, 67, 0.08),
  err() {
    const d = outlet(0.16);
    buzz(d, ac.currentTime, 62, 0.09);
    buzz(d, ac.currentTime + 0.11, 58, 0.09);
  },
};

/** A soft, glassy voice: two slightly detuned sines that shimmer against each other, swelling in over `attack`. */
function glass(out, t, m, n, { rate = 5, gain = 1, attack = 0.04, cents = 7.8 } = {}) {
  for (const d of [1, 2 ** (cents / 1200)]) tone(out, t, n, { f0: midi(m) * d, rate, gain: gain * 0.6, attack });
}

let humming = null;

/** Stop the running-command sound, if one is playing. */
export function hush() {
  const stop = humming;
  humming = null;
  try {
    stop?.();
  } catch {}
}

/** Play an effect, if sound is on and the page and the demo are visible. */
export function play(name, ...args) {
  if (!on || !inView || document.hidden || !ac || ac.state !== 'running') return;
  try {
    FX[name](...args);
  } catch {}
}

/** The video's mapping from what the phone does to what you hear. */
export function hookPhone(Phone) {
  const onPhone = (...a) => {
    bus = phoneBus;
    try {
      play(...a);
    } finally {
      bus = null;
    }
  };
  const wrap = (name, cue) => {
    const orig = Phone.prototype[name];
    Phone.prototype[name] = function (...a) {
      cue(...a);
      return orig.apply(this, a);
    };
  };
  wrap('touch', (x, y, o) => (o?.hold ? onPhone('hold', o.hold) : onPhone('tap')));
  wrap('swipe', () => onPhone('swipe'));
  wrap('scrollList', () => onPhone('swipe'));
  wrap('pinch', () => onPhone('pinch'));
  wrap('crash', () => onPhone('crash'));
  wrap('typeInto', (label, text, perChar = 45) => {
    for (let i = 0; i < String(text).length; i++) onPhone('softkey', 0.15 + (i * perChar) / 1000);
  });
  wrap('set', (patch) => {
    if (patch.dark) onPhone('dim');
    if (patch.text) onPhone('stretch');
    if (patch.clean) onPhone('shimmer');
    if (patch.offline) onPhone('error');
  });
  wrap('overlay', (o) => {
    const k = o.kind;
    if (k === 'banner') onPhone('chime', [88, 83]);
    else if (k === 'alert') onPhone('chime', [81, 85, 88], 0.09, 0.2);
    else if ((k === 'faceid' && o.state === 'bad') || k === 'offline') onPhone('error');
    else if ((k === 'faceid' && o.state === 'ok') || k === 'welcome') onPhone('chime', [77, 81, 84], 0.07, 0.2, 1.0);
    else if (['toast', 'card', 'pin'].includes(k)) onPhone('pop');
    else if (k === 'keyboard') onPhone('whoosh', 0.22, 800, 2600, true, 0.12);
  });
}

/** A sound for a printed result that went wrong: an error over a warning. Success stays quiet. */
export function result(lines) {
  const has = (c) => lines.some((l) => typeof l === 'object' && l.c === c);
  if (has('err')) play('err');
  else if (has('warn')) play('warn');
}

/**
 The speaker button. Sound is off until the reader turns it on, and the button pulses until they choose. Turning it on
 replays the scene, so its sound is heard from the start. Once on, the choice is remembered; browsers start audio only
 after a click, a tap or a key (not a scroll), so on a later visit the first touch starts it and `unlocked` replays.
 */
export function soundButton(button, { stored, store, unlocked, stage }) {
  if (typeof AudioContext === 'undefined') return void (button.hidden = true);
  // Silent while the demo is off screen: a click on a nav link must not make sounds from something you can't see.
  if (stage && 'IntersectionObserver' in window)
    new IntersectionObserver(([e]) => (inView = e.isIntersecting) || hush(), { threshold: 0.3 }).observe(stage);
  // Off until the reader turns it on: a click elsewhere on the page must not start sound they didn't ask for.
  let fresh = stored('sw-sound') == null;
  on = stored('sw-sound') === 'on';
  const show = () => {
    button.setAttribute('aria-pressed', String(on));
    button.setAttribute('aria-label', on ? 'Mute' : 'Turn sound on');
    button.title = on ? (ac?.state === 'running' ? 'Sound on' : 'Sound on: click anywhere to hear it') : 'Turn sound on';
    // Pulse to invite a first-time reader, or a returning one whose sound waits for a click.
    button.classList.toggle('waiting', on ? ac?.state !== 'running' : fresh);
  };
  const unlock = (e) => {
    for (const ev of ['pointerdown', 'keydown']) removeEventListener(ev, unlock, true);
    audio()
      .resume()
      .then(() => {
        show();
        // The first touch was the mute button itself: no replay.
        if (on && inView && !button.contains(e.target)) unlocked?.();
      });
  };
  for (const ev of ['pointerdown', 'keydown']) addEventListener(ev, unlock, true);
  button.addEventListener('click', () => {
    on = !on;
    fresh = false;
    if (!on) hush();
    store('sw-sound', on ? 'on' : 'off');
    // Turning sound on replays the scene, so it's heard from the start.
    if (on) audio().resume().then(() => (show(), inView && unlocked ? unlocked() : play('tap')));
    show();
  });
  show();
}
