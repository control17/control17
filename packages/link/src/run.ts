/**
 * `@control17/link` — library entry.
 *
 * Exposes `runLink()` as the single callable entry point. The CLI
 * subcommand (`c17 link`) imports this directly rather than relying
 * on a module side-effect, so double-imports, tests, or
 * programmatic callers don't end up with two copies of the signal
 * handlers racing each other.
 *
 * The bin file (`src/index.ts`) is a thin wrapper that just calls
 * `runLink()` and maps any startup failure to `process.exit(1)`.
 *
 * Responsibilities:
 *   1. Declare the `claude/channel` experimental MCP capability so
 *      events forwarded via `notifications/claude/channel` are
 *      injected into the running session as
 *      <channel source="c17" ...>body</channel>.
 *   2. Call `/briefing` at startup to learn the caller's callsign,
 *      role, team, and mission.
 *   3. Expose `roster`, `broadcast`, `send`, and `recent` as MCP
 *      tools whose descriptions carry the team context — making it
 *      ambient and sticky across context compaction.
 *   4. Open an authenticated SSE subscription to the broker for the
 *      caller's callsign and relay every inbound message as a
 *      channel event.
 */

import { Client as BrokerClient } from '@control17/sdk/client';
import { ENV, MCP_CHANNEL_CAPABILITY } from '@control17/sdk/protocol';
import type { BriefingResponse } from '@control17/sdk/types';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { runForwarder } from './forwarder.js';
import { defineTools, handleToolCall } from './tools.js';
import { LINK_VERSION } from './version.js';

/** Error thrown at startup when a required env var is missing. */
export class LinkStartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LinkStartupError';
  }
}

// Never console.log() from a stdio server — stdout is reserved for MCP.
// All logs go to stderr as structured JSON lines.
function log(msg: string, ctx: Record<string, unknown> = {}): void {
  const record = { ts: new Date().toISOString(), component: 'link', msg, ...ctx };
  process.stderr.write(`${JSON.stringify(record)}\n`);
}

function readRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.length === 0) {
    throw new LinkStartupError(`${name} is required`);
  }
  return value;
}

/**
 * Start the link. Fetches the briefing, wires the MCP server to
 * stdio, and keeps the broker→stdio forwarder running in the
 * background. Resolves only when a shutdown signal aborts the
 * controller. Throws `LinkStartupError` if required env vars are
 * missing or if the briefing fetch fails.
 *
 * The caller is responsible for signal handling and process exit.
 * In the bin path (`src/index.ts`) we install SIGINT/SIGTERM
 * handlers. In test paths, the caller drives the abort controller
 * directly.
 */
export async function runLink(): Promise<void> {
  const url = readRequiredEnv(ENV.url);
  const token = readRequiredEnv(ENV.token);

  const brokerClient = new BrokerClient({ url, token });
  let briefing: BriefingResponse;
  try {
    briefing = await brokerClient.briefing();
  } catch (err) {
    throw new LinkStartupError(
      `briefing failed against ${url}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const server = new Server(
    { name: 'control17', version: LINK_VERSION },
    {
      capabilities: {
        experimental: { [MCP_CHANNEL_CAPABILITY]: {} },
        tools: {},
      },
      instructions: briefing.instructions,
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: defineTools(briefing),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    return handleToolCall(req.params.name, req.params.arguments, brokerClient, briefing);
  });

  const abortController = new AbortController();
  const shutdown = (signal: string) => {
    log('shutdown requested', { signal });
    abortController.abort();
    // Give the forwarder a moment to unwind, then exit.
    setTimeout(() => process.exit(0), 200).unref();
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('stdio connected', { url, callsign: briefing.callsign, role: briefing.role });

  // Run the broker→stdio forwarder in the background. This resolves
  // only when the signal is aborted; we don't await it so the stdio
  // handler loop (inside server.connect) stays the hot path.
  void runForwarder({
    server,
    brokerClient,
    callsign: briefing.callsign,
    signal: abortController.signal,
    log,
  });
}
