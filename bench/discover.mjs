// Print each MCP server's tools, so adapters call them the way their authors intended.
//   node bench/discover.mjs [name]
import { startMcp } from './mcp-client.mjs';

const MAESTRO = `${process.env.HOME}/.maestro/bin/maestro`;
export const SERVERS = {
  'mobile-mcp': ['npx', ['-y', '@mobilenext/mobile-mcp@latest']],
  'appium-mcp': ['npx', ['-y', 'appium-mcp@latest']],
  'ios-simulator-mcp': ['npx', ['-y', 'ios-simulator-mcp@latest']],
  mobilebuildmcp: ['npx', ['-y', 'mobilebuildmcp@latest', 'mcp']],
  'maestro-mcp': [MAESTRO, ['mcp']],
  looktap: ['node', [new URL('../bin/looktap.js', import.meta.url).pathname, 'mcp']],
};

for (const [name, [cmd, args]] of Object.entries(SERVERS)) {
  if (process.argv[2] && process.argv[2] !== name) continue;
  try {
    const s = await startMcp(cmd, args);
    console.log(`\n== ${name}: ${s.server?.name} ${s.server?.version} (${s.tools.length} tools, ${JSON.stringify(s.tools).length} bytes of definitions)`);
    for (const t of s.tools) {
      const props = Object.entries(t.inputSchema?.properties || {}).map(([k, v]) => `${k}${(t.inputSchema.required || []).includes(k) ? '' : '?'}:${v.type || (v.enum ? 'enum' : '')}`);
      console.log(`  ${t.name}(${props.join(', ')})`);
    }
    await s.close();
  } catch (e) {
    console.log(`\n== ${name}: FAILED ${e.message.slice(0, 400)}`);
  }
}
