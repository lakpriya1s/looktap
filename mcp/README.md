# @looktap/mcp

The MCP server for [looktap](https://github.com/lakpriya1s/looktap): it lets an AI agent drive an iPhone or Android
device (simulator, emulator or real phone). It reads the screen as a few lines of text, taps by label, types,
swipes, takes screenshots and reads logs and crashes.

This package only starts the server. Everything else lives in [`@looktap/cli`](https://www.npmjs.com/package/@looktap/cli), which it installs, so you always
get the latest looktap. If you already have the CLI installed, `looktap mcp` is the same server.

## Set up

**Claude Code**

```bash
claude mcp add looktap -- npx -y @looktap/mcp
```

**Claude Desktop, Cursor, VS Code and other clients**

```json
{
  "mcpServers": {
    "looktap": { "command": "npx", "args": ["-y", "@looktap/mcp"] }
  }
}
```

- Claude Desktop: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Cursor: `~/.cursor/mcp.json`

Desktop apps start servers with a minimal `PATH`, so if yours can't find `npx` (common with nvm), install the CLI
with `npm install -g @looktap/cli` and paste the config that `looktap mcp --config` prints. It uses absolute paths.

## Requirements

- Node 18+
- iPhone: macOS with Xcode, and a simulator or a paired iPhone (a free Apple ID is enough). The `looktap` tool's
  `boot "iPhone 16 Pro"` starts a simulator, and `devices` lists what's connected
- Android: `adb`, with an emulator (`boot <AVD name>` starts one) or a phone with USB or wireless debugging

## Tools

`ls`, `tap`, `tap_xy`, `long_press`, `fill`, `type`, `key`, `hide_keyboard`, `swipe`, `scroll_to`, `back`, `home`,
`wait`, `screenshot` (returns the image), `logs`, `crashes`, `perf` (CPU, memory, threads, or frames and jank), and `looktap` for any other command (`devices`, `boot`,
`capabilities`, `stop`, `expect`, `test`, `apps`, `launch --time` …). Actions return the settled screen unless `ls: false`.

Full docs: https://lakpriya1s.github.io/looktap/

## License

AGPL-3.0-only
