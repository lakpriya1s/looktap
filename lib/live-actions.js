// The buttons under each device in `looktap live`: the same looktap commands an agent would run (rotate, appearance,
// textsize, touches, open), with what the device answered as the note under it. Used by the server for simulators
// and Android, and by a real iPhone's worker (lib/live-iphone.js), which owns that phone's runner.
import { capability } from './capabilities.js';
import { ORIENTATIONS, TEXT_SIZES, rotation, textSize } from './conditions.js';

/** The page's actions, each with the looktap command it is (for what the device can do, and for the activity log). */
export const ACTIONS = { rotate: 'rotate', appearance: 'appearance', textsize: 'textsize', touches: 'touches', open: 'open' };

/** A device from the list → the looktap kind its abilities are listed under (lib/capabilities.js). */
export function kindOf(d) {
  if (d.platform === 'ios') return d.kind === 'simulator' ? (d.form === 'watch' || /Watch/.test(d.name) ? 'watchos-simulator' : 'ios-simulator') : 'ios-device';
  return /wear/i.test(d.name || '') ? 'wearos' : d.kind === 'emulator' ? 'android-emulator' : 'android-device';
}

/** The actions this device can take ("conditional" ones too: the note says what happened). */
export const actionsFor = (d) =>
  // A real iPhone's touches are only for an app built with LooktapTouches.m: not a switch worth a button.
  Object.keys(ACTIONS).filter((a) => capability(kindOf(d), ACTIONS[a]).status !== 'unsupported' && !(a === 'touches' && kindOf(d) === 'ios-device'));

/** Is this an action message's value? Anything else is dropped before it reaches a device. */
export function actionValue(name, value) {
  const v = String(value ?? '');
  if (name === 'rotate') return ['portrait', 'landscape', 'left', 'right', 'upsidedown'].includes(v) ? v : null;
  if (name === 'appearance') return ['dark', 'light'].includes(v) ? v : null;
  if (name === 'textsize') return v in TEXT_SIZES ? v : null;
  if (name === 'touches') return ['on', 'off'].includes(v) ? v : null;
  if (name === 'open') return v.length <= 2000 && /^[a-z][\w+.-]*:\S+$/i.test(v) ? v : null;
  return null;
}

/** Do it on driver `d`: resolves to a line for the page. */
export async function runAction(d, name, value) {
  if (name === 'rotate') {
    const r = await d.rotate(rotation(value));
    return `${ORIENTATIONS[r.turns]} (${r.w}×${r.h})`;
  }
  if (name === 'appearance') return `appearance: ${await d.appearance(value)}`;
  if (name === 'textsize') return `text size: ${await d.textSize(textSize(value))}`;
  if (name === 'touches') {
    const r = await d.showTouches(value);
    return `touches ${r.on ? 'on' : 'off'}${r.notes?.length ? `: ${r.notes[0]}` : ''}`;
  }
  if (name === 'open') {
    await d.open(value);
    return `opened ${value.length > 60 ? `${value.slice(0, 59)}…` : value}`;
  }
  throw new Error(`unknown action: ${name}`);
}
