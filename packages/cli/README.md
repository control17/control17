# @control17/cli

Operator CLI for [control17](https://github.com/control17/control17), an MCP-based agent team control plane.

## Install

```bash
npm install -g @control17/cli
```

Or run without installing:

```bash
npx @control17/cli push --agent ALPHA-1 --body "hello"
```

## Commands

```
c17 connect                   interactive TUI — join the team net
c17 push    --body <text> (--agent <callsign> | --broadcast) [--title <t>] [--level <lvl>] [--data key=value]
c17 roster                    list slots and connection state
c17 serve   [--config-path <path>] [--port <n>] [--host <h>] [--db <path>]
c17 link    (configured via C17_URL / C17_TOKEN env vars; usually spawned by Claude Code from .mcp.json)
```

## Environment

| Variable | Purpose |
|---|---|
| `C17_URL` | Broker base URL (default `http://127.0.0.1:8717`) |
| `C17_TOKEN` | Slot token for the caller (required for connect/push/roster/link) |

## Example

```bash
# Start a broker in one terminal (first run triggers the team-setup wizard)
c17 serve

# Join interactively from another terminal
export C17_TOKEN=c17_your_slot_token
c17 connect

# Or push a one-shot message
c17 roster
c17 push --agent ALPHA-1 --body "ci failed on main" --level warning
```

## License

Apache 2.0. See the [control17 monorepo](https://github.com/control17/control17) for the full source.
