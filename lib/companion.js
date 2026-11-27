// `looktap runner install|remove`: looktap runner for Android (native/android-app), the same name and screen as the
// runner app a real iPhone gets. A screen that
// shows what looktap is doing there (the computer connected, the last commands) and a switch to pause it. It talks
// only to looktap's helper on the same phone (native/android, Companion.java), which answers no other app.
//
// Opt-in: looktap installs nothing on an Android device otherwise (its helper runs through adb). A real iPhone has
// this already, and simulators and emulators are on the computer in front of you.
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ADB, HOME, UsageError, run } from './util.js';

export const COMPANION = 'com.looktap.app';
/** Its versionCode (native/android-app/AndroidManifest.xml): GitHub Actions publishes it as release app-v<this>. */
export const COMPANION_VERSION = 1;
const URL_ = `https://github.com/lakpriya1s/looktap/releases/download/app-v${COMPANION_VERSION}/looktap-app.apk`;
/** A build in this checkout (native/android-app/build.sh), used before downloading one. */
const LOCAL = new URL('../native/android-app/build/looktap-app.apk', import.meta.url).pathname;

/**
 The app's APK: LOOKTAP_COMPANION_APK, else a build in this checkout, else the copy downloaded before, else
 downloaded now from the GitHub release Actions built and signed. Not in the npm package: only who asks gets it.
 */
async function companionApk(say) {
  if (process.env.LOOKTAP_COMPANION_APK) return process.env.LOOKTAP_COMPANION_APK;
  if (existsSync(LOCAL)) return LOCAL;
  const path = join(HOME, `looktap-app-${COMPANION_VERSION}.apk`);
  if (existsSync(path)) return path;
  say(`downloading looktap runner for Android (${URL_})`);
  let bytes;
  try {
    const r = await fetch(URL_, { signal: AbortSignal.timeout(60000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    bytes = Buffer.from(await r.arrayBuffer());
  } catch (e) {
    throw new UsageError(`couldn't download looktap runner for Android (${e.message}) from ${URL_} — check the network, or build it (native/android-app/build.sh) and set LOOKTAP_COMPANION_APK to it`);
  }
  if (bytes.subarray(0, 2).toString() !== 'PK') throw new UsageError(`what ${URL_} sent isn't an APK`);
  mkdirSync(HOME, { recursive: true });
  writeFileSync(`${path}.part`, bytes);
  renameSync(`${path}.part`, path);
  return path;
}

const shell = (id, cmd) => run(ADB, ['-s', id, 'shell', cmd], { allowFail: true, timeout: 15000 }).trim();

/** Is the companion app on this phone? */
export const hasCompanion = (id) => shell(id, `pm list packages ${COMPANION}`).split(/\r?\n/).includes(`package:${COMPANION}`);

/** Install it (replacing one signed by another build), and say so. Android 10 or later. */
export async function installCompanion(id, { say = () => {} } = {}) {
  const sdk = Number(shell(id, 'getprop ro.build.version.sdk')) || 0;
  if (sdk && sdk < 29) throw new UsageError(`${id} runs Android ${shell(id, 'getprop ro.build.version.release')}: looktap runner needs Android 10 or later`);
  const apk = await companionApk(say);
  const install = () => {
    let err = '';
    const out = run(ADB, ['-s', id, 'install', '-r', apk], { allowFail: true, timeout: 60000, onStderr: (e) => (err += e) });
    return `${out}\n${err}`;
  };
  let out = install();
  if (/INSTALL_FAILED_UPDATE_INCOMPATIBLE/.test(out)) run(ADB, ['-s', id, 'uninstall', COMPANION], { allowFail: true, timeout: 30000 }), (out = install());
  if (!/Success/.test(out)) throw new UsageError(`couldn't install looktap runner (adb: ${out.trim().split('\n').pop()})`);
  return apk;
}

/** Take it off the phone. True if it was there. The helper's pause, if it was paused, ends with it. */
export function removeCompanion(id) {
  const had = hasCompanion(id);
  if (had) run(ADB, ['-s', id, 'uninstall', COMPANION], { allowFail: true, timeout: 30000 });
  shell(id, 'rm -f /data/local/tmp/looktap-paused');
  return had;
}
