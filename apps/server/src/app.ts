/**
 * Hono application factory for the control17 broker.
 *
 * Routes:
 *   GET  /healthz         — unauthed, liveness probe
 *   POST /session/totp    — unauthed, exchange TOTP code for a session cookie
 *   POST /session/logout  — session-auth, clear the session
 *   GET  /session         — session-auth, return current session info
 *   GET  /briefing        — dual-auth, team-context packet for the slot
 *   GET  /roster          — dual-auth, full teammate list + live connection state
 *   POST /push            — dual-auth, deliver a message to one teammate or broadcast
 *   GET  /subscribe       — dual-auth, long-lived SSE stream of messages for a callsign
 *   GET  /history         — dual-auth, prior messages filtered by viewer scope
 *
 * Dual-auth = either `Authorization: Bearer <token>` (machine plane,
 * MCP link) or `Cookie: c17_session=<id>` (human plane, web SPA).
 * Both resolve to the same `LoadedSlot`, which downstream handlers
 * use to stamp authoritative `from` on pushes and to gate identity
 * checks on subscribe. All routes must carry `X-C17-Protocol: 1` if
 * the header is present.
 */

import { existsSync } from 'node:fs';
import { type Broker, clampQueryLimit } from '@control17/core';
import { PATHS, PROTOCOL_HEADER, PROTOCOL_VERSION } from '@control17/sdk/protocol';
import {
  CallsignSchema,
  PushPayloadSchema,
  PushSubscriptionPayloadSchema,
  TotpLoginRequestSchema,
} from '@control17/sdk/schemas';
import type { Message, Role, Team } from '@control17/sdk/types';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import { streamSSE } from 'hono/streaming';
import { type AuthBindings, createAuthMiddleware } from './auth.js';
import { composeBriefing } from './briefing.js';
import type { Logger } from './logger.js';
import type { PushSubscriptionStore } from './push/store.js';
import { SESSION_COOKIE_NAME, SESSION_TTL_MS, type SessionStore } from './sessions.js';
import { type LoadedSlot, type SlotStore, teammatesFromStore } from './slots.js';
import { verifyCode as verifyTotpCode } from './totp.js';

export interface AppOptions {
  broker: Broker;
  slots: SlotStore;
  sessions: SessionStore;
  team: Team;
  roles: Record<string, Role>;
  version: string;
  logger: Logger;
  /**
   * Whether the server is listening over HTTPS. Controls the `Secure`
   * attribute on the session cookie — we MUST NOT set Secure on a
   * plain-HTTP listener (browsers drop the cookie on the next request),
   * and we MUST set it on HTTPS (sending a session cookie in cleartext
   * is a leak).
   */
  secureCookies?: boolean;
  /**
   * Triggered when the server is shutting down. Open SSE streams
   * listen for this so they can tear down cleanly and let
   * `http.Server.close()` complete.
   */
  shutdownSignal?: AbortSignal;
  /**
   * Absolute path to the directory containing the built `@control17/web`
   * bundle (index.html + assets/). When set, the server serves the
   * SPA at `/` plus SPA fallback for any non-API GET request. When
   * omitted or missing on disk, no SPA routes are registered — useful
   * for tests and for the machine-only auth plane where the web UI
   * isn't built.
   */
  publicRoot?: string;
  /**
   * Web Push subscription store + VAPID public key. When both are
   * present, the `/push/vapid-public-key` and `/push/subscriptions`
   * endpoints are registered and the `onPushed` hook fires push
   * dispatch for every message. Omit for tests or machine-only
   * deployments that don't need browser notifications.
   */
  pushStore?: PushSubscriptionStore;
  vapidPublicKey?: string;
  /**
   * Fired once per successful `/push` (or broker-level push) with the
   * stamped message. Runs in the background — do not await it in the
   * request path. The broker-fanout integration lives here so the
   * push-dispatch side effect stays out of the HTTP handler.
   */
  onPushed?: (message: Message) => void;
  /**
   * Clock injection for tests — rate-limit book-keeping uses `now()`
   * so tests don't have to wall-clock-wait to see a lockout expire.
   */
  now?: () => number;
}

type AppBindings = AuthBindings;

/**
 * Rate-limit bucket for TOTP login attempts. Keyed by slot callsign —
 * an attacker hammering one slot can't accidentally lock a different
 * one out. In-memory, per-process; a restart clears the bucket, which
 * is acceptable at our scale (no distributed deployment yet).
 *
 * Sliding window: we count failures within `TOTP_LOCKOUT_WINDOW_MS`.
 * Lockout is implicit — when `failures >= TOTP_MAX_FAILURES` and the
 * window hasn't elapsed yet, any further attempt is rejected. Once
 * the window elapses the bucket is cleared and the slot can try again.
 */
interface TotpLockout {
  failures: number;
  firstFailureAt: number;
}

const TOTP_MAX_FAILURES = 5;
const TOTP_LOCKOUT_WINDOW_MS = 15 * 60 * 1000;

/**
 * The set of request paths we treat as "API." Any GET outside this
 * set falls through to the SPA fallback when `publicRoot` is set, so
 * client-side routes like `/login` or `/dm/build-bot` resolve to
 * `index.html` instead of 404. Keep in sync with `PATHS` + the
 * session endpoints.
 */
const API_PATH_PREFIXES = [
  PATHS.health,
  PATHS.briefing,
  PATHS.roster,
  PATHS.push,
  PATHS.subscribe,
  PATHS.history,
  PATHS.sessionTotp,
  PATHS.sessionLogout,
  PATHS.session,
  PATHS.pushVapidPublicKey,
  PATHS.pushSubscriptions,
] as const;

function isApiPath(pathname: string): boolean {
  for (const p of API_PATH_PREFIXES) {
    if (pathname === p || pathname.startsWith(`${p}/`) || pathname.startsWith(p)) {
      return true;
    }
  }
  return false;
}

export function createApp(options: AppOptions): Hono<AppBindings> {
  const {
    broker,
    slots,
    sessions,
    team,
    roles,
    version,
    logger,
    shutdownSignal,
    secureCookies = false,
    publicRoot,
    pushStore,
    vapidPublicKey,
    onPushed,
  } = options;
  const now = options.now ?? Date.now;
  const app = new Hono<AppBindings>();

  const auth = createAuthMiddleware({ slots, sessions, logger });

  const totpLockouts = new Map<string, TotpLockout>();

  function checkTotpLockout(callsign: string): { locked: boolean; retryAfter?: number } {
    const entry = totpLockouts.get(callsign);
    if (!entry) return { locked: false };
    const t = now();
    const elapsed = t - entry.firstFailureAt;
    if (elapsed >= TOTP_LOCKOUT_WINDOW_MS) {
      // Window expired — caller gets a fresh slate.
      totpLockouts.delete(callsign);
      return { locked: false };
    }
    if (entry.failures >= TOTP_MAX_FAILURES) {
      return {
        locked: true,
        retryAfter: Math.ceil((TOTP_LOCKOUT_WINDOW_MS - elapsed) / 1000),
      };
    }
    return { locked: false };
  }

  function recordTotpFailure(callsign: string): void {
    const t = now();
    const entry = totpLockouts.get(callsign);
    if (!entry || t - entry.firstFailureAt >= TOTP_LOCKOUT_WINDOW_MS) {
      totpLockouts.set(callsign, { failures: 1, firstFailureAt: t });
      return;
    }
    entry.failures += 1;
  }

  function clearTotpLockout(callsign: string): void {
    totpLockouts.delete(callsign);
  }

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

  // ─── Session endpoints ────────────────────────────────────────────

  app.post(PATHS.sessionTotp, async (c) => {
    const raw = await c.req.json().catch(() => null);
    const parsed = TotpLoginRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: 'invalid login payload', details: parsed.error.issues }, 400);
    }
    const { slot: callsign, code } = parsed.data;

    // Rate-limit check BEFORE slot lookup so attackers can't enumerate
    // valid callsigns via timing (the unknown-callsign path is as slow
    // as a failed verify).
    const lockout = checkTotpLockout(callsign);
    if (lockout.locked) {
      return c.json(
        { error: 'too many attempts; try again later', retryAfter: lockout.retryAfter },
        429,
      );
    }

    const slot = slots.resolveByCallsign(callsign);
    if (!slot?.totpSecret) {
      // Generic error: don't reveal whether the slot exists or is
      // TOTP-enrolled. Still count it as a failure for rate-limit
      // purposes so attackers can't probe slot names cheaply.
      recordTotpFailure(callsign);
      logger.warn('totp login rejected: no such enrolled slot', { callsign });
      return c.json({ error: 'invalid code' }, 401);
    }

    const verify = verifyTotpCode(slot.totpSecret, code, slot.totpLastCounter ?? 0, now());
    if (!verify.ok) {
      recordTotpFailure(callsign);
      logger.warn('totp login rejected', { callsign, reason: verify.reason });
      return c.json({ error: 'invalid code' }, 401);
    }

    // Accept: persist the new counter, clear the lockout, mint a session.
    slots.recordTotpAccept(callsign, verify.counter);
    clearTotpLockout(callsign);

    const userAgent = c.req.header('User-Agent') ?? null;
    const session = sessions.create(callsign, userAgent);

    setCookie(c, SESSION_COOKIE_NAME, session.id, {
      httpOnly: true,
      secure: secureCookies,
      sameSite: 'Strict',
      path: '/',
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
    });

    logger.info('session created', { callsign, expiresAt: session.expiresAt });
    return c.json({
      slot: callsign,
      role: slot.role,
      expiresAt: session.expiresAt,
    });
  });

  app.post(PATHS.sessionLogout, auth, (c) => {
    const sessionId = c.get('sessionId');
    if (sessionId) {
      sessions.delete(sessionId);
    }
    deleteCookie(c, SESSION_COOKIE_NAME, { path: '/' });
    return c.body(null, 204);
  });

  app.get(PATHS.session, auth, (c) => {
    const slot = c.get('slot');
    const sessionId = c.get('sessionId');
    // Cookie-auth requests have a sessionId so we can return expiresAt;
    // bearer-auth requests (machine plane) do not, and we report the
    // far future so clients don't infer a misleading expiry.
    const expiresAt = sessionId
      ? (sessions.get(sessionId)?.expiresAt ?? now() + SESSION_TTL_MS)
      : Number.MAX_SAFE_INTEGER;
    return c.json({
      slot: slot.callsign,
      role: slot.role,
      expiresAt,
    });
  });

  // ─── Team endpoints (dual-auth) ───────────────────────────────────

  app.get(PATHS.briefing, auth, (c) => {
    const slot = c.get('slot');
    const selfRole = roles[slot.role];
    if (!selfRole) {
      // Shouldn't happen — config validation ensures every slot role
      // key exists in the roles map. Surface clearly if it does.
      logger.error('briefing: unknown role for slot', {
        callsign: slot.callsign,
        role: slot.role,
      });
      return c.json({ error: `unknown role '${slot.role}' for slot '${slot.callsign}'` }, 500);
    }
    const briefing = composeBriefing({
      self: slot,
      selfRole,
      team,
      teammates: teammatesFromStore(slots),
    });
    return c.json(briefing);
  });

  app.get(PATHS.roster, auth, (c) => {
    return c.json({
      teammates: teammatesFromStore(slots),
      connected: broker.listAgents(),
    });
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
    const slot = c.get('slot');
    const result = await broker.push(parsed.data, { from: slot.callsign });
    logger.info('push delivered', {
      messageId: result.message.id,
      from: slot.callsign,
      targetAgent: parsed.data.agentId ?? '*broadcast*',
      sse: result.delivery.sse,
      targets: result.delivery.targets,
    });
    // Fire-and-forget the push notification fanout. We don't await —
    // notification delivery shouldn't block the HTTP response, and
    // onPushed is responsible for its own error handling.
    if (onPushed) {
      queueMicrotask(() => {
        onPushed(result.message);
      });
    }
    return c.json(result);
  });

  // ─── Web Push endpoints ───────────────────────────────────────────

  if (vapidPublicKey !== undefined) {
    app.get(PATHS.pushVapidPublicKey, (c) => {
      return c.json({ publicKey: vapidPublicKey });
    });
  }

  if (pushStore !== undefined) {
    app.post(PATHS.pushSubscriptions, auth, async (c) => {
      const raw = await c.req.json().catch(() => null);
      const parsed = PushSubscriptionPayloadSchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ error: 'invalid push subscription', details: parsed.error.issues }, 400);
      }
      const slot = c.get('slot');
      const userAgent = c.req.header('User-Agent') ?? null;
      const row = pushStore.upsert({
        slotCallsign: slot.callsign,
        endpoint: parsed.data.endpoint,
        p256dh: parsed.data.keys.p256dh,
        auth: parsed.data.keys.auth,
        userAgent,
      });
      logger.info('push subscription registered', {
        callsign: slot.callsign,
        id: row.id,
      });
      return c.json({ id: row.id, endpoint: row.endpoint, createdAt: row.createdAt });
    });

    app.delete(`${PATHS.pushSubscriptions}/:id`, auth, (c) => {
      const idParam = c.req.param('id');
      const id = Number.parseInt(idParam, 10);
      if (!Number.isFinite(id) || id < 1) {
        return c.json({ error: 'invalid subscription id' }, 400);
      }
      const slot = c.get('slot');
      pushStore.deleteForSlot(id, slot.callsign);
      return c.body(null, 204);
    });
  }

  app.get(PATHS.subscribe, auth, (c) => {
    const agentId = c.req.query('agentId');
    if (!agentId) {
      return c.json({ error: 'agentId query parameter is required' }, 400);
    }
    const slot = c.get('slot');

    // Identity check has to happen BEFORE we hand the stream to
    // streamSSE; otherwise the client sees 200 + an empty SSE stream
    // when we should be returning 403. agentId MUST equal the
    // caller's callsign.
    if (agentId !== slot.callsign) {
      logger.warn('subscribe rejected: identity mismatch', {
        agentId,
        callsign: slot.callsign,
      });
      return c.json(
        {
          error:
            `slot '${slot.callsign}' cannot subscribe to agent '${agentId}'; ` +
            `agentId must equal the calling slot's callsign`,
        },
        403,
      );
    }

    return streamSSE(c, async (stream) => {
      // Identity was already verified above, so `broker.subscribe`
      // cannot throw AgentIdentityError here. If the pre-stream check
      // is ever relaxed, that's a bug — we'd serve 200 + empty-body.
      // Keep the check above watertight and don't add a redundant
      // post-stream catch that would hide the regression.
      const unsubscribe = broker.subscribe(
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
        { role: slot.role, callsign: slot.callsign },
      );

      // Shutdown signal aborts all live streams so `http.Server.close()`
      // can finish. Without this, an idle SSE client would pin the
      // server open indefinitely and SIGTERM would hang.
      const onShutdown = () => {
        stream.abort();
      };
      shutdownSignal?.addEventListener('abort', onShutdown, { once: true });

      stream.onAbort(() => {
        unsubscribe();
        shutdownSignal?.removeEventListener('abort', onShutdown);
        logger.info('sse stream closed', { agentId, by: slot.callsign });
      });

      logger.info('sse stream opened', { agentId, by: slot.callsign });

      // Initial comment so clients see the connection immediately, even
      // if no push arrives for a while.
      await stream.writeSSE({ event: 'connected', data: agentId });

      // Keep the handler alive until the client disconnects or the
      // server is shutting down; send a periodic keepalive so idle
      // proxies don't drop us.
      while (!stream.aborted && !shutdownSignal?.aborted) {
        await stream.sleep(15_000);
        if (stream.aborted || shutdownSignal?.aborted) break;
        await stream.writeSSE({ event: 'keepalive', data: '' });
      }
    });
  });

  app.get(PATHS.history, auth, async (c) => {
    const slot = c.get('slot');

    const withRaw = c.req.query('with');
    let withOther: string | undefined;
    if (withRaw !== undefined && withRaw.length > 0) {
      const parsed = CallsignSchema.safeParse(withRaw);
      if (!parsed.success) {
        return c.json(
          { error: '`with` must be a valid callsign', details: parsed.error.issues },
          400,
        );
      }
      withOther = parsed.data;
    }

    const limitQuery = c.req.query('limit');
    const limit = clampQueryLimit(limitQuery === undefined ? undefined : Number(limitQuery));
    const beforeRaw = c.req.query('before');
    const before = beforeRaw ? Number(beforeRaw) : undefined;
    if (before !== undefined && !Number.isFinite(before)) {
      return c.json({ error: 'invalid `before` parameter' }, 400);
    }

    const eventLog = broker.getEventLog();
    const messages = await eventLog.query({
      viewer: slot.callsign,
      with: withOther,
      limit,
      before,
    });
    return c.json({ messages });
  });

  // ─── Static SPA serving (registered LAST so API routes match first) ─

  if (publicRoot && existsSync(publicRoot)) {
    // Absolute root works despite serveStatic's docstring — the
    // implementation uses `path.join(root, filename)` which handles
    // absolute `root` correctly. We guard `existsSync` up front so
    // a stale `publicRoot` prints a Hono warning at startup rather
    // than 404ing every request silently.
    //
    // Two-phase serving:
    //   1. Direct file match (assets, manifest, icons, the root index)
    //   2. SPA fallback — for any GET that isn't an API path AND
    //      wasn't a direct file hit, serve index.html so client-side
    //      routing (preact-iso) can take over.
    app.use('*', serveStatic({ root: publicRoot }));
    app.get('*', async (c, next) => {
      if (isApiPath(c.req.path)) return next();
      return serveStatic({ root: publicRoot, path: 'index.html' })(c, next);
    });
  }

  return app;
}

/** Re-export so `LoadedSlot` consumers don't have to dig into slots.ts. */
export type { LoadedSlot };
