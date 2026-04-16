# Architecture

control17 is a command-and-control plane for AI agent squadrons. A
server is authoritative about a squadron's mission, roles, slots,
authority levels, objectives, and captured LLM traces. An operator
runs `c17 claude-code` as a **runner**, the runner spawns `claude` as
a child, and inside that session the agent speaks MCP over stdio to a
thin `c17 mcp-bridge` relay — which hands every request back to the
runner over a local Unix socket. Events from the broker flow forward
through the same path as MCP `notifications/claude/channel` messages,
no polling, no user prompt, no vendor lock-in.

## Two auth planes, one identity

The broker serves two kinds of clients:

```
            ┌─ humans ─┐                    ┌─ runners ──────────┐
            │ browser  │                    │ operator's         │
            └────┬─────┘                    │ c17 claude-code    │
                 │ HTTPS + session cookie   └─────────┬──────────┘
                 │ (after TOTP login)                 │ HTTP/1.1 or HTTP/2 + bearer
                 ▼                                    ▼
           ┌──────────────┐                    ┌──────────────┐
           │  @control17  │                    │  HTTP routes │
           │     /web     │                    │ (Hono + SSE) │
           │  (PWA SPA)   │                    └──────┬───────┘
           └──────┬───────┘                           │
                  │                                   │
                  └───────────────┬───────────────────┘
                                  │
                                  │ both resolve to the same
                                  │ slot with authority level
                                  ▼
                       ╔═══════════════════╗
                       ║      BROKER       ║
                       ║  @control17/core  ║
                       ║  @control17/server║
                       ╚═══════════════════╝
```

- **Machine plane** — `Authorization: Bearer c17_…`. Tokens live in
  the squadron config (SHA-256 hashed on disk) and authenticate the
  runner subprocess.
- **Human plane** — `c17_session` cookie minted after a TOTP login.
  The VAPID web-push keys live in the same config file.

Both planes pass through the same auth middleware and resolve to the
same `LoadedSlot`. Downstream handlers (`/push`, `/subscribe`,
`/history`, `/objectives/*`, `/agents/:callsign/activity`) never
care which plane a request came from — they care about the slot's
**authority**.

## Authority model

Every slot has one of three authority levels:

| Authority | What it permits |
|---|---|
| **commander** | Full squadron power: create/assign objectives, reassign, cancel any objective, manage watchers, **view captured LLM traces** |
| **lieutenant** | Create objectives (as originator), cancel objectives they originated, post to discussion threads they're members of |
| **operator** | Execute assigned work: update own status, complete assigned objectives, post to threads they're members of |

The operator authority is the default; commanders are set explicitly
in the squadron config. Authority is checked server-side on every
mutating endpoint; there's no client-side gate you can skip.

## The runner / bridge process tree

The most important piece of control17's architecture is how the
operator's CLI process relates to the agent it's driving:

```
                   operator terminal
                          │
                          ▼
           ┌──────────────────────────────────┐
           │   c17 claude-code                │
           │                                  │
           │   ── runner, long-lived ──       │
           │   • @control17/sdk Client        │   <-- HTTP to broker
           │   • /briefing + objectives       │
           │   • SSE forwarder loop           │
           │   • TraceHost (MITM proxy + local CA)   │
           │   • IPC server on UDS            │
           │   • spawns `claude` as a child   │
           │                                  │
           └──────────────┬───────────────────┘
                          │ exec claude with env
                          │   HTTPS_PROXY=http://127.0.0.1:$PORT
                          │   
                          │   NODE_EXTRA_CA_CERTS=$PATH
                          │   C17_RUNNER_SOCKET=/tmp/.c17-runner-$PID.sock
                          │
                          ▼
           ┌──────────────────────────────────┐
           │         claude (CLI)             │
           │                                  │
           │ reads .mcp.json the runner wrote │
           │ spawns the MCP bridge from it    │
           └──────────────┬───────────────────┘
                          │ stdio JSON-RPC
                          ▼
           ┌──────────────────────────────────┐
           │   c17 mcp-bridge                 │
           │                                  │
           │   ── thin relay, no state ──     │
           │   • connects to runner's UDS     │
           │   • wraps every MCP request as   │
           │     `mcp_request` frame          │
           │   • emits every runner-initiated │
           │     `mcp_notification` frame as  │
           │     a real MCP notification      │
           │                                  │
           └──────────────┬───────────────────┘
                          │ IPC frames (newline JSON)
                          ▼
                  back to the runner
```

### Why this tree

The obvious alternative — make the bridge a child of the agent and
have it talk HTTP directly to the broker — is what control17 used to
do. The problem with that shape is that the bridge is *downstream* of
the agent process, so it can't observe the agent's network traffic.
You can't MitM OAuth flows cleanly, you can't plant
`NODE_EXTRA_CA_CERTS=`, you can't redirect `HTTPS_PROXY=` after the child is
already running.

Flipping the tree gives the runner an upstream position relative to
the agent. The runner can:

- Bake env vars into the agent's initial environment
- Run a loopback HTTP CONNECT relay the agent's HTTPS traffic flows through
- Terminate TLS on both legs using a per-session local CA
- Attribute captured bytes to the objective the agent is working on
- Clean up `.mcp.json` modifications on any exit path

### IPC protocol

Runner ↔ bridge messages are newline-delimited JSON over a Unix
domain socket. Frame types:

| Kind | Direction | Purpose |
|---|---|---|
| `mcp_request` | bridge → runner | Agent made an MCP request; runner must handle |
| `mcp_response` | runner → bridge | Response to a correlated `mcp_request` |
| `mcp_notification` | runner → bridge | Bridge should emit this as a real MCP notification on stdio (channel events, `tools/list_changed`) |
| `shutdown` | either | Courtesy teardown signal |
| `error` | either | Protocol-level error |

The bridge picks a monotonic correlation id per outbound request and
matches responses on the way back. There's no retry or keepalive at
this layer — if the runner dies, the bridge dies with it (which
makes the agent see its MCP server disappear, which is the correct
signal).

## Objectives

Objectives are control17's structured work primitive — push-assigned,
single-assignee, outcome-required, four-state. They replace ad-hoc
chat pushes for anything that needs a lifecycle.

- **States**: `active → blocked → done | cancelled`. Terminal states
  are `done` and `cancelled`. Only `active ↔ blocked` is round-tripable.
- **Contract**: every objective has a non-empty `outcome` — the
  tangible definition of done. The briefing composer and tool
  descriptions surface it so the agent sees its acceptance criteria
  on every turn.
- **Threaded discussion**: each objective gets its own thread at
  `obj:<id>`. Originator + assignee + commanders + explicit watchers
  are the members; posts fan out via the normal channel path.
- **Audit log**: every mutation appends to `objective_events`
  (append-only). Kinds: `assigned | blocked | unblocked | completed
  | cancelled | reassigned | watcher_added | watcher_removed`.
- **Tool description refresh**: when the open objective set for a
  slot changes, the runner emits an MCP `notifications/tools/list_changed`
  and the agent re-reads tool descriptions — which means the
  current-plate summary stays sticky across compaction because it
  lives in tool metadata, not chat history.

See [concepts/objectives.mdx](./concepts/objectives.mdx) for the
user-facing walkthrough.

## Trace capture

The runner maintains one append-only **agent activity stream**
per slot. The proxy relay's MITM path decrypts every HTTPS flow
on the fly: the agent makes a CONNECT request to the proxy, the
proxy dials the real upstream as a normal TLS client, then
terminates TLS toward the agent with a cert issued on-demand
from the per-session local CA (which the agent trusts via
`NODE_EXTRA_CA_CERTS`). Between the two TLS legs lives plaintext
in both directions — reassembled as HTTP/1.1 exchanges in real
time and streamed to the broker as activity events.

Each completed HTTP/1.1 exchange runs through the decode
pipeline as soon as the reassembler finishes it:

```
   ProxyChunk[]   (plaintext, arriving live from the MITM proxy)
           │
           ▼
   ┌───────────────┐
   │ Http1         │  per-TLS-session rolling buffer; emits
   │ Reassembler   │  completed HTTP/1.1 request/response pairs
   │ (http1-       │  in FIFO order — handles Content-Length,
   │  reassembler) │  chunked, gzip/deflate/br.
   └───────┬───────┘
           │
           ▼
   ┌───────────────┐
   │ extractEntries│  Anthropic /v1/messages requests parse into a
   │ (anthropic.ts)│  typed AnthropicMessagesEntry; everything else
   │               │  becomes an OpaqueHttpEntry.
   └───────┬───────┘
           │
           ▼
   ┌───────────────┐
   │ redactJson    │  strip Authorization / x-api-key / cookie
   │ (redact.ts)   │  headers and scrub known secret patterns.
   └───────┬───────┘
           │
           ▼
   ┌───────────────┐
   │ ActivityUpload│  batched POST /agents/:callsign/activity.
   │     er        │  Flushes every 50 events / 64 KB / 500 ms.
   └───────────────┘
```

Zero runtime deps — just Node's built-in `tls` + `crypto` +
`zlib` + a small amount of `node-forge` for CA cert signing.
No tshark, no pcap synthesis, no TLS keylog file.

Activity events are one of four kinds: `llm_exchange`,
`opaque_http`, `objective_open`, `objective_close`. The
objective lifecycle markers are emitted by the runner's
objectives tracker whenever its open set changes and flow
through the same uploader.

Per-objective "traces" are a **time-range view** over this
stream: the web UI queries
`GET /agents/<assignee>/activity?from=<open>&to=<close>&kind=llm_exchange`
to reconstruct what the LLM was doing during an objective's
lifetime. No per-objective blobs are stored anywhere.

Commanders view traces in the web UI's **TracePanel** on each
objective's detail page. Non-commanders get a 403 from
`GET /agents/:callsign/activity`.

See [tracing.mdx](./tracing.mdx) for the full setup guide.

## Package layout

```
                        ╔════════════════════════════════════════╗
                        ║              OPERATORS                 ║
                        ╚════════════════════════════════════════╝

  ┌──────────────┐   ┌───────────┐   ┌───────────┐   ┌─────────────┐
  │  c17 claude- │   │  TS SDK   │   │  c17 CLI  │   │  web UI     │
  │  code        │   │ (programs)│   │ one-shot  │   │ (browser,   │
  │  (runner)    │   │           │   │ push/etc. │   │  PWA+push)  │
  └──────┬───────┘   └─────┬─────┘   └─────┬─────┘   └──────┬──────┘
         │                 │               │                 │
         │   bearer        │   bearer      │   bearer        │ session cookie
         │                 │               │                 │
         └─────────────────┴───────┬───────┴─────────────────┘
                                   │
                                   │  HTTP/2 + TLS
                                   │  @control17/sdk · protocol v1
                                   ▼
                     ╔═══════════════════════════════════════╗
                     ║               BROKER                  ║
                     ╚═══════════════════════════════════════╝

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
                 │  loads squadron config:          │
                 │   • squadron · roles · slots     │
                 │   • authority per slot           │
                 │   • TOTP secrets (per slot)      │
                 │   • HTTPS cert + VAPID keys      │
                 │                                  │
                 │  persistence:                    │
                 │   • objectives + events          │
                 │   • objective_traces             │
                 │   • sessions + push subs         │
                 │                                  │
                 │  serves:                         │
                 │   • machine API (bearer)         │
                 │   • human API (session cookie)   │
                 │   • /objectives + /agents/*      │
                 │   • @control17/web static SPA    │
                 │                                  │
                 │  first-run wizard for setup      │
                 └────────────┬─────────────────────┘
                              │
                              │ SSE (/subscribe)
                              ▼
              ┌───────────────────────────────────┐
              │      c17 claude-code (runner)     │
              │                                   │
              │  • briefing + slot identity       │
              │  • objectives tracker (open set)  │
              │  • SSE forwarder → bridge IPC     │
              │  • TraceHost:                     │
              │     - HTTP CONNECT relay (loopback)      │
              │     - per-session CA (node-forge)        │
              │     - streaming ActivityUploader         │
              │  • spawns `claude` with HTTPS_PROXY  │
              │  • backs up + restores .mcp.json  │
              └──────────┬────────────────────────┘
                         │ spawns
                         ▼
              ┌───────────────────────────────────┐
              │             claude                │
              │                                   │
              │  HTTPS → HTTP CONNECT relay → upstream   │
              │  plaintext → MITM proxy         │
              │  stdio MCP → c17 mcp-bridge       │
              └──────────┬────────────────────────┘
                         │ stdio
                         ▼
              ┌───────────────────────────────────┐
              │          c17 mcp-bridge           │
              │  thin stdio MCP relay; forwards   │
              │  frames to the runner over UDS    │
              └───────────────────────────────────┘
```

### Components

| Package | Role | Install when you want |
|---|---|---|
| **`@control17/c17`** | Meta-package. Depends on everything below, no code of its own. | The full ecosystem in one install |
| **`@control17/sdk`** | The wire contract. Types, zod schemas, protocol constants, TS client. Everything speaks this. | To embed a client in your own Node / Workers / browser code |
| **`@control17/core`** | Broker logic with zero runtime deps. Registry, push fanout, event log, SSE delivery, identity enforcement. | To build a custom broker runtime (Durable Objects, etc.) |
| **`@control17/server`** | Node broker. Wraps `core` in Hono + `node:sqlite`. Squadron config loader, first-run wizard, objectives + traces persistence, built-in web UI. | To host a self-hosted broker |
| **`@control17/web`** | Preact + Vite + UnoCSS PWA served by the broker. Real-time chat, roster, objectives with commander-only TracePanel, Web Push. | Nothing — it ships inside `@control17/server` |
| **`@control17/cli`** | Operator terminal. `c17 claude-code`, `c17 push`, `c17 roster`, `c17 objectives`, `c17 serve`. Also hosts the internal `c17 mcp-bridge` verb. | To push / inspect from a terminal or run the runner |

**Light install:** `@control17/cli` has `@control17/sdk` as its only
hard dependency. `@control17/server` is an optional peer —
subcommands dynamically import it and print an install hint if
missing.

## Identity model

Every slot has:

- **Callsign** — the slot's identity in the net. What `message.from`
  is stamped with, what `/roster` lists, what teammates address each
  other by. Complementary to whatever identity the underlying agent
  already has.
- **Role** — a key into the squadron's roles map, giving the slot
  role-specific instructions in its briefing. Cosmetic for access
  control; **authority** gates permissions, not role.
- **Authority** — `commander | lieutenant | operator`. The real
  access control boundary.
- **Bearer token** — SHA-256 hashed on disk, never persisted in
  plaintext. Plaintext tokens in the config file are auto-migrated
  to hashes on first boot, and the file is atomically rewritten at
  `0o600`.
- Optionally, a **TOTP secret** — enabled for slots flagged for web
  UI access. Used by the human plane to mint a session cookie. Base32
  on disk, replay-guarded via a per-slot counter. The bearer token
  remains as the recovery path.

The broker enforces `agentId === slot.callsign` on subscribe: a slot
can only act on its own agent. DMs are addressed by callsign;
broadcasts go to everyone. Sender-fanout delivers DMs to the
sender's own agent too, which keeps multi-device sessions in sync
without client-side echo logic.

## Transport

- **HTTP/2** when HTTPS is active. Removes the browser
  6-connection-per-origin cap on SSE so multi-tab users don't
  deadlock.
- **HTTP/1.1** fallback via ALPN for legacy clients. Same listener,
  same cert.
- **Self-signed certs** auto-generated on first boot when binding to
  a non-loopback interface. Stored under the config directory at
  `0o600`, hot-reloadable via `SecureContext` swap (future ACME
  renewal path).

## How a chat push flows

1. Operator calls `c17 push --agent scout --body "ci failed"` (or
   posts `/push` directly, or clicks send in the web UI).
2. Broker validates against `@control17/sdk/schemas`, writes to the
   event log, and fans out the message to `scout`'s SSE subscribers
   (plus the sender's own agent, if registered).
3. The operator's `c17 claude-code` runner is subscribed on
   `scout`'s stream. The forwarder receives the SSE frame,
   suppresses self-echoes, and sends an `mcp_notification` IPC frame
   to the bridge.
4. The bridge emits the frame as a real
   `notifications/claude/channel` MCP notification on stdio.
5. Claude Code (via the `claude/channel` capability the bridge
   declared at initialize) wraps the content in a
   `<channel source="cmdcntr" thread="dm" from="CALLSIGN">body</channel>`
   tag and injects it into the running model's context.
6. The model wakes and reacts in real time — no user prompt, no
   polling.
7. Simultaneously, the operator's phone buzzes with an OS
   notification via the service worker (if push is enabled and they
   don't have a live tab open).

Five process boundaries for the machine plane: HTTP → broker → SSE →
runner IPC → bridge stdio → model. Plus a parallel HTTP → broker →
web-push library → push service → service worker → OS notification
shell for humans.

## How an objective flows

1. Commander or lieutenant creates an objective via `c17 objectives
   create` or the web UI: `{title, outcome, assignee, body?}`.
2. The store inserts the row, appends an `assigned` audit event in
   the same transaction, and the app layer publishes an objective
   channel event to the thread members.
3. The assignee's runner sees the event on SSE, the objectives
   tracker refreshes the open set, and emits a
   `notifications/tools/list_changed` out to the bridge — the
   agent's next `tools/list` sees the new objective in its tool
   descriptions.
4. **`objective_open` event** is appended to the slot's activity
   stream, marking the start of the time range that will later
   represent this objective's trace. Every HTTP/1.1 exchange the
   agent makes from here on flows through the MITM proxy → HTTP
   reassembler → activity uploader as a live `llm_exchange` or
   `opaque_http` event.
5. The agent works: updates status, posts discussion messages,
   eventually calls `objectives_complete`.
6. On terminal transition (`done` or `cancelled`), the store emits
   the lifecycle event, the tracker refreshes again, and an
   `objective_close` event is appended to the slot's activity
   stream. No batch flush — every exchange has already been
   streamed up.
7. A commander opens the objective in the web UI. The TracePanel
   queries `GET /agents/<assignee>/activity?from=<createdAt>
   &to=<completedAt>&kind=llm_exchange`, which 200s only for
   commanders. The panel renders model, usage, messages, and
   tool_use / tool_result blocks inline.

## Protocol boundary

Every HTTP request carries an `X-C17-Protocol: 1` header and is
validated against the zod schemas in `@control17/sdk/schemas`.
Breaking changes bump the version constant in
`@control17/sdk/protocol` and are gated by the header, so older
runners keep working against newer brokers within the same major
version.
