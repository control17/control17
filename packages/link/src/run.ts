/**
 * `@control17/link` — library entry.
 *
 * Exposes `runLink()` as the single callable entry point. The CLI
 * subcommand (`c17 link`) imports this directly rather than relying
 * on a module side-effect, so double-imports, tests, or
 * programmatic callers don't end up with two copies of the signal
 * handlers racing each other.
 *
 * Responsibilities:
 *   1. Declare the `claude/channel` experimental MCP capability so
 *      events forwarded via `notifications/claude/channel` are
 *      injected into the running session as
 *      <channel source="c17" ...>body</channel>.
 *   2. Call `/briefing` at startup to learn the caller's callsign,
 *      role, authority, squadron, mission, and open objectives plate.
 *   3. Expose the chat tools (`roster`, `broadcast`, `send`, `recent`)
 *      and the objective tools (`objectives_list`, `objectives_view`,
 *      `objectives_update`, `objectives_complete`) whose descriptions
 *      carry the squadron context + live open objectives — making
 *      both ambient and sticky across compaction.
 *   4. Open an authenticated SSE subscription to the broker for the
 *      caller's callsign and relay every inbound message as a
 *      channel event. Objective lifecycle events trigger a
 *      tool-description refresh via `tools/list_changed`.
 */

import { Client as BrokerClient } from '@control17/sdk/client';
import { ENV, MCP_CHANNEL_CAPABILITY } from '@control17/sdk/protocol';
import type { BriefingResponse, Objective } from '@control17/sdk/types';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { runForwarder } from './forwarder.js';
import { createObjectivesTracker } from './objectives-tracker.js';
import { defineTools, handleToolCall } from './tools.js';
import { LINK_VERSION } from './version.js';

export class LinkStartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LinkStartupError';
  }
}

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

  // The briefing carries the slot's live open objectives already
  // (server-side join) so we don't need a second round trip at boot.
  // The tracker starts from this set and refreshes when an objective
  // event lands on the SSE stream.
  let openObjectives: Objective[] = briefing.openObjectives;

  const server = new Server(
    { name: 'control17', version: LINK_VERSION },
    {
      capabilities: {
        experimental: { [MCP_CHANNEL_CAPABILITY]: {} },
        tools: { listChanged: true },
      },
      instructions: briefing.instructions,
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: defineTools(briefing, openObjectives),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    return handleToolCall(req.params.name, req.params.arguments, brokerClient, briefing);
  });

  const tracker = createObjectivesTracker({
    brokerClient,
    callsign: briefing.callsign,
    log,
    onRefresh: (next) => {
      openObjectives = next;
      // Tell the MCP client its tool list may have changed so it
      // re-fetches the descriptions carrying the new open set.
      server.sendToolListChanged().catch((err: unknown) =>
        log('tools/list_changed emit failed', {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    },
  });

  const abortController = new AbortController();
  const shutdown = (signal: string) => {
    log('shutdown requested', { signal });
    abortController.abort();
    setTimeout(() => process.exit(0), 200).unref();
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('stdio connected', {
    url,
    callsign: briefing.callsign,
    role: briefing.role,
    authority: briefing.authority,
    openObjectives: openObjectives.length,
  });

  void runForwarder({
    server,
    brokerClient,
    callsign: briefing.callsign,
    signal: abortController.signal,
    log,
    onObjectiveEvent: (message) => {
      // Fire-and-forget — the tracker handles its own errors.
      void tracker.refresh(message);
    },
  });
}
