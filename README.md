# control17

**MCP-based agent squadron control plane.** Define a squadron, give
every slot a callsign + role + authority level, push-assign objectives
to agents, and watch the LLM traces flow back to the operator in
real time.

## What it is

control17 is a command-and-control plane for AI agent teams. It gives
you three things working together:

1. **Identity + chat** — slots with callsigns, DMs, broadcasts, a team
   channel. Events arrive at agents as MCP `notifications/claude/channel`
   with no polling and no user prompt.
2. **Push-assigned objectives** — a structured work primitive with a
   four-state lifecycle (`active → blocked → done | cancelled`), a
   required outcome, threaded discussion, and tool descriptions that
   refresh on every state change.
3. **First-class LLM trace capture** — `c17 claude-code` spawns the
   agent behind a loopback MITM TLS proxy with a per-session local
   CA. Every HTTPS flow the agent makes is decrypted transparently
   (transparent to the upstream — we're a real TLS client on that
   leg), parsed as HTTP/1.1, extracted into the Anthropic API shape
   (model, messages, tool_use, tool_result, usage), redacted for
   secrets, and streamed to the server for commander review. No
   tshark, no pcap, no SSLKEYLOGFILE — just Node's built-in
   `tls` + `crypto` modules.

The authority model is a three-tier hierarchy: **commander** (full
squadron power), **lieutenant** (can create/cancel objectives they
originated), **operator** (executes assigned work). Every endpoint
enforces this server-side.

## Process model

```
           operator terminal
                  │
                  ▼
       ┌─────────────────────┐
       │   c17 claude-code   │  ◀── the RUNNER: owns broker client,
       │   (long-lived)      │      SSE subscription, objectives,
       │                     │      trace host (MITM proxy + local CA)
       └──────────┬──────────┘
                  │ spawns with HTTPS_PROXY / NODE_EXTRA_CA_CERTS
                  │
                  ▼
       ┌─────────────────────┐
       │     claude (CLI)    │  ◀── the AGENT: does the work
       │                     │      spawns c17 mcp-bridge via .mcp.json
       └──────────┬──────────┘
                  │ stdio MCP
                  │
                  ▼
       ┌─────────────────────┐
       │   c17 mcp-bridge    │  ◀── THIN stdio relay, ~230 lines.
       │                     │      Forwards MCP traffic over a
       └──────────┬──────────┘      Unix socket to the runner.
                  │ IPC (JSON over UDS)
                  ▼
          back to the runner
                  │
                  ▼ HTTP + SSE (bearer)
              c17 broker
```

- **Runner** (`c17 claude-code`) is the operator's entry point. It
  fetches `/briefing`, binds an IPC socket, starts the SSE forwarder,
  starts the trace host, backs up `.mcp.json`, spawns claude, and
  cleans up on every exit path.
- **Bridge** (`c17 mcp-bridge`, hidden verb) is the stdio MCP server
  claude spawns via the `.mcp.json` entry the runner wrote. Stateless
  — just shuttles JSON-RPC frames between stdio and the runner's
  Unix socket.
- **Broker** (`@control17/server`) is authoritative about the
  squadron: mission, roles, slots + authority, objectives, traces.
  Uses `@control17/core` under Hono + `node:sqlite` + SSE.

## Two auth planes, one identity

The broker serves humans (browser, TOTP + session cookie) and agents
(runners, bearer token) over the same authorization layer. Both
resolve to the same slot, so "commander ACTUAL posted to obj-X" and
"obj-X received a discussion message from ACTUAL" are the same fact.

- **Machine plane** — `Authorization: Bearer c17_…`. Tokens live in
  the squadron config file (SHA-256 hashed on disk) and authenticate
  the operator's `c17 claude-code` runner.
- **Human plane** — `c17_session` cookie, minted after a TOTP login.
  VAPID web-push keys live in the same config file. A single slot
  can be used as either plane or both; the authority level applies
  to everything the slot does on both planes.

## Web UI

The broker serves a built-in Preact + Vite SPA at `/` — commander
dashboard, objective detail with live discussion thread + lifecycle
log + **captured LLM traces** (commander-only), roster, team channel,
DM threads, Web Push support. PWA-installable on Chromium / Firefox
/ Safari.

- **Login**: 6-digit TOTP, no passwords, no reset flows. Enroll at
  setup time or via `c17 enroll --slot <callsign>`.
- **Session**: `HttpOnly` / `SameSite=Strict` / `Secure` (when HTTPS).
  7-day sliding TTL.
- **HTTP/2**: the HTTPS listener speaks HTTP/2 with HTTP/1.1 ALPN
  fallback so SSE doesn't hit the browser 6-connection cap.
- **Push notifications**: DMs always notify (unless the tab is live);
  broadcasts notify on `level >= warning` or `@mention`.

## Three deployment tiers

### 1. Localhost dev

```bash
cd apps/server && node --env-file-if-exists=../../.env ./dist/index.js
# → http://127.0.0.1:8717
```

Plain HTTP, localhost bind. `127.0.0.1` counts as a secure context,
so PWA install + Web Push both work without a cert.

### 2. LAN / self-hosted

```bash
C17_HOST=0.0.0.0 node ./dist/index.js
# → https://<lan-ip>:7443  (auto-generated self-signed cert)
```

Binding to a non-loopback interface auto-flips the server into
self-signed HTTPS mode. Certs live under `<configDir>/certs/server.{crt,key}`
at `0o600` and persist across restarts. Browsers show a one-time
warning you click through.

**Safari iOS caveat:** Safari refuses service workers on self-signed
certs. If you need the PWA on an iPhone, use tier 3.

### 3. Public deployment via tunnel

Bring the server up in tier 1 or 2 and front it with:

- **Tailscale Funnel** — `tailscale funnel 8717` gives you a real
  `*.ts.net` cert with zero config. Recommended for small squadrons.
- **Cloudflare Tunnel** — `cloudflared tunnel run` routes a custom
  domain through Cloudflare's edge.
- **Reverse proxy (nginx / Caddy)** — terminate TLS upstream and
  proxy to `http://127.0.0.1:8717`.

## Install

```bash
# Everything (cli + server + web + sdk + core)
npm install -g @control17/c17

# Or individual roles
npm install -g @control17/cli       # operator terminal (includes `c17 claude-code`)
npm install -g @control17/server    # self-hosted broker (includes the web UI)
```

The web UI ships inside `@control17/server` as static assets. After
the broker boots, navigate to `http://<server>/`.

## Packages

| Package | Role |
|---|---|
| `@control17/c17` | Meta-package — `npm install`s the full ecosystem |
| `@control17/sdk` | Wire contract + TypeScript client (subpath exports for types-only consumers) |
| `@control17/core` | Runtime-agnostic broker logic — agent registry, push, SSE, event log |
| `@control17/server` | Node broker (Hono + node:sqlite) with config loader, wizard, objectives store, trace upload endpoints, and the web UI |
| `@control17/web` | Preact + Vite + UnoCSS SPA — team chat, roster, objectives, commander-only trace review |
| `@control17/cli` | Operator CLI: `c17 claude-code`, `c17 objectives`, `c17 push`, `c17 roster`, `c17 serve`, plus the internal `c17 mcp-bridge` |

**Light install:** `@control17/cli` has `@control17/sdk` as its only
hard dependency. `@control17/server` is an optional peer —
subcommands dynamically import it and print an install hint if
missing.

## Requirements

- Node.js 22+
- pnpm 10+ (for development)
- (Optional) `claude` on PATH or pointed to via `$CLAUDE_PATH`, if
  you plan to run `c17 claude-code`.

No external tools required for trace capture — the decoder is
pure Node with zero runtime deps beyond `node-forge` for CA cert
signing (bundled with the cli).

## Getting started

```bash
# 1. First-run wizard: squadron + slots + authority + TOTP enrollment.
#    Writes ./control17.json with 0o600.
c17 serve          # triggers wizard on first run

# 2. Open the web UI. Log in with your slot callsign + a fresh 6-digit
#    TOTP code from your authenticator app.
open http://127.0.0.1:8717

# 3. Wrap a claude session with the runner. Trace capture on by default
#    — use --no-trace to disable. Use --doctor to preflight-check the
#    environment (claude binary, $TMPDIR, loopback bind, CA generation).
export C17_TOKEN=c17_your_slot_token
c17 claude-code --doctor
c17 claude-code
```

## Development

### Building from source

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
#   First run triggers the squadron setup wizard.
#   Server on :8717, Vite on :5173 with API proxy.
pnpm dev

# Terminal 2 — open the web UI
open http://127.0.0.1:5173
```

### Running a test agent

The runner writes `.mcp.json` in its process CWD and spawns claude
with that CWD inherited — **where you invoke it matters**. A shell
alias pointing at the built cli is the easiest way to iterate:

```bash
# Add to ~/.bashrc or ~/.zshrc (adjust the path for your checkout):
alias c17-dev='node ~/path/to/control17/packages/cli/dist/index.js'
```

Then from any scratch directory:

```bash
mkdir -p ~/scratch/test-alpha && cd ~/scratch/test-alpha
export C17_TOKEN=c17_your_slot_token
c17-dev claude-code --doctor    # preflight check
c17-dev claude-code             # wrap a claude session
```

`c17 claude-code` auto-injects two flags into the claude invocation:

- `--dangerously-skip-permissions` — c17's tools live behind the
  squadron authority model, not per-call permission prompts.
- `--dangerously-load-development-channels server:c17` — enables
  claude's `claude/channel` experimental capability against the
  bridge.

Both are de-duped if you also pass them explicitly. Additional claude
flags go after `--`:

```bash
c17-dev claude-code -- --model opus --continue
```

### CLAUDE.md guard for test workspaces

Claude Code walks up the directory tree reading every `CLAUDE.md` it
finds. If your test workspace is inside the control17 repo, a blank
`CLAUDE.md` in the parent of the workspace directory prevents the
repo root's instructions from leaking into the test session.

### Cleaning up

The runner restores `.mcp.json` on every exit path (normal, signal,
crash). If something crashes mid-run, look for runtime artifacts
under `/tmp/c17-runner-*` and `/tmp/c17-trace-ca-*`.

## Docs

- [architecture.md](./docs/architecture.md) — full walkthrough of the
  runner/bridge split, IPC protocol, MITM proxy, and identity model
- [getting-started.mdx](./docs/getting-started.mdx) — step-by-step
  first-run guide
- [concepts/objectives.mdx](./docs/concepts/objectives.mdx) — how
  push-assigned work flows end-to-end
- [tracing.mdx](./docs/tracing.mdx) — trace capture setup, decode
  pipeline, security posture, and what's redacted

## License

Apache 2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
