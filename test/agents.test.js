import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { AGENTS, claudePlugin, detectAgents, installSkill, installedVersion, pickAgents, skillFor, skillsDir, uninstallSkill } from '../lib/agents.js';

const SOURCE = readFileSync(new URL('../skills/looktap/SKILL.md', import.meta.url), 'utf8');
const agent = (id) => AGENTS.find((a) => a.id === id);
const frontmatter = (text) => /^---\n([\s\S]*?)\n---\n/.exec(text)[1];
const keys = (text) => frontmatter(text).split('\n').filter((l) => /^[\w-]+:/.test(l)).map((l) => l.split(':')[0]);

test('every agent gets name, description and the version; only Claude-style agents get allowed-tools', () => {
  assert.deepEqual(keys(skillFor(agent('claude'), SOURCE, '1.2.3')), ['name', 'description', 'allowed-tools', 'metadata']);
  for (const id of ['codex', 'gemini', 'cursor', 'copilot']) assert.deepEqual(keys(skillFor(agent(id), SOURCE, '1.2.3')), ['name', 'description', 'metadata'], id);
  const codex = skillFor(agent('codex'), SOURCE, '1.2.3');
  assert.match(codex, /^metadata:\n {2}version: "1\.2\.3"$/m);
  // the body is the guide itself, unchanged
  assert.equal(codex.slice(codex.indexOf('\n---\n') + 5), SOURCE.slice(SOURCE.indexOf('\n---\n') + 5));
});

test('agents are found by their config folder or their command on PATH', () => {
  const home = mkdtempSync(join(tmpdir(), 'looktap-home-'));
  const bin = mkdtempSync(join(tmpdir(), 'looktap-bin-'));
  try {
    mkdirSync(join(home, '.codex'));
    mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
    writeFileSync(join(bin, 'gemini'), '');
    assert.deepEqual(detectAgents({ home, env: { PATH: bin } }).map((a) => a.id), ['codex', 'gemini', 'opencode']);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
});

test('--agents takes ids and aliases, all, and names the known ones for a typo', () => {
  assert.deepEqual(pickAgents('claude-code, github,codex').map((a) => a.id), ['claude', 'copilot', 'codex']);
  assert.equal(pickAgents('all').length, AGENTS.length);
  assert.throws(() => pickAgents('claud'), /unknown agent "claud" — one of: claude, codex/);
});

test('install writes each agent its own copy (user-wide or in the repo), uninstall removes only looktap\'s', () => {
  const home = mkdtempSync(join(tmpdir(), 'looktap-home-'));
  try {
    const env = { XDG_CONFIG_HOME: join(home, 'xdg') };
    const written = installSkill(pickAgents('claude,codex,opencode,copilot'), { source: SOURCE, version: '1.2.3', home, env });
    assert.deepEqual(written.map((w) => w.file.slice(home.length)), [
      '/.claude/skills/looktap/SKILL.md', '/.agents/skills/looktap/SKILL.md', '/xdg/opencode/skills/looktap/SKILL.md', '/.copilot/skills/looktap/SKILL.md',
    ]);
    assert.equal(installedVersion(written[1].file), '1.2.3');
    const repo = join(home, 'repo');
    const local = installSkill(pickAgents('copilot'), { source: SOURCE, version: '1.2.3', home, root: repo });
    assert.equal(local[0].file, join(repo, '.github', 'skills', 'looktap', 'SKILL.md'));
    // someone else's skill folder named looktap is left alone
    const other = join(skillsDir(agent('cursor'), { home }), 'looktap');
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, 'SKILL.md'), '---\nname: something-else\n---\n');
    const removed = uninstallSkill(AGENTS, { home, env });
    assert.deepEqual(removed.map((r) => r.agent.id), ['claude', 'codex', 'copilot', 'opencode']);
    assert.equal(installedVersion(written[0].file), null);
    assert.equal(readFileSync(join(other, 'SKILL.md'), 'utf8'), '---\nname: something-else\n---\n');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a copy written before copies were versioned reads as unversioned (doctor calls it outdated)', () => {
  const home = mkdtempSync(join(tmpdir(), 'looktap-home-'));
  try {
    const f = join(home, 'SKILL.md');
    writeFileSync(f, SOURCE);
    assert.equal(installedVersion(f), 'unversioned');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('Claude Code follows CLAUDE_CONFIG_DIR, and a looktap plugin for every project counts as having the skill', () => {
  const home = mkdtempSync(join(tmpdir(), 'looktap-home-'));
  try {
    const env = { CLAUDE_CONFIG_DIR: join(home, '.claude-work') };
    assert.equal(skillsDir(agent('claude'), { home, env }), join(home, '.claude-work', 'skills'));
    assert.equal(skillsDir(agent('claude'), { home, env: {} }), join(home, '.claude', 'skills'));
    const file = join(home, '.claude-work', 'plugins', 'installed_plugins.json');
    mkdirSync(join(home, '.claude-work', 'plugins'), { recursive: true });
    writeFileSync(file, JSON.stringify({ plugins: { 'looktap@looktap': [{ scope: 'local', projectPath: '/tmp/x' }] } }));
    assert.equal(claudePlugin({ home, env }), false); // one project only
    writeFileSync(file, JSON.stringify({ plugins: { 'looktap@looktap': [{ scope: 'user' }] } }));
    assert.equal(claudePlugin({ home, env }), true);
    assert.equal(claudePlugin({ home, env: {} }), false); // another account
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
