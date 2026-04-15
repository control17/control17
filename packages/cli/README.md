# @control17/cli

Operator CLI for [control17](https://github.com/control17/control17),
an MCP-based agent squadron control plane.

This package provides the `c17` binary, which hosts the operator
entry points (`c17 claude-code`, `c17 connect`, `c17 serve`, etc.)
plus the internal `c17 mcp-bridge` verb that `.mcp.json` entries
point at.

## Install

```bash
npm install -g @control17/cli
```

Or run without installing:

```bash
npx @control17/cli claude-code --doctor
```

## Commands

```
c17 setup       [--config-path <path>]                                 first-run wizard (squadron + slots + TOTP)
c17 enroll      --slot <callsign> [--config-path <path>]               (re-)enroll a slot for web UI login
c17 connect                                                            interactive TUI — join the squadron net
c17 claude-code [--no-trace] [--doctor] [-- <claude args>...]          spawn claude wrapped in a c17 runner
c17 push        --body <text> (--agent <id> | --broadcast) [--title <t>] [--level <lvl>] [--data key=value]...
c17 roster                                                             list slots, authority, and connection state
c17 objectives  list | view | create | update | complete | cancel | reassign   squadron objectives
c17 serve       [--config-path <path>] [--port <n>] [--host <h>] [--db <path>]
```

### `c17 claude-code` (the headliner)

Spawns `claude` as a child of a long-lived **runner** process. The
runner:

- Fetches `/briefing` from the broker to learn this slot's
  callsign, role, authority, teammates, and open objectives
- Binds a Unix domain socket and starts an IPC server
- Starts the trace host: SOCKS relay + TLS keylog tailer + per-span
  buffer
- Backs up `.mcp.json` and writes one pointing at `c17 mcp-bridge`
- Spawns claude with `ALL_PROXY`, `SSLKEYLOGFILE`, and
  `NODE_OPTIONS=--tls-keylog=…` merged into the environment
- Forwards SSE channel events from the broker into the agent as
  MCP `notifications/claude/channel`
- Restores `.mcp.json` on any exit path (normal, signal, crash)

Flags:

- `--no-trace` — disable the trace subsystem entirely. Runner still
  handles SSE, objectives, and bridge IPC.
- `--doctor` — preflight check: claude binary, tshark, `$TMPDIR`,
  SOCKS bindability. Exits 0 on pass, 1 on any FAIL (WARN doesn't
  fail the exit code).
- Everything after `--` is forwarded verbatim to the `claude`
  binary.

Example:

```bash
export C17_TOKEN=c17_your_slot_token
c17 claude-code --doctor
c17 claude-code
c17 claude-code --no-trace -- --model claude-opus-4-6
```

### `c17 mcp-bridge` (hidden internal verb)

The stdio MCP server that claude spawns via the `.mcp.json` entry
the runner wrote. Connects to the runner's UDS path from
`$C17_RUNNER_SOCKET` and forwards every MCP request/response +
every runner-initiated notification. Not shown in `--help`;
operators never invoke it directly.

## Environment

| Variable | Purpose |
|---|---|
| `C17_URL` | Broker base URL (default `http://127.0.0.1:8717`) |
| `C17_TOKEN` | Slot bearer token — required for `claude-code`, `connect`, `push`, `roster`, `objectives` |
| `CLAUDE_PATH` | Override the claude binary path (otherwise `which claude`) |
| `C17_RUNNER_SOCKET` | Set by the runner on the bridge's env; operators never set this |

## Quick start

```bash
# 1. Start a broker (first run triggers the squadron setup wizard)
c17 serve

# 2. In another terminal, set your slot token
export C17_TOKEN=c17_your_slot_token

# 3. Preflight check the environment
c17 claude-code --doctor

# 4. Wrap claude
c17 claude-code
```

To push a one-shot chat message without spawning claude:

```bash
c17 roster
c17 push --agent ALPHA-1 --body "ci failed on main" --level warning
```

To manage objectives from the terminal:

```bash
c17 objectives list --assignee ALPHA-1 --status active
c17 objectives create --assignee ALPHA-1 --title "…" --outcome "…"
c17 objectives complete --id obj-xxx --result "shipped as PR #1245"
```

## License

Apache 2.0. See the [control17 monorepo](https://github.com/control17/control17)
for the full source.
