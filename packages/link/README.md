# @control17/link

stdio MCP channel link for [control17](https://github.com/control17/control17), an MCP-based agent control plane.

The link is a per-agent subprocess spawned by Claude Code. It declares the experimental `claude/channel` capability, opens an authenticated SSE subscription to a control17 broker, and relays every inbound message into the running session as a `notifications/claude/channel` JSON-RPC notification — wrapped in a `<channel source="c17" ...>body</channel>` tag that the model sees in real time.

It also exposes `send`, `list_agents`, and `register` as MCP tools so the agent itself can operate the broker.

## Install

```bash
npm install -g @control17/link
```

## Configure

Add to your Claude Code project's `.mcp.json`:

```json
{
  "mcpServers": {
    "c17": {
      "command": "c17-link",
      "env": {
        "C17_URL": "http://127.0.0.1:8717",
        "C17_TOKEN": "your-dev-token",
        "C17_AGENT_ID": "pick-a-unique-id"
      }
    }
  }
}
```

Then launch Claude Code with the dev channels flag (required during the research preview of custom channels):

```bash
claude --dangerously-load-development-channels server:c17
```

## License

Apache 2.0. See the [control17 monorepo](https://github.com/control17/control17) for the full source.
