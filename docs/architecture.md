# Ecosystem

control17 is an MCP-based agent control plane. An operator pushes an event,
a broker routes it, and a per-agent link drops it into a running session as
a `<channel>` event — no polling, no user prompt, no vendor lock-in.

## Diagram

```
                        ╔════════════════════════════════════════╗
                        ║               OPERATORS                ║
                        ╚════════════════════════════════════════╝

      ┌───────────┐   ┌───────────┐   ┌───────────┐   ┌───────────────┐
      │  c17 CLI  │   │  TS SDK   │   │  webhook  │   │ another agent │
      │ (terminal)│   │ (programs)│   │   (any)   │   │ (via link's   │
      └─────┬─────┘   └─────┬─────┘   └─────┬─────┘   │  send tool)   │
            │               │               │         └───────┬───────┘
            └───────────────┴───────┬───────┴─────────────────┘
                                    │
                                    │  HTTP  (POST /push, GET /agents, …)
                                    │  @control17/sdk · protocol v1
                                    ▼
                        ╔════════════════════════════════════════╗
                        ║                BROKER                  ║
                        ╚════════════════════════════════════════╝

                   ┌──────────────────────────────────────┐
                   │           @control17/core            │
                   │ mailbox · push fanout · event log ·  │
                   │  SSE delivery · auth · registration  │
                   │       (runtime-agnostic logic)       │
                   └──────────────────┬───────────────────┘
                                      │
                                      │ hosted by
                                      ▼
                       ┌────────────────────────────┐
                       │     @control17/server      │
                       │   Node + Hono +            │
                       │   better-sqlite3           │
                       └──────────────┬─────────────┘
                                      │
                                      │  MCP streamable-http
                                      │  (notifications/message · tools)
                                      ▼
                        ╔════════════════════════════════════════╗
                        ║          PER-AGENT ON-RAMP             ║
                        ╚════════════════════════════════════════╝

                       ┌────────────────────────────┐
                       │      @control17/link       │
                       │   stdio MCP server that    │
                       │   declares claude/channel  │
                       │                            │
                       │  tools: send, list_agents, │
                       │         register           │
                       └──────────────┬─────────────┘
                                      │
                                      │  stdio JSON-RPC
                                      │  notifications/claude/channel
                                      ▼
                       ┌────────────────────────────┐
                       │       Claude Code          │
                       │   session (or any other    │
                       │   MCP channel-aware agent) │
                       │                            │
                       │  event arrives as          │
                       │  <channel source="c17">    │
                       │   body </channel>          │
                       └────────────────────────────┘
```

## Components

| Package | What it is |
|---|---|
| **`@control17/sdk`** | The wire contract. Types, zod schemas, protocol constants, TS client. Everything in the ecosystem speaks this. |
| **`@control17/core`** | Broker logic with zero runtime deps. Mailbox, push fanout, event log, SSE delivery. |
| **`@control17/server`** | Node broker. Wraps `core` in Hono + better-sqlite3. Install via `npm i -g @control17/server`. |
| **`@control17/cli`** | Operator terminal. `c17 push`, `c17 agents`, `c17 tail`, `c17 serve`. |
| **`@control17/link`** | Per-agent stdio MCP server. Spawned by Claude Code; declares the `claude/channel` capability and forwards broker events into the session. |

## How a push flows

1. Operator calls `c17 push --agent test-1 --body "ci failed"` (or posts to `/push` directly).
2. Broker validates against `@control17/sdk/schemas`, writes to the event log, enqueues the message into agent `test-1`'s mailbox, and emits an MCP `notifications/message` on that agent's live streamable-http connection.
3. `@control17/link` (spawned by Claude Code as a subprocess) receives the notification, repackages it as a raw `notifications/claude/channel` JSON-RPC message, and writes it to stdout.
4. Claude Code sees the `claude/channel` notification — recognized because the link declared the capability on initialize — wraps the content in a `<channel source="c17" ...>` tag, and injects it into the running model's context.
5. The model wakes and reacts in real time, no user prompt, no polling.

Five process boundaries: HTTP → in-broker queue → MCP SSE → stdio → model.

## Protocol boundary

Every HTTP request carries an `X-C17-Protocol: 1` header and is validated
against the zod schemas in `@control17/sdk/schemas`. Breaking changes bump
the version constant in `@control17/sdk/protocol` and are gated by the
header, so older links keep working against newer brokers and vice versa
within the same major version.
