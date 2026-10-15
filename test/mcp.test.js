import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';

import { TOOLS, toWords } from '../lib/mcp.js';

test('tool calls become simwright command lines', () => {
  assert.deepEqual(toWords('tap', { target: 'Sign in' }), ['tap', 'Sign in', '--ls']);
  assert.deepEqual(toWords('tap', { target: '@3', ls: false }), ['tap', '@3']);
  assert.deepEqual(toWords('fill', { target: 'Email', text: 'a b' }), ['fill', 'Email', 'a b', '--ls']);
  assert.deepEqual(toWords('long_press', { x: 10, y: 20, ms: 900 }), ['longpress', '10', '20', '900', '--ls']);
  assert.deepEqual(toWords('wait', { target: 'Home', gone: true, seconds: 5 }), ['wait', 'Home', '--gone', '--wait', '5']);
  assert.deepEqual(toWords('logs', { errors: true, grep: 'pay' }), ['logs', '--errors', '--grep', 'pay']);
  assert.throws(() => toWords('long_press', {}), /target, or x and y/);
});

test('every tool has a schema that names its required fields', () => {
  for (const t of TOOLS) {
    assert.equal(t.inputSchema.type, 'object', t.name);
    for (const r of t.inputSchema.required) assert.ok(r in t.inputSchema.properties, `${t.name}.${r}`);
  }
});

test('the server speaks MCP over stdio and keeps stdout clean', async () => {
  const p = spawn(process.execPath, [new URL('../bin/simwright.js', import.meta.url).pathname, 'mcp'], { cwd: '/' });
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  const send = (m) => p.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
  send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  send({ method: 'notifications/initialized' });
  send({ id: 2, method: 'tools/list' });
  send({ id: 3, method: 'nope' });
  p.stdin.end();
  await new Promise((r) => p.on('close', r));
  const msgs = out.trim().split('\n').map((l) => JSON.parse(l)); // every line is a protocol message
  assert.equal(msgs.length, 3);
  assert.equal(msgs[0].result.serverInfo.name, 'simwright');
  assert.equal(msgs[1].result.tools.length, TOOLS.length);
  assert.equal(msgs[2].error.code, -32601);
});
