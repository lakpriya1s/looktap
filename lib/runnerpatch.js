// Making the XCUITest runner start on iOS 16 and older. Xcode builds the test bundle for the deployment target, but
// the host app around it (Xcode's XCTRunner template, renamed) asks for iOS 17: in its Info.plist, in its Mach-O
// build version, and by strongly importing XCTest classes that only iOS 17's XCTest has. On iOS 16 XCTest comes
// from the developer image, not the app, so a missing class stops the runner at launch. The fix: lower both
// minimums, mark the host's XCTest imports weak (dyld then binds a missing one to nil), and sign the app again.
// The template has no icon either, and is named after the test target: every runner gets looktap's icon
// (native/ios-device/LooktapRunner/Icon) and name here.
import { closeSync, copyFileSync, existsSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { run } from './util.js';

const MH_MAGIC_64 = 0xfeedfacf, FAT_MAGIC = 0xcafebabe;
const LC_BUILD_VERSION = 0x32, LC_DYLD_CHAINED_FIXUPS = 0x80000034;
const LOAD_DYLIB = new Set([0xc, 0x80000018, 0x8000001f, 0x20, 0x80000023]);
const ICON_DIR = fileURLToPath(new URL('../native/ios-device/LooktapRunner/Icon/', import.meta.url));
/** Info.plist's icon keys for the PNGs in ICON_DIR (iOS finds the @2x/@3x and ~ipad files from these base names). */
const DISPLAY_NAME = 'looktap runner';
const ICONS = {
  CFBundleIcons: { CFBundlePrimaryIcon: { CFBundleIconFiles: ['AppIcon60x60'] } },
  'CFBundleIcons~ipad': { CFBundlePrimaryIcon: { CFBundleIconFiles: ['AppIcon60x60', 'AppIcon76x76', 'AppIcon83.5x83.5'] } },
};

/** "16.0" → the X.Y.Z nibbles a Mach-O version is stored as. */
const packVersion = (v) => {
  const [a = 0, b = 0, c = 0] = String(v).split('.').map(Number);
  return ((a << 16) | (b << 8) | c) >>> 0;
};

/** The offsets of the arm64 (or only) Mach-O slices in a file, thin or universal. */
function slices(buf) {
  if (buf.readUInt32BE(0) === FAT_MAGIC) {
    const n = buf.readUInt32BE(4);
    return Array.from({ length: n }, (_, i) => buf.readUInt32BE(8 + i * 20 + 8));
  }
  return [0];
}

/**
 Patch one Mach-O in place (a Buffer): LC_BUILD_VERSION's minimum OS → `minos`, and the weak bit on every chained-
 fixup import from a library whose path matches `weakFrom`. Returns { minos: changed, weakened: [symbol names] }.
 */
export function patchMachO(buf, { minos, weakFrom = /\/XCTest\.framework\// } = {}) {
  const weakened = [];
  let changed = false;
  for (const base of slices(buf)) {
    if (buf.readUInt32LE(base) !== MH_MAGIC_64) throw new Error('not a 64-bit Mach-O');
    const ncmds = buf.readUInt32LE(base + 16);
    let at = base + 32, ordinal = 0;
    const libs = new Map(); // ordinal → path
    let fixups = null;
    for (let i = 0; i < ncmds; i++) {
      const cmd = buf.readUInt32LE(at), size = buf.readUInt32LE(at + 4);
      if (cmd === LC_BUILD_VERSION && minos) {
        const want = packVersion(minos);
        if (buf.readUInt32LE(at + 12) > want) buf.writeUInt32LE(want, at + 12), (changed = true);
      } else if (LOAD_DYLIB.has(cmd)) {
        const nameAt = at + buf.readUInt32LE(at + 8);
        libs.set(++ordinal, buf.subarray(nameAt, at + size).toString('latin1').replace(/\0.*$/s, ''));
      } else if (cmd === LC_DYLD_CHAINED_FIXUPS) fixups = base + buf.readUInt32LE(at + 8);
      at += size;
    }
    if (fixups == null) continue;
    const importsAt = fixups + buf.readUInt32LE(fixups + 8), symbolsAt = fixups + buf.readUInt32LE(fixups + 12);
    const count = buf.readUInt32LE(fixups + 16), format = buf.readUInt32LE(fixups + 20);
    const name = (off) => buf.subarray(symbolsAt + off, buf.indexOf(0, symbolsAt + off)).toString('latin1');
    for (let i = 0; i < count; i++) {
      if (format === 1 || format === 2) {
        // DYLD_CHAINED_IMPORT(_ADDEND): lib_ordinal:8 | weak_import:1 | name_offset:23
        const p = importsAt + i * (format === 1 ? 4 : 8);
        const v = buf.readUInt32LE(p);
        const lib = libs.get(v & 0xff);
        if (lib && weakFrom.test(lib) && !(v & 0x100)) buf.writeUInt32LE((v | 0x100) >>> 0, p), weakened.push(name(v >>> 9));
      } else if (format === 3) {
        // DYLD_CHAINED_IMPORT_ADDEND64: lib_ordinal:16 | weak_import:1 | reserved:15 | name_offset:32, then addend
        const p = importsAt + i * 16;
        const v = buf.readUInt32LE(p);
        const lib = libs.get(v & 0xffff);
        if (lib && weakFrom.test(lib) && !(v & 0x10000)) buf.writeUInt32LE((v | 0x10000) >>> 0, p), weakened.push(name(buf.readUInt32LE(p + 4)));
      }
    }
  }
  return { minos: changed, weakened };
}

/** The SHA-1 of the certificate an app is signed with: codesign's unambiguous name for that identity. */
function signingIdentity(app) {
  const dir = mkdtempSync(join(tmpdir(), 'looktap-cert-'));
  try {
    run('codesign', ['-d', `--extract-certificates=${join(dir, 'c')}`, app], { allowFail: true });
    return createHash('sha1').update(readFileSync(join(dir, 'c0'))).digest('hex').toUpperCase();
  } catch {
    throw new Error(`could not read the signing certificate of ${app}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 Finish a built runner app: give it looktap's icon and home-screen name and, with `osVersion` (e.g. "16.7", for a phone driven through
 lockdown), make it start on that iOS: lower its minimums and weaken its XCTest imports. Then sign it again with the
 identity and entitlements it had. Does nothing to an app that already has all that.
 */
export function patchRunnerHost(app, osVersion = null) {
  const plist = join(app, 'Info.plist');
  const exe = join(app, run('plutil', ['-extract', 'CFBundleExecutable', 'raw', plist]).trim());
  const bin = readFileSync(exe);
  const major = osVersion && `${parseInt(osVersion, 10)}.0`;
  const result = major ? patchMachO(bin, { minos: major }) : { minos: false, weakened: [] };
  const current = major && run('plutil', ['-extract', 'MinimumOSVersion', 'raw', plist], { allowFail: true }).trim();
  const plistChange = current && current.localeCompare(major, undefined, { numeric: true }) > 0;
  const icons = readdirSync(ICON_DIR).filter((f) => f.endsWith('.png'));
  const iconChange = icons.some((f) => !existsSync(join(app, f)));
  const nameChange = run('plutil', ['-extract', 'CFBundleDisplayName', 'raw', plist], { allowFail: true }).trim() !== DISPLAY_NAME;
  if (!result.minos && !result.weakened.length && !plistChange && !iconChange && !nameChange) return result;
  const identity = signingIdentity(app);
  const ent = join(mkdtempSync(join(tmpdir(), 'looktap-ent-')), 'ent.plist');
  run('codesign', ['-d', '--entitlements', `:${ent}`, app], { allowFail: true });
  if (result.minos || result.weakened.length) writeFileSync(exe, bin);
  if (plistChange) run('plutil', ['-replace', 'MinimumOSVersion', '-string', major, plist]);
  if (iconChange) {
    for (const f of icons) copyFileSync(join(ICON_DIR, f), join(app, f));
    for (const [key, value] of Object.entries(ICONS)) run('plutil', ['-replace', key, '-json', JSON.stringify(value), plist]);
  }
  if (nameChange) run('plutil', ['-replace', 'CFBundleDisplayName', '-string', DISPLAY_NAME, plist]);
  run('codesign', ['-f', '-s', identity, ...(readable(ent) ? ['--entitlements', ent] : []), '--generate-entitlement-der', app]);
  rmSync(join(ent, '..'), { recursive: true, force: true });
  return result;
}

function readable(f) {
  try {
    const fd = openSync(f, 'r');
    const n = readSync(fd, Buffer.alloc(1));
    closeSync(fd);
    return n > 0;
  } catch {
    return false;
  }
}
