// Minimal stdio MCP client for appium-mcp (npx appium-mcp).
import { spawn } from 'node:child_process';

export class Mcp {
  constructor() {
    this.p = spawn('npx', ['-y', 'appium-mcp@latest'], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.buf = '';
    this.pending = new Map();
    this.id = 0;
    this.p.stdout.on('data', (d) => {
      this.buf += d;
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        const cb = this.pending.get(msg.id);
        if (cb) { this.pending.delete(msg.id); cb({ msg, bytes: Buffer.byteLength(line) }); }
      }
    });
    this.p.stderr.on('data', () => {});
  }
  rpc(method, params, timeoutMs = 600000) {
    const id = ++this.id;
    this.p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`timeout ${method}`)), timeoutMs);
      this.pending.set(id, (r) => { clearTimeout(t); r.msg.error ? rej(new Error(JSON.stringify(r.msg.error))) : res(r); });
    });
  }
  async init() {
    await this.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'bench', version: '0' } });
    this.p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  }
  /** Returns { ms, bytes (whole JSON-RPC response = what lands in an agent's context), text, isError }. */
  async call(name, args = {}) {
    const t = performance.now();
    const { msg, bytes } = await this.rpc('tools/call', { name, arguments: args });
    const content = msg.result?.content || [];
    const text = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    return { ms: performance.now() - t, bytes, text, isError: !!msg.result?.isError, content };
  }
  close() { this.p.kill(); }
}

if (process.argv[2] === 'list') {
  const m = new Mcp();
  await m.init();
  const { msg } = await m.rpc('tools/list', {});
  for (const t of msg.result.tools) console.log(`${t.name}  ${JSON.stringify(t.inputSchema?.properties ? Object.fromEntries(Object.entries(t.inputSchema.properties).map(([k, v]) => [k, v.enum || v.type])) : {})}`);
  m.close();
}
