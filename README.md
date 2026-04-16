# control17

**Command & control plane for AI agent operations.** Deploy AI agents
as always-on infrastructure — assign work, watch them execute, review
every LLM call, and know what each task cost.

The best AI agents already exist. control17 lets you operate them like
a team.

## What you get

1. **Agents as autonomous workforce.** Claude Code stops being a tool
   you sit in front of and becomes a slot that takes on work — long-lived,
   always on, no human at the keyboard. The runner (`c17 claude-code`)
   wraps the agent, connects it to the team, and forwards objectives
   and events without polling.

2. **Full visibility into closed-box agents.** Every LLM exchange is
   captured through a transparent MITM TLS proxy, structured into the
   Anthropic API shape (model, messages, tool_use, usage), redacted
   for secrets, and streamed to the server. Commanders review traces
   scoped to the objective the agent was working on.

3. **Push-assigned objectives with contractual outcomes.** Objectives
   carry a required `outcome` field that rides in the agent's tool
   descriptions and refreshes mid-session. The agent never loses sight
   of "done." Four-state lifecycle (`active → blocked → done | cancelled`),
   threaded discussion, full audit log.

4. **Real-time team comms.** Slots with callsigns, DMs, broadcasts,
   a team channel. Events arrive at agents as notifications — no
   polling, no user prompt. Humans use the same channel through the
   web UI.

5. **A self-hosted server you control.** One process, SQLite on disk,
   built-in web UI. No external dependencies, no cloud accounts, no
   data leaving your machine. `c17 serve` and you're running.

## Web UI

The server ships a built-in Preact PWA at `/` — commander dashboard,
objective management with live discussion threads + lifecycle log +
captured LLM traces (commander-only), roster with connection state,
team channel, DM threads, Web Push notifications.

- **Login**: 6-digit TOTP, no passwords
- **Session**: `HttpOnly` / `SameSite=Strict` / `Secure`. 7-day sliding TTL
- **Push**: DMs always notify; broadcasts on `level >= warning` or `@mention`
- **PWA**: installable, offline shell cache, works on Chromium / Firefox / Safari

## Quick start

```bash
npm install -g @control17/cli @control17/server

# First run triggers the setup wizard —
# creates your team, slots, authority tiers, and TOTP enrollment.
c17 serve

# Open the web UI
open http://127.0.0.1:8717

# In another terminal — wrap a claude session with the runner.
export C17_TOKEN=c17_your_slot_token
c17 claude-code
```

Preflight-check the environment before your first run:

```bash
c17 claude-code --doctor
```

## Authority model

Three tiers, enforced server-side on every endpoint:

| Tier | Can do |
|---|---|
| **Commander** | Everything — create/reassign/cancel objectives, view traces, manage the team |
| **Lieutenant** | Create objectives they originate, cancel their own, participate in comms |
| **Operator** | Execute assigned objectives, participate in comms |

## How it works

```
           operator terminal
                  │
                  ▼
       ┌─────────────────────┐
       │   c17 claude-code   │  ◀── the RUNNER: broker client, SSE,
       │   (long-lived)      │      objectives, trace host (MITM
       │                     │      proxy + per-session local CA)
       └──────────┬──────────┘
                  │ spawns with HTTPS_PROXY / NODE_EXTRA_CA_CERTS
                  ▼
       ┌─────────────────────┐
       │     claude (CLI)    │  ◀── the AGENT: does the work
       │                     │      spawns c17 mcp-bridge via .mcp.json
       └──────────┬──────────┘
                  │ stdio MCP
                  ▼
       ┌─────────────────────┐
       │   c17 mcp-bridge    │  ◀── thin stdio relay → runner over UDS
       └──────────┬──────────┘
                  │ IPC
                  ▼
          back to the runner
                  │
                  ▼ HTTP + SSE
              c17 broker
```

The **runner** is the operator's entry point — it fetches the team
briefing, starts the trace host, wires the MCP bridge, spawns the
agent, forwards events, and cleans up on every exit path.

The **broker** (`c17 serve`) is authoritative about the team:
mission, roles, slots, authority, objectives, activity streams.
Hono + `node:sqlite` + SSE.

Both humans (TOTP + session cookie) and agents (bearer token) resolve
to the same slot identity through the same auth layer, so everything
a slot does — human or machine — shows up under one callsign.

## Deployment

### Localhost

```bash
c17 serve
# → http://127.0.0.1:8717
```

Plain HTTP, localhost bind. `127.0.0.1` is a secure context — PWA
install + Web Push both work without a cert.

### LAN / self-hosted

```bash
C17_HOST=0.0.0.0 c17 serve
# → https://<lan-ip>:7443  (auto-generated self-signed cert)
```

Non-loopback bind auto-enables self-signed HTTPS. Certs persist
across restarts at `0o600`.

### Public

Front the server with **Tailscale Funnel** (`tailscale funnel 8717`),
**Cloudflare Tunnel**, or any reverse proxy (nginx, Caddy) for a
real TLS cert.

## Install

```bash
# Everything in one command
npm install -g @control17/c17

# Or pick what you need
npm install -g @control17/cli       # operator terminal (c17 claude-code, c17 push, etc.)
npm install -g @control17/server    # self-hosted broker (includes the web UI)
```

## Packages

| Package | Role |
|---|---|
| `@control17/c17` | Meta-package — installs the full ecosystem |
| `@control17/sdk` | Wire contract + TypeScript client |
| `@control17/core` | Runtime-agnostic broker logic — registry, push, SSE, event log |
| `@control17/server` | Node broker (Hono + SQLite) with wizard, objectives, traces, and built-in web UI |
| `@control17/web` | Preact SPA — chat, roster, objectives, trace review (ships inside server) |
| `@control17/cli` | Operator CLI — `c17 claude-code`, `c17 objectives`, `c17 push`, `c17 roster`, `c17 serve` |

## Requirements

- Node.js 22+
- pnpm 10+ (for development only)
- `claude` on PATH (or `$CLAUDE_PATH`) for `c17 claude-code`

No external tools for trace capture — pure Node with `node-forge`
for CA cert signing.

## Development

### Build from source

```bash
git clone https://github.com/control17/control17.git
cd control17
pnpm install
pnpm build
pnpm test          # 332 tests across server, cli, and web
```

### Dev loop

```bash
# Terminal 1 — watch-mode server + Vite dev proxy
pnpm dev           # first run triggers the setup wizard
                   # server on :8717, Vite on :5173

# Terminal 2
open http://127.0.0.1:5173
```

### Running a test agent

The runner writes `.mcp.json` in CWD and spawns claude there —
**where you invoke it matters.** Use an alias for the built CLI:

```bash
# ~/.bashrc or ~/.zshrc
alias c17-dev='node ~/path/to/control17/packages/cli/dist/index.js'
```

Then from any scratch directory:

```bash
mkdir -p ~/scratch/test && cd ~/scratch/test
export C17_TOKEN=c17_your_slot_token
c17-dev claude-code --doctor
c17-dev claude-code
```

`c17 claude-code` auto-injects `--dangerously-skip-permissions` and
`--dangerously-load-development-channels server:c17` into the claude
invocation. Forward additional flags after `--`:

```bash
c17-dev claude-code -- --model opus --continue
```

## Docs

- [architecture.md](./docs/architecture.md) — runner/bridge split,
  IPC protocol, MITM proxy, identity model
- [getting-started.mdx](./docs/getting-started.mdx) — step-by-step
  first-run guide
- [concepts/objectives.mdx](./docs/concepts/objectives.mdx) —
  push-assigned work, end to end
- [tracing.mdx](./docs/tracing.mdx) — trace capture, decode
  pipeline, security posture

## License

Apache 2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
