// Movement for `looktap route`, and keeping coordinates out of what looktap prints. Pure functions: the drivers feed
// the fixes, this file works out where they are and when. Coordinates are [lat, lon] in degrees, distances metres.
import { UsageError } from './util.js';

const R = 6371008.8; // mean Earth radius, m
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

/** Great-circle distance between two points, in metres. */
export function haversine([lat1, lon1], [lat2, lon2]) {
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** The initial bearing from one point to another, degrees clockwise from north (0–360). */
export function bearing([lat1, lon1], [lat2, lon2]) {
  const y = Math.sin(rad(lon2 - lon1)) * Math.cos(rad(lat2));
  const x = Math.cos(rad(lat1)) * Math.sin(rad(lat2)) - Math.sin(rad(lat1)) * Math.cos(rad(lat2)) * Math.cos(rad(lon2 - lon1));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

/** The point `dist` metres from `from` along `brg` degrees. */
export function destination([lat, lon], brg, dist) {
  const d = dist / R, b = rad(brg), p1 = rad(lat), l1 = rad(lon);
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [deg(p2), ((deg(l2) + 540) % 360) - 180];
}

/** `630m`, `1.2km`, `630` (metres), `0.5mi` → metres. */
export function distance(v) {
  const m = /^(\d+(?:\.\d+)?)\s*(m|km|mi|ft)?$/i.exec(String(v ?? '').trim());
  if (!m) throw new UsageError(`a distance is metres or km, e.g. 630m or 1.2km, not ${JSON.stringify(String(v))}`);
  return Number(m[1]) * { m: 1, km: 1000, mi: 1609.344, ft: 0.3048 }[(m[2] || 'm').toLowerCase()];
}

/** `lat,lon` (or `lat lon`) → [lat, lon]. The text isn't repeated in the error: it is a location. */
export function point(text, what = '--from') {
  const [lat, lon, extra] = String(text ?? '').split(/[\s,]+/).filter(Boolean).map(Number);
  if (extra != null || !(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) throw new UsageError(`${what} takes <lat>,<lon> in degrees (e.g. 51.5072,-0.1276)`);
  return [lat, lon];
}

/** GPX track/route/way points → [{ at: [lat, lon], t: ms | null }], in order. */
export function parseGpx(xml) {
  const pts = [];
  for (const m of xml.matchAll(/<(trkpt|rtept|wpt)\b([^>]*?)(\/>|>([\s\S]*?)<\/\1>)/g)) {
    const attr = (n) => Number(new RegExp(`\\b${n}\\s*=\\s*["']([^"']+)["']`).exec(m[2])?.[1]);
    const lat = attr('lat'), lon = attr('lon');
    if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) continue;
    const time = /<time>([^<]+)<\/time>/.exec(m[4] || '')?.[1];
    const t = time ? Date.parse(time) : NaN;
    pts.push({ at: [lat, lon], t: Number.isNaN(t) ? null : t, kind: m[1] });
  }
  // A file with a track uses only the track: waypoints are usually places marked along it, not stops in order.
  const track = pts.filter((p) => p.kind !== 'wpt');
  return (track.length >= 2 ? track : pts).map(({ at, t }) => ({ at, t }));
}

/**
 The fixes of a straight walk: from `from`, `dist` metres along `brg`, at `speed` m/s, one fix every `step` ms (the
 last one exactly at the end), then the end point repeated every `step` for `still` ms. Each fix:
 { at: [lat, lon], ms (since the start), m (metres covered), speed, bearing }.
 */
export function straightPlan({ from, brg = 0, dist, speed = 1.4, step = 1000, still = 0 }) {
  if (!(dist > 0)) throw new UsageError('route needs --distance (e.g. --distance 630m)');
  if (!(speed > 0)) throw new UsageError('--speed takes metres a second above 0 (1.4 is a walk)');
  if (!(step >= 100)) throw new UsageError('--step takes 100ms or more (e.g. --step 5s)');
  const total = Math.round((dist / speed) * 1000);
  const fixes = [];
  for (let ms = 0; ; ms = Math.min(ms + step, total)) {
    const m = (ms / total) * dist;
    fixes.push({ at: destination(from, brg, m), ms: Math.round(ms), m, speed, bearing: brg });
    if (ms >= total) break;
  }
  return withStill(fixes, step, still);
}

/**
 The fixes along a GPX track. With times in the file: the track's own pace, sped up by `scale`; without: `speed` m/s.
 Fixes every `step` ms, interpolated between the file's points.
 */
export function gpxPlan(points, { speed = 1.4, scale = 1, step = 1000, still = 0 } = {}) {
  if (points.length < 2) throw new UsageError('the GPX file needs at least two track points (<trkpt lat=… lon=…>)');
  if (!(scale > 0)) throw new UsageError('--speed-scale takes a factor above 0 (2 = twice as fast)');
  if (!(step >= 100)) throw new UsageError('--step takes 100ms or more (e.g. --step 5s)');
  // Each point's time from the start (ms) and distance along (m).
  const timed = points.every((p) => p.t != null) && points.at(-1).t > points[0].t;
  let m = 0;
  const legs = points.map((p, i) => {
    if (i) m += haversine(points[i - 1].at, p.at);
    return { at: p.at, m };
  });
  for (let i = 0; i < legs.length; i++) legs[i].ms = timed ? (points[i].t - points[0].t) / scale : (legs[i].m / (speed * scale)) * 1000;
  const total = legs.at(-1).ms;
  const fixes = [];
  let j = 0;
  for (let ms = 0; ; ms = Math.min(ms + step, total)) {
    while (j < legs.length - 2 && legs[j + 1].ms < ms) j++;
    const a = legs[j], b = legs[j + 1];
    const f = b.ms > a.ms ? (ms - a.ms) / (b.ms - a.ms) : 1;
    const leg = haversine(a.at, b.at);
    const brg = leg > 0 ? bearing(a.at, b.at) : fixes.at(-1)?.bearing ?? 0;
    const at = leg > 0 ? destination(a.at, brg, leg * Math.min(1, Math.max(0, f))) : b.at;
    fixes.push({ at, ms: Math.round(ms), m: a.m + leg * Math.min(1, Math.max(0, f)), speed: b.ms > a.ms ? (leg / (b.ms - a.ms)) * 1000 : 0, bearing: brg });
    if (ms >= total) break;
  }
  return withStill(fixes, step, still);
}

/** The last fix held where it is, a fix every `step` ms for `still` ms after the movement ends. */
function withStill(fixes, step, still) {
  const end = fixes.at(-1);
  for (let ms = step; ms <= still; ms += step) fixes.push({ ...end, ms: end.ms + ms, speed: 0, still: true });
  return fixes;
}

/** A plan's length and duration, as `route` prints them: never where it goes. */
export const planSummary = (fixes) => {
  const moving = fixes.filter((f) => !f.still);
  return { m: moving.at(-1).m, ms: moving.at(-1).ms, stillMs: fixes.at(-1).ms - moving.at(-1).ms, fixes: fixes.length };
};

export const metres = (m) => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`);
export const clockTime = (ms) => {
  const s = Math.round(ms / 1000);
  return s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

// ── keeping coordinates out of output ──────────────────────────────────────

/**
 A decimal number with at least three places that isn't part of a time (12:04:05.123), a version (16.7.12) or a
 longer number: what a latitude or longitude looks like when a command or a log line carries one.
 */
const COORD = /(?<![\w.:])-?\d{1,3}\.\d{3,}(?![\d.:])/g;

/** `text` with every coordinate-like number replaced: for error messages that may quote a command's arguments. */
export const scrubCoords = (text) => String(text).replace(COORD, '‹redacted›');

/** Words of a key: camelCase, snake_case, kebab and dots split, lower-cased. */
const keyWords = (key) => String(key).replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

const COORD_WORDS = new Set(['lat', 'lng', 'lon', 'latitude', 'longitude', 'coord', 'coords', 'coordinate', 'coordinates', 'geohash', 'geopoint', 'latlng', 'latlon']);

/** A preference key that holds a coordinate by its name: homeLat, last_lng, geo.coords … */
export const coordKey = (key) => keyWords(key).some((w) => COORD_WORDS.has(w));

/**
 A preference value with coordinates taken out: keys named like a coordinate (or matching one of `extra`, a key or a
 word of it) are redacted whole, nested values (objects, and JSON held in strings) are walked, and a "lat,lon" pair
 anywhere in a string is replaced. `hit(key)` is told each redaction.
 */
export function redact(key, value, { extra = [], hit = () => {} } = {}) {
  const named = (k) => coordKey(k) || extra.some((x) => String(k).toLowerCase() === x || keyWords(k).includes(x));
  if (key != null && named(key)) {
    hit(key);
    return '‹redacted›';
  }
  if (Array.isArray(value)) return value.map((v) => redact(null, v, { extra, hit }));
  if (value && typeof value === 'object' && !(value instanceof Date) && !Buffer.isBuffer(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(k, v, { extra, hit })]));
  }
  if (typeof value === 'string') {
    const s = value.trim();
    if (/^[[{]/.test(s)) {
      try {
        let found = false;
        const inner = redact(null, JSON.parse(s), { extra, hit: (k) => ((found = true), hit(key == null ? k : `${key}.${k}`)) });
        if (found) return JSON.stringify(inner);
      } catch {}
    }
    const pair = /-?\d{1,3}\.\d{3,}\s*,\s*-?\d{1,3}\.\d{3,}/g;
    if (pair.test(value)) {
      hit(key ?? 'value');
      return value.replace(pair, '‹redacted›');
    }
  }
  return value;
}
