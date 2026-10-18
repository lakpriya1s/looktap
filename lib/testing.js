// `looktap test`: flow files (run scripts) found on disk, the names their evidence folders get, and a JUnit
// report for CI. Running the flows is the CLI's: it owns the driver and the commands.
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { UsageError } from './util.js';

/** The flow files named: files as given, folders searched (sorted, dotfiles skipped). */
export function flowFiles(paths) {
  const out = [];
  const walk = (dir) => {
    for (const f of readdirSync(dir).filter((x) => !x.startsWith('.')).sort()) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(p);
    }
  };
  for (const p of paths) {
    let st;
    try {
      st = statSync(p);
    } catch {
      throw new UsageError(`test: no such file or folder: ${p}`);
    }
    if (st.isDirectory()) walk(p);
    else out.push(p);
  }
  return [...new Set(out)];
}

/** A flow's evidence folder name: its path from `cwd`, extension dropped, separators as dashes. */
export function flowName(file, cwd = process.cwd()) {
  const rel = relative(cwd, file).startsWith('..') ? file : relative(cwd, file);
  return rel.replace(/\.[^./\\]+$/, '').replace(/^[./\\]+/, '').replace(/[^\w.-]+/g, '-') || 'flow';
}

const xml = (s) =>
  String(s)
    // Characters XML 1.0 can't carry at all (terminal escapes, NUL …).
    .replace(/[^\t\n\r\x20-퟿-�\u{10000}-\u{10FFFF}]/gu, '')
    .replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);

const secs = (ms) => (ms / 1000).toFixed(3);

/** JUnit XML for results [{ file, ms, lines, error, evidence }]: one testcase per flow. */
export function junit(results, { name = 'looktap', ms = results.reduce((t, r) => t + r.ms, 0) } = {}) {
  const failures = results.filter((r) => r.error).length;
  const cases = results.map((r) => {
    const out = r.lines.length ? `\n      <system-out>${xml(r.lines.join('\n'))}</system-out>` : '';
    const failure = r.error
      ? `\n      <failure message="${xml(r.error.message)}">${xml([r.error.message, r.evidence ? `evidence: ${r.evidence}` : ''].filter(Boolean).join('\n'))}</failure>`
      : '';
    return `    <testcase classname="${xml(name)}" name="${xml(r.file)}" time="${secs(r.ms)}">${failure}${out}${failure || out ? '\n    ' : ''}</testcase>`;
  });
  const counts = `tests="${results.length}" failures="${failures}" errors="0" time="${secs(ms)}"`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="${xml(name)}" ${counts}>
  <testsuite name="${xml(name)}" ${counts}>
${cases.join('\n')}
  </testsuite>
</testsuites>
`;
}
