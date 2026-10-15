#!/usr/bin/env node
// Serve site/dist locally: node site/serve.mjs [port]. Builds first. Zero dependencies.
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from './build.mjs';

const DIST = join(fileURLToPath(new URL('.', import.meta.url)), 'dist');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };

const problems = await build();
if (problems.length) {
  console.error(`site build failed:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
const port = Number(process.argv[2]) || 4173;
createServer((req, res) => {
  let path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
  let file = join(DIST, path);
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!file.startsWith(DIST) || !existsSync(file)) return res.writeHead(404).end('not found');
  res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  createReadStream(file).pipe(res);
}).listen(port, '127.0.0.1', () => console.log(`simwright site on http://127.0.0.1:${port}`));
