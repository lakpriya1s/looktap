// The demo phone. Screens are data in real iOS points (a 390×844 iPhone; Android rows are converted to its
// 411×923 dp), so what the phone draws, what the demo terminal's `ls` prints, where a tap lands and where the
// @ref boxes sit all come from the same numbers. Nothing here is a screenshot: it's a fictional demo app.
import { formatRow } from './rows.js';

const W = 390, H = 844;
const ANDROID = { w: 411, h: 923 };
const ANDROID_TYPE = { Heading: 'TextView', StaticText: 'TextView', TextField: 'EditText', SecureTextField: 'EditText', SearchField: 'EditText', Image: 'ImageView', GenericElement: 'View', Cell: 'ViewGroup', Alert: 'FrameLayout' };

export const PRODUCTS = [
  ['House blend beans', '$14', '#7c4a2d'], ['Oat milk, 1 L', '$4', '#d9c7a3'], ['Whole milk, 1 L', '$3', '#e8eef5'],
  ['Ceramic mug', '$18', '#2f6f73'], ['Pour-over kettle', '$42', '#3b3f4a'], ['Paper filters', '$6', '#efe6d5'],
  ['Hand grinder', '$55', '#5b4636'], ['Travel tumbler', '$24', '#c2410c'], ['Gift card', '$25', '#6366f1'],
];
const LIST_TOP = 196, LIST_BOTTOM = 690, ROW = 72;

// ── screens: { elements: [{ type, label, value?, x, y, w, h, kind, scroll? }] } ──

function signin() {
  return [
    { type: 'Heading', label: 'Sign in', x: 24, y: 104, w: 140, h: 41, kind: 'title' },
    { type: 'StaticText', label: 'Welcome back to Demo Store', x: 24, y: 152, w: 246, h: 22, kind: 'sub' },
    { type: 'StaticText', label: 'Email', x: 24, y: 210, w: 42, h: 20, kind: 'label' },
    { type: 'TextField', label: 'Email', value: 'Your email address', x: 24, y: 236, w: 342, h: 48, kind: 'field', placeholder: true },
    { type: 'StaticText', label: 'Password', x: 24, y: 300, w: 72, h: 20, kind: 'label' },
    { type: 'SecureTextField', label: 'Password', value: 'Password', x: 24, y: 326, w: 342, h: 48, kind: 'field', placeholder: true },
    { type: 'Button', label: 'Forgot password?', x: 24, y: 386, w: 136, h: 28, kind: 'link' },
    { type: 'Button', label: 'Sign in', x: 24, y: 432, w: 342, h: 52, kind: 'primary' },
    { type: 'Button', label: 'Create account', x: 24, y: 496, w: 342, h: 52, kind: 'secondary' },
    { type: 'StaticText', label: 'By continuing you agree to the Terms', x: 56, y: 776, w: 278, h: 18, kind: 'fine' },
  ];
}

function home(state = {}) {
  const cart = state.cart ?? 2;
  const els = [
    { type: 'Heading', label: 'Demo Store', x: 20, y: 100, w: 190, h: 41, kind: 'title' },
    { type: 'Button', label: 'Cart', value: String(cart), x: 326, y: 102, w: 44, h: 38, kind: 'iconbtn', icon: 'cart' },
    { type: 'SearchField', label: 'Search products', x: 20, y: 148, w: 350, h: 38, kind: 'search' },
  ];
  PRODUCTS.forEach(([name, price, color], i) => {
    const y = LIST_TOP + 8 + i * ROW;
    els.push(
      { type: 'Image', label: '', x: 20, y: y + 10, w: 52, h: 52, kind: 'thumb', color, scroll: true },
      { type: 'StaticText', label: name, x: 88, y: y + 14, w: 200, h: 22, kind: 'name', scroll: true },
      { type: 'StaticText', label: price, x: 88, y: y + 40, w: 48, h: 18, kind: 'price', scroll: true },
      { type: 'Button', label: 'Add', x: 314, y: y + 18, w: 56, h: 36, kind: 'add', scroll: true },
    );
  });
  els.push(
    { type: 'Button', label: `Checkout · ${cart} items`, x: 20, y: 702, w: 350, h: 48, kind: 'primary' },
    ...['Home', 'Search', 'Cart', 'Account'].map((t, i) => ({ type: 'Button', label: t === 'Cart' ? 'Bag' : t, x: i * 97.5, y: 770, w: 97, h: 49, kind: 'tab', active: i === 0 })),
  );
  return els;
}

function homeLandscape(state = {}) {
  const cart = state.cart ?? 2;
  const els = [
    { type: 'Heading', label: 'Demo Store', x: 64, y: 22, w: 190, h: 41, kind: 'title' },
    { type: 'SearchField', label: 'Search products', x: 280, y: 24, w: 380, h: 38, kind: 'search' },
    { type: 'Button', label: 'Cart', value: String(cart), x: 736, y: 22, w: 44, h: 38, kind: 'iconbtn', icon: 'cart' },
  ];
  PRODUCTS.slice(0, 4).forEach(([name, price, color], i) => {
    const x = 64 + i * 184;
    els.push(
      { type: 'Image', label: '', x, y: 84, w: 168, h: 110, kind: 'thumb', color },
      { type: 'StaticText', label: name, x, y: 204, w: 168, h: 22, kind: 'name' },
      { type: 'StaticText', label: price, x, y: 230, w: 48, h: 18, kind: 'price' },
      { type: 'Button', label: 'Add', x: x + 112, y: 232, w: 56, h: 32, kind: 'add' },
    );
  });
  els.push({ type: 'Button', label: `Checkout · ${cart} items`, x: 64, y: 300, w: 716, h: 44, kind: 'primary' });
  return els;
}

// The iPhone Duo, in its own points: closed, the outer screen (466×678); open, the inner one (951×669), which
// fits a list beside the item it shows.
const DUO = { closed: { w: 466, h: 678 }, open: { w: 951, h: 669 } };

function duoCover(state = {}) {
  const cart = state.cart ?? 2;
  const els = [
    { type: 'Heading', label: 'Demo Store', x: 20, y: 58, w: 190, h: 41, kind: 'title' },
    { type: 'Button', label: 'Cart', value: String(cart), x: 402, y: 60, w: 44, h: 38, kind: 'iconbtn', icon: 'cart' },
    { type: 'SearchField', label: 'Search products', x: 20, y: 108, w: 426, h: 38, kind: 'search' },
  ];
  PRODUCTS.slice(0, 6).forEach(([name, price, color], i) => {
    const y = 158 + i * 70;
    els.push(
      { type: 'Image', label: '', x: 20, y: y + 9, w: 52, h: 52, kind: 'thumb', color },
      { type: 'StaticText', label: name, x: 88, y: y + 13, w: 200, h: 22, kind: 'name' },
      { type: 'StaticText', label: price, x: 88, y: y + 39, w: 48, h: 18, kind: 'price' },
      { type: 'Button', label: 'Add', x: 390, y: y + 17, w: 56, h: 36, kind: 'add' },
    );
  });
  els.push({ type: 'Button', label: `Checkout · ${cart} items`, x: 20, y: 604, w: 426, h: 48, kind: 'primary' });
  return els;
}

function duoOpen(state = {}) {
  const cart = state.cart ?? 2;
  const [name, price, color] = PRODUCTS[0];
  const els = [
    { type: 'Other', label: '', x: 340, y: 0, w: 611, h: 669, kind: 'pane' },
    { type: 'Heading', label: 'Demo Store', x: 24, y: 34, w: 190, h: 41, kind: 'title' },
    { type: 'SearchField', label: 'Search products', x: 24, y: 86, w: 292, h: 38, kind: 'search' },
    { type: 'Other', label: '', x: 12, y: 136, w: 316, h: 66, kind: 'sel' },
  ];
  PRODUCTS.slice(0, 7).forEach(([n, pr, c], i) => {
    const y = 136 + i * 66;
    els.push(
      { type: 'Image', label: '', x: 24, y: y + 9, w: 48, h: 48, kind: 'thumb', color: c },
      { type: 'StaticText', label: n, x: 86, y: y + 12, w: 200, h: 22, kind: 'name' },
      { type: 'StaticText', label: pr, x: 86, y: y + 36, w: 48, h: 18, kind: 'price' },
    );
  });
  els.push(
    { type: 'Button', label: 'Cart', value: String(cart), x: 879, y: 34, w: 44, h: 38, kind: 'iconbtn', icon: 'cart' },
    { type: 'Image', label: name, x: 380, y: 92, w: 230, h: 230, kind: 'thumb', color },
    { type: 'Heading', label: name, x: 640, y: 112, w: 280, h: 34, kind: 'detail' },
    { type: 'StaticText', label: price, x: 640, y: 156, w: 60, h: 22, kind: 'price' },
    { type: 'StaticText', label: 'Medium roast, 1 kg', x: 640, y: 190, w: 260, h: 22, kind: 'sub' },
    { type: 'Button', label: 'Add to bag', x: 640, y: 262, w: 280, h: 52, kind: 'primary' },
    { type: 'Button', label: `Checkout · ${cart} items`, x: 380, y: 590, w: 540, h: 48, kind: 'secondary' },
  );
  return els;
}

function map() {
  return [
    { type: 'Image', label: 'Map', x: 0, y: 0, w: 390, h: 844, kind: 'map' },
    { type: 'Button', label: 'Back', x: 16, y: 58, w: 76, h: 44, kind: 'back' },
    { type: 'GenericElement', label: 'Harbour Park', x: 92, y: 300, w: 30, h: 30, kind: 'poi', color: '#16a34a' },
    { type: 'GenericElement', label: 'Old Town', x: 232, y: 214, w: 30, h: 30, kind: 'poi', color: '#c2410c' },
    { type: 'GenericElement', label: 'Central Station', x: 250, y: 470, w: 30, h: 30, kind: 'poi', color: '#2563eb' },
    { type: 'Button', label: 'Map Modes', x: 326, y: 120, w: 48, h: 48, kind: 'mapbtn', icon: 'layers' },
    { type: 'Button', label: 'Tracking', value: 'Off', x: 326, y: 168, w: 48, h: 48, kind: 'mapbtn', icon: 'arrow' },
    { type: 'SearchField', label: 'Search Maps', x: 20, y: 726, w: 350, h: 48, kind: 'search', sheet: true },
  ];
}

function springboard(installed = true) {
  const apps = [['Settings', '#8e8e93'], ['Maps', '#34c759'], ['Photos', '#ff9500'], ['Camera', '#3a3a3c'], ['Clock', '#1c1c1e'], ['Notes', '#ffcc00'], ['Weather', '#0a84ff']];
  if (installed) apps.push(['Demo Store', '#0891b2']);
  return apps.map(([label, color], i) => ({ type: 'Button', label, x: 26 + (i % 4) * 90, y: 76 + Math.floor(i / 4) * 102, w: 68, h: 91, kind: 'app', color, fresh: label === 'Demo Store' }));
}

const SCREENS = { signin, home, homeLandscape, duoCover, duoOpen, map, springboard: () => springboard(true), springboardEmpty: () => springboard(false) };

// ── the phone ─────────────────────────────────────────────────────────────

const svg = {
  cart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 6h15l-1.5 9h-12z"/><path d="M6 6 5 3H2"/><circle cx="9" cy="20" r="1.4"/><circle cx="18" cy="20" r="1.4"/></svg>',
  layers: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 11 21 3l-8 18-2-8z"/></svg>',
  wifi: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 20 1.5 8.6a15 15 0 0 1 21 0z" opacity=".95"/></svg>',
  plane: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5z"/></svg>',
  face: '<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M6 20V12a6 6 0 0 1 6-6h8M44 6h8a6 6 0 0 1 6 6v8M58 44v8a6 6 0 0 1-6 6h-8M20 58h-8a6 6 0 0 1-6-6v-8"/><path d="M23 24v5M41 24v5M32 26v12h-3M24 44c5 4 11 4 16 0"/></svg>',
  finger: '<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M20 16a18 18 0 0 1 28 6M14 28a18 18 0 0 1 2-7M50 30c0 8-1 14-4 20M32 22a10 10 0 0 1 10 10c0 7-1 13-3 18M22 34a10 10 0 0 1 4-10M32 32c0 9-2 16-6 22M22 42c0 5-1 8-3 11"/></svg>',
};

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Phone {
  constructor(root) {
    this.root = root;
    root.classList.add('phone');
    root.innerHTML = `
      <div class="device" aria-hidden="true">
        <div class="screen">
          <div class="canvas"></div>
          <div class="statusbar"><span class="sb-time">10:24</span><span class="sb-cam"></span><span class="sb-icons"><i class="sb-signal"></i><i class="sb-net">${svg.wifi}</i><i class="sb-batt"><b></b></i></span></div>
          <div class="refs"></div>
          <div class="touches"></div>
          <div class="flash"></div>
          <div class="homebar"></div>
        </div>
      </div>
      <div class="rec" hidden><i></i>REC</div>`;
    this.device = root.querySelector('.device');
    this.screenEl = root.querySelector('.screen');
    this.canvas = root.querySelector('.canvas');
    this.refsEl = root.querySelector('.refs');
    this.touchEl = root.querySelector('.touches');
    this.fit();
    new ResizeObserver(() => this.fit()).observe(root);
    this.reset();
  }

  get platform() {
    return document.documentElement.dataset.platform === 'android' ? 'android' : 'ios';
  }

  get size() {
    if (this.duo) return DUO[this.duo];
    return this.landscape ? { w: H, h: W } : { w: W, h: H };
  }

  /** Scale the 390×844 point canvas to the device's drawn size. */
  fit() {
    // Layout size, not the bounding box: mid-turn the device is rotated, and that box is sideways.
    const w = this.screenEl.clientWidth, h = this.screenEl.clientHeight;
    if (w && h) this.screenEl.style.setProperty('--s', String(Math.min(w / this.size.w, h / this.size.h)));
  }

  // ── state ──

  reset() {
    this.state = { screen: 'signin', scroll: 0, values: {}, overlays: [], dark: false, text: 1, clean: false, offline: false, zoom: 1, cart: 2, focus: null, freshIcon: false };
    this.landscape = false;
    this.duo = null;
    this.root.classList.remove('landscape', 'turning', 'gone', 'duo', 'duo-closed', 'duo-open');
    this.refsEl.innerHTML = '';
    this.root.querySelector('.rec').hidden = true;
    this.render();
  }

  set(patch) {
    Object.assign(this.state, patch);
    this.render();
  }

  show(screen, patch = {}) {
    this.set({ screen, scroll: 0, overlays: [], zoom: 1, ...patch });
  }

  overlay(o) {
    this.state.overlays = [...this.state.overlays.filter((x) => x.kind !== o.kind), o];
    this.render();
  }

  clear(kind) {
    this.state.overlays = this.state.overlays.filter((x) => (kind ? x.kind !== kind : false));
    this.render();
  }

  has(kind) {
    return this.state.overlays.some((o) => o.kind === kind);
  }

  // ── elements, as looktap sees them ──

  baseElements() {
    const els = SCREENS[this.state.screen](this.state).map((e) => ({ ...e }));
    for (const e of els) {
      if (e.scroll) e.y -= this.state.scroll;
      if (e.kind === 'field' && this.state.values[e.label] != null) (e.value = this.state.values[e.label]), (e.placeholder = false);
    }
    return els;
  }

  overlayElements() {
    const out = [];
    for (const o of this.state.overlays) {
      if (o.kind === 'alert') {
        const top = 300;
        out.push({ type: 'StaticText', label: o.title, x: 65, y: top, w: 260, h: 47, kind: 'alert-title', modal: true });
        if (o.message) out.push({ type: 'StaticText', label: o.message, x: 65, y: top + 54, w: 260, h: 44, kind: 'alert-msg', modal: true });
        const by = top + (o.message ? 116 : 64);
        if (o.buttons.length === 2) o.buttons.forEach((b, i) => out.push({ type: 'Button', label: b, x: 51 + i * 148, y: by, w: 140, h: 48, kind: 'alert-btn', strong: i === 1, modal: true }));
        else o.buttons.forEach((b, i) => out.push({ type: 'Button', label: b, x: 51, y: by + i * 56, w: 288, h: 48, kind: 'alert-btn', modal: true }));
      }
      if (o.kind === 'keyboard') out.push({ type: 'Button', label: 'done', x: 288, y: 778, w: 94, h: 42, kind: 'key-done' });
      if (o.kind === 'menu') o.items.forEach((t, i) => out.push({ type: 'Button', label: t, x: o.x, y: o.y + i * 44, w: 220, h: 44, kind: 'menu-item' }));
      if (o.kind === 'card') {
        out.push({ type: 'Heading', label: o.title, x: 20, y: 600, w: 350, h: 30, kind: 'card-title' });
        out.push({ type: 'StaticText', label: o.sub, x: 20, y: 632, w: 350, h: 20, kind: 'card-sub' });
        o.buttons.forEach((b, i) => out.push({ type: 'Button', label: b, x: 20 + i * 120, y: 668, w: 110, h: 54, kind: 'card-btn' }));
      }
      if (o.kind === 'banner') out.push({ type: 'Button', label: `Demo Store, ${o.text}`, x: 10, y: 52, w: 370, h: 72, kind: 'banner' });
      if (o.kind === 'toast') out.push({ type: 'StaticText', label: o.text, x: 20, y: o.y ?? 690, w: 350, h: 52, kind: 'toast' });
      if (o.kind === 'spinner') out.push({ type: 'StaticText', label: 'Loading', x: 155, y: 400, w: 80, h: 60, kind: 'spinner' });
      if (o.kind === 'welcome') out.push({ type: 'StaticText', label: 'Welcome back, Sam', x: 20, y: 52, w: 350, h: 40, kind: 'welcome' });
      if (o.kind === 'offline') out.push({ type: 'StaticText', label: 'You’re offline. Showing saved items', x: 20, y: 196, w: 350, h: 34, kind: 'offline' });
      if (o.kind === 'pin') out.push({ type: 'GenericElement', label: 'Dropped Pin', x: o.x - 15, y: o.y - 34, w: 30, h: 38, kind: 'pin' });
      if (o.kind === 'dot') out.push({ type: 'GenericElement', label: 'My Location', x: o.x - 11, y: o.y - 11, w: 22, h: 22, kind: 'dot' });
      if (o.kind === 'faceid') out.push({ type: 'Image', label: o.state === 'ok' ? 'Face ID: matched' : 'Face ID', x: 135, y: 340, w: 120, h: 120, kind: 'faceid', state: o.state });
      if (o.kind === 'passcode') out.push({ type: 'Other', label: '', x: 0, y: 0, w: 390, h: 844, kind: 'passcode', modal: true });
    }
    return out;
  }

  /** Everything drawn, in drawing order. */
  all() {
    return [...this.baseElements(), ...this.overlayElements()];
  }

  /** What `ls` lists: labelled, on screen; a modal overlay hides what's under it. */
  visible() {
    const { w, h } = this.size;
    let els = this.all();
    if (els.some((e) => e.modal)) els = els.filter((e) => e.modal);
    return els
      .filter((e) => e.label && e.w > 0 && e.h > 0)
      .filter((e) => !(e.scroll && (e.y + e.h <= LIST_TOP || e.y >= LIST_BOTTOM)))
      .filter((e) => e.x < w && e.y < h && e.x + e.w > 0 && e.y + e.h > 0)
      .sort((a, b) => a.y - b.y || a.x - b.x);
  }

  /** An element in the units and type names of the current platform. */
  toPlatform(e) {
    const r = (v) => Math.round(v);
    if (this.platform === 'ios') return { ...e, x: r(e.x), y: r(e.y), w: r(e.w), h: r(e.h) };
    const sx = (this.landscape ? ANDROID.h / H : ANDROID.w / W), sy = (this.landscape ? ANDROID.w / W : ANDROID.h / H);
    const editable = /TextField|SearchField/.test(e.type);
    return {
      ...e,
      type: ANDROID_TYPE[e.type] || e.type,
      label: editable ? e.value || e.label : e.label,
      value: undefined,
      x: r(e.x * sx), y: r(e.y * sy), w: r(e.w * sx), h: r(e.h * sy),
    };
  }

  /** The screen size as looktap reports it (points / dp). */
  screenSize() {
    if (this.duo) return DUO[this.duo];
    const s = this.platform === 'ios' ? { w: W, h: H } : ANDROID;
    return this.landscape ? { w: s.h, h: s.w } : s;
  }

  /** `ls` rows, exactly as looktap formats them. */
  rows(limit = Infinity) {
    return this.visible().slice(0, limit).map((e, i) => formatRow(this.toPlatform(e), i + 1));
  }

  /** The element `tap <label>` picks, looktap's way: exact, else a unique prefix, else a unique substring. */
  find(label) {
    const els = this.visible();
    const hit = els.find((e) => e.label === label);
    if (hit) return { e: hit };
    for (const pred of [(l) => l.startsWith(label), (l) => l.includes(label)]) {
      const hits = els.filter((e) => pred(e.label));
      const distinct = [...new Set(hits.map((e) => e.label))];
      if (distinct.length === 1) return { e: hits[0] };
      if (distinct.length > 1) return { error: `"${label}" is ambiguous — matches ${distinct.length} labels: ${distinct.slice(0, 5).map((l) => JSON.stringify(l)).join(', ')}` };
    }
    return { error: `not found: ${label}` };
  }

  /** Where looktap would tap: the element's centre, in the platform's units. */
  centre(e) {
    const p = this.toPlatform(e);
    return [Math.round(p.x + p.w / 2), Math.round(p.y + p.h / 2)];
  }

  // ── drawing ──

  render() {
    const s = this.state;
    const root = this.root;
    root.classList.toggle('dark', s.dark);
    root.classList.toggle('offline', s.offline);
    root.classList.toggle('kb', this.has('keyboard'));
    root.style.setProperty('--text', String(s.text));
    root.querySelector('.sb-time').textContent = s.clean ? '9:41' : '10:24';
    root.querySelector('.sb-net').innerHTML = s.offline ? svg.plane : svg.wifi;
    root.querySelector('.sb-batt b').style.width = s.clean ? '100%' : '62%';
    this.canvas.dataset.screen = s.screen;
    this.canvas.style.setProperty('--zoom', String(s.zoom));
    const all = this.all();
    this.canvas.innerHTML =
      `<div class="bg"></div>` +
      (s.screen === 'map' ? `<div class="map-layer"><div class="map-art"></div></div>` : '') +
      `<div class="list-clip"><div class="list-inner" style="transform:translateY(${-s.scroll}px)"></div></div>` +
      (this.has('card') ? '<div class="sheet"></div>' : '') +
      all.map((e) => this.draw(e)).join('') +
      (this.has('keyboard') ? this.keyboardHtml() : '') +
      (this.has('alert') ? '<div class="scrim"></div>' : '');
    // Scrolled rows go inside the clip so they're cut at the list's edges.
    const inner = this.canvas.querySelector('.list-inner');
    for (const el of this.canvas.querySelectorAll('[data-scroll]')) inner.appendChild(el);
    const scrim = this.canvas.querySelector('.scrim');
    if (scrim) for (const el of this.canvas.querySelectorAll('.k-alert-title, .k-alert-msg, .k-alert-btn')) scrim.appendChild(el);
    this.fit();
  }

  keyboardHtml() {
    const rows = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
    return `<div class="keyboard">${rows
      .map((r, i) => `<div class="krow r${i}">${i === 2 ? '<span class="key mod">⇧</span>' : ''}${[...r].map((c) => `<span class="key">${c}</span>`).join('')}${i === 2 ? '<span class="key mod">⌫</span>' : ''}</div>`)
      .join('')}<div class="krow"><span class="key mod wide">123</span><span class="key space">space</span><span class="key mod done">done</span></div></div>`;
  }

  draw(e) {
    // List rows sit in the list's own layer at their unscrolled place; the layer moves when the list scrolls.
    const top = e.scroll ? e.y + this.state.scroll - LIST_TOP : e.y;
    const pos = `style="left:${e.x}px;top:${top}px;width:${e.w}px;height:${e.h}px"${e.scroll ? ' data-scroll' : ''}`;
    const k = `el k-${e.kind}`;
    switch (e.kind) {
      case 'title': case 'detail': return `<div class="${k}" ${pos}>${esc(e.label)}</div>`;
      case 'pane': case 'sel': return `<div class="${k}" ${pos}></div>`;
      case 'sub': case 'label': case 'fine': case 'name': case 'price': return `<div class="${k}" ${pos}>${esc(e.label)}</div>`;
      case 'field': {
        const v = e.placeholder ? e.value : e.type === 'SecureTextField' ? '•'.repeat(e.value.length) : e.value;
        return `<div class="${k}${e.placeholder ? ' ph' : ''}${this.state.focus === e.label ? ' focus' : ''}" ${pos}><span>${esc(v)}</span></div>`;
      }
      case 'primary': case 'secondary': case 'link': case 'add': return `<div class="${k}" ${pos}>${esc(e.label)}</div>`;
      case 'iconbtn': return `<div class="${k}" ${pos}>${svg[e.icon]}<b>${esc(e.value)}</b></div>`;
      case 'search': return `<div class="${k}" ${pos}><span>⌕</span>${esc(e.label)}</div>`;
      case 'thumb': return `<div class="${k}" ${pos}><i style="background:${e.color}"></i></div>`;
      case 'tab': return `<div class="${k}${e.active ? ' on' : ''}" ${pos}><i></i>${esc(e.label)}</div>`;
      case 'map': return '';
      case 'poi': return `<div class="${k}" ${pos}><i style="background:${e.color}"></i><span>${esc(e.label)}</span></div>`;
      case 'mapbtn': return `<div class="${k}" ${pos}>${svg[e.icon]}</div>`;
      case 'back': return `<div class="${k}" ${pos}>‹ ${esc(e.label)}</div>`;
      case 'app': return `<div class="${k}${e.fresh && this.state.freshIcon ? ' pop' : ''}" ${pos}><i style="background:${e.color}"></i><span>${esc(e.label)}</span></div>`;
      case 'alert-title': case 'alert-msg': return `<div class="${k}" ${pos}>${esc(e.label)}</div>`;
      case 'alert-btn': return `<div class="${k}${e.strong ? ' strong' : ''}" ${pos}>${esc(e.label)}</div>`;
      case 'key-done': return '';
      case 'menu-item': return `<div class="${k}" ${pos}>${esc(e.label)}</div>`;
      case 'card-title': case 'card-sub': return `<div class="${k}" ${pos}>${esc(e.label)}</div>`;
      case 'card-btn': return `<div class="${k}" ${pos}>${esc(e.label)}</div>`;
      case 'banner': return `<div class="${k}" ${pos}><i></i><div><b>Demo Store</b><span>${esc(e.label.replace(/^Demo Store, /, ''))}</span></div><em>now</em></div>`;
      case 'toast': return `<div class="${k}" ${pos}>${esc(e.label)}<b>Undo</b></div>`;
      case 'spinner': return `<div class="${k}" ${pos}><i></i></div>`;
      case 'welcome': return `<div class="${k}" ${pos}>${esc(e.label)}</div>`;
      case 'offline': return `<div class="${k}" ${pos}>${svg.plane}${esc(e.label)}</div>`;
      case 'pin': return `<div class="${k}" ${pos}></div>`;
      case 'dot': return `<div class="${k}" ${pos}></div>`;
      case 'faceid': return `<div class="${k} ${e.state || ''}" ${pos}>${this.platform === 'ios' ? svg.face : svg.finger}</div>`;
      case 'passcode': return `<div class="${k}" ${pos}><p>Enter Passcode</p><div class="dots"><i></i><i></i><i></i><i></i><i></i><i></i></div></div>`;
      default: return `<div class="${k}" ${pos}>${esc(e.label)}</div>`;
    }
  }

  /** Dashed boxes with @N tags over what `ls` lists. */
  showRefs(on = true) {
    if (!on) return void (this.refsEl.innerHTML = '');
    this.refsEl.innerHTML = this.visible()
      .map((e, i) => `<div class="ref" style="left:${e.x}px;top:${e.y}px;width:${e.w}px;height:${e.h}px;--d:${i * 40}ms" data-ref="${i + 1}"><b>@${i + 1}</b></div>`)
      .join('');
  }

  focusRef(n) {
    for (const r of this.refsEl.children) r.classList.toggle('hot', r.dataset.ref === String(n));
  }

  // ── motion ──

  async touch(x, y, { hold = 0, ms = 260 } = {}) {
    const t = document.createElement('i');
    t.className = 'touch';
    t.style.cssText = `left:${x}px;top:${y}px`;
    this.touchEl.appendChild(t);
    if (hold) t.classList.add('hold'), t.style.setProperty('--hold', `${hold}ms`);
    await sleep(hold || ms);
    t.classList.add('up');
    setTimeout(() => t.remove(), 500);
  }

  /** Tap an element (a found element's centre, in points). */
  async tapEl(e, opts) {
    await this.touch(e.x + e.w / 2, e.y + e.h / 2, opts);
  }

  async swipe(x1, y1, x2, y2, ms = 420) {
    const t = document.createElement('i');
    t.className = 'touch drag';
    t.style.cssText = `left:${x1}px;top:${y1}px;--dx:${x2 - x1}px;--dy:${y2 - y1}px;--ms:${ms}ms`;
    this.touchEl.appendChild(t);
    await sleep(ms);
    t.classList.add('up');
    setTimeout(() => t.remove(), 500);
  }

  async pinch(cx, cy, out = false) {
    for (const side of [-1, 1]) {
      const t = document.createElement('i');
      t.className = `touch pinch ${out ? 'in' : 'out'}`;
      t.style.cssText = `left:${cx}px;top:${cy}px;--side:${side}`;
      this.touchEl.appendChild(t);
      setTimeout(() => t.remove(), 1200);
    }
    await sleep(700);
  }

  /** Scroll the product list to `to` points, smoothly. */
  async scrollList(to, ms = 450) {
    const from = this.state.scroll;
    const t0 = performance.now();
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) return this.set({ scroll: to });
    await new Promise((done) => {
      const step = (now) => {
        const p = Math.min(1, (now - t0) / ms);
        const k = 1 - (1 - p) ** 3;
        this.state.scroll = from + (to - from) * k;
        const inner = this.canvas.querySelector('.list-inner');
        if (inner) inner.style.transform = `translateY(${-this.state.scroll}px)`;
        if (p < 1) requestAnimationFrame(step);
        else done();
      };
      requestAnimationFrame(step);
    });
    this.render();
  }

  async typeInto(label, text, perChar = 45) {
    this.state.focus = label;
    for (let i = 1; i <= text.length; i++) {
      this.state.values[label] = text.slice(0, i);
      this.render();
      await sleep(perChar);
    }
  }

  flash() {
    const f = this.root.querySelector('.flash');
    f.classList.remove('go');
    void f.offsetWidth;
    f.classList.add('go');
  }

  rec(on) {
    this.root.querySelector('.rec').hidden = !on;
  }

  /** The app in front dies: it shrinks away to the home screen. */
  async crash() {
    this.root.classList.add('gone');
    await sleep(450);
    this.root.classList.remove('gone');
    this.show('springboard');
  }

  /** Become the iPhone Duo, `closed` or `open`, in one frame (the caller animates it). */
  setDuo(form) {
    this.duo = form;
    this.landscape = false;
    this.root.classList.remove('landscape', 'duo-closed', 'duo-open');
    this.root.classList.add('duo', `duo-${form}`);
    this.state.screen = form === 'open' ? 'duoOpen' : 'duoCover';
    this.render();
    this.fit();
  }

  /**
   `fold open` on the iPhone Duo: the phone becomes the Duo, closed (its outer screen), then opens like a book. The
   left half stays where the closed device was and the right half swings out from the hinge.
   */
  async unfold() {
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const ease = { easing: 'cubic-bezier(0.3, 0, 0.2, 1)' };
    let before = this.root.getBoundingClientRect();
    this.setDuo('closed');
    if (!reduce) {
      const after = this.root.getBoundingClientRect();
      const dx = before.left + before.width / 2 - (after.left + after.width / 2);
      const dy = before.top + before.height / 2 - (after.top + after.height / 2);
      this.root.animate([{ transform: `translate(${dx}px, ${dy}px) scale(${before.height / after.height})` }, { transform: 'none' }], { duration: 420, ...ease });
      await sleep(900);
    }
    before = this.root.getBoundingClientRect();
    this.setDuo('open');
    if (reduce) return;
    // Start with only the left half showing, over the closed device; the right half opens out to the full width.
    const after = this.root.getBoundingClientRect();
    const k = before.height / after.height;
    // Scaled about its centre, the open device's left half (centred a quarter in) lands on the closed one.
    const dx = before.left + before.width / 2 - (after.left + after.width / 2) + (after.width / 4) * k;
    const dy = before.top + before.height / 2 - (after.top + after.height / 2);
    this.root.animate([{ transform: `translate(${dx}px, ${dy}px) scale(${k})` }, { transform: 'none' }], { duration: 760, ...ease });
    this.device.animate([{ clipPath: 'inset(0 50% 0 0 round 3%)' }, { clipPath: 'inset(0 0 0 0 round 3%)' }], { duration: 760, ...ease });
    const shade = document.createElement('i');
    shade.className = 'fold-shade';
    this.device.appendChild(shade);
    await shade.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 760, ...ease }).finished;
    shade.remove();
  }

  /** Turn the device: a quarter turn, then the app lays itself out again for the new shape. */
  async rotate(landscape) {
    if (this.landscape === landscape) return;
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!reduce) {
      this.root.classList.add('turning');
      this.root.style.setProperty('--turn', landscape ? '-90deg' : '90deg');
      await sleep(520);
    }
    // Swap to the new shape and drop the turn in the same frame, with no transition: the turned portrait frame and
    // the landscape one look the same, so the swap doesn't show. Animated, it would turn back the other way.
    const before = this.device.getBoundingClientRect();
    this.landscape = landscape;
    this.root.classList.add('settle');
    this.root.classList.remove('turning');
    this.root.classList.toggle('landscape', landscape);
    this.state.screen = landscape ? 'homeLandscape' : 'home';
    this.render();
    this.fit();
    void this.root.offsetWidth;
    this.root.classList.remove('settle');
    // The new shape sits at its own size and place; ease it there from where the turned frame was.
    if (!reduce) {
      const after = this.root.getBoundingClientRect();
      const dx = before.left + before.width / 2 - (after.left + after.width / 2);
      const dy = before.top + before.height / 2 - (after.top + after.height / 2);
      const k = before.width / after.width;
      this.root.animate([{ transform: `translate(${dx}px, ${dy}px) scale(${k})` }, { transform: 'none' }], { duration: 450, easing: 'cubic-bezier(0.3, 0, 0.2, 1)' });
    }
  }
}
