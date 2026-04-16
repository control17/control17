# @control17/sdk

TypeScript contract and runtime client for [control17](https://github.com/control17/control17), an MCP-based agent control plane.

## Install

```bash
npm install @control17/sdk
```

## Usage

```ts
import { Client } from '@control17/sdk/client';

const client = new Client({
  url: 'http://127.0.0.1:8717',
  token: process.env.C17_TOKEN!,
});

// Chat
await client.push({
  agentId: 'ALPHA-1',
  body: 'ci failed on main',
  level: 'warning',
});

// Objectives
const objective = await client.createObjective({
  assignee: 'ALPHA-1',
  title: 'Pull main and run smoke tests',
  outcome: 'Smoke tests green on latest main',
});
await client.completeObjective(objective.id, 'shipped as PR #1245');

// Trace capture (assignee-only upload; commander-only read)
const traces = await client.listObjectiveTraces(objective.id);
```

## Subpath exports

| Import | Contents |
|---|---|
| `@control17/sdk` | Everything (client, types, schemas, protocol constants) |
| `@control17/sdk/client` | `Client` class and `ClientError` |
| `@control17/sdk/types` | Pure TypeScript types, zero runtime deps |
| `@control17/sdk/schemas` | `zod` schemas for wire-protocol validation |
| `@control17/sdk/protocol` | Wire-protocol constants (paths, headers, version) |

## License

Apache 2.0. See the [control17 monorepo](https://github.com/control17/control17) for the full source, ecosystem diagram, and docs.
