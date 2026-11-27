// `looktap touches on|off`: a pointer drawn where each touch lands, for videos, demos and watching an agent work.
//
// How it gets on screen differs per kind of device, and nothing is installed on any of them:
//  - Android: the helper draws it on a display layer of its own (native/android, Server.Pointer), for every app.
//  - iOS simulator: a small dylib (native/ios-touches) is loaded into the simulator's apps and its home screen, and
//    draws inside each one.
//  - A real iPhone: iOS lets nothing draw over another app, so only an app built with LooktapTouches.m shows it.
//
// This file keeps who has it on (~/.looktap/touches.json), places the simulator's dylib, and draws the same pointer
// onto a screenshot (`shot --mark`), which is the one way to show a touch on any device, a real iPhone included.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { HOME, readJson, writeJson } from './util.js';

const FILE = join(HOME, 'touches.json');

/** The simulator's dylib as shipped, and the one source file an app for a real iPhone adds. */
export const TOUCHES_DYLIB = new URL('./assets/looktap-touches.dylib', import.meta.url).pathname;
export const TOUCHES_SOURCE = new URL('../native/ios-touches/LooktapTouches.m', import.meta.url).pathname;

/** What `touches on` and `touches off` post, for apps that already have the dylib loaded. */
export const NOTIFY = { on: 'com.looktap.touches.on', off: 'com.looktap.touches.off', glowOff: 'com.looktap.touches.glow.off', glowOn: 'com.looktap.touches.glow.on' };

/** Is the pointer switched on for this device (its serial or UDID)? */
export const touchesOn = (id) => Boolean(readJson(FILE, {})[id]);

export function setTouches(id, on) {
  const all = readJson(FILE, {});
  if (on) all[id] = true;
  else delete all[id];
  writeJson(FILE, all);
}

/**
 The dylib where simulator processes load it from: ~/.looktap/touches/<hash>/looktap-touches.dylib. Not the package's
 own copy: that can sit in a folder macOS guards (Documents, an external disk), and a process that can't load a
 library it was told to insert dies at launch. A copy is never changed in place either (a new build gets a new folder):
 macOS kills processes that load a signed library whose file was overwritten.
 */
export function placeDylib(home = HOME, source = TOUCHES_DYLIB) {
  const bytes = readFileSync(source);
  const dir = join(home, 'touches', createHash('sha1').update(bytes).digest('hex').slice(0, 12));
  const path = join(dir, 'looktap-touches.dylib');
  if (!existsSync(path)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${path}.${process.pid}`, bytes, { mode: 0o755 });
    renameSync(`${path}.${process.pid}`, path);
  }
  return path;
}

const ours = (p) => /(^|\/)looktap-touches\.dylib$/.test(p);
const parts = (value) => String(value || '').split(':').filter(Boolean);

/** A DYLD_INSERT_LIBRARIES value with our dylib in it once (an older copy's path replaced), others kept. */
export const withInsert = (value, path) => [...parts(value).filter((p) => !ours(p)), path].join(':');

/** The same value without ours: '' when nothing else was inserted. */
export const withoutInsert = (value) => parts(value).filter((p) => !ours(p)).join(':');

/** Does a DYLD_INSERT_LIBRARIES value (or a process's environment, as `ps eww` prints it) carry our dylib? */
export const hasInsert = (value) => /(^|[\/:=\s])looktap-touches\.dylib(?=$|[:\s])/.test(String(value || ''));

// ── the pointer on a screenshot ──────────────────────────────────────────

/** The pointer's look, shared with the helpers (Server.Pointer, LooktapTouches.m): sizes in points/dp. */
export const POINTER = { radius: 20, ring: 2.5, halo: 3, accent: [0x22, 0xd3, 0xee] };

/**
 Draw the pointer on raw pixels (RGB or RGBA, `channels` per pixel), centred on (cx, cy) px; `scale` is px per point.
 looktap's accent inside and as its ring, with a soft dark halo outside it so it shows on a light screen too. Changes
 `pixels`.
 */
export function drawPointer(pixels, width, height, channels, cx, cy, scale = 1) {
  const r = POINTER.radius * scale, ring = POINTER.ring * scale, halo = POINTER.halo * scale;
  const reach = Math.ceil(r + halo + 1);
  // Coverage of a band between two radii at distance d, smoothed over one pixel at each edge.
  const band = (d, from, to) => Math.max(0, Math.min(1, d - from + 0.5)) * Math.max(0, Math.min(1, to - d + 0.5));
  const blend = (i, rgb, a) => {
    for (let c = 0; c < 3; c++) pixels[i + c] = Math.round(pixels[i + c] * (1 - a) + rgb[c] * a);
    if (channels === 4) pixels[i + 3] = Math.max(pixels[i + 3], Math.round(255 * a));
  };
  for (let y = Math.max(0, Math.floor(cy - reach)); y <= Math.min(height - 1, Math.ceil(cy + reach)); y++) {
    for (let x = Math.max(0, Math.floor(cx - reach)); x <= Math.min(width - 1, Math.ceil(cx + reach)); x++) {
      const d = Math.hypot(x - cx, y - cy), i = (y * width + x) * channels;
      const inside = band(d, -1, r - ring), white = band(d, r - ring, r);
      const out = d > r ? Math.max(0, 1 - (d - r) / halo) * 0.45 : 0;
      if (inside > 0) blend(i, POINTER.accent, 0.35 * inside);
      if (out > 0) blend(i, [0, 0, 0], out);
      if (white > 0) blend(i, POINTER.accent, 0.95 * white);
    }
  }
  return pixels;
}
