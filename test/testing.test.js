import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { flowFiles, flowName, junit } from '../lib/testing.js';

test('flowFiles: files as given, folders searched in order, dotfiles skipped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'looktap-flows-'));
  mkdirSync(join(dir, 'checkout'));
  for (const f of ['b.txt', 'a.txt', '.hidden', 'checkout/pay.txt']) writeFileSync(join(dir, f), 'ls\n');
  assert.deepEqual(flowFiles([dir]), ['a.txt', 'b.txt', 'checkout/pay.txt'].map((f) => join(dir, f)));
  assert.deepEqual(flowFiles([join(dir, 'b.txt'), dir]).length, 3);
  assert.throws(() => flowFiles([join(dir, 'nope')]), /no such file or folder/);
});

test('flowName: a folder name from the path', () => {
  assert.equal(flowName('/w/flows/checkout/pay.txt', '/w'), 'flows-checkout-pay');
  assert.equal(flowName('./login.flow', '/w'), 'login');
  assert.equal(flowName('/elsewhere/sign in.txt', '/w'), 'elsewhere-sign-in');
});

test('junit: a testcase per flow, failures with their message, XML escaped', () => {
  const report = junit([
    { file: 'flows/login.txt', ms: 4200, lines: ['$ tap "Sign in"', 'tapped "Sign in" at 1,2'], error: null },
    { file: 'flows/pay.txt', ms: 1500, lines: [], error: new Error('step 2 (expect Total = <€5>): expect failed: "Total" is "€4"\x1b'), evidence: 'shots/failures/flows-pay' },
  ]);
  assert.match(report, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
  assert.match(report, /<testsuites name="looktap" tests="2" failures="1" errors="0" time="5.700">/);
  assert.match(report, /<testcase classname="looktap" name="flows\/login.txt" time="4.200">\n {6}<system-out>\$ tap &quot;Sign in&quot;\ntapped/);
  assert.match(report, /<failure message="step 2 \(expect Total = &lt;€5&gt;\): expect failed: &quot;Total&quot; is &quot;€4&quot;">/);
  assert.match(report, /evidence: shots\/failures\/flows-pay<\/failure>/);
  assert.ok(!report.includes('\x1b'));
});
