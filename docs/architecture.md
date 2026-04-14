# Ecosystem

control17 is an MCP-based agent **team control plane**. The server is
authoritative about a team's mission, roles, and slots. An operator
pushes an event to a callsign, a broker routes it, and a per-agent
link drops it into a running session as a `<channel>` event — no
polling, no user prompt, no vendor lock-in.

## Two auth planes, one identity

The broker serves two kinds of clients at once:

```
                ┌─ humans ─┐                    ┌─ machines ─┐
                │ browser  │                    │ Claude Code│
                └────┬─────┘                    └─────┬──────┘
                     │                                │
                     │ HTTPS + c17_session cookie     │ HTTP/stdio + bearer token
                     │ (after TOTP login)             │ (from team config)
                     ▼                                ▼
               ┌──────────────┐                ┌──────────────┐
               │  @control17  │                │  @control17  │
               │     /web     │                │    /link     │
               │  (PWA SPA)   │                │ (MCP stdio)  │
               └──────┬───────┘                └──────┬───────┘
                      │                               │
                      └──────────────┬────────────────┘
                                     │
                                     │ both resolve to
                                     │ the same slot identity
                                     ▼
                          ╔═══════════════════╗
                          ║      BROKER       ║
                          ║  @control17/core  ║
                          ║  @control17/server║
                          ╚═══════════════════╝
```

- **Human plane** authenticates via TOTP + session cookie. `@control17/web`
  is a Preact+Vite SPA served by the broker as static assets. Session
  cookies are `HttpOnly`, `SameSite=Strict`, `Secure` when the server
  is behind HTTPS.
- **Machine plane** authenticates via bearer token. The `c17_link`
  subprocess reads `C17_TOKEN` from the environment and talks HTTP
  to the broker on behalf of a Claude Code session.

Both planes resolve through the same auth middleware into the same
`LoadedSlot`. Downstream handlers (`/push`, `/subscribe`, `/history`)
never care which plane a request came from.

## Diagram

```
                        ╔════════════════════════════════════════╗
                        ║               OPERATORS                ║
                        ╚════════════════════════════════════════╝

   ┌───────────┐   ┌───────────┐   ┌───────────┐   ┌─────────────┐   ┌──────────────┐
   │  c17 CLI  │   │  TS SDK   │   │  webhook  │   │  web UI     │   │ another agent│
   │ (terminal)│   │ (programs)│   │   (any)   │   │ (browser,   │   │ (via link's  │
   └─────┬─────┘   └─────┬─────┘   └─────┬─────┘   │  PWA+push)  │   │  send tool)  │
         │               │               │         └──────┬──────┘   └──────┬───────┘
         │               │               │                │                 │
         │               │               │                │                 │
         │   bearer      │   bearer      │   bearer       │ session cookie  │ bearer
         │               │               │                │                 │
         └───────────────┴───────┬───────┴────────────────┴─────────────────┘
                                 │
                                 │  HTTP/2+TLS
                                 │  @control17/sdk · protocol v1
                                 ▼
                    ╔════════════════════════════════════════╗
                    ║                BROKER                  ║
                    ╚════════════════════════════════════════╝

                ┌──────────────────────────────────────┐
                │           @control17/core            │
                │ agent registry · push fanout ·       │
                │ event log · SSE delivery · auth ·    │
                │ identity enforcement                 │
                │      (runtime-agnostic logic)        │
                └──────────────────┬───────────────────┘
                                   │
                                   │ hosted by
                                   ▼
                   ┌──────────────────────────────────┐
                   │       @control17/server          │
                   │   Node + Hono + node:sqlite      │
                   │                                  │
                   │  loads team config from disk:    │
                   │   • team · roles · slots         │
                   │   • TOTP secrets (per slot)      │
                   │   • HTTPS cert + VAPID keys      │
                   │                                  │
                   │  serves:                         │
                   │   • machine API (bearer)         │
                   │   • human API (session cookie)   │
                   │   • /push/* Web Push endpoints   │
                   │   • @control17/web static SPA    │
                   │                                  │
                   │  first-run wizard for setup      │
                   └────────────┬─────────────────────┘
                                │
                    ┌───────────┴────────────┐
                    │                        │
                SSE (/subscribe)         Web Push fanout
                    │                        │
                    ▼                        ▼
  ┌────────────────────────────┐   ┌────────────────────────────┐
  │      @control17/link       │   │  browser push service      │
  │   stdio MCP server that    │   │  (FCM / Mozilla autopush / │
  │   declares claude/channel  │   │   Apple Push)              │
  │                            │   │                            │
  │  fetches /briefing at      │   │  delivers encrypted         │
  │  startup; team/role/mission│   │  VAPID-signed payloads to   │
  │  become ambient tool       │   │  registered devices         │
  │  descriptions              │   └──────────────┬─────────────┘
  │                            │                  │
  │  tools: roster, broadcast, │                  │
  │         send, recent       │                  ▼
  └──────────────┬─────────────┘   ┌────────────────────────────┐
                 │                 │   @control17/web service   │
                 │                 │   worker on user's device  │
                 │                 │   (OS notification tray)   │
                 │ stdio JSON-RPC  └────────────────────────────┘
                 │ notifications/claude/channel
                 ▼
  ┌────────────────────────────┐
  │       Claude Code          │
  │   session (or any other    │
  │   MCP channel-aware agent) │
  │                            │
  │  event arrives as          │
  │  <channel source="c17"     │
  │    thread="primary|dm"     │
  │    from="CALLSIGN">        │
  │   body </channel>          │
  └────────────────────────────┘
```

## Components

| Package | Role | Install when you want |
|---|---|---|
| **`@control17/c17`** | Meta-package. Depends on everything below, no code of its own. | The full ecosystem in one install |
| **`@control17/sdk`** | The wire contract. Types, zod schemas, protocol constants, TS client. Everything speaks this. | To embed a client in your own Node/Workers/browser code |
| **`@control17/core`** | Broker logic with zero runtime deps. Registry, push fanout, event log, SSE delivery, identity enforcement. | To build a custom broker runtime (e.g., Durable Objects) |
| **`@control17/server`** | Node broker. Wraps `core` in Hono + `node:sqlite`. Team config loader, first-run wizard, built-in web UI. | To host a self-hosted broker |
| **`@control17/web`** | Preact+Vite+UnoCSS PWA served by the broker. Real-time chat, roster, Web Push notifications. | Nothing — it ships inside `@control17/server` |
| **`@control17/link`** | Per-agent stdio MCP server. Declares `claude/channel`, fetches `/briefing`, and forwards broker events. | To wire Claude Code into a broker via `.mcp.json` |
| **`@control17/tui`** | Ink-based terminal UI. | To use `c17 connect` (the TUI is an optional peer of the CLI) |
| **`@control17/cli`** | Operator terminal. `c17 connect`, `c17 push`, `c17 roster`, `c17 serve`, `c17 link`. | To push/inspect from a terminal or join the team net interactively |

**Light install:** `@control17/cli` has `@control17/sdk` as its only hard dependency. `@control17/server`, `@control17/link`, and `@control17/tui` are optional peers — the corresponding subcommands dynamically import them and print an install hint if missing.

## Identity model

Every slot on the team has:

- A **callsign** — the agent's identity in the net. What `message.from` is stamped with, what `/roster` lists, what teammates address each other by. Complementary to whatever identity the underlying agent (LLM, human, webhook) already has.
- A **role** — a key into the team's roles map. Determines what role-specific instructions appear in the agent's briefing. Cosmetic at the broker level; never gates auth or delivery.
- A **bearer token** — SHA-256 hashed on disk, never persisted in plaintext. The machine-plane auth boundary. Plaintext tokens in the config file are auto-migrated to hashes on first boot and the file is atomically rewritten at `0o600`.
- Optionally, a **TOTP secret** — enabled for slots in editor-flagged roles. Used by the human plane to mint a session cookie. Base32 on disk, replay-guarded via a per-slot counter. Bearer token remains as the recovery path if the device with the authenticator is lost.

The broker enforces `agentId === slot.callsign` on register and subscribe: a slot can only act on its own agent. DMs are addressed by callsign; broadcasts go to everyone registered. Sender-fanout delivers a DM to the sender's own agent too, which keeps multi-device sessions in sync without client-side echo logic.

## Transport

- **HTTP/2** when HTTPS is active. Removes the browser 6-connection-per-origin cap on SSE, so multi-tab users don't deadlock.
- **HTTP/1.1** fallback via ALPN for legacy clients. Same listener, same cert.
- **Self-signed certs** auto-generated on first boot when binding to a non-loopback interface. Stored under the config directory at `0o600`, hot-reloadable via `SecureContext` swap (future ACME renewal path).

## How a push flows

1. Operator calls `c17 push --agent ALPHA-1 --body "ci failed"` (or posts to `/push` directly, or clicks send in the web UI).
2. Broker validates against `@control17/sdk/schemas`, writes to the event log, and fans out the message to `ALPHA-1`'s SSE subscribers (plus the sender's own agent, if registered).
3. In parallel, `queueMicrotask` fires the Web Push fanout path: the dispatcher consults `shouldPush` per recipient (skips self-echoes, skips recipients with live SSE tabs, accepts DMs + high-severity broadcasts + `@mention` broadcasts), then calls `web-push.sendNotification` for every matching subscription with `p-limit(20)` concurrency.
4. `@control17/link` (spawned by Claude Code as a subprocess, subscribed on its callsign) receives the SSE message, repackages it as a `notifications/claude/channel` JSON-RPC notification with `thread="dm"` and `from="<operator-callsign>"`, and writes it to stdout.
5. Claude Code sees the `claude/channel` notification — recognized because the link declared the capability on initialize — wraps the content in a `<channel source="c17" thread="dm" from="…" …>` tag, and injects it into the running model's context.
6. The model wakes and reacts in real time, no user prompt, no polling.
7. Simultaneously, the operator's phone buzzes with an OS notification via the service worker (if they have push enabled and they're not sitting in front of the live tab).

Five process boundaries for the machine plane: HTTP → broker registry → SSE → stdio → model. Plus a parallel HTTP → broker → web-push library → push service → service worker → OS notification shell for humans.

## Protocol boundary

Every HTTP request carries an `X-C17-Protocol: 1` header and is validated
against the zod schemas in `@control17/sdk/schemas`. Breaking changes bump
the version constant in `@control17/sdk/protocol` and are gated by the
header, so older links keep working against newer brokers and vice versa
within the same major version.
