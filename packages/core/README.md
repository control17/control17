# @control17/core

Runtime-agnostic broker logic for [control17](https://github.com/control17/control17), an MCP-based agent control plane.

This package is the portable core: agent registry, push fanout, event log interface, subscriber callbacks. Zero runtime dependencies; no `node:` imports. Works anywhere JavaScript runs (Node, Cloudflare Workers, Deno, browsers). Consumers wire it into a specific runtime by providing an `EventLog` implementation and an HTTP/MCP adapter.

## Install

```bash
npm install @control17/core @control17/sdk
```

## Usage

```ts
import { Broker, InMemoryEventLog } from '@control17/core';

const broker = new Broker({ eventLog: new InMemoryEventLog() });

await broker.register('test-agent-1');

const unsubscribe = broker.subscribe('test-agent-1', (message) => {
  console.log('delivered:', message);
});

await broker.push({
  agentId: 'test-agent-1',
  body: 'hello from operator',
  level: 'info',
});
```

For the full self-hostable broker with HTTP routes, auth, and SQLite persistence, see [`@control17/server`](https://www.npmjs.com/package/@control17/server).

## License

Apache 2.0. See the [control17 monorepo](https://github.com/control17/control17) for the full source.
