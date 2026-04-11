# @control17/cli

Operator CLI for [control17](https://github.com/control17/control17), an MCP-based agent control plane.

## Install

```bash
npm install -g @control17/cli
```

Or run without installing:

```bash
npx @control17/cli push --agent test-1 --body "hello"
```

## Commands

```
c17 push    --body <text> (--agent <id> | --broadcast) [--title <t>] [--level <lvl>] [--data key=value]
c17 agents
c17 serve   [--port <n>] [--host <h>] [--db <path>]
```

## Environment

| Variable | Purpose |
|---|---|
| `C17_URL` | Broker base URL (default `http://127.0.0.1:8717`) |
| `C17_TOKEN` | Shared-secret bearer token (required for push/agents) |

## Example

```bash
export C17_TOKEN=your-dev-token
c17 serve &
c17 agents
c17 push --agent test-1 --body "ci failed on main" --level warning
```

## License

Apache 2.0. See the [control17 monorepo](https://github.com/control17/control17) for the full source.
