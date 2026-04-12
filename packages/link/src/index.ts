/**
 * `@control17/link` — stdio MCP channel for control17.
 *
 * Claude Code spawns this binary as a subprocess (via `.mcp.json`). It:
 *   1. Declares the `claude/channel` experimental capability so events
 *      forwarded via `notifications/claude/channel` are injected into
 *      the running session as `<channel source="c17" ...>body</channel>`.
 *   2. Exposes `send`, `list_agents`, and `register` as MCP tools so the
 *      session can operate the broker directly.
 *   3. Opens an authenticated SSE subscription to the broker for its
 *      agent id and relays every inbound message as a channel event.
 */

import { Client as BrokerClient } from '@control17/sdk/client';
import { ENV, MCP_CHANNEL_CAPABILITY } from '@control17/sdk/protocol';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { runForwarder } from './forwarder.js';
import { defineTools, handleToolCall } from './tools.js';
import { LINK_VERSION } from './version.js';

const INSTRUCTIONS =
  'Events from the control17 command center arrive as <channel source="c17" level="..." ' +
  'thread="primary|dm" from="...">body</channel>. Treat each event as a new instruction ' +
  'or situational update and react accordingly. ' +
  'Match the channel: if thread="primary", reply with `broadcast`; if thread="dm", reply ' +
  'with `send_dm`. Messages where from= is your own name are echoes of your own sends — ' +
  'do not react to them. Use `list_agents` to discover peers.';

// Never console.log() from a stdio server — stdout is reserved for MCP.
// All logs go to stderr as structured JSON lines.
function log(msg: string, ctx: Record<string, unknown> = {}): void {
  const record = { ts: new Date().toISOString(), component: 'link', msg, ...ctx };
  process.stderr.write(`${JSON.stringify(record)}\n`);
}

function readRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.length === 0) {
    process.stderr.write(`link: ${name} is required\n`);
    process.exit(1);
  }
  return value;
}

async function main(): Promise<void> {
  const url = readRequiredEnv(ENV.url);
  const token = readRequiredEnv(ENV.token);

  // The link's agentId is derived from its principal — one principal,
  // one canonical agentId. We ask the broker who we are before opening
  // any other connection. If the token is unknown or the server is
  // down, fail fast with a readable message instead of trying to
  // register a guessed agentId.
  const brokerClient = new BrokerClient({ url, token });
  let agentId: string;
  try {
    const who = await brokerClient.whoami();
    agentId = who.name;
  } catch (err) {
    process.stderr.write(
      `link: whoami failed against ${url}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }

  const server = new Server(
    { name: 'control17', version: LINK_VERSION },
    {
      capabilities: {
        experimental: { [MCP_CHANNEL_CAPABILITY]: {} },
        tools: {},
      },
      instructions: INSTRUCTIONS,
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: defineTools(agentId),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const result = await handleToolCall(
      req.params.name,
      req.params.arguments,
      brokerClient,
      agentId,
    );
    return result;
  });

  const abortController = new AbortController();
  const shutdown = (signal: string) => {
    log('shutdown requested', { signal });
    abortController.abort();
    // Give the forwarder a moment to unwind, then exit.
    setTimeout(() => process.exit(0), 200).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('stdio connected', { url, agentId });

  // Run the broker→stdio forwarder in the background. This resolves only
  // when the signal is aborted; we don't await it so the stdio handler
  // loop (inside server.connect) stays the hot path.
  void runForwarder({
    server,
    brokerClient,
    agentId,
    signal: abortController.signal,
    log,
  });
}

main().catch((err) => {
  process.stderr.write(
    `link: fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
