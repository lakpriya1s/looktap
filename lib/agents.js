// The agent guide (skills/looktap/SKILL.md) for every AI coding agent that reads Agent Skills
// (https://agentskills.io): where each one looks for skills, how to tell it's on this machine, and what
// frontmatter it accepts. One source file, a copy per agent, as impeccable does.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';

/**
 Each agent: `project` is its skills folder inside a repo, `global(home, env)` its user-wide one. It's on this
 machine when one of `dirs` (under home) exists or one of `bins` is on PATH. `fields`: frontmatter it takes beyond
 name, description and metadata (Codex rejects keys it doesn't know; `allowed-tools` is Claude's syntax).
 */
export const AGENTS = [
  { id: 'claude', name: 'Claude Code', aliases: ['claude-code'], project: '.claude/skills', global: (h) => join(h, '.claude', 'skills'), dirs: ['.claude'], bins: ['claude'], fields: ['allowed-tools'] },
  { id: 'codex', name: 'Codex CLI', aliases: ['agents'], project: '.agents/skills', global: (h) => join(h, '.agents', 'skills'), dirs: ['.codex', '.agents'], bins: ['codex'] },
  { id: 'cursor', name: 'Cursor', project: '.cursor/skills', global: (h) => join(h, '.cursor', 'skills'), dirs: ['.cursor'], bins: ['cursor-agent', 'cursor'] },
  { id: 'gemini', name: 'Gemini CLI', project: '.gemini/skills', global: (h) => join(h, '.gemini', 'skills'), dirs: ['.gemini'], bins: ['gemini'] },
  { id: 'copilot', name: 'GitHub Copilot', aliases: ['github'], project: '.github/skills', global: (h) => join(h, '.copilot', 'skills'), dirs: ['.copilot'], bins: ['copilot'] },
  { id: 'opencode', name: 'OpenCode', project: '.opencode/skills', global: (h, env) => join(env.XDG_CONFIG_HOME || join(h, '.config'), 'opencode', 'skills'), dirs: ['.config/opencode'], bins: ['opencode'] },
  { id: 'antigravity', name: 'Antigravity', project: '.agent/skills', global: (h) => join(h, '.gemini', 'config', 'skills'), dirs: ['.gemini/antigravity'], bins: ['antigravity'] },
  { id: 'kiro', name: 'Kiro', project: '.kiro/skills', global: (h) => join(h, '.kiro', 'skills'), dirs: ['.kiro'], bins: ['kiro-cli', 'kiro'] },
  { id: 'grok', name: 'Grok Build', project: '.grok/skills', global: (h) => join(h, '.grok', 'skills'), dirs: ['.grok'], bins: ['grok'], fields: ['allowed-tools'] },
  { id: 'hermes', name: 'Hermes Agent', project: '.hermes/skills', global: (h, env) => join(env.HERMES_HOME || join(h, '.hermes'), 'skills'), dirs: ['.hermes'], bins: ['hermes'] },
  { id: 'pi', name: 'Pi', project: '.pi/skills', global: (h) => join(h, '.pi', 'agent', 'skills'), dirs: ['.pi'], bins: ['pi'] },
  { id: 'vibe', name: 'Mistral Vibe', project: '.vibe/skills', global: (h) => join(h, '.vibe', 'skills'), dirs: ['.vibe'], bins: ['vibe'] },
  { id: 'qoder', name: 'Qoder', project: '.qoder/skills', global: (h) => join(h, '.qoder', 'skills'), dirs: ['.qoder'], bins: ['qodercli'] },
  { id: 'rovo-dev', name: 'Rovo Dev', aliases: ['rovodev'], project: '.rovodev/skills', global: (h) => join(h, '.rovodev', 'skills'), dirs: ['.rovodev'], bins: [] },
  { id: 'trae', name: 'Trae', project: '.trae/skills', global: (h) => join(h, '.trae', 'skills'), dirs: ['.trae'], bins: ['trae'] },
  { id: 'trae-cn', name: 'Trae CN', project: '.trae-cn/skills', global: (h) => join(h, '.trae-cn', 'skills'), dirs: ['.trae-cn'], bins: [] },
];

/** In a repo, these two cover most agents: Claude (and Grok) read .claude/skills; Codex, Cursor, Gemini, Copilot, OpenCode, Pi, Vibe and Antigravity read .agents/skills. */
export const PROJECT_DEFAULT = ['claude', 'codex'];

const onPath = (bin, env) => (env.PATH || '').split(delimiter).some((d) => d && existsSync(join(d, bin)));

/** The agents that look installed: their config folder exists, or their command is on PATH. */
export function detectAgents({ home, env = process.env } = {}) {
  return AGENTS.filter((a) => a.dirs.some((d) => existsSync(join(home, d))) || a.bins.some((b) => onPath(b, env)));
}

/** `--agents claude,codex` (or `all`) → agents; an unknown name is an error that lists the known ones. */
export function pickAgents(list) {
  if (list === 'all') return AGENTS;
  return [...new Set(list.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))].map((n) => {
    const a = AGENTS.find((x) => x.id === n || x.aliases?.includes(n));
    if (!a) throw new Error(`unknown agent "${n}" — one of: ${AGENTS.map((x) => x.id).join(', ')}, or all`);
    return a;
  });
}

/** The skills folder an agent reads: user-wide, or inside the repo at `root` with `project`. */
export const skillsDir = (agent, { home, env = process.env, root = null }) => (root ? join(root, agent.project) : agent.global(home, env));

/** SKILL.md → { fields: [[key, raw line]], body }: top-level frontmatter keys as written. */
function split(source) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(source);
  if (!m) throw new Error('SKILL.md has no frontmatter');
  const fields = [];
  for (const line of m[1].split('\n')) {
    const k = /^([\w-]+):/.exec(line);
    if (k) fields.push([k[1], line]);
    else if (fields.length) fields.at(-1)[1] += `\n${line}`; // a continued (indented) value
  }
  return { fields, body: source.slice(m[0].length) };
}

/** The guide as `agent` takes it: name and description, the fields it accepts, and looktap's version in metadata. */
export function skillFor(agent, source, version) {
  const { fields, body } = split(source);
  const keep = new Set(['name', 'description', ...(agent.fields || [])]);
  const head = fields.filter(([k]) => keep.has(k)).map(([, line]) => line);
  head.push('metadata:', `  version: "${version}"`);
  return `---\n${head.join('\n')}\n---\n${body}`;
}

/** The looktap version a skill copy carries, or null (none there, or one written before copies were versioned). */
export function installedVersion(file) {
  try {
    const text = readFileSync(file, 'utf8');
    if (!/^name: looktap$/m.test(text)) return null;
    return /^\s+version: "([^"]+)"/m.exec(text)?.[1] || 'unversioned';
  } catch {
    return null;
  }
}

/** Write the guide for each agent. Agents sharing a folder get one copy (the first agent's flavour). Returns [{ agent, file }]. */
export function installSkill(agents, { source, version, home, env = process.env, root = null }) {
  const done = new Map();
  for (const a of agents) {
    const file = join(skillsDir(a, { home, env, root }), 'looktap', 'SKILL.md');
    if (done.has(file)) {
      done.get(file).agents.push(a);
      continue;
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, skillFor(a, source, version));
    done.set(file, { file, agents: [a] });
  }
  return [...done.values()];
}

/** Remove looktap's skill folder from each agent's skills folder (only a folder holding looktap's guide). */
export function uninstallSkill(agents, { home, env = process.env, root = null }) {
  const removed = [];
  for (const a of agents) {
    const dir = join(skillsDir(a, { home, env, root }), 'looktap');
    if (installedVersion(join(dir, 'SKILL.md')) == null) continue;
    rmSync(dir, { recursive: true, force: true });
    removed.push({ agent: a, dir });
  }
  return removed;
}
