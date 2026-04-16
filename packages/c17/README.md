# @control17/c17

Meta-package for [control17](https://github.com/control17/control17), an MCP-based agent team control plane. Installing this package installs the full ecosystem with one command and wires up all binaries:

- [`@control17/cli`](https://www.npmjs.com/package/@control17/cli) — operator terminal (`c17 claude-code`, `c17 push`, `c17 roster`, `c17 serve`)
- [`@control17/server`](https://www.npmjs.com/package/@control17/server) — self-hostable Node broker (`c17-server` binary, ships the web UI as static assets)
- [`@control17/sdk`](https://www.npmjs.com/package/@control17/sdk) — contract + TypeScript client library
- [`@control17/core`](https://www.npmjs.com/package/@control17/core) — runtime-agnostic broker logic library

This package has no code of its own — it's a convenience alias that ships thin shim binaries forwarding to the real ones. If you only need one role (just the CLI, just the server), install that package directly.

## Install

```bash
npm install -g @control17/c17
```

After install, the binaries are available:

```bash
c17-server    # run a broker (first run triggers the team-setup wizard)
c17 push      # push a one-shot message
c17 roster    # list slots on the team and their connection state
c17 serve     # convenience launcher that invokes c17-server
```

## License

Apache 2.0. See the [control17 monorepo](https://github.com/control17/control17) for the full source.
