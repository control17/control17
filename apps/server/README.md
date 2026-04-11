# @control17/server

Self-hostable Node broker for [control17](https://github.com/control17/control17), an MCP-based agent control plane.

Wraps [`@control17/core`](https://www.npmjs.com/package/@control17/core) in a Hono HTTP app with bearer-token auth and a SQLite-backed event log. Exposes:

- `GET /healthz`
- `POST /register`
- `GET /agents`
- `POST /push`
- `GET /subscribe?agentId=…` (long-lived SSE stream)

## Install

```bash
npm install -g @control17/server
```

## Run

```bash
export C17_TOKEN=your-dev-token
export C17_PORT=8717
export C17_DB_PATH=/var/lib/c17/events.db
c17-server
```

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `C17_TOKEN` | **required** | Shared-secret bearer token for `/push`, `/agents`, `/register`, `/subscribe` |
| `C17_PORT` | `8717` | HTTP listen port |
| `C17_HOST` | `127.0.0.1` | HTTP listen address |
| `C17_DB_PATH` | `:memory:` | SQLite event log path (use a real path for durability) |

## Embedding

You can also embed the broker in your own Node process:

```ts
import { runServer } from '@control17/server';

const running = await runServer({
  token: process.env.C17_TOKEN!,
  port: 8717,
  dbPath: '/var/lib/c17/events.db',
});

// later…
await running.stop();
```

## License

Apache 2.0. See the [control17 monorepo](https://github.com/control17/control17) for the full source.
