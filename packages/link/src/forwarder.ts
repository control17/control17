/**
 * Broker → stdio forwarder.
 *
 * Opens a long-lived SSE subscription to the broker for this agent id
 * and relays every inbound message as a `notifications/claude/channel`
 * JSON-RPC notification on the link's MCP stdio server. Reconnects
 * with exponential backoff on any error.
 */

import type { Client as BrokerClient } from '@control17/sdk/client';
import { MCP_CHANNEL_NOTIFICATION } from '@control17/sdk/protocol';
import type { Message } from '@control17/sdk/types';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

const BACKOFF_START_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

export interface ForwarderOptions {
  server: Server;
  brokerClient: BrokerClient;
  agentId: string;
  signal: AbortSignal;
  log: (msg: string, ctx?: Record<string, unknown>) => void;
}

export async function runForwarder(opts: ForwarderOptions): Promise<void> {
  const { server, brokerClient, agentId, signal, log } = opts;
  let backoff = BACKOFF_START_MS;

  while (!signal.aborted) {
    try {
      await brokerClient.register(agentId);
      log('registered with broker', { agentId });
      backoff = BACKOFF_START_MS;

      for await (const message of brokerClient.subscribe(agentId, signal)) {
        await forwardMessage(server, message, log);
      }

      // If we get here, the stream ended cleanly — treat as a reconnect.
      log('broker subscription stream ended, reconnecting');
    } catch (err) {
      if (signal.aborted) return;
      log('broker loop error', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    if (signal.aborted) return;
    await sleep(backoff, signal);
    backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
  }
}

async function forwardMessage(
  server: Server,
  message: Message,
  log: (msg: string, ctx?: Record<string, unknown>) => void,
): Promise<void> {
  const meta: Record<string, string> = {
    msg_id: message.id,
    level: message.level,
    ts: String(message.ts),
  };
  if (message.title) meta.title = message.title;
  if (message.agentId) meta.target = message.agentId;

  if (typeof message.data === 'object' && message.data !== null) {
    for (const [k, v] of Object.entries(message.data)) {
      if (v === null || v === undefined) continue;
      const key = sanitizeMetaKey(k);
      if (!key) continue;
      if (typeof v === 'string') {
        meta[key] = v;
      } else if (typeof v === 'number' || typeof v === 'boolean') {
        meta[key] = String(v);
      }
      // Drop complex values — channels meta must be flat strings.
    }
  }

  try {
    await server.notification({
      method: MCP_CHANNEL_NOTIFICATION,
      params: {
        content: message.body,
        meta,
      },
    });
  } catch (err) {
    log('failed to emit channel notification', {
      messageId: message.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Channel meta keys must be identifiers (letters, digits, underscore).
 * Anything else is silently dropped on the Claude Code side, so we
 * sanitise here to keep the key stable.
 */
function sanitizeMetaKey(key: string): string {
  const clean = key.replace(/[^a-zA-Z0-9_]/g, '_');
  // If the cleaned key is empty or starts with a digit, drop it.
  if (clean.length === 0 || /^[0-9]/.test(clean)) return '';
  return clean;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
