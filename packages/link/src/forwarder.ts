/**
 * Broker → stdio forwarder.
 *
 * Opens a long-lived SSE subscription to the broker for this slot's
 * callsign and relays every inbound message as a
 * `notifications/claude/channel` JSON-RPC notification on the link's
 * MCP stdio server. Reconnects with exponential backoff on any error.
 */

import type { Client as BrokerClient } from '@control17/sdk/client';
import { MCP_CHANNEL_NOTIFICATION } from '@control17/sdk/protocol';
import type { Message } from '@control17/sdk/types';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

const BACKOFF_START_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

export type ThreadType = 'primary' | 'dm';

export interface ForwarderOptions {
  server: Server;
  brokerClient: BrokerClient;
  callsign: string;
  signal: AbortSignal;
  log: (msg: string, ctx?: Record<string, unknown>) => void;
}

export async function runForwarder(opts: ForwarderOptions): Promise<void> {
  const { server, brokerClient, callsign, signal, log } = opts;
  let backoff = BACKOFF_START_MS;

  while (!signal.aborted) {
    try {
      log('subscribing to broker', { callsign });
      backoff = BACKOFF_START_MS;

      for await (const message of brokerClient.subscribe(callsign, signal)) {
        // Self-echo suppression: the broker fans out every push to all
        // subscribers INCLUDING the sender, so our own sends come back
        // on the SSE stream. Forwarding those to the MCP client would
        // cost the agent a turn to recognise and discard its own
        // output. Filter them here instead — the agent should never
        // see its own broadcast/send as an incoming channel event.
        // `recent` (history) still returns self-sends, which is the
        // right behaviour: scrollback is supposed to include what you
        // said. Only the live stream is filtered.
        if (message.from === callsign) continue;
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

/**
 * Meta keys the broker owns authoritatively. Anything a sender places
 * in `message.data` with one of these names is silently dropped so a
 * malicious push cannot spoof `from`, `thread`, `level`, etc. on the
 * receiving side. This mirrors the broker-side guarantee that
 * `message.from` is stamped from the authenticated slot and never from
 * the payload — same invariant, one layer down.
 */
const RESERVED_META_KEYS: ReadonlySet<string> = new Set([
  'msg_id',
  'level',
  'ts',
  'thread',
  'from',
  'title',
  'target',
]);

async function forwardMessage(
  server: Server,
  message: Message,
  log: (msg: string, ctx?: Record<string, unknown>) => void,
): Promise<void> {
  const thread: ThreadType = message.agentId === null ? 'primary' : 'dm';
  const meta: Record<string, string> = {
    msg_id: message.id,
    level: message.level,
    ts: String(message.ts),
    thread,
  };
  if (message.from) meta.from = message.from;
  if (message.title) meta.title = message.title;
  if (message.agentId) meta.target = message.agentId;

  if (typeof message.data === 'object' && message.data !== null) {
    for (const [k, v] of Object.entries(message.data)) {
      if (v === null || v === undefined) continue;
      const key = sanitizeMetaKey(k);
      if (!key) continue;
      // Skip reserved keys — a sender cannot override broker-stamped meta.
      if (RESERVED_META_KEYS.has(key)) continue;
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
