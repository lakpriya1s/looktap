// Simulated conditions shared by both platforms: text sizes, push payloads, coordinates, orientation.
import { existsSync, readFileSync } from 'node:fs';

import { UsageError } from './util.js';

/** iOS content-size categories, smallest to largest, with the Android font scale closest to each. */
export const TEXT_SIZES = {
  'extra-small': 0.8,
  small: 0.85,
  medium: 0.9,
  large: 1, // both platforms' default
  'extra-large': 1.15,
  'extra-extra-large': 1.3,
  'extra-extra-extra-large': 1.5,
  'accessibility-medium': 1.6,
  'accessibility-large': 1.7,
  'accessibility-extra-large': 1.8,
  'accessibility-extra-extra-large': 1.9,
  'accessibility-extra-extra-extra-large': 2,
};

const SIZE_ALIASES = { xs: 'extra-small', s: 'small', m: 'medium', default: 'large', l: 'large', xl: 'extra-large', xxl: 'extra-extra-large', xxxl: 'extra-extra-extra-large', ax1: 'accessibility-medium', ax2: 'accessibility-large', ax3: 'accessibility-extra-large', ax4: 'accessibility-extra-extra-large', ax5: 'accessibility-extra-extra-extra-large' };

export function textSize(name) {
  const size = SIZE_ALIASES[name] || name;
  if (!(size in TEXT_SIZES)) throw new UsageError(`text size: one of ${Object.keys(TEXT_SIZES).join(', ')} (or xs, s, m, l/default, xl, xxl, xxxl, ax1…ax5)`);
  return size;
}

/** The size category nearest an Android font scale. */
export function sizeForScale(scale) {
  return Object.entries(TEXT_SIZES).reduce((best, [k, v]) => (Math.abs(v - scale) < Math.abs(TEXT_SIZES[best] - scale) ? k : best), 'large');
}

/** Latitude/longitude from "lat lon" or "lat,lon", checked for range. */
export function coordinates(args) {
  const [lat, lon] = args.join(' ').split(/[\s,]+/).filter(Boolean).map(Number);
  if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) throw new UsageError('usage: looktap location <lat> <lon>   e.g. location 51.5072 -0.1276');
  return [lat, lon];
}

/**
 Orientations as quarter turns counter-clockwise from portrait (Android's display rotation): "left" is the
 device turned to the left, its top edge on the left — Simulator's Rotate Left, iOS's landscape left.
 */
const TURNS = { portrait: 0, left: 1, landscape: 1, upsidedown: 2, right: 3 };
export const ORIENTATIONS = ['portrait', 'landscape left', 'upside down', 'landscape right'];

export function rotation(name) {
  const turns = TURNS[name?.toLowerCase().replace(/[-\s]/g, '')];
  if (turns == null) throw new UsageError('usage: looktap rotate [portrait|landscape|left|right|upsidedown]   (landscape = left)');
  return turns;
}

/**
 A push payload from a JSON file, inline JSON, or plain text (→ an alert with that body). A payload
 without "aps" is wrapped as custom data, so `{"orderId": 7}` works as well.
 */
export function pushPayload(arg) {
  let payload;
  if (existsSync(arg)) payload = parse(readFileSync(arg, 'utf8'), arg);
  else if (/^\s*\{/.test(arg)) payload = parse(arg, 'the payload');
  else payload = { aps: { alert: arg, sound: 'default' } };
  if (!payload.aps) payload = { aps: { 'content-available': 1 }, ...payload };
  if (Buffer.byteLength(JSON.stringify(payload)) > 4096) throw new UsageError('push payloads are limited to 4096 bytes');
  return payload;
}

function parse(text, what) {
  try {
    const v = JSON.parse(text);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  } catch {}
  throw new UsageError(`${what} is not a JSON object`);
}
