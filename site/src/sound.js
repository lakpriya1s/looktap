// Sound for the landing page's story: the social video's effects (local/video/sound.py), synthesized live with Web
// Audio, so there are no audio files. Off until the reader turns it on; the choice is remembered. Nothing plays
// while the tab is hidden. The phone sits a little to the right, as in the video.
const PHONE = 0.25;
const midi = (m) => 440 * 2 ** ((m - 69) / 12);
const rnd = (a, b) => a + Math.random() * (b - a);

let ac = null;
let master = null;
let on = false;

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
  const wet = ac.createGain();
  wet.gain.value = 0.12;
  master.connect(limiter);
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
  g.connect(p).connect(master);
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
  key(kind = 'key') {
    const t = ac.currentTime;
    const f = { key: 3200, space: 1400, enter: 1100 }[kind] * rnd(0.9, 1.1);
    const d = outlet({ key: 0.1, space: 0.12, enter: 0.18 }[kind] * rnd(0.7, 1.1), rnd(-0.15, 0.15));
    const rate = kind === 'key' ? 260 : 110;
    noise(d, t, 0.05, { f0: f * 1.1, q: 1.4, rate, gain: 1.6 });
    tone(d, t, 0.05, { f0: f, rate, gain: 0.4 });
  },
  softkey(at = 0) {
    const t = ac.currentTime + at;
    const d = outlet(0.16 * rnd(0.8, 1), 0.3);
    tone(d, t, 0.06, { f0: rnd(1650, 1950), rate: 140 });
    tone(d, t, 0.06, { f0: 320, rate: 90, gain: 0.6 });
    noise(d, t, 0.03, { f0: 4500, q: 0.9, rate: 600, gain: 0.5 });
  },
  tap(at = 0, level = 0.4) {
    const t = ac.currentTime + 0.02 + at;
    const d = outlet(level, PHONE);
    tone(d, t, 0.09, { f0: 1400, f1: 520, rate: 45 });
    noise(d, t, 0.03, { f0: 4000, q: 1, rate: 200, gain: 0.45 });
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
  ok: () => tone(outlet(0.1), ac.currentTime, 0.07, { f0: midi(96), rate: 40 }),
  warn: () => buzz(outlet(0.14), ac.currentTime, 67, 0.08),
  err() {
    const d = outlet(0.16);
    buzz(d, ac.currentTime, 62, 0.09);
    buzz(d, ac.currentTime + 0.11, 58, 0.09);
  },
};

/** Play an effect, if sound is on and the page is visible. */
export function play(name, ...args) {
  if (!on || document.hidden || !ac || ac.state !== 'running') return;
  try {
    FX[name](...args);
  } catch {}
}

/** The video's mapping from what the phone does to what you hear. */
export function hookPhone(Phone) {
  const wrap = (name, cue) => {
    const orig = Phone.prototype[name];
    Phone.prototype[name] = function (...a) {
      cue(...a);
      return orig.apply(this, a);
    };
  };
  wrap('touch', (x, y, o) => (o?.hold ? play('hold', o.hold) : play('tap')));
  wrap('swipe', () => play('swipe'));
  wrap('scrollList', () => play('swipe'));
  wrap('pinch', () => play('pinch'));
  wrap('crash', () => play('crash'));
  wrap('typeInto', (label, text, perChar = 45) => {
    for (let i = 0; i < String(text).length; i++) play('softkey', 0.15 + (i * perChar) / 1000);
  });
  wrap('set', (patch) => {
    if (patch.dark) play('dim');
    if (patch.text) play('stretch');
    if (patch.clean) play('shimmer');
    if (patch.offline) play('error');
  });
  wrap('overlay', (o) => {
    const k = o.kind;
    if (k === 'banner') play('chime', [88, 83]);
    else if (k === 'alert') play('chime', [81, 85, 88], 0.09, 0.2);
    else if ((k === 'faceid' && o.state === 'bad') || k === 'offline') play('error');
    else if ((k === 'faceid' && o.state === 'ok') || k === 'welcome') play('chime', [77, 81, 84], 0.07, 0.2, 1.0);
    else if (['toast', 'card', 'pin'].includes(k)) play('pop');
    else if (k === 'keyboard') play('whoosh', 0.22, 800, 2600, true, 0.12);
  });
}

/** One sound per printed result: an error over a warning over a ✓. */
export function result(lines) {
  const has = (c) => lines.some((l) => typeof l === 'object' && l.c === c);
  for (const c of ['err', 'warn', 'ok']) if (has(c)) return play(c);
}

/**
 The speaker button. Sound is on unless the reader turned it off. Browsers start audio only after a click, a tap or a
 key (not a scroll), so until then the button pulses, and that first touch starts it: `unlocked` then replays the
 scene, so its sound is heard from the start. Clicking the button mutes and unmutes.
 */
export function soundButton(button, { stored, store, unlocked }) {
  if (typeof AudioContext === 'undefined') return void (button.hidden = true);
  on = stored('sw-sound') !== 'off';
  const show = () => {
    button.setAttribute('aria-pressed', String(on));
    button.setAttribute('aria-label', on ? 'Mute' : 'Turn sound on');
    button.title = on ? (ac?.state === 'running' ? 'Sound on' : 'Sound on: click anywhere to hear it') : 'Muted';
    button.classList.toggle('waiting', on && ac?.state !== 'running');
  };
  const unlock = (e) => {
    for (const ev of ['pointerdown', 'keydown']) removeEventListener(ev, unlock, true);
    audio()
      .resume()
      .then(() => {
        show();
        // The first touch was the mute button itself: no replay.
        if (on && !button.contains(e.target)) unlocked?.();
      });
  };
  for (const ev of ['pointerdown', 'keydown']) addEventListener(ev, unlock, true);
  button.addEventListener('click', () => {
    on = !on;
    store('sw-sound', on ? 'on' : 'off');
    if (on) audio().resume().then(() => (show(), play('tap')));
    show();
  });
  show();
}
