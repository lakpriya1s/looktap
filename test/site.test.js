import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { formatRow as cliRow } from '../lib/screen.js';
import { cliCommands, cliFlags, readmeCommands, sections } from '../site/build.mjs';
import { inline, render, slug } from '../site/md.js';
import { formatRow as siteRow } from '../site/src/rows.js';
import { SCENES } from '../site/src/scenes.js';

test('the demo terminal prints ls rows exactly as simwright does', () => {
  for (const e of [
    { label: 'Sign in', type: 'Button', x: 24, y: 432, w: 342, h: 52 },
    { label: 'Email', value: 'Your email address', type: 'TextField', x: 24, y: 236, w: 342, h: 48 },
    { label: '', type: 'AVeryLongTypeNameIndeed', x: 0, y: 0, w: 1, h: 1 },
  ])
    assert.equal(siteRow(e, 12), cliRow(e, 12));
});

test('slug: GitHub heading ids, emoji and punctuation dropped', () => {
  assert.equal(slug('🤖 Kickstart with your AI agent'), '-kickstart-with-your-ai-agent');
  assert.equal(slug('Options, environment variables, config file'), 'options-environment-variables-config-file');
  assert.equal(slug('Catch a spinner, toast, or transition (`burst`)'), 'catch-a-spinner-toast-or-transition-burst');
});

test('render: tables with escaped pipes, code, headings, HTML blocks', () => {
  const { html, headings } = render('## Commands\n\n| Command | What |\n|---|---|\n| `bio match\\|nomatch` | Face ID |\n\n<details>\n<summary>More</summary>\n\nHidden *text*.\n</details>');
  assert.match(html, /<code>bio match\|nomatch<\/code>/);
  assert.match(html, /<details>[\s\S]*<em>text<\/em>[\s\S]*<\/details>/);
  assert.deepEqual(headings, [{ level: 2, text: 'Commands', id: 'commands' }]);
  assert.equal(render('```bash\na < b\n```').html, '<pre><code class="language-bash">a &lt; b</code></pre>');
});

test('render: nested lists and links through the rewriter', () => {
  const { html } = render('- one\n  - two [x](#y)\n- three', { link: (h) => `page.html${h}` });
  assert.match(html, /<ul>\n<li>one\n?<ul>/);
  assert.match(html, /<a href="page.html#y">x<\/a>/);
  assert.equal(inline('a & b <br> `<c>`'), 'a &amp; b <br> <code>&lt;c&gt;</code>');
});

test('the inventory covers every command, and every scene names real ones', () => {
  const cli = readFileSync(new URL('../bin/simwright.js', import.meta.url), 'utf8');
  const commands = cliCommands(cli);
  assert.ok(commands.includes('tap') && commands.includes('mcp') && commands.includes('rotate'));
  assert.ok(!commands.includes('help'));
  const covered = new Set(SCENES.flatMap((s) => s.covers));
  assert.deepEqual(commands.filter((c) => !covered.has(c)), []);
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const rows = readmeCommands(readme);
  assert.deepEqual(commands.filter((c) => !rows.has(c)), []);
  assert.ok(sections(readme).some((s) => s.title === 'Commands'));
});

test('the agent skill lists every command and flag', () => {
  const cli = readFileSync(new URL('../bin/simwright.js', import.meta.url), 'utf8');
  const skill = readFileSync(new URL('../skills/simwright/SKILL.md', import.meta.url), 'utf8');
  const commands = sections(skill).find((s) => s.title === 'Commands');
  assert.ok(commands);
  const used = new Set([...commands.md.matchAll(/^simwright ([a-z]+)/gm)].map((m) => m[1]));
  assert.deepEqual(cliCommands(cli).filter((c) => !used.has(c)), []);
  assert.deepEqual(cliFlags(cli).filter((f) => !new RegExp(`(^|[\\s\`\\[,])${f}\\b`).test(skill)), []);
});
