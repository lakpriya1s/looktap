// A small Markdown → HTML renderer for looktap's own docs (README, SKILL.md, BENCHMARK.md). It covers what
// those files use: ATX headings (GitHub-style ids), fenced code, GFM tables, nested lists, blockquotes, rules,
// paragraphs, HTML blocks passed through (<details>, <p align>, <img>), and inline code, links, images,
// bold and italics. Not a general CommonMark implementation. Zero dependencies.

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => esc(s).replace(/"/g, '&quot;');

// ── code highlighting ─────────────────────────────────────────────────
// Just enough to tell comments from commands in shell, console and YAML blocks: comments, `looktap` and its
// command, quoted strings, flags, a console's prompt and its output. Classes t-c, t-k, t-v, t-s, t-f, t-p, t-o, t-y.

const tok = (cls, text) => `<span class="t-${cls}">${esc(text)}</span>`;
const SHELL = /("(?:\\.|[^"\\])*"?|'[^']*'?)|((?<=^|\s)#.*$)|(--?[A-Za-z][\w-]*)|([^\s"']+)|(\s+)/g;

/** One line of shell: a comment, else `looktap <command>`, strings and flags marked. */
function shellLine(line) {
  let html = '';
  let after = false; // the word after `looktap` is its command
  for (const [t, str, comment, flag, word] of line.matchAll(SHELL)) {
    if (str) html += tok('s', t);
    else if (comment) html += tok('c', t);
    else if (flag) html += tok('f', t);
    else if (word === 'looktap') (html += tok('k', t)), (after = true);
    else if (word && after) (html += tok('v', t)), (after = false);
    else html += esc(t);
  }
  return html;
}

/** A fenced block's HTML: highlighted for bash/sh/shell, console (`$ ` lines are commands, the rest output) and yaml. */
export function highlight(code, lang) {
  const lines = code.split('\n');
  if (['bash', 'sh', 'shell', 'zsh'].includes(lang)) return lines.map(shellLine).join('\n');
  if (lang === 'console') return lines.map((l) => (/^\$ /.test(l) ? `${tok('p', '$')} ${shellLine(l.slice(2))}` : l ? tok('o', l) : '')).join('\n');
  if (lang === 'yaml' || lang === 'yml')
    return lines
      .map((l) => {
        const c = /(^|\s)#.*$/.exec(l);
        const body = c ? l.slice(0, c.index + c[1].length) : l;
        const k = /^(\s*(?:- )?)([\w.-]+)(:)(.*)$/.exec(body);
        const html = k ? `${esc(k[1])}${tok('y', k[2])}${esc(k[3])}${esc(k[4])}` : esc(body);
        return html + (c ? tok('c', c[0].slice(c[1].length)) : '');
      })
      .join('\n');
  return esc(code);
}

/** GitHub's heading id: lower case, punctuation and emoji dropped, spaces → hyphens. */
export function slug(text) {
  return text
    .replace(/<[^>]+>/g, '')
    .replace(/`/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

/** The plain text of inline Markdown (for ids, search, titles). */
export function plain(text) {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]/g, '')
    .replace(/<[^>]+>/g, '')
    .trim();
}

/**
 Inline Markdown → HTML. `link(href)` may rewrite link targets. Inline HTML tags pass through; other `<`
 and `&` are escaped. Code spans are protected first so nothing inside them is interpreted.
 */
export function inline(text, { link = (h) => h } = {}) {
  const held = [];
  const hold = (html) => `\u0000${held.push(html) - 1}\u0000`;
  let s = text.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, __, code) => hold(`<code>${esc(code.trim() === '' ? code : code.replace(/^ (.*) $/, '$1'))}</code>`));
  s = s.replace(/<\/?[a-zA-Z][^>]*>/g, (tag) => hold(tag));
  s = s.replace(/&(?![a-zA-Z]+;|#\d+;)/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (_, alt, src) => hold(`<img src="${escAttr(link(src))}" alt="${escAttr(alt)}" loading="lazy">`));
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => {
    const target = link(href);
    const external = /^https?:/.test(target);
    return `<a href="${escAttr(target)}"${external ? ' rel="noopener"' : ''}>${label}</a>`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[^\w*])\*([^*\s][^*]*)\*(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^\w])_([^_\s][^_]*)_(?!\w)/g, '$1<em>$2</em>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => held[i]);
}

/** Split a table row on unescaped pipes; `\|` becomes a literal pipe. */
function cells(row) {
  const parts = [];
  let cur = '';
  let inCode = false;
  const r = row.trim().replace(/^\|/, '').replace(/\|$/, '');
  for (let i = 0; i < r.length; i++) {
    const c = r[i];
    if (c === '\\' && r[i + 1] === '|') (cur += '|'), i++;
    else if (c === '`') (inCode = !inCode), (cur += c);
    else if (c === '|' && !inCode) parts.push(cur.trim()), (cur = '');
    else cur += c;
  }
  parts.push(cur.trim());
  return parts;
}

const BLOCK_TAG = /^<\/?(details|summary|p|div|img|br|table|thead|tbody|tr|td|th|h[1-6]|picture|source|center|sup|sub)\b[^>]*>/i;

/**
 Markdown → { html, headings: [{ level, text, id }] }. Options: `link(href)` rewrites link and image
 targets; `shift` demotes headings by that many levels.
 */
export function render(md, { link = (h) => h, shift = 0 } = {}) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  const headings = [];
  const used = new Map();
  const opt = { link };
  let i = 0;

  const uniqueId = (text) => {
    const base = slug(text);
    const n = used.get(base) || 0;
    used.set(base, n + 1);
    return n ? `${base}-${n}` : base;
  };

  const isBlockStart = (l) =>
    /^\s*$/.test(l) || /^#{1,6}\s/.test(l) || /^\s*(```|~~~)/.test(l) || /^\s*([-*+]|\d+[.)])\s/.test(l) || /^>/.test(l) || BLOCK_TAG.test(l.trim()) || /^(---|\*\*\*|___)\s*$/.test(l) || /^\|/.test(l.trim());

  function list(start) {
    // Collect lines belonging to this list (items, their continuations and nested lists), then render.
    const indent = (l) => l.match(/^\s*/)[0].length;
    const base = indent(lines[start]);
    const ordered = /^\s*\d+[.)]\s/.test(lines[start]);
    const items = [];
    let j = start;
    while (j < lines.length) {
      const l = lines[j];
      const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(l);
      if (m && m[1].length === base) {
        items.push([m[3]]);
        j++;
        continue;
      }
      if (/^\s*$/.test(l)) {
        // A blank line ends the list unless the next line continues it (indented, or another item).
        const next = lines[j + 1];
        if (next !== undefined && (indent(next) > base || /^(\s*)([-*+]|\d+[.)])\s/.test(next)) && indent(next) >= base && items.length) {
          items[items.length - 1].push('');
          j++;
          continue;
        }
        break;
      }
      if (indent(l) > base && items.length) {
        items[items.length - 1].push(l.slice(Math.min(indent(l), base + 2)));
        j++;
        continue;
      }
      if (items.length && !isBlockStart(l)) {
        items[items.length - 1].push(l.trim()); // a lazy continuation of the item's text
        j++;
        continue;
      }
      break;
    }
    const tag = ordered ? 'ol' : 'ul';
    const html = items
      .map((item) => {
        const [first, ...rest] = item;
        const body = rest.length ? render([first, ...rest].join('\n'), { link }).html : `<p>${inline(first, opt)}</p>`;
        // Tight items: drop the paragraph wrapper of a single-paragraph item.
        return `<li>${body.replace(/^<p>([\s\S]*?)<\/p>(?=\s*(<ul|<ol|$))/, '$1')}</li>`;
      })
      .join('\n');
    return [`<${tag}>\n${html}\n</${tag}>`, j];
  }

  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*$/.test(line)) {
      i++;
      continue;
    }

    const fence = /^(\s*)(```|~~~)\s*([\w+-]*)/.exec(line);
    if (fence) {
      const code = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s*${fence[2]}`).test(lines[i])) code.push(lines[i++].slice(fence[1].length));
      i++;
      const lang = fence[3] ? ` class="language-${fence[3]}"` : '';
      out.push(`<pre><code${lang}>${highlight(code.join('\n'), fence[3])}</code></pre>`);
      continue;
    }

    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      const level = Math.min(6, h[1].length + shift);
      const text = h[2];
      const id = uniqueId(text);
      headings.push({ level, text: plain(text), id });
      out.push(`<h${level} id="${id}"><a class="anchor" href="#${id}" aria-hidden="true" tabindex="-1">#</a>${inline(text, opt)}</h${level}>`);
      i++;
      continue;
    }

    if (/^(---|\*\*\*|___)\s*$/.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }

    if (/^\|/.test(line.trim()) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const head = cells(line);
      const aligns = cells(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? 'center' : /-+:$/.test(c) ? 'right' : ''));
      i += 2;
      const rows = [];
      while (i < lines.length && /^\|/.test(lines[i].trim())) rows.push(cells(lines[i++]));
      // An empty header cell still names its column for screen readers.
      const td = (tag, c, k) =>
        `<${tag}${aligns[k] ? ` style="text-align:${aligns[k]}"` : ''}>${tag === 'th' && !c ? '<span class="visually-hidden">Item</span>' : inline(c, opt)}</${tag}>`;
      out.push(
        `<div class="table"><table>\n<thead><tr>${head.map((c, k) => td('th', c, k)).join('')}</tr></thead>\n<tbody>\n${rows
          .map((r) => `<tr>${r.map((c, k) => td('td', c, k)).join('')}</tr>`)
          .join('\n')}\n</tbody></table></div>`,
      );
      continue;
    }

    if (/^>/.test(line)) {
      const quote = [];
      while (i < lines.length && /^>/.test(lines[i])) quote.push(lines[i++].replace(/^>\s?/, ''));
      out.push(`<blockquote>${render(quote.join('\n'), { link }).html}</blockquote>`);
      continue;
    }

    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const [html, next] = list(i);
      out.push(html);
      i = next;
      continue;
    }

    if (BLOCK_TAG.test(line.trim())) {
      // An HTML line: passed through, with link targets inside it rewritten.
      out.push(line.trim().replace(/\b(src|href)="([^"]+)"/g, (_, attr, v) => `${attr}="${escAttr(link(v))}"`));
      i++;
      continue;
    }

    const para = [line.trim()];
    i++;
    while (i < lines.length && !isBlockStart(lines[i])) para.push(lines[i++].trim());
    out.push(`<p>${inline(para.join('\n'), opt)}</p>`);
  }
  return { html: out.join('\n'), headings };
}
