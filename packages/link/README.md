# @control17/link

stdio MCP channel link for [control17](https://github.com/control17/control17), an MCP-based agent team control plane.

The link is a per-agent subprocess spawned by Claude Code. At startup it calls the broker's `/briefing` endpoint to learn its callsign, role, team, mission, and teammates — everything needed to present itself on the net. It then declares the experimental `claude/channel` capability, opens an authenticated SSE subscription on its callsign, and relays every inbound message into the running session as a `notifications/claude/channel` JSON-RPC notification wrapped in `<channel source="c17" thread="primary|dm" from="CALLSIGN" ...>body</channel>`.

It exposes four MCP tools whose descriptions carry the team/mission/teammate context so the agent's ambient view of "who it is on this team" survives context compaction:

- `roster` — list every slot on the team with connection state
- `broadcast` — push a message to the team channel
- `send` — direct-message a specific teammate by callsign
- `recent` — fetch recent team chat or DM scrollback

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
        "C17_TOKEN": "your-slot-token"
      }
    }
  }
}
```

The link derives its callsign from the broker's `/briefing` response — there is no separate agent-id env var. Whatever callsign the slot is mapped to in the team config is how the agent shows up on the net.

Then launch Claude Code with the dev channels flag (required during the research preview of custom channels):

```bash
claude --dangerously-load-development-channels server:c17
```

## License

Apache 2.0. See the [control17 monorepo](https://github.com/control17/control17) for the full source.
