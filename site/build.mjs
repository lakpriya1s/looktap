#!/usr/bin/env node
// Builds the website into site/dist: the landing page (site/src, copied), the docs pages (rendered from
// README.md, skills/simwright/SKILL.md and BENCHMARK.md), and inventory.js (commands, MCP tools and flags,
// read from the code). Fails when the docs or the landing page fall behind the code:
//   - a command in bin/simwright.js with no row in the README Commands table, or no landing scene
//   - a README section that no docs page includes
//   - an internal link or #anchor that doesn't resolve
// Zero dependencies: node site/build.mjs
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { plain, render } from './md.js';

const SITE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SITE, '..');
const SRC = join(SITE, 'src');
const DIST = join(SITE, 'dist');
const REPO = 'https://github.com/lakpriya1s/simwright';
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const problems = [];

// ── inventory, from the code ────────────────────────────────────────────

/** Commands: every `case` of act() in bin/simwright.js, plus the ones main() handles itself. */
export function cliCommands(source) {
  const act = source.slice(source.indexOf('async function act('), source.indexOf('\n}\n', source.indexOf('async function act(')));
  const cases = [...act.matchAll(/^ {4}case '([a-z]+)'/gm)].map((m) => m[1]);
  const top = [...source.matchAll(/cmd === '([a-z]+)'/g)].map((m) => m[1]).filter((c) => c !== 'help');
  return [...new Set([...cases, ...top])];
}

/** Flags parse() knows. */
export function cliFlags(source) {
  const parse = source.slice(source.indexOf('function parse('), source.indexOf('function pickDriver('));
  return [...new Set([...parse.matchAll(/'(--?[a-z]+)'/g)].map((m) => m[1]))].sort();
}

/** Command names in the README's Commands table (rows starting `simwright <name>`). */
export function readmeCommands(readme) {
  return new Set([...readme.matchAll(/^\| `simwright ([a-z]+)/gm)].map((m) => m[1]));
}

// ── docs pages ──────────────────────────────────────────────────────────

/** `## ` sections of a Markdown file: [{ title, md }] (md includes the heading line). */
export function sections(md) {
  const out = [];
  let cur = null;
  let fence = false;
  for (const line of md.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (!fence && /^## /.test(line)) out.push((cur = { title: line.slice(3).trim(), md: line }));
    else if (cur) cur.md += `\n${line}`;
  }
  return out;
}

const PAGES = [
  { slug: 'quick-start', title: 'Quick start', group: 'Start', readme: ['Quick start', '🤖 Kickstart with your AI agent', 'Requirements'] },
  { slug: 'features', title: 'Features', group: 'Start', readme: ['What you get'] },
  { slug: 'how-it-works', title: 'How it works', group: 'Start', readme: ['How it works'] },
  { slug: 'examples', title: 'Examples', group: 'Use', readme: ['Examples'] },
  { slug: 'commands', title: 'Commands & options', group: 'Use', readme: ['Commands', 'Options, environment variables, config file'] },
  { slug: 'troubleshooting', title: 'Troubleshooting & FAQ', group: 'Use', readme: ['Troubleshooting', 'FAQ'] },
  { slug: 'agents', title: 'For AI agents', group: 'Agents', readme: ['For AI agents'] },
  { slug: 'agent-guide', title: 'Agent guide (skill)', group: 'Agents', file: 'skills/simwright/SKILL.md' },
  { slug: 'benchmark', title: 'Benchmark', group: 'Project', readme: ['simwright vs Appium'], file: 'BENCHMARK.md' },
  { slug: 'safety', title: 'Safety rules', group: 'Project', readme: ['Safety rules'] },
  { slug: 'contributing', title: 'Contributing & roadmap', group: 'Project', readme: ['Contributing', 'Roadmap', 'License'] },
];
const SKIPPED = ['Contents']; // the landing page and the sidebar replace it

/** A file's Markdown for a docs page: front matter and its own top heading dropped, the rest kept. */
function fileBody(path) {
  let md = read(path).replace(/^---\n[\s\S]*?\n---\n/, '');
  // The page has its own title: the file's H1 becomes a section heading (or goes, for the skill).
  md = path.endsWith('SKILL.md') ? md.replace(/^# .*\n/m, '') : md.replace(/^# (.*)$/m, '## The full benchmark: $1');
  return md;
}

/**
 A page's Markdown, and the id its title takes. The first README section's heading would repeat the page
 title, so it's dropped and its id moves to the page's h1 (old #links to it still land).
 */
function pageMarkdown(page, readmeSections) {
  const parts = (page.readme || []).map((t) => readmeSections.find((s) => s.title === t).md);
  let titleId = '';
  if (parts.length) {
    titleId = render(parts[0].split('\n')[0]).headings[0].id;
    parts[0] = parts[0].split('\n').slice(1).join('\n');
  }
  if (page.file) parts.push(fileBody(page.file));
  return { md: parts.join('\n\n'), titleId };
}

/** Where a link from the README / SKILL / BENCHMARK points on the site. */
function makeLinker(page, anchors, pageIds) {
  return (href) => {
    if (/^(https?:|mailto:)/.test(href)) return href;
    if (href.startsWith('#')) {
      const id = href.slice(1);
      if (pageIds.get(page.slug).has(id)) return href;
      if (anchors.has(id)) return `${anchors.get(id)}.html${href}`;
      problems.push(`${page.slug}: link to unknown anchor ${href}`);
      return href;
    }
    const [path, hash = ''] = href.replace(/^\.\//, '').split('#');
    const files = { 'BENCHMARK.md': 'benchmark', 'README.md': 'quick-start', 'skills/simwright/SKILL.md': 'agent-guide' };
    if (files[path]) {
      const target = files[path];
      if (hash && !pageIds.get(target).has(hash)) problems.push(`${page.slug}: link to unknown anchor ${href}`);
      return `${target}.html${hash ? `#${hash}` : ''}`;
    }
    if (path.startsWith('assets/')) return `../${path}`;
    return `${REPO}/blob/main/${path}${hash ? `#${hash}` : ''}`; // any other repo file: on GitHub
  };
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function docsPage(page, html, headings, all, version, titleId) {
  const groups = [...new Set(all.map((p) => p.group))];
  const nav = groups
    .map(
      (g) =>
        `<p class="nav-group">${g}</p><ul>${all
          .filter((p) => p.group === g)
          .map((p) => `<li><a href="${p.slug}.html"${p === page ? ' aria-current="page"' : ''}>${esc(p.title)}</a></li>`)
          .join('')}</ul>`,
    )
    .join('');
  const toc = headings
    .filter((h) => h.level === 2 || h.level === 3)
    .map((h) => `<li class="toc-${h.level}"><a href="#${h.id}">${esc(h.text)}</a></li>`)
    .join('');
  const i = all.indexOf(page);
  const prev = all[i - 1], next = all[i + 1];
  const source = [...(page.readme ? ['README.md'] : []), ...(page.file ? [page.file] : [])];
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(page.title)} · simwright docs</title>
<meta name="description" content="simwright documentation: ${esc(page.title)}.">
<link rel="icon" href="../favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Martian+Mono:wght@300;400;500&family=Hanken+Grotesk:wght@400;500;600;700&display=swap">
<link rel="stylesheet" href="../styles.css">
<link rel="stylesheet" href="../docs.css">
<script>try{const t=localStorage.getItem('sw-theme');if(t)document.documentElement.dataset.theme=t}catch(e){}</script>
</head>
<body class="docs">
<a class="skip" href="#content">Skip to content</a>
<header class="topbar">
  <a class="brand" href="../index.html" aria-label="simwright home"><img src="../favicon.svg" alt="" width="26" height="26"><span>simwright</span></a>
  <span class="version">v${version}</span>
  <nav class="topnav" aria-label="Site">
    <a href="../index.html#story">Features</a>
    <a href="quick-start.html">Docs</a>
    <a href="benchmark.html">Benchmark</a>
    <a href="${REPO}" rel="noopener">GitHub</a>
  </nav>
  <button class="theme-toggle" type="button" aria-label="Toggle dark mode"><span aria-hidden="true"></span></button>
  <button class="menu-toggle" type="button" aria-expanded="false" aria-controls="sidebar">Menu</button>
</header>
<div class="docs-shell">
  <aside class="sidebar" id="sidebar">
    <label class="search"><span class="visually-hidden">Search the docs</span><input type="search" placeholder="Search the docs" autocomplete="off" data-search></label>
    <ol class="search-results" data-results hidden></ol>
    <nav aria-label="Docs">${nav}</nav>
  </aside>
  <main id="content" class="prose">
    <p class="crumb">${esc(page.group)}</p>
    <h1${titleId ? ` id="${titleId}"` : ''}>${esc(page.title)}</h1>
${html}
    <nav class="pager" aria-label="Pages">
      ${prev ? `<a class="prev" href="${prev.slug}.html"><span>Previous</span>${esc(prev.title)}</a>` : '<span></span>'}
      ${next ? `<a class="next" href="${next.slug}.html"><span>Next</span>${esc(next.title)}</a>` : '<span></span>'}
    </nav>
    <p class="edit">Generated from ${source.map((s) => `<a href="${REPO}/blob/main/${s}" rel="noopener">${s}</a>`).join(' and ')}. Edit it there.</p>
  </main>
  <aside class="toc" aria-label="On this page"><p>On this page</p><ul>${toc}</ul></aside>
</div>
<script src="../docs.js" defer></script>
</body>
</html>
`;
}

// ── build ───────────────────────────────────────────────────────────────

export async function build() {
  const pkg = JSON.parse(read('package.json'));
  const cli = read('bin/simwright.js');
  const readme = read('README.md');
  const { TOOLS } = await import(pathToFileURL(join(ROOT, 'lib/mcp.js')).href);
  const { SCENES } = await import(pathToFileURL(join(SRC, 'scenes.js')).href);

  // Coverage: the code is the source of truth.
  const commands = cliCommands(cli);
  const inReadme = readmeCommands(readme);
  const inScenes = new Set(SCENES.flatMap((s) => s.covers || []));
  for (const c of commands) {
    if (!inReadme.has(c)) problems.push(`command "${c}" has no row in the README Commands table`);
    if (!inScenes.has(c)) problems.push(`command "${c}" has no landing scene (site/src/scenes.js "covers")`);
  }
  for (const c of inScenes) if (!commands.includes(c)) problems.push(`site/src/scenes.js covers "${c}", which isn't a simwright command`);

  // Docs: every README section lands on a page.
  const readmeSections = sections(readme);
  const placed = new Set([...PAGES.flatMap((p) => p.readme || []), ...SKIPPED]);
  for (const s of readmeSections) if (!placed.has(s.title)) problems.push(`README section "${s.title}" isn't on any docs page (site/build.mjs PAGES)`);
  for (const p of PAGES) for (const t of p.readme || []) if (!readmeSections.some((s) => s.title === t)) problems.push(`docs page ${p.slug}: README has no section "${t}"`);
  if (problems.length) return problems;

  // Pass 1: each page's heading ids, so links between pages can be resolved.
  const markdown = new Map(PAGES.map((p) => [p.slug, pageMarkdown(p, readmeSections)]));
  const pageIds = new Map();
  const anchors = new Map();
  for (const p of PAGES) {
    const { md, titleId } = markdown.get(p.slug);
    const ids = render(md).headings.map((h) => h.id);
    if (titleId) ids.unshift(titleId);
    pageIds.set(p.slug, new Set(ids));
    for (const id of ids) if (!anchors.has(id)) anchors.set(id, p.slug);
  }
  // README's own section anchors (#quick-start, #-kickstart-…) land on the page holding that section.
  for (const p of PAGES) for (const t of p.readme || []) {
    const id = render(`## ${t}`).headings[0].id;
    anchors.set(id, p.slug);
  }

  // Pass 2: render with links rewritten.
  rmSync(DIST, { recursive: true, force: true });
  cpSync(SRC, DIST, { recursive: true });
  cpSync(join(ROOT, 'assets'), join(DIST, 'assets'), { recursive: true });
  mkdirSync(join(DIST, 'docs'), { recursive: true });
  const search = [];
  for (const p of PAGES) {
    const { md, titleId } = markdown.get(p.slug);
    const { html, headings } = render(md, { link: makeLinker(p, anchors, pageIds) });
    writeFileSync(join(DIST, 'docs', `${p.slug}.html`), docsPage(p, html, headings, PAGES, pkg.version, titleId));
    search.push({ t: p.title, p: p.slug, id: '' });
    for (const h of headings) if (h.level <= 3) search.push({ t: h.text, p: p.slug, id: h.id, in: p.title });
  }
  writeFileSync(join(DIST, 'docs', 'search.json'), JSON.stringify(search));

  // The landing page's inventory: what the code has, so the page can't miss a command or tool.
  const inventory = {
    version: pkg.version,
    commands,
    flags: cliFlags(cli),
    tools: TOOLS.map((t) => ({ name: t.name, description: t.description })),
  };
  writeFileSync(join(DIST, 'inventory.js'), `export const INVENTORY = ${JSON.stringify(inventory, null, 2)};\n`);

  // Every internal link in the output resolves.
  for (const p of PAGES) {
    const html = readFileSync(join(DIST, 'docs', `${p.slug}.html`), 'utf8');
    for (const [, href] of html.matchAll(/href="([^"]+)"/g)) {
      if (/^(https?:|mailto:)/.test(href)) continue;
      const [file, hash] = href.split('#');
      const target = file ? join(DIST, 'docs', file) : join(DIST, 'docs', `${p.slug}.html`);
      if (!existsSync(target)) problems.push(`${p.slug}: broken link ${href}`);
      else if (hash && file.endsWith('.html') && !readFileSync(target, 'utf8').includes(`id="${hash}"`)) problems.push(`${p.slug}: broken anchor ${href}`);
    }
  }
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const found = await build();
  if (found.length) {
    console.error(`site build failed:\n  ${found.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`built ${join('site', 'dist')}: landing page, ${PAGES.length} docs pages`);
}

export { PAGES, plain };
