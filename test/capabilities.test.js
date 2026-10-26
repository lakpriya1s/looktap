import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { COMMANDS, KINDS, LIMITS, capabilities, capability, unsupported } from '../lib/capabilities.js';
import { UsageError } from '../lib/util.js';
import { withTable } from '../scripts/capabilities.mjs';

test('COMMANDS is every command the CLI runs on a device', () => {
  const cli = readFileSync(new URL('../bin/looktap.js', import.meta.url), 'utf8');
  const act = cli.slice(cli.indexOf('async function act('), cli.indexOf('\n}\n', cli.indexOf('async function act(')));
  const cases = [...act.matchAll(/^ {4}case '([a-z]+)'/gm)].map((m) => m[1]);
  assert.deepEqual([...COMMANDS].sort(), [...new Set(cases)].sort());
});

test('every limit names a real command, a known status and a reason', () => {
  assert.deepEqual(Object.keys(LIMITS).sort(), Object.keys(KINDS).sort());
  for (const [kind, limits] of Object.entries(LIMITS))
    for (const [name, [status, why]] of Object.entries(limits)) {
      assert.ok(COMMANDS.includes(name.split(' ')[0]), `${kind}: ${name}`);
      assert.ok(['conditional', 'unsupported'].includes(status), `${kind}: ${name}`);
      assert.ok(why, `${kind}: ${name} has no reason`);
    }
});

test('a subcommand falls back to its command; anything unlisted is supported', () => {
  assert.equal(capability('ios-device', 'location clear').status, 'conditional');
  assert.equal(capability('android-emulator', 'location').status, 'supported');
  assert.equal(capability('android-emulator', 'location clear').status, 'unsupported');
  assert.equal(capability('ios-simulator', 'tap').status, 'supported');
  assert.equal(capabilities('android-device')['location clear'].status, 'unsupported');
  // Every command, plus its one subcommand limit.
  assert.deepEqual(Object.keys(capabilities('ios-simulator')).filter((c) => !COMMANDS.includes(c)), ['perf --frames']);
  assert.equal(capabilities('ios-simulator')['perf --frames'].status, 'conditional');
  assert.equal(capabilities('ios-simulator').perf.status, 'supported');
});

test('unsupported throws a usage error naming the device and the reason', () => {
  assert.throws(() => unsupported('android-device', 'bio'), (e) => e instanceof UsageError && /^bio isn't available on an Android device — .*emulator/.test(e.message));
});

test("the README's platform table is up to date (npm run docs:capabilities)", () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.equal(readme, withTable(readme));
});
