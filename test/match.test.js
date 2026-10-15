import assert from 'node:assert/strict';
import { test } from 'node:test';

import { UsageError, pickMatch } from '../lib/util.js';

const nodes = (...labels) => labels.map((label, i) => ({ label, i }));

test('exact label wins, even when fuzzy matches exist', () => {
  assert.equal(pickMatch(nodes('Messages, 2 unread', 'Messages'), 'Messages').i, 1);
});

test('a unique prefix match is used', () => {
  assert.equal(pickMatch(nodes('Dashboard', 'Messages, 2 unread'), 'Messages').label, 'Messages, 2 unread');
});

test('a unique contains match is used', () => {
  assert.equal(pickMatch(nodes('Dashboard', 'Network & internet'), 'internet').label, 'Network & internet');
});

test('the same label on several nodes (text + its row) is not ambiguous', () => {
  assert.equal(pickMatch(nodes('Network & internet', 'Network & internet', 'Apps'), 'Network').i, 0);
});

test('a fuzzy match naming two different labels is an error, not a guess', () => {
  assert.throws(() => pickMatch(nodes('Wi-Fi', 'Wi-Fi hotspot'), 'Wi'), (e) => e instanceof UsageError && /ambiguous.*2 labels/.test(e.message));
});

test('--exact disables fuzzy matching', () => {
  assert.throws(() => pickMatch(nodes('Messages, 2 unread'), 'Messages', { exact: true }), /not found: Messages \(exact match\)/);
});

test('nothing matching is "not found"', () => {
  assert.throws(() => pickMatch(nodes('Dashboard'), 'Settings'), /not found: Settings/);
});

import { NotFound, waitFor } from '../lib/util.js';

test('waitFor retries "not found" until the target appears', async () => {
  let n = 0;
  const r = await waitFor(async () => {
    if (++n < 3) throw new NotFound('not found: x');
    return 'ok';
  }, 3000);
  assert.equal(r, 'ok');
  assert.equal(n, 3);
});

test('waitFor gives up after its deadline', async () => {
  await assert.rejects(waitFor(async () => { throw new NotFound('not found: x'); }, 500), NotFound);
});

test('waitFor never retries an ambiguous match or other errors', async () => {
  let n = 0;
  await assert.rejects(waitFor(async () => { n++; throw new UsageError('ambiguous'); }, 3000), /ambiguous/);
  assert.equal(n, 1);
});

test('splitScript splits steps on ; and newlines, honouring quotes and comments', async () => {
  const { splitScript } = await import('../lib/util.js');
  assert.deepEqual(splitScript(`tap General; fill "Search" 'wi fi;x'\n# note\nwait "A \\"b\\"" --gone`), [
    ['tap', 'General'],
    ['fill', 'Search', 'wi fi;x'],
    ['wait', 'A "b"', '--gone'],
  ]);
  assert.deepEqual(splitScript('fill Name ""'), [['fill', 'Name', '']]);
  assert.throws(() => splitScript('tap "oops'));
});
