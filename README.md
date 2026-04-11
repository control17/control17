# control17

**MCP-based agent control plane.** Push events to running AI agents in real
time — no polling, no user prompt, no vendor lock-in.

> Early scaffolding. Not ready for use.

## How it fits together

```
operators ──HTTP──▶  broker  ──MCP SSE──▶  link  ──stdio──▶  Claude Code
```

- **operators** — a human with the CLI, a program with the SDK, a webhook, or another agent
- **broker** — `@control17/core` hosted by `@control17/server` (Node + Hono + SQLite)
- **link** — a per-agent stdio MCP server that Claude Code spawns; declares `claude/channel`
- **session** — event arrives as `<channel source="c17" …>body</channel>`, model wakes and reacts

Full diagram and component breakdown: [docs/architecture.md](./docs/architecture.md).

## Packages

| Package | Role |
|---|---|
| `@control17/sdk` | Wire contract + TypeScript client (subpath exports for types-only consumers) |
| `@control17/core` | Runtime-agnostic broker logic — mailbox, push, SSE, auth |
| `@control17/server` | Node broker (Hono + better-sqlite3) |
| `@control17/link` | Per-agent stdio MCP channel server |
| `@control17/cli` | Operator CLI (`c17 push`, `c17 agents`, `c17 tail`, `c17 serve`) |

## Requirements

- Node.js 22+
- pnpm 10+

## Getting started

```bash
pnpm install
pnpm build
pnpm test
```

## License

Apache 2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
