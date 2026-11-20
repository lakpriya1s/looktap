#!/usr/bin/env node
// A smoke run on one real device: doctor, install, reverse, launch, shot, logs --since 1m, stop, each timed.
//   node scripts/smoke-device.mjs -d <serial|udid> --app <id> [--install <apk|app>] [--out <dir>]
// It takes the device the way any looktap command does (a lease), so run it when no other session is driving it
// (`looktap who <device>`). It installs only when --install names a build of the app under test. Exits 1 if a step failed.
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};
const device = arg('-d');
const app = arg('--app');
const build = arg('--install');
const out = arg('--out') || 'shots/smoke';
if (!device || !app) {
  console.error('usage: node scripts/smoke-device.mjs -d <serial|udid> --app <id> [--install <apk|app>] [--out <dir>]');
  process.exit(2);
}
const cli = new URL('../bin/looktap.js', import.meta.url).pathname;
const android = !/^[0-9A-F]{8}-[0-9A-F]{16}$|^[0-9a-f]{40}$|^[0-9A-F-]{36}$/i.test(device);

const steps = [
  ['doctor', ['doctor', '-d', device, '--app', app]],
  ...(build ? [['install', ['install', build]]] : []),
  ...(android ? [['reverse', ['reverse', '8081']], ['reverse --list', ['reverse', '--list']]] : []),
  ['launch', ['launch', app]],
  ['ps', ['ps', app]],
  ['shot', ['shot', 'smoke', '-o', out]],
  ['logs --since 1m', ['logs', app, '--since', '1m', '--lines', '5']],
  ['stop', ['stop', app]],
];

let failed = 0;
const rows = [];
for (const [name, words] of steps) {
  const t = Date.now();
  const where = words[0] === 'doctor' ? [] : ['-d', device];
  const r = spawnSync(process.execPath, [cli, ...where, ...words], { encoding: 'utf8', timeout: 180e3 });
  const ms = Date.now() - t;
  const ok = r.status === 0;
  if (!ok) failed++;
  const last = `${r.stdout}${r.stderr}`.trim().split('\n').filter(Boolean).pop() || '';
  rows.push(`${ok ? '✓' : '✗'} ${name.padEnd(16)} ${(ms / 1000).toFixed(1).padStart(6)} s  ${last.slice(0, 100)}`);
  console.log(rows.at(-1));
  if (!ok && name === 'doctor') console.log(`${r.stdout}${r.stderr}`);
}
console.log(`\n${steps.length - failed}/${steps.length} steps passed on ${device}`);
process.exit(failed ? 1 : 0);
