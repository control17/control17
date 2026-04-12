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
 * All non-health routes require `Authorization: Bearer <token>` where
 * `<token>` maps to a named principal loaded from the server config.
 * The matched principal is stored on `c.var.principal` and used to
 * stamp authoritative `from` on pushes and `kind` on registrations.
 * All routes must carry `X-C17-Protocol: 1` if the header is present.
 */

import {
  AgentIdentityError,
  type Broker,
  DEFAULT_QUERY_LIMIT,
  MAX_QUERY_LIMIT,
} from '@control17/core';
import { PATHS, PROTOCOL_HEADER, PROTOCOL_VERSION } from '@control17/sdk/protocol';
import { AgentRegistrationRequestSchema, PushPayloadSchema } from '@control17/sdk/schemas';
import { Hono, type MiddlewareHandler } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { Logger } from './logger.js';
import type { Principal, PrincipalStore } from './principals.js';

export interface AppOptions {
  broker: Broker;
  principals: PrincipalStore;
  version: string;
  logger: Logger;
}

type AppBindings = {
  Variables: {
    principal: Principal;
  };
};

export function createApp(options: AppOptions): Hono<AppBindings> {
  const { broker, principals, version, logger } = options;
  const app = new Hono<AppBindings>();

  const auth: MiddlewareHandler<AppBindings> = async (c, next) => {
    const header = c.req.header('Authorization');
    if (!header?.startsWith('Bearer ')) {
      return c.json({ error: 'missing bearer token' }, 401);
    }
    const raw = header.slice('Bearer '.length).trim();
    const principal = principals.resolve(raw);
    if (!principal) {
      return c.json({ error: 'unknown token' }, 401);
    }
    c.set('principal', principal);
    await next();
  };

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

  app.get(PATHS.whoami, auth, (c) => {
    const principal = c.get('principal');
    return c.json({ name: principal.name, kind: principal.kind });
  });

  app.post(PATHS.register, auth, async (c) => {
    const raw = await c.req.json().catch(() => null);
    const parsed = AgentRegistrationRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: 'invalid body', details: parsed.error.issues }, 400);
    }
    const principal = c.get('principal');
    try {
      const reg = await broker.register(parsed.data.agentId, {
        kind: principal.kind,
        principal: principal.name,
      });
      logger.info('agent registered', {
        agentId: reg.agentId,
        by: principal.name,
        kind: principal.kind,
      });
      return c.json(reg);
    } catch (err) {
      if (err instanceof AgentIdentityError) {
        logger.warn('register rejected: identity mismatch', {
          agentId: err.agentId,
          principal: err.principal,
        });
        return c.json({ error: err.message }, 403);
      }
      throw err;
    }
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
    const principal = c.get('principal');
    const result = await broker.push(parsed.data, { from: principal.name });
    logger.info('push delivered', {
      messageId: result.message.id,
      from: principal.name,
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
    const principal = c.get('principal');

    // Identity check has to happen BEFORE we hand the stream to
    // streamSSE; otherwise the client sees 200 + an empty SSE stream
    // when we should be returning 403. agentId MUST equal the
    // principal name — the broker will throw otherwise, but doing it
    // ourselves keeps the happy path free of a dummy register/unsub.
    if (agentId !== principal.name) {
      logger.warn('subscribe rejected: identity mismatch', {
        agentId,
        principal: principal.name,
      });
      return c.json(
        {
          error:
            `principal '${principal.name}' cannot subscribe to agent '${agentId}'; ` +
            `agentId must equal the calling principal's name`,
        },
        403,
      );
    }

    return streamSSE(c, async (stream) => {
      let unsubscribe: (() => void) | null = null;

      stream.onAbort(() => {
        unsubscribe?.();
        logger.info('sse stream closed', { agentId, by: principal.name });
      });

      unsubscribe = broker.subscribe(
        agentId,
        async (message) => {
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
        },
        { kind: principal.kind, principal: principal.name },
      );

      logger.info('sse stream opened', { agentId, by: principal.name });

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

  app.get(PATHS.history, auth, async (c) => {
    const principal = c.get('principal');
    const withOther = c.req.query('with') || undefined;
    const limitRaw = Number(c.req.query('limit') ?? String(DEFAULT_QUERY_LIMIT));
    const limit = Number.isFinite(limitRaw)
      ? Math.min(Math.max(limitRaw, 1), MAX_QUERY_LIMIT)
      : DEFAULT_QUERY_LIMIT;
    const beforeRaw = c.req.query('before');
    const before = beforeRaw ? Number(beforeRaw) : undefined;
    if (before !== undefined && !Number.isFinite(before)) {
      return c.json({ error: 'invalid `before` parameter' }, 400);
    }
    const eventLog = broker.getEventLog();
    const messages = await eventLog.query({
      viewer: principal.name,
      with: withOther,
      limit,
      before,
    });
    return c.json({ messages });
  });

  return app;
}
