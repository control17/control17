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
  CancelObjectiveRequestSchema,
  CompleteObjectiveRequestSchema,
  CreateObjectiveRequestSchema,
  DiscussObjectiveRequestSchema,
  ListObjectivesQuerySchema,
  PushPayloadSchema,
  PushSubscriptionPayloadSchema,
  ReassignObjectiveRequestSchema,
  TotpLoginRequestSchema,
  UpdateObjectiveRequestSchema,
  UpdateWatchersRequestSchema,
  UploadObjectiveTraceRequestSchema,
} from '@control17/sdk/schemas';
import type {
  Message,
  Objective,
  ObjectiveEvent,
  ObjectiveEventKind,
  Role,
  Squadron,
} from '@control17/sdk/types';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import { streamSSE } from 'hono/streaming';
import { type AuthBindings, createAuthMiddleware } from './auth.js';
import { composeBriefing } from './briefing.js';
import type { Logger } from './logger.js';
import { ObjectivesError, type ObjectivesStore } from './objectives.js';
import type { PushSubscriptionStore } from './push/store.js';
import { SESSION_COOKIE_NAME, SESSION_TTL_MS, type SessionStore } from './sessions.js';
import { type LoadedSlot, type SlotStore, teammatesFromStore } from './slots.js';
import { verifyCode as verifyTotpCode } from './totp.js';

export interface AppOptions {
  broker: Broker;
  slots: SlotStore;
  sessions: SessionStore;
  squadron: Squadron;
  roles: Record<string, Role>;
  /**
   * Objectives store — the server's authoritative task state. The
   * `/objectives*` endpoints are registered iff this is provided,
   * which lets tests opt out of the whole objectives surface when
   * they're only exercising chat paths.
   */
  objectives?: ObjectivesStore;
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

// Per-slot lockout — applies when the caller sent an explicit `slot`
// hint (CLI / targeted login). Same 5/15min sliding window as before.
const TOTP_MAX_FAILURES = 5;
const TOTP_LOCKOUT_WINDOW_MS = 15 * 60 * 1000;

// Global codeless lockout — applies to the SPA's "just type a code"
// login path where the server iterates slots to find a match. With N
// enrolled slots each guess has N× the per-slot hit chance, so we
// compensate with a tighter global cap in the same 15min window.
// 10 failures / 15min × 6-digit code space × ~10 enrolled slots works
// out to a multi-year expected-crack time, comparable to the old
// per-slot flow.
const TOTP_CODELESS_MAX_FAILURES = 10;
const CODELESS_LOCKOUT_KEY = '__codeless__';

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
  PATHS.objectives,
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
    squadron,
    roles,
    objectives,
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

  // Unified lockout map — per-slot buckets keyed on callsign plus a
  // global "codeless" bucket keyed on a fixed sentinel. Both obey
  // the same sliding-window shape; they differ only in their
  // max-failures threshold (per-slot = 5, codeless = 10).
  const totpLockouts = new Map<string, TotpLockout>();

  function maxFailuresFor(key: string): number {
    return key === CODELESS_LOCKOUT_KEY ? TOTP_CODELESS_MAX_FAILURES : TOTP_MAX_FAILURES;
  }

  function checkTotpLockout(key: string): { locked: boolean; retryAfter?: number } {
    const entry = totpLockouts.get(key);
    if (!entry) return { locked: false };
    const t = now();
    const elapsed = t - entry.firstFailureAt;
    if (elapsed >= TOTP_LOCKOUT_WINDOW_MS) {
      totpLockouts.delete(key);
      return { locked: false };
    }
    if (entry.failures >= maxFailuresFor(key)) {
      return {
        locked: true,
        retryAfter: Math.ceil((TOTP_LOCKOUT_WINDOW_MS - elapsed) / 1000),
      };
    }
    return { locked: false };
  }

  function recordTotpFailure(key: string): void {
    const t = now();
    const entry = totpLockouts.get(key);
    if (!entry || t - entry.firstFailureAt >= TOTP_LOCKOUT_WINDOW_MS) {
      totpLockouts.set(key, { failures: 1, firstFailureAt: t });
      return;
    }
    entry.failures += 1;
  }

  function clearTotpLockout(key: string): void {
    totpLockouts.delete(key);
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
    const { slot: providedCallsign, code } = parsed.data;

    // Two paths:
    //   1. `slot` was provided → targeted login (CLI, scripts that
    //      know their callsign). Uses the per-slot rate-limit bucket.
    //   2. `slot` was omitted → codeless login (SPA). Server iterates
    //      TOTP-enrolled slots to find a match. Uses the tighter
    //      global `__codeless__` rate-limit bucket to compensate for
    //      the multi-slot effective attack surface.
    const lockoutKey = providedCallsign ?? CODELESS_LOCKOUT_KEY;
    const lockout = checkTotpLockout(lockoutKey);
    if (lockout.locked) {
      return c.json(
        { error: 'too many attempts; try again later', retryAfter: lockout.retryAfter },
        429,
      );
    }

    // Resolve which slot we're about to verify against.
    // Targeted: look up by callsign (returns null on unknown/unenrolled).
    // Codeless: iterate all TOTP-enrolled slots in config order and
    // pick the first match. We iterate the full enrolled set even on
    // success to keep the verify loop's timing signal low (squadrons
    // have a handful of slots, not thousands, so cost is negligible).
    let matchedSlot: LoadedSlot | null = null;
    let matchedCounter = 0;

    if (providedCallsign !== undefined) {
      const slot = slots.resolveByCallsign(providedCallsign);
      if (slot?.totpSecret) {
        const verify = verifyTotpCode(slot.totpSecret, code, slot.totpLastCounter ?? 0, now());
        if (verify.ok) {
          matchedSlot = slot;
          matchedCounter = verify.counter;
        }
      }
    } else {
      // Codeless: iterate every enrolled slot. First ok-verify wins.
      // Ambiguous collisions (two slots with the same current code in
      // the same window) are statistically ~1-in-20K at 10 slots and
      // resolve in 30s when codes rotate, so first-match is fine.
      for (const slot of slots.slots()) {
        if (!slot.totpSecret) continue;
        const verify = verifyTotpCode(slot.totpSecret, code, slot.totpLastCounter ?? 0, now());
        if (verify.ok) {
          matchedSlot = slot;
          matchedCounter = verify.counter;
          break;
        }
      }
    }

    if (!matchedSlot) {
      recordTotpFailure(lockoutKey);
      logger.warn('totp login rejected', {
        path: providedCallsign ? 'targeted' : 'codeless',
        ...(providedCallsign ? { callsign: providedCallsign } : {}),
      });
      return c.json({ error: 'invalid code' }, 401);
    }

    const matchedCallsign = matchedSlot.callsign;

    // Accept: persist the new counter, clear both lockout buckets
    // (codeless on success + per-slot in case the caller had been
    // failing on the targeted path), mint a session.
    slots.recordTotpAccept(matchedCallsign, matchedCounter);
    clearTotpLockout(lockoutKey);
    // If the caller was on the codeless path, also clear any stray
    // per-slot lockout for the matched slot so a successful codeless
    // login unblocks a legit user who'd been fat-fingering via CLI.
    if (providedCallsign === undefined) {
      clearTotpLockout(matchedCallsign);
    }

    const userAgent = c.req.header('User-Agent') ?? null;
    const session = sessions.create(matchedCallsign, userAgent);

    setCookie(c, SESSION_COOKIE_NAME, session.id, {
      httpOnly: true,
      secure: secureCookies,
      sameSite: 'Strict',
      path: '/',
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
    });

    logger.info('session created', {
      callsign: matchedCallsign,
      path: providedCallsign ? 'targeted' : 'codeless',
      expiresAt: session.expiresAt,
    });
    return c.json({
      slot: matchedCallsign,
      role: matchedSlot.role,
      authority: matchedSlot.authority,
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
      authority: slot.authority,
      expiresAt,
    });
  });

  // ─── Squadron endpoints (dual-auth) ────────────────────────────────

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
    // Live open objectives for this slot — included in the briefing so
    // the link can bake them into its tool descriptions at startup.
    // Active + blocked are both "on the plate"; done/cancelled drop off.
    const openObjectives: Objective[] = objectives
      ? [
          ...objectives.list({ assignee: slot.callsign, status: 'active' }),
          ...objectives.list({ assignee: slot.callsign, status: 'blocked' }),
        ]
      : [];
    const briefing = composeBriefing({
      self: slot,
      selfRole,
      squadron,
      teammates: teammatesFromStore(slots),
      openObjectives,
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

  // ─── Objective endpoints ──────────────────────────────────────────
  // Registered iff an ObjectivesStore is provided — keeps chat-only
  // tests clean. Permission guards enforce the authority matrix:
  //   operator   — can see/update/complete objectives assigned to self
  //   lieutenant — operator + create + cancel own-originated + see squadron
  //   commander  — any mutation, see everything
  //
  // All mutations publish an `ObjectiveEvent` through the broker on
  // thread key `obj:<id>` so web clients + the link can react in
  // real time. The publish is fire-and-forget so an SSE failure
  // never blocks the HTTP response.
  if (objectives !== undefined) {
    /**
     * The set of callsigns that belong to an objective's thread.
     * Originator + assignee + explicit watchers + every slot with
     * commander authority ("commanders see everything in their
     * squadron"). For a `reassigned` event, also include the previous
     * assignee so they know the objective left their plate. For a
     * `watcher_removed` event, also include the removed watcher so
     * they get the exit notification before the next event skips
     * them entirely.
     *
     * This function is reused by the lifecycle-event publisher, the
     * `/discuss` endpoint, and the `/watchers` endpoint so every
     * surface that fans out a push uses the same membership rule.
     */
    const objectiveThreadMembers = (
      objective: Objective,
      extraEvent?: ObjectiveEvent,
    ): Set<string> => {
      const members = new Set<string>([objective.assignee, objective.originator]);
      for (const w of objective.watchers) members.add(w);
      for (const s of slots.slots()) {
        if (s.authority === 'commander') members.add(s.callsign);
      }
      if (extraEvent?.kind === 'reassigned') {
        const fromCs = extraEvent.payload.from;
        if (typeof fromCs === 'string') members.add(fromCs);
      }
      if (extraEvent?.kind === 'watcher_removed') {
        const cs = extraEvent.payload.callsign;
        if (typeof cs === 'string') members.add(cs);
      }
      return members;
    };

    const publishObjectiveEvent = async (
      objective: Objective,
      event: ObjectiveEvent,
      actor: string,
    ): Promise<void> => {
      const threadKey = `obj:${objective.id}`;
      const primaryTargets = objectiveThreadMembers(objective, event);
      const body = systemMessageForEvent(objective, event.kind, event);
      for (const target of primaryTargets) {
        if (!broker.hasAgent(target)) continue;
        try {
          await broker.push(
            {
              agentId: target,
              body,
              level: 'info',
              // Minimal machine meta: classification + ids for filtering.
              // The full objective state used to be serialized here as
              // `data.objective = JSON.stringify(...)`, but that landed
              // in the agent's channel-event envelope as a noisy XML
              // attribute. Agents read the human-readable `body` above
              // and call `objectives_view` for full state when they
              // need it — one extra tool call on the rare path, clean
              // events on the common path.
              data: {
                kind: 'objective',
                event: event.kind,
                objective_id: objective.id,
                objective_status: objective.status,
                thread: threadKey,
                actor,
              },
            },
            { from: actor },
          );
        } catch (err) {
          logger.warn('failed to fanout objective event', {
            objectiveId: objective.id,
            event: event.kind,
            target,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    };

    function mapObjectivesError(err: unknown): { status: number; body: { error: string } } {
      if (err instanceof ObjectivesError) {
        const status =
          err.code === 'not_found'
            ? 404
            : err.code === 'terminal' || err.code === 'invalid_transition'
              ? 409
              : 400;
        return { status, body: { error: err.message } };
      }
      return {
        status: 500,
        body: { error: err instanceof Error ? err.message : String(err) },
      };
    }

    // GET /objectives?assignee=&status=
    //
    // Operators see objectives they have any relationship with:
    // assigned, originated, or watching. Lieutenant+ see squadron-wide.
    // When an operator passes an explicit `assignee` filter, it must
    // match their own callsign — they can't fish for other operators'
    // plates. The watching filter has no equivalent explicit param
    // today; watched objectives appear in the default list.
    app.get(PATHS.objectives, auth, (c) => {
      const slot = c.get('slot');
      const raw = {
        assignee: c.req.query('assignee'),
        status: c.req.query('status'),
      };
      const parsed = ListObjectivesQuerySchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ error: 'invalid query', details: parsed.error.issues }, 400);
      }
      const filter = parsed.data;

      if (slot.authority === 'operator') {
        if (filter.assignee && filter.assignee !== slot.callsign) {
          return c.json({ error: 'operators may only list their own objectives' }, 403);
        }
        // Default scope for an operator: assigned OR originated OR watching.
        // App-level filter on the full list is fine at squadron scale
        // where objective counts are in the dozens, not thousands.
        const all = objectives.list(filter.status ? { status: filter.status } : {});
        const scoped = all.filter(
          (o) =>
            o.assignee === slot.callsign ||
            o.originator === slot.callsign ||
            o.watchers.includes(slot.callsign),
        );
        return c.json({ objectives: scoped });
      }
      return c.json({ objectives: objectives.list(filter) });
    });

    // GET /objectives/:id
    //
    // An operator can view an objective if they're the assignee, the
    // originator, or in the watcher list. Lieutenant+ can view any.
    app.get(`${PATHS.objectives}/:id`, auth, (c) => {
      const slot = c.get('slot');
      const id = c.req.param('id');
      const obj = objectives.get(id);
      if (!obj) return c.json({ error: `no such objective: ${id}` }, 404);
      if (
        slot.authority === 'operator' &&
        obj.assignee !== slot.callsign &&
        obj.originator !== slot.callsign &&
        !obj.watchers.includes(slot.callsign)
      ) {
        return c.json(
          {
            error: 'operators may only view objectives they are assigned, originated, or watching',
          },
          403,
        );
      }
      return c.json({ objective: obj, events: objectives.events(id) });
    });

    // POST /objectives (lieutenant+)
    app.post(PATHS.objectives, auth, async (c) => {
      const slot = c.get('slot');
      if (slot.authority === 'operator') {
        return c.json({ error: 'creating objectives requires lieutenant or commander' }, 403);
      }
      const raw = await c.req.json().catch(() => null);
      const parsed = CreateObjectiveRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ error: 'invalid objective payload', details: parsed.error.issues }, 400);
      }
      // Assignee must be a known slot on the squadron.
      if (!slots.resolveByCallsign(parsed.data.assignee)) {
        return c.json({ error: `unknown assignee: ${parsed.data.assignee}` }, 400);
      }
      // Every initial watcher must also resolve — catch typos at
      // creation time, not on the first fanout attempt.
      if (Array.isArray(parsed.data.watchers)) {
        for (const w of parsed.data.watchers) {
          if (!slots.resolveByCallsign(w)) {
            return c.json({ error: `unknown watcher: ${w}` }, 400);
          }
        }
      }
      try {
        const { objective: created, events } = objectives.create(parsed.data, slot.callsign);
        logger.info('objective created', {
          id: created.id,
          originator: slot.callsign,
          assignee: created.assignee,
        });
        queueMicrotask(() => {
          for (const ev of events) {
            void publishObjectiveEvent(created, ev, slot.callsign);
          }
        });
        return c.json(created);
      } catch (err) {
        const mapped = mapObjectivesError(err);
        return c.json(mapped.body, mapped.status as 400 | 404 | 409 | 500);
      }
    });

    // PATCH /objectives/:id (assignee OR commander)
    app.patch(`${PATHS.objectives}/:id`, auth, async (c) => {
      const slot = c.get('slot');
      const id = c.req.param('id');
      const current = objectives.get(id);
      if (!current) return c.json({ error: `no such objective: ${id}` }, 404);
      if (current.assignee !== slot.callsign && slot.authority !== 'commander') {
        return c.json({ error: 'only the assignee or a commander may update this objective' }, 403);
      }
      const raw = await c.req.json().catch(() => null);
      const parsed = UpdateObjectiveRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ error: 'invalid update payload', details: parsed.error.issues }, 400);
      }
      try {
        const { objective: updated, events } = objectives.update(id, parsed.data, slot.callsign);
        // `events` can have 0-2 entries: 0 for a no-op (status=current,
        // no note), 1 for a single status transition or a note-only
        // update, 2 for a status transition + note in the same call.
        // Publish each one individually so each landing push carries
        // its own structured body — the note's note, the block's
        // block reason, etc.
        queueMicrotask(() => {
          for (const ev of events) {
            void publishObjectiveEvent(updated, ev, slot.callsign);
          }
        });
        return c.json(updated);
      } catch (err) {
        const mapped = mapObjectivesError(err);
        return c.json(mapped.body, mapped.status as 400 | 404 | 409 | 500);
      }
    });

    // POST /objectives/:id/complete (assignee only)
    app.post(`${PATHS.objectives}/:id/complete`, auth, async (c) => {
      const slot = c.get('slot');
      const id = c.req.param('id');
      const current = objectives.get(id);
      if (!current) return c.json({ error: `no such objective: ${id}` }, 404);
      if (current.assignee !== slot.callsign) {
        return c.json({ error: 'only the assignee may complete this objective' }, 403);
      }
      const raw = await c.req.json().catch(() => null);
      const parsed = CompleteObjectiveRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ error: 'invalid complete payload', details: parsed.error.issues }, 400);
      }
      try {
        const { objective: updated, events } = objectives.complete(id, parsed.data, slot.callsign);
        queueMicrotask(() => {
          for (const ev of events) {
            void publishObjectiveEvent(updated, ev, slot.callsign);
          }
        });
        return c.json(updated);
      } catch (err) {
        const mapped = mapObjectivesError(err);
        return c.json(mapped.body, mapped.status as 400 | 404 | 409 | 500);
      }
    });

    // POST /objectives/:id/cancel (originator lieutenant+ or commander)
    app.post(`${PATHS.objectives}/:id/cancel`, auth, async (c) => {
      const slot = c.get('slot');
      const id = c.req.param('id');
      const current = objectives.get(id);
      if (!current) return c.json({ error: `no such objective: ${id}` }, 404);
      const isOriginator = current.originator === slot.callsign;
      const isCommander = slot.authority === 'commander';
      const isLieutenant = slot.authority === 'lieutenant';
      if (!(isCommander || (isLieutenant && isOriginator))) {
        return c.json(
          { error: 'only the originating lieutenant or a commander may cancel this objective' },
          403,
        );
      }
      const raw = await c.req.json().catch(() => ({}));
      const parsed = CancelObjectiveRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ error: 'invalid cancel payload', details: parsed.error.issues }, 400);
      }
      try {
        const { objective: updated, events } = objectives.cancel(id, parsed.data, slot.callsign);
        queueMicrotask(() => {
          for (const ev of events) {
            void publishObjectiveEvent(updated, ev, slot.callsign);
          }
        });
        return c.json(updated);
      } catch (err) {
        const mapped = mapObjectivesError(err);
        return c.json(mapped.body, mapped.status as 400 | 404 | 409 | 500);
      }
    });

    // POST /objectives/:id/reassign (commander only)
    app.post(`${PATHS.objectives}/:id/reassign`, auth, async (c) => {
      const slot = c.get('slot');
      if (slot.authority !== 'commander') {
        return c.json({ error: 'only a commander may reassign objectives' }, 403);
      }
      const id = c.req.param('id');
      const raw = await c.req.json().catch(() => null);
      const parsed = ReassignObjectiveRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ error: 'invalid reassign payload', details: parsed.error.issues }, 400);
      }
      if (!slots.resolveByCallsign(parsed.data.to)) {
        return c.json({ error: `unknown assignee: ${parsed.data.to}` }, 400);
      }
      try {
        const { objective: updated, events } = objectives.reassign(id, parsed.data, slot.callsign);
        queueMicrotask(() => {
          for (const ev of events) {
            void publishObjectiveEvent(updated, ev, slot.callsign);
          }
        });
        return c.json(updated);
      } catch (err) {
        const mapped = mapObjectivesError(err);
        return c.json(mapped.body, mapped.status as 400 | 404 | 409 | 500);
      }
    });

    // POST /objectives/:id/watchers
    //
    // Add and/or remove watchers on an objective. Permitted to:
    //   - any commander (squadron-wide admin)
    //   - the originating lieutenant (they own the objective they made)
    // Every callsign in both `add` and `remove` must resolve to a
    // known slot. Watcher mutations produce `watcher_added` and
    // `watcher_removed` audit events that fan out to the full
    // post-change thread membership (plus removed parties so they
    // get the exit notification).
    app.post(`${PATHS.objectives}/:id/watchers`, auth, async (c) => {
      const slot = c.get('slot');
      const id = c.req.param('id');
      const current = objectives.get(id);
      if (!current) return c.json({ error: `no such objective: ${id}` }, 404);

      const isOriginator = current.originator === slot.callsign;
      const isCommander = slot.authority === 'commander';
      const isLieutenant = slot.authority === 'lieutenant';
      if (!(isCommander || (isLieutenant && isOriginator))) {
        return c.json(
          {
            error:
              'only a commander or the originating lieutenant may change watchers on this objective',
          },
          403,
        );
      }

      const raw = await c.req.json().catch(() => null);
      const parsed = UpdateWatchersRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ error: 'invalid watchers payload', details: parsed.error.issues }, 400);
      }

      // Validate every callsign in both lists.
      for (const cs of parsed.data.add ?? []) {
        if (!slots.resolveByCallsign(cs)) {
          return c.json({ error: `unknown watcher: ${cs}` }, 400);
        }
      }
      for (const cs of parsed.data.remove ?? []) {
        if (!slots.resolveByCallsign(cs)) {
          return c.json({ error: `unknown watcher: ${cs}` }, 400);
        }
      }

      try {
        const { objective: updated, events } = objectives.updateWatchers(
          id,
          parsed.data,
          slot.callsign,
        );
        queueMicrotask(() => {
          for (const ev of events) {
            void publishObjectiveEvent(updated, ev, slot.callsign);
          }
        });
        return c.json(updated);
      } catch (err) {
        const mapped = mapObjectivesError(err);
        return c.json(mapped.body, mapped.status as 400 | 404 | 409 | 500);
      }
    });

    // POST /objectives/:id/discuss (thread members only)
    //
    // Discussion posts are real squadron messages with thread key
    // `obj:<id>`. The server fans out to every thread member via
    // `broker.push` — one targeted push per member so the existing
    // single-`agentId` broker API still works. The message lands in
    // the event log alongside chat, visible in the web UI's inline
    // thread and in `recent`/`history` for anyone filtering by thread.
    //
    // The caller itself also receives its own message back via the
    // fanout (broker.push targets the sender). The link's self-echo
    // suppression DOES apply here — agents won't see their own
    // objective-discussion posts on the live stream — which is the
    // same behaviour as `broadcast`/`send`. The web client still
    // renders its own posts because the web SSE handler does NOT
    // suppress self-echoes.
    // POST /objectives/:id/traces (assignee only)
    //
    // The current assignee's runner uploads decoded LLM traces here.
    // Gate on exact assignee match — not commanders, not originators.
    // If a reassignment has happened mid-flight, the old assignee can
    // no longer upload to the objective, which is correct: the trace
    // belongs to whoever is doing the work now.
    app.post(`${PATHS.objectives}/:id/traces`, auth, async (c) => {
      const slot = c.get('slot');
      const id = c.req.param('id');
      const current = objectives.get(id);
      if (!current) return c.json({ error: `no such objective: ${id}` }, 404);
      if (current.assignee !== slot.callsign) {
        return c.json({ error: 'only the current assignee may upload traces' }, 403);
      }
      const raw = await c.req.json().catch(() => null);
      const parsed = UploadObjectiveTraceRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ error: 'invalid trace payload', details: parsed.error.issues }, 400);
      }
      try {
        const trace = objectives.appendTrace(id, parsed.data);
        return c.json(trace, 201);
      } catch (err) {
        const mapped = mapObjectivesError(err);
        return c.json(mapped.body, mapped.status as 400 | 404 | 409 | 500);
      }
    });

    // GET /objectives/:id/traces (commander only)
    //
    // Traces contain decrypted LLM prompts + completions, which are
    // the most sensitive content on the squadron net. Only commanders
    // can view them — operators, lieutenants, assignees, and watchers
    // all get 403. This matches the spec's "commander-gated review"
    // stance for trace content.
    app.get(`${PATHS.objectives}/:id/traces`, auth, async (c) => {
      const slot = c.get('slot');
      if (slot.authority !== 'commander') {
        return c.json({ error: 'only commanders may view objective traces' }, 403);
      }
      const id = c.req.param('id');
      const current = objectives.get(id);
      if (!current) return c.json({ error: `no such objective: ${id}` }, 404);
      const traces = objectives.listTraces(id);
      return c.json({ traces });
    });

    app.post(`${PATHS.objectives}/:id/discuss`, auth, async (c) => {
      const slot = c.get('slot');
      const id = c.req.param('id');
      const objective = objectives.get(id);
      if (!objective) return c.json({ error: `no such objective: ${id}` }, 404);

      const members = objectiveThreadMembers(objective);
      if (!members.has(slot.callsign)) {
        return c.json(
          { error: `slot '${slot.callsign}' is not a member of objective ${id}'s thread` },
          403,
        );
      }

      const raw = await c.req.json().catch(() => null);
      const parsed = DiscussObjectiveRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ error: 'invalid discuss payload', details: parsed.error.issues }, 400);
      }

      const threadKey = `obj:${id}`;
      let canonical: Message | null = null;
      for (const target of members) {
        if (!broker.hasAgent(target)) continue;
        try {
          const result = await broker.push(
            {
              agentId: target,
              body: parsed.data.body,
              title: parsed.data.title ?? null,
              level: 'info',
              data: {
                kind: 'objective_discuss',
                objective_id: id,
                thread: threadKey,
              },
            },
            { from: slot.callsign },
          );
          // Grab the first returned message as the canonical response
          // — every fanout push produces the same Message shape, and
          // callers just want to know "my post landed as msg X" so
          // they can dedupe. Subsequent fanouts reuse different ids
          // internally but that's the broker's concern.
          if (canonical === null) canonical = result.message;
        } catch (err) {
          logger.warn('failed to fanout objective discuss', {
            objectiveId: id,
            target,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (!canonical) {
        // Shouldn't happen — the caller is at least a member, and
        // `broker.hasAgent` should be true for any active callsign.
        // Return 202 semantics as 200 with an empty-ish body rather
        // than faking a Message shape.
        return c.json({ error: 'no thread members are currently registered with the broker' }, 503);
      }
      return c.json(canonical);
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

/**
 * Render the human-readable body for a lifecycle event's channel push.
 * This is what the agent actually reads in its channel envelope — it
 * has to carry enough structured context that the agent can act on
 * the event without immediately calling `objectives_view`. Kept out of
 * the store so the store stays free of wire-format concerns.
 *
 * Format: a one-line header identifying the event, followed by a
 * structured block of `key: value` lines for the fields the agent
 * cares about. The lines are plain text (no JSON, no XML) so they
 * flow naturally in the agent's context window alongside chat.
 */
function systemMessageForEvent(
  objective: Objective,
  kind: ObjectiveEventKind,
  event: ObjectiveEvent | undefined,
): string {
  const header = `[objective ${kind}] ${objective.id}`;

  switch (kind) {
    case 'assigned': {
      return [
        header,
        `title:      ${objective.title}`,
        `outcome:    ${objective.outcome}`,
        `assignee:   ${objective.assignee}`,
        `originator: ${objective.originator}`,
        `status:     ${objective.status}`,
        objective.body ? `body:       ${objective.body}` : null,
      ]
        .filter((l): l is string => l !== null)
        .join('\n');
    }
    case 'blocked': {
      const reason =
        typeof event?.payload.reason === 'string' ? event.payload.reason : '(no reason given)';
      return [
        header,
        `title:    ${objective.title}`,
        `assignee: ${objective.assignee}`,
        `reason:   ${reason}`,
      ].join('\n');
    }
    case 'unblocked': {
      return [
        header,
        `title:    ${objective.title}`,
        `assignee: ${objective.assignee}`,
        `status:   active (resumed)`,
      ].join('\n');
    }
    case 'completed': {
      return [
        header,
        `title:    ${objective.title}`,
        `outcome:  ${objective.outcome}`,
        `assignee: ${objective.assignee}`,
        `result:   ${objective.result ?? ''}`,
      ].join('\n');
    }
    case 'cancelled': {
      const reason =
        typeof event?.payload.reason === 'string' ? event.payload.reason : '(no reason given)';
      return [
        header,
        `title:    ${objective.title}`,
        `assignee: ${objective.assignee}`,
        `reason:   ${reason}`,
      ].join('\n');
    }
    case 'reassigned': {
      const from = typeof event?.payload.from === 'string' ? event.payload.from : '(unknown)';
      const to = typeof event?.payload.to === 'string' ? event.payload.to : objective.assignee;
      return [
        header,
        `title:   ${objective.title}`,
        `outcome: ${objective.outcome}`,
        `from:    ${from}`,
        `to:      ${to}`,
      ].join('\n');
    }
    case 'watcher_added': {
      const cs = typeof event?.payload.callsign === 'string' ? event.payload.callsign : '(unknown)';
      return [
        header,
        `title:    ${objective.title}`,
        `outcome:  ${objective.outcome}`,
        `watcher:  ${cs}`,
        `status:   ${objective.status}`,
      ].join('\n');
    }
    case 'watcher_removed': {
      const cs = typeof event?.payload.callsign === 'string' ? event.payload.callsign : '(unknown)';
      return [header, `title:   ${objective.title}`, `watcher: ${cs}`].join('\n');
    }
  }
}
