// The landing page's scroll story. The scene whose section crosses the middle of the viewport plays on the
// sticky phone and terminal: the phone is reset and set up, then each beat's command is typed and its output
// printed. Scrolling to another scene cancels the one playing. Reduced motion: no typing, no animation.
import { INVENTORY } from './inventory.js';
import { Phone } from './phone.js';
import { SCENES } from './scenes.js';
import { hookPhone, play as sound, result, soundButton } from './sound.js';

const reduce = matchMedia('(prefers-reduced-motion: reduce)');
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const sleep = (ms) => new Promise((r) => setTimeout(r, reduce.matches ? 0 : ms));
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

class Cancelled extends Error {}

// ── platform and theme ──

const root = document.documentElement;
const stored = (k) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const store = (k, v) => {
  try {
    localStorage.setItem(k, v);
  } catch {}
};

root.dataset.platform = stored('sw-platform') === 'android' ? 'android' : 'ios';
const ctx = () => ({ ios: root.dataset.platform === 'ios', platform: root.dataset.platform });

function setPlatform(p) {
  root.dataset.platform = p;
  store('sw-platform', p);
  for (const b of $$('[data-platform-set]')) b.setAttribute('aria-pressed', String(b.dataset.platformSet === p));
  termTitle();
  phone.fit();
  if (active) play(active, { restart: true });
}

for (const b of $$('.theme-toggle')) {
  b.addEventListener('click', () => {
    const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    root.dataset.theme = dark ? 'light' : 'dark';
    store('sw-theme', root.dataset.theme);
  });
}

// ── terminal ──

const term = $('[data-term]');
const body = $('[data-term-body]');

function line(html, cls = '') {
  const el = document.createElement('div');
  el.className = `tl ${cls}`;
  el.innerHTML = html;
  body.appendChild(el);
  // Keep the newest lines in view; old ones scroll off the top like a real terminal.
  while (body.children.length > 60) body.firstChild.remove();
  body.scrollTop = body.scrollHeight;
  return el;
}

async function typeCommand(cmd, token) {
  const el = line('<span class="prompt">$</span> <span class="cmd"></span><span class="caret"></span>', 'in');
  const out = el.querySelector('.cmd');
  if (reduce.matches) out.textContent = cmd;
  else
    for (const ch of cmd) {
      if (token !== run) throw new Cancelled();
      out.textContent += ch;
      sound('key', ch === ' ' ? 'space' : 'key');
      body.scrollTop = body.scrollHeight;
      await sleep(cmd.length > 50 ? 9 : 16);
    }
  el.querySelector('.caret').remove();
  if (!reduce.matches) sound('key', 'enter');
}

function print(lines) {
  result(lines);
  lines.forEach((l, i) => {
    const o = typeof l === 'string' ? { s: l } : l;
    const el = line(esc(o.s), `out ${o.c || ''}${o.ref ? ' ref-row' : ''}`);
    if (o.ref) {
      el.dataset.ref = String(i + 1);
      el.addEventListener('mouseenter', () => phone.focusRef(i + 1));
      el.addEventListener('mouseleave', () => phone.focusRef(0));
    }
  });
}

// ── playing scenes ──

hookPhone(Phone);
const phone = new Phone($('[data-phone]'));
let run = 0;
let active = null;

/** The terminal's title: the device the scene drives (a scene can name its own, e.g. a real phone). */
function termTitle() {
  const { ios } = ctx();
  $('[data-term-title]').textContent = `agent ➜ ${active?.device?.(ios) || (ios ? 'iPhone 18 Pro simulator' : 'Pixel 11 emulator')}`;
}

async function play(scene, { restart = false } = {}) {
  const token = ++run;
  active = scene;
  if (!restart) for (const s of $$('.scene')) s.classList.toggle('is-active', s.dataset.scene === scene.id);
  $('[data-scene-label]').textContent = scene.kicker;
  termTitle();
  for (const d of $$('[data-dot]')) d.classList.toggle('on', d.dataset.dot === scene.id);
  body.innerHTML = '';
  phone.reset();
  scene.start(phone);
  try {
    await sleep(350);
    for (const beat of scene.beats) {
      if (token !== run) throw new Cancelled();
      const cmd = typeof beat.cmd === 'function' ? beat.cmd(ctx()) : beat.cmd;
      await typeCommand(cmd, token);
      await sleep(180);
      if (token !== run) throw new Cancelled();
      const out = await beat.run(phone, ctx());
      if (token !== run) throw new Cancelled();
      print(out || []);
      await sleep(900);
    }
    if (token === run) line('<span class="prompt">$</span> <span class="caret"></span>', 'in idle');
  } catch (e) {
    if (!(e instanceof Cancelled)) throw e;
  }
}

$('[data-replay]').addEventListener('click', () => active && play(active, { restart: true }));
soundButton($('[data-sound]'), { stored, store, unlocked: () => active && play(active, { restart: true }) });
for (const b of $$('[data-platform-set]')) b.addEventListener('click', () => setPlatform(b.dataset.platformSet));

// The section crossing the viewport's middle line is the one playing.
const byId = new Map(SCENES.map((s) => [s.id, s]));
const io = new IntersectionObserver(
  (entries) => {
    for (const e of entries) if (e.isIntersecting && byId.get(e.target.dataset.scene) !== active) play(byId.get(e.target.dataset.scene));
  },
  { rootMargin: '-50% 0px -50% 0px' },
);

// ── page content from data ──

// Scene sections: written from scenes.js, so the copy and the demo can't disagree.
const story = $('[data-scenes]');
for (const s of SCENES.slice(1)) {
  const a = document.createElement('article');
  a.className = 'scene';
  a.id = s.id;
  a.dataset.scene = s.id;
  a.innerHTML = `<p class="kicker">${s.kicker}</p><h2>${s.title}</h2>${s.body}${
    s.covers.length ? `<p class="covers">${s.covers.map((c) => `<a href="docs/commands.html#commands"><code>${c}</code></a>`).join('')}</p>` : ''
  }`;
  story.appendChild(a);
}
// Start the story once the page has loaded and gone idle, so the first scene's animation doesn't compete with
// the first paint.
const startStory = () => {
  const go = () => {
    // The first scene plays from the start: on a phone the hero sits below the pinned stage, short of the
    // middle line that picks the scene. Scrolling takes over from there.
    if (!active) play(SCENES[0]);
    for (const el of $$('[data-scene]')) io.observe(el);
  };
  'requestIdleCallback' in window ? requestIdleCallback(go, { timeout: 600 }) : setTimeout(go, 200);
};
document.readyState === 'complete' ? startStory() : addEventListener('load', startStory, { once: true });

// Progress dots beside the phone.
$('[data-dots]').innerHTML = SCENES.map((s) => `<a href="#${s.id}" data-dot="${s.id}" aria-label="${esc(s.kicker)}"></a>`).join('');

// MCP tools and every command, from the code (inventory.js is generated by site/build.mjs).
for (const el of $$('[data-tools]')) el.innerHTML = INVENTORY.tools.map((t) => `<span title="${esc(t.description)}"><code>${t.name}</code></span>`).join('');
const sceneOf = new Map(SCENES.flatMap((s) => s.covers.map((c) => [c, s])));
const grid = $('[data-commands]');
// In story order: the order the scenes show them, which groups related commands.
const ordered = [...new Set([...SCENES.flatMap((s) => s.covers), ...INVENTORY.commands])].filter((c) => INVENTORY.commands.includes(c));
if (grid)
  grid.innerHTML = ordered
    .map((c) => {
      const s = sceneOf.get(c);
      return `<a href="#${s.id}"><code>${c}</code><span>${esc(s.kicker.replace(/^\d+ · /, ''))}</span></a>`;
    })
    .join('');
for (const el of $$('[data-version]')) el.textContent = `v${INVENTORY.version}`;
for (const el of $$('[data-count="commands"]')) el.textContent = String(INVENTORY.commands.length);
for (const el of $$('[data-count="tools"]')) el.textContent = String(INVENTORY.tools.length);

// Copy buttons.
for (const b of $$('[data-copy]')) {
  b.addEventListener('click', async () => {
    const text = $(b.dataset.copy).textContent.trim();
    try {
      await navigator.clipboard.writeText(text);
      b.textContent = 'Copied';
    } catch {
      b.textContent = 'Select and copy';
    }
    setTimeout(() => (b.textContent = 'Copy'), 1600);
  });
}

// Benchmark bars grow when they come into view.
const bars = new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) e.target.classList.add('in'), bars.unobserve(e.target);
}, { threshold: 0.3 });
for (const el of $$('.bench')) bars.observe(el);

setPlatform(root.dataset.platform);

// The scroll cue goes once the reader has scrolled a little, or followed it.
const cue = $('[data-scroll-cue]');
const hideCue = () => {
  if (scrollY < 120) return;
  cue.classList.add('gone');
  removeEventListener('scroll', hideCue);
};
addEventListener('scroll', hideCue, { passive: true });
hideCue();

// A reader still at the top after a few seconds gets a small nudge: the page dips and comes back, once.
// Any touch, wheel or key first, and it never happens.
let nudge = setTimeout(async () => {
  if (reduce.matches || scrollY > 0) return;
  scrollTo({ top: 70, behavior: 'smooth' });
  await new Promise((r) => setTimeout(r, 650));
  if (nudge && scrollY <= 80) scrollTo({ top: 0, behavior: 'smooth' });
}, 5000);
const noNudge = () => {
  clearTimeout(nudge);
  nudge = null;
  for (const ev of ['wheel', 'touchstart', 'keydown', 'pointerdown']) removeEventListener(ev, noNudge, true);
};
for (const ev of ['wheel', 'touchstart', 'keydown', 'pointerdown']) addEventListener(ev, noNudge, { capture: true, passive: true });
