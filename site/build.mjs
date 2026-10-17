#!/usr/bin/env node
// Builds the website into site/dist: the landing page (site/src, copied), the docs pages (rendered from
// README.md, skills/looktap/SKILL.md and BENCHMARK.md), and inventory.js (commands, MCP tools and flags,
// read from the code). Fails when the docs or the landing page fall behind the code:
//   - a command in bin/looktap.js with no row in the README Commands table, or no landing scene
//   - a README section that no docs page includes
//   - an internal link or #anchor that doesn't resolve
// Zero dependencies: node site/build.mjs
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { plain, render } from './md.js';

const SITE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SITE, '..');
const SRC = join(SITE, 'src');
const DIST = join(SITE, 'dist');
const REPO = 'https://github.com/lakpriya1s/looktap';
const SITE_URL = 'https://lakpriya1s.github.io/looktap/';
const FONTS = 'https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Martian+Mono:wght@300;400;500&family=Hanken+Grotesk:wght@400;500;600;700&display=swap';
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const problems = [];

// ── inventory, from the code ────────────────────────────────────────────

/** Commands: every `case` of act() in bin/looktap.js, plus the ones main() handles itself. */
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

/** Command names in the README's Commands table (rows starting `looktap <name>`). */
export function readmeCommands(readme) {
  return new Set([...readme.matchAll(/^\| `looktap ([a-z]+)/gm)].map((m) => m[1]));
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
  { slug: 'quick-start', description: 'Install looktap, check your toolchain and drive an iPhone or Android device in four commands, or let your AI agent set it up for you.', title: 'Quick start', group: 'Start', readme: ['Quick start', '🤖 Kickstart with your AI agent', 'Requirements'] },
  { slug: 'features', description: 'Everything looktap does: read the screen as text, tap by label, type, gestures, screenshots, video, logs, crashes, biometrics and simulated conditions.', title: 'Features', group: 'Start', readme: ['What you get'] },
  { slug: 'how-it-works', description: 'How looktap reads the screen and sends touches without Appium or WebDriverAgent: a macOS helper for the iOS simulator and an 8 KB Android helper.', title: 'How it works', group: 'Start', readme: ['How it works'] },
  { slug: 'examples', description: 'Worked looktap examples: tap by label, fill forms, wait instead of sleeping, debug crashes, catch transitions, reset app state, simulate conditions.', title: 'Examples', group: 'Use', readme: ['Examples'] },
  { slug: 'commands', description: 'Every looktap command and option: look, act, debug, app state and conditions, plus flags, environment variables and the config file.', title: 'Commands & options', group: 'Use', readme: ['Commands', 'Platform support', 'Options, environment variables, config file'] },
  { slug: 'troubleshooting', description: 'Fixes for common looktap problems on the iOS simulator and Android emulator, and answers to frequent questions.', title: 'Troubleshooting & FAQ', group: 'Use', readme: ['Troubleshooting', 'FAQ'] },
  { slug: 'agents', description: 'Why looktap suits AI coding agents: one call per step, small text output, batching, JSON, a Claude Code plugin, and an MCP server for chat apps without a shell.', title: 'For AI agents', group: 'Agents', readme: ['For AI agents'] },
  { slug: 'agent-guide', description: 'The looktap skill for AI agents: the look-act loop, choosing targets, waiting, screenshots, debugging, and the rules an agent should follow.', title: 'Agent guide (skill)', group: 'Agents', file: 'skills/looktap/SKILL.md' },
  { slug: 'benchmark', description: 'looktap against every other agent mobile tool (mobile-mcp, Maestro, Appium, ios-simulator-mcp, MobileBuildMCP, idb, adb): the same steps on the same devices, timed and checked.', title: 'Benchmark', group: 'Project', readme: ['How it compares'], file: 'BENCHMARK.md' },
  { slug: 'safety', description: 'Safety rules for driving apps with looktap: no real credentials, no recordings of sign-in screens, and care with live backends and logs.', title: 'Safety rules', group: 'Project', readme: ['Safety rules'] },
  { slug: 'contributing', description: 'Build looktap from source, rebuild the native helpers, add a command, and see the roadmap and license.', title: 'Contributing & roadmap', group: 'Project', readme: ['Contributing', 'Roadmap', 'License'] },
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
    // Its subsections move up a level: the page's h1 stands where the section's h2 was.
    let fence = false;
    parts[0] = parts[0]
      .split('\n')
      .slice(1)
      .map((l) => {
        if (/^\s*(```|~~~)/.test(l)) fence = !fence;
        return !fence && /^#{3,6} /.test(l) ? l.slice(1) : l;
      })
      .join('\n');
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
    const files = { 'BENCHMARK.md': 'benchmark', 'README.md': 'quick-start', 'skills/looktap/SKILL.md': 'agent-guide' };
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

/** A page's meta description: its first paragraph of prose, trimmed to a search snippet's length. */
function describe(page, html) {
  const first = /<p>([\s\S]*?)<\/p>/.exec(html)?.[1] || '';
  const text = first.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
  const base = text || `looktap documentation: ${page.title}.`;
  return base.length > 158 ? `${base.slice(0, 155).replace(/\s\S*$/, '')}…` : base;
}

function docsPage(page, html, headings, all, version, titleId) {
  const description = page.description || describe(page, html);
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
<title>${esc(page.title)} · looktap docs</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${SITE_URL}docs/${page.slug}.html">
<meta property="og:type" content="article">
<meta property="og:site_name" content="looktap">
<meta property="og:url" content="${SITE_URL}docs/${page.slug}.html">
<meta property="og:title" content="${esc(page.title)} · looktap docs">
<meta property="og:description" content="${esc(description)}">
<meta property="og:image" content="${SITE_URL}og.png">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="../favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${FONTS}" media="print" onload="this.media='all'">
<noscript><link rel="stylesheet" href="${FONTS}"></noscript>
<link rel="stylesheet" href="../styles.css">
<link rel="stylesheet" href="../docs.css">
<script>try{const t=localStorage.getItem('sw-theme');if(t)document.documentElement.dataset.theme=t}catch(e){}</script>
</head>
<body class="docs">
<a class="skip" href="#content">Skip to content</a>
<header class="topbar">
  <a class="brand" href="../index.html" aria-label="looktap home"><img src="../favicon.svg" alt="" width="26" height="26"><span>looktap</span></a>
  <a class="version" href="https://www.npmjs.com/package/@looktap/cli" rel="noopener" title="looktap on npm">v${version}</a>
  <nav class="topnav" aria-label="Site">
    <a href="../index.html#story">Features</a>
    <a href="quick-start.html">Docs</a>
    <a href="benchmark.html">Benchmark</a>
    <a class="ico-link" href="${REPO}" rel="noopener" aria-label="GitHub"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/></svg><span>GitHub</span></a>
    <a class="ico-link" href="https://www.npmjs.com/package/@looktap/cli" rel="noopener" aria-label="npm"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M1.763 0C.786 0 0 .786 0 1.763v20.474C0 23.214.786 24 1.763 24h20.474c.977 0 1.763-.786 1.763-1.763V1.763C24 .786 23.214 0 22.237 0zM5.13 5.323l13.837.019-.009 13.836h-3.464l.01-10.382h-3.456L12.04 19.17H5.113z"/></svg><span>npm</span></a>
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
  const cli = read('bin/looktap.js');
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
  for (const c of inScenes) if (!commands.includes(c)) problems.push(`site/src/scenes.js covers "${c}", which isn't a looktap command`);

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

  // For search engines: every page, and where the list is.
  const today = new Date().toISOString().slice(0, 10);
  const urls = ['', ...PAGES.map((p) => `docs/${p.slug}.html`)];
  writeFileSync(
    join(DIST, 'sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
      .map((u) => `  <url><loc>${SITE_URL}${u}</loc><lastmod>${today}</lastmod></url>`)
      .join('\n')}\n</urlset>\n`,
  );
  writeFileSync(join(DIST, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}sitemap.xml\n`);

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
  if (problems.length) return problems;

  // GitHub Pages lets browsers keep a file for 10 minutes, so right after a deploy a page could get new HTML and old
  // CSS. Every stylesheet and script reference, module imports included, carries one hash of all of them.
  const assets = [...readdirSync(DIST), ...readdirSync(join(DIST, 'docs')).map((f) => `docs/${f}`)].filter((f) => /\.(css|js)$/.test(f)).sort();
  const sum = createHash('sha1');
  for (const f of assets) sum.update(f).update(readFileSync(join(DIST, f)));
  const v = sum.digest('hex').slice(0, 10);
  const stamp = (file, pattern) => writeFileSync(file, readFileSync(file, 'utf8').replace(pattern, (m, a, ref, b) => `${a}${ref}?v=${v}${b}`));
  for (const page of ['index.html', ...PAGES.map((p) => `docs/${p.slug}.html`)]) stamp(join(DIST, page), /((?:href|src)=")([^"?#:]+\.(?:css|js))(")/g);
  for (const f of assets.filter((f) => f.endsWith('.js'))) stamp(join(DIST, f), /(from\s+['"])(\.{1,2}\/[^'"?]+\.js)(['"])/g);
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
