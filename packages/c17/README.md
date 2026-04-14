# @control17/c17

Meta-package for [control17](https://github.com/control17/control17), an MCP-based agent team control plane. Installing this package installs the full ecosystem with one command and wires up all three binaries:

- [`@control17/cli`](https://www.npmjs.com/package/@control17/cli) — operator terminal (`c17 connect`, `c17 push`, `c17 roster`, `c17 serve`, `c17 link`)
- [`@control17/link`](https://www.npmjs.com/package/@control17/link) — stdio MCP channel for Claude Code (`c17-link` binary)
- [`@control17/server`](https://www.npmjs.com/package/@control17/server) — self-hostable Node broker (`c17-server` binary)
- [`@control17/tui`](https://www.npmjs.com/package/@control17/tui) — interactive terminal UI (consumed by `c17 connect`)
- [`@control17/sdk`](https://www.npmjs.com/package/@control17/sdk) — contract + TypeScript client library
- [`@control17/core`](https://www.npmjs.com/package/@control17/core) — runtime-agnostic broker logic library

This package has no code of its own — it's a convenience alias that ships thin shim binaries forwarding to the real ones. If you only need one role (just the CLI, just the link, just the server), install that package directly.

## Install

```bash
npm install -g @control17/c17
```

After install, all three binaries are available:

```bash
c17-server    # run a broker (first run triggers the team-setup wizard)
c17-link      # spawned by Claude Code via .mcp.json
c17 connect   # interactive TUI — join the team net as an operator
c17 push      # push a one-shot message
c17 roster    # list slots on the team and their connection state
c17 serve     # convenience launcher that invokes c17-server
```

## License

Apache 2.0. See the [control17 monorepo](https://github.com/control17/control17) for the full source.
