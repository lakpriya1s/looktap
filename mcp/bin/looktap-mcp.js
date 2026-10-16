#!/usr/bin/env node
// `npx -y @looktap/mcp` is `looktap mcp`: the MCP server lives in @looktap/cli, so this only starts it.
// Any options given here (-p ios, -d <id>, …) are passed on.
process.argv.push('mcp');
await import('@looktap/cli/bin/looktap.js');
