// One set of permission names for both platforms: `simwright permission grant camera`.
// iOS names are simctl privacy services; Android names are the runtime permissions behind them.
import { UsageError } from './util.js';

export const SERVICES = {
  camera: { android: ['CAMERA'] }, // simctl has no camera service (the simulator has no camera)
  microphone: { ios: 'microphone', android: ['RECORD_AUDIO'] },
  location: { ios: 'location', android: ['ACCESS_FINE_LOCATION', 'ACCESS_COARSE_LOCATION'] },
  'location-always': { ios: 'location-always', android: ['ACCESS_FINE_LOCATION', 'ACCESS_COARSE_LOCATION', 'ACCESS_BACKGROUND_LOCATION'] },
  photos: { ios: 'photos', android: ['READ_MEDIA_IMAGES', 'READ_MEDIA_VIDEO', 'READ_MEDIA_VISUAL_USER_SELECTED', 'READ_EXTERNAL_STORAGE'] },
  'photos-add': { ios: 'photos-add', android: ['WRITE_EXTERNAL_STORAGE'] },
  contacts: { ios: 'contacts', android: ['READ_CONTACTS', 'WRITE_CONTACTS', 'GET_ACCOUNTS'] },
  'contacts-limited': { ios: 'contacts-limited' },
  calendar: { ios: 'calendar', android: ['READ_CALENDAR', 'WRITE_CALENDAR'] },
  reminders: { ios: 'reminders' },
  notifications: { android: ['POST_NOTIFICATIONS'] }, // simctl can't set notification permission
  motion: { ios: 'motion', android: ['ACTIVITY_RECOGNITION'] },
  'media-library': { ios: 'media-library', android: ['READ_MEDIA_AUDIO'] },
  siri: { ios: 'siri' },
  all: { ios: 'all', android: 'all' },
};

export const ACTIONS = ['grant', 'revoke', 'reset'];

const names = () => Object.keys(SERVICES).join(', ');

/** The simctl privacy service for `name`, or a UsageError saying iOS can't do it. */
export function iosService(name) {
  const s = SERVICES[name];
  if (!s) throw new UsageError(`unknown permission: ${name} (one of: ${names()})`);
  if (!s.ios) throw new UsageError(`the iOS simulator can't set "${name}" (simctl privacy has no such service)`);
  return s.ios;
}

/** Android permission names for `name` (`android.permission.X`, `X`, or a shared name), or 'all'. */
export function androidPermissions(name) {
  if (/^android\.permission\./.test(name) || /^[A-Z_]+$/.test(name)) return [name.replace(/^android\.permission\./, '')];
  const s = SERVICES[name];
  if (!s) throw new UsageError(`unknown permission: ${name} (one of: ${names()}, or android.permission.*)`);
  if (!s.android) throw new UsageError(`Android has no "${name}" permission`);
  return s.android;
}
