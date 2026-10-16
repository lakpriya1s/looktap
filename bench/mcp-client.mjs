// A minimal MCP client over stdio (newline-delimited JSON-RPC), the way an agent's harness talks to a server.
import { spawn } from 'node:child_process';

export async function startMcp(command, args, { env = {}, cwd, timeout = 120000 } = {}) {
  const proc = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  let stderr = '';
  let id = 0;
  const waiting = new Map();
  proc.stderr.on('data', (d) => (stderr = (stderr + d).slice(-20000)));
  proc.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // some servers log to stdout; an agent's client ignores those lines too
      }
      if (msg.id != null && waiting.has(msg.id)) {
        waiting.get(msg.id)(msg);
        waiting.delete(msg.id);
      } else if (msg.method && msg.id != null) {
        // A server request (roots/list, sampling, elicitation): answer with an empty result.
        proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: msg.method === 'roots/list' ? { roots: [] } : {} }) + '\n');
      }
    }
  });
  const exited = new Promise((r) => proc.once('exit', (code) => r(code)));
  const rpc = (method, params, ms = timeout) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      const t = setTimeout(() => (waiting.delete(n), reject(new Error(`${method} timed out after ${ms} ms`))), ms);
      waiting.set(n, (m) => (clearTimeout(t), resolve(m)));
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n');
    });
  const init = await Promise.race([
    rpc('initialize', { protocolVersion: '2025-06-18', capabilities: { roots: {} }, clientInfo: { name: 'looktap-bench', version: '1' } }),
    exited.then((code) => {
      throw new Error(`server exited (${code}) before initialize: ${stderr.slice(-800)}`);
    }),
  ]);
  if (init.error) throw new Error(`initialize: ${JSON.stringify(init.error)}`);
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const tools = (await rpc('tools/list', {})).result?.tools || [];
  return {
    server: init.result.serverInfo,
    tools,
    /** Call a tool. Resolves to { ok, content, bytes, text, ms, raw } — bytes is what an agent's context receives. */
    async call(name, args = {}, ms = timeout) {
      const t0 = performance.now();
      const r = await rpc('tools/call', { name, arguments: args }, ms);
      const elapsed = performance.now() - t0;
      const content = r.result?.content || [];
      const text = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      const bytes = Buffer.byteLength(JSON.stringify(r.result ?? r.error ?? ''));
      const ok = !r.error && !r.result?.isError;
      return { ok, content, text, bytes, ms: elapsed, raw: r, error: r.error?.message || (r.result?.isError ? text.slice(0, 300) : undefined) };
    },
    stderr: () => stderr,
    async close() {
      proc.stdin.end();
      proc.kill();
      await Promise.race([exited, new Promise((r) => setTimeout(r, 2000))]);
      if (proc.exitCode === null) proc.kill('SIGKILL');
    },
  };
}
