/**
 * Hono application factory for the control17 broker.
 *
 * Routes:
 *   GET  /healthz            — unauthed, liveness probe
 *   POST /register           — create/touch an agent registration
 *   GET  /agents             — list all registered agents
 *   POST /push               — deliver a message to one agent or broadcast
 *   GET  /subscribe?agentId  — long-lived SSE stream of messages for an agent
 *
 * All non-health routes require `Authorization: Bearer <token>`. All
 * routes must carry `X-C17-Protocol: 1` if the header is present.
 */

import type { Broker } from '@control17/core';
import { PATHS, PROTOCOL_HEADER, PROTOCOL_VERSION } from '@control17/sdk/protocol';
import { AgentRegistrationRequestSchema, PushPayloadSchema } from '@control17/sdk/schemas';
import { Hono } from 'hono';
import { bearerAuth } from 'hono/bearer-auth';
import { streamSSE } from 'hono/streaming';
import type { Logger } from './logger.js';

export interface AppOptions {
  broker: Broker;
  token: string;
  version: string;
  logger: Logger;
}

export function createApp(options: AppOptions): Hono {
  const { broker, token, version, logger } = options;
  const auth = bearerAuth({ token });
  const app = new Hono();

  // Enforce protocol version if the client sent the header. Missing header
  // is allowed for relaxed clients; wrong version is a 400.
  app.use('*', async (c, next) => {
    const header = c.req.header(PROTOCOL_HEADER);
    if (header && Number(header) !== PROTOCOL_VERSION) {
      return c.json(
        {
          error: `unsupported protocol version`,
          got: header,
          expected: PROTOCOL_VERSION,
        },
        400,
      );
    }
    await next();
  });

  app.get(PATHS.health, (c) => {
    return c.json({ status: 'ok' as const, version });
  });

  app.post(PATHS.register, auth, async (c) => {
    const raw = await c.req.json().catch(() => null);
    const parsed = AgentRegistrationRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: 'invalid body', details: parsed.error.issues }, 400);
    }
    const reg = await broker.register(parsed.data.agentId);
    logger.info('agent registered', { agentId: reg.agentId });
    return c.json(reg);
  });

  app.get(PATHS.agents, auth, (c) => {
    return c.json({ agents: broker.listAgents() });
  });

  app.post(PATHS.push, auth, async (c) => {
    const raw = await c.req.json().catch(() => null);
    const parsed = PushPayloadSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: 'invalid push payload', details: parsed.error.issues }, 400);
    }
    if (parsed.data.agentId && !broker.hasAgent(parsed.data.agentId)) {
      return c.json({ error: `no such agent: ${parsed.data.agentId}` }, 404);
    }
    const result = await broker.push(parsed.data);
    logger.info('push delivered', {
      messageId: result.message.id,
      targetAgent: parsed.data.agentId ?? '*broadcast*',
      sse: result.delivery.sse,
      targets: result.delivery.targets,
    });
    return c.json(result);
  });

  app.get(PATHS.subscribe, auth, (c) => {
    const agentId = c.req.query('agentId');
    if (!agentId) {
      return c.json({ error: 'agentId query parameter is required' }, 400);
    }

    return streamSSE(c, async (stream) => {
      let unsubscribe: (() => void) | null = null;

      stream.onAbort(() => {
        unsubscribe?.();
        logger.info('sse stream closed', { agentId });
      });

      unsubscribe = broker.subscribe(agentId, async (message) => {
        try {
          await stream.writeSSE({
            id: message.id,
            data: JSON.stringify(message),
          });
        } catch (err) {
          logger.warn('sse write failed', {
            agentId,
            messageId: message.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });

      logger.info('sse stream opened', { agentId });

      // Initial comment so clients see the connection immediately, even
      // if no push arrives for a while.
      await stream.writeSSE({ event: 'connected', data: agentId });

      // Keep the handler alive until the client disconnects; send a
      // periodic keepalive so idle proxies don't drop us.
      while (!stream.aborted) {
        await stream.sleep(15_000);
        if (stream.aborted) break;
        await stream.writeSSE({ event: 'keepalive', data: '' });
      }
    });
  });

  return app;
}
