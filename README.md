# control17

**MCP-based agent team control plane.** Define a team, give every
member a callsign and a role, and push events to them in real time —
no polling, no user prompt, no vendor lock-in.

> Early scaffolding. Not ready for use.

## Two planes, one identity

control17 distinguishes **machine** access (an MCP link subprocess
feeding a Claude Code session) from **human** access (an operator
opening the web UI in a browser). Both resolve to the same slot:

```
Claude Code ──stdio──▶  link  ──HTTP bearer──▶  broker  ◀──HTTP cookie──  web UI (browser)
                                                   │
                                        one team · one identity model
```

- **Machine plane** — `Authorization: Bearer c17_…`. Tokens live in
  the team config file (SHA-256 hashed on disk) and authenticate the
  per-agent link subprocess.
- **Human plane** — `c17_session` cookie, minted after a TOTP login.
  The `webPush` VAPID keys live in the same config file. Both planes
  share the same slot identity model, so a "human-only" slot and a
  "machine-only" slot look the same to the broker.

Full diagram and component breakdown: [docs/architecture.md](./docs/architecture.md).

## Web UI

The broker serves a built-in Preact+Vite SPA at `/`. Operators sign
in with a 6-digit TOTP code (no passwords, no reset flows), see the
team channel and DM threads in real time over SSE, and can opt into
Web Push notifications for DMs and high-severity broadcasts. The SPA
is a PWA: installable from any Chromium/Firefox/Safari browser, with
an offline shell cache.

- **Auth**: TOTP enrollment during the first-run wizard (or via
  `c17 enroll --slot <callsign>`). Bearer tokens stay as the machine
  credential and as the human recovery key.
- **Session cookies**: `HttpOnly`, `SameSite=Strict`, `Secure` when
  the server runs over HTTPS. 7-day sliding TTL.
- **HTTP/2**: the HTTPS listener runs over HTTP/2 with HTTP/1.1 ALPN
  fallback so SSE can multiplex — no browser 6-connection cap.
- **Push notifications**: DMs always notify (unless you have a live
  tab open); broadcasts notify on `level >= warning` or `@mention`.
  VAPID keys are auto-generated on first boot.

## Three deployment tiers

### 1. Localhost dev

```bash
cd apps/server && node --env-file-if-exists=../../.env ./dist/index.js
# → http://127.0.0.1:8717
```

Plain HTTP, localhost-only bind. The browser treats `127.0.0.1` as a
secure context, so PWA install and Web Push both work without a cert.

### 2. LAN / self-hosted

```bash
C17_HOST=0.0.0.0 node ./dist/index.js
# → https://<lan-ip>:7443  (auto-generated self-signed cert)
```

Binding to a non-loopback interface auto-flips the server into
self-signed HTTPS mode. Certs are stored under the config directory
(`<configDir>/certs/server.{crt,key}`, mode `0o600`) and reused
across restarts. Clients get a one-time "not private" warning they
click through; after that, PWA install and push both work.

**Safari iOS caveat:** Safari refuses service workers on self-signed
certs. If you need the PWA on an iPhone, use tier 3 below.

### 3. Public deployment via tunnel

For a real cert without running ACME infrastructure, bring the
server up in tier 1 or 2 and front it with:

- **Tailscale Funnel** — `tailscale funnel 8717` gives you a
  `*.ts.net` cert with zero config. Recommended for small teams.
- **Cloudflare Tunnel** — `cloudflared tunnel run` routes a custom
  domain through Cloudflare's edge. Good when you want a vanity URL.
- **Reverse proxy (nginx / Caddy)** — terminate TLS upstream and
  proxy to `http://127.0.0.1:8717`. Set `C17_HOST=127.0.0.1` and run
  the server in plain-HTTP mode (`https.mode: "off"`).

Full ACME/Let's Encrypt support is planned but deferred — the tunnel
and reverse-proxy paths cover the real-world use cases today.

## How it fits together

```
humans (browser)  ──HTTPS+cookie──┐
                                  │
agents (Claude)  ──stdio──▶  link ─┼──HTTP bearer──▶  broker  ──SSE──▶  (back out to subscribers)
                                  │
operators (CLI/SDK)  ──HTTP───────┘
```

- **broker** — `@control17/core` hosted by `@control17/server` (Node
  + Hono + `node:sqlite`), authoritative about the team's mission,
  roles, slots, and VAPID keys
- **link** — a per-agent stdio MCP server that Claude Code spawns;
  declares `claude/channel` and fetches `/briefing` at startup to
  learn its callsign, role, team context, and teammates
- **web** — Preact+Vite SPA built into the server's static dir, served
  by Hono with SPA-fallback routing
- **session** — events arrive at connected agents as
  `<channel source="c17" thread="primary|dm" from="CALLSIGN" …>body</channel>`
  and the model wakes and reacts in real time

## Install

Pick what you need — or install the meta-package to get everything at once.

```bash
# Everything (cli + link + server + tui + web + sdk + core)
npm install -g @control17/c17

# Or just one role:
npm install -g @control17/cli       # operator terminal
npm install -g @control17/link      # Claude Code channel adapter
npm install -g @control17/server    # self-hosted broker (includes the web UI)
npm install -g @control17/tui       # interactive TUI (c17 connect consumes this)
```

The web UI ships inside `@control17/server` as static assets — no
extra install needed. Navigate to `http://<server>/` after the broker
boots.

## Packages

| Package | Role |
|---|---|
| `@control17/c17` | Meta-package — `npm install`s the full ecosystem in one step |
| `@control17/sdk` | Wire contract + TypeScript client (subpath exports for types-only consumers) |
| `@control17/core` | Runtime-agnostic broker logic — agent registry, push, SSE, event log |
| `@control17/server` | Node broker (Hono + node:sqlite) with team config loader, first-run wizard, and the built-in web UI |
| `@control17/web` | Preact+Vite+UnoCSS SPA served by the broker — team chat, roster, push notifications |
| `@control17/link` | Per-agent stdio MCP channel server (spawned by Claude Code) |
| `@control17/tui` | Ink-based terminal UI for `c17 connect` |
| `@control17/cli` | Operator CLI (`c17 connect`, `c17 push`, `c17 roster`, `c17 serve`, `c17 link`) |

## Requirements

- Node.js 22+
- pnpm 10+

## Getting started

```bash
pnpm install
pnpm build
pnpm test
```

To run a team locally:

```bash
# 1. First-run wizard: team + slots + TOTP enrollment. Writes
#    ./control17.json at the repo root. Refuses to overwrite an
#    existing config, so re-running is safe.
#    (`pnpm setup` is a pnpm built-in; we use `pnpm wizard` instead.)
pnpm wizard

# 2. Watch-mode server + Vite dev for the web UI. The server picks
#    up ./control17.json automatically; the Vite dev server on
#    :5173 proxies API calls to the broker on :8717.
pnpm dev

# 3. Open the web UI. Log in with the operator callsign + a fresh
#    6-digit code from the authenticator app you enrolled during setup.
open http://127.0.0.1:5173

# (Optional) join the net as an operator from the terminal instead
export C17_TOKEN=c17_your_slot_token
node packages/cli/dist/index.js connect
```

## License

Apache 2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
