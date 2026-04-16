/**
 * `c17 push` — deliver a message to one agent or broadcast to all.
 */

import type { Client } from '@control17/sdk/client';
import type { LogLevel, PushPayload } from '@control17/sdk/types';
import { UsageError } from './errors.js';

const VALID_LEVELS: readonly LogLevel[] = [
  'debug',
  'info',
  'notice',
  'warning',
  'error',
  'critical',
];

export interface PushCommandInput {
  agentId?: string;
  body: string;
  title?: string;
  level?: string;
  broadcast?: boolean;
  data?: Record<string, unknown>;
}

export { UsageError };

export function buildPushPayload(input: PushCommandInput): PushPayload {
  if (!input.body || input.body.length === 0) {
    throw new UsageError('push: --body is required');
  }
  if (!input.broadcast && !input.agentId) {
    throw new UsageError('push: either --agent <id> or --broadcast is required');
  }
  if (input.broadcast && input.agentId) {
    throw new UsageError('push: --broadcast and --agent are mutually exclusive');
  }

  let level: LogLevel = 'info';
  if (input.level) {
    if (!(VALID_LEVELS as readonly string[]).includes(input.level)) {
      throw new UsageError(
        `push: invalid --level '${input.level}' (allowed: ${VALID_LEVELS.join(', ')})`,
      );
    }
    level = input.level as LogLevel;
  }

  return {
    agentId: input.broadcast ? null : input.agentId,
    title: input.title ?? null,
    body: input.body,
    level,
    data: input.data,
  };
}

export async function runPushCommand(input: PushCommandInput, client: Client): Promise<string> {
  const payload = buildPushPayload(input);
  const result = await client.push(payload);
  const target = payload.agentId ?? '*broadcast*';
  return (
    `delivered to ${target}\n` +
    `  message_id: ${result.message.id}\n` +
    `  sse: ${result.delivery.sse}\n` +
    `  targets: ${result.delivery.targets}`
  );
}
