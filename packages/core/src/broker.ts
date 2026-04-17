/**
 * Broker — the runtime-agnostic core of control17.
 *
 * Ties the agent registry to an event log and handles the push fanout.
 * Knows nothing about HTTP, MCP, or persistence; runtime adapters layer
 * those on top.
 *
 * Identity model: every authenticated caller occupies a slot with a
 * unique `callsign`. The broker enforces `agentId === callsign` on
 * register and subscribe, so a slot can only act on its own agent.
 * DMs go to the target agent and also fan out to the sender's agent
 * (if registered), which keeps multiple live sessions of the same
 * slot in sync with zero client-side bookkeeping.
 */

import type { Agent, Message, PushPayload, PushResult, Slot } from '@control17/sdk/types';
import type { EventLog } from './event-log.js';
import { AgentIdentityError, AgentRegistry, type AgentState, type Subscriber } from './registry.js';

export interface BrokerLogger {
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export interface BrokerOptions {
  eventLog: EventLog;
  /** Clock injection point. Defaults to `Date.now`. */
  now?: () => number;
  /** ID factory. Defaults to `crypto.randomUUID`. */
  idFactory?: () => string;
  /** Logger for subscriber-side failures and diagnostics. */
  logger?: BrokerLogger;
  /**
   * Max subscribers invoked in parallel during a single `push`. Keeps
   * one slow SSE writer from head-of-line-blocking every other
   * subscriber on the same push, while still bounding fan-out
   * concurrency so a pathological 10000-subscriber broadcast doesn't
   * spawn 10000 simultaneous async tasks.
   *
   * Defaults to 32 — comfortably parallel for real squadron-scale
   * workloads (≤100 concurrent subscribers total), cheap enough
   * that smaller deployments see no overhead. Set to 1 to keep the
   * pre-2026-04-16 serial behavior for debugging.
   */
  fanoutConcurrency?: number;
}

/**
 * Per-push context supplied by the runtime adapter. `from` is the
 * authenticated slot's callsign; the broker stamps it onto
 * `message.from` verbatim and never reads sender identity from the
 * payload. Pass `from: null` for unauthenticated / system-originated
 * pushes (tests, internal fanout).
 */
export interface PushContext {
  from: string | null;
}

/**
 * Per-register / per-subscribe context. `callsign` is the caller's
 * authenticated identity — the broker checks it matches the
 * `agentId` being registered/subscribed. Pass `callsign: null` to
 * skip the check (tests, in-process core usage without a runtime).
 * `role` is cosmetic and surfaces on the agent's roster entry.
 */
export interface IdentityContext {
  callsign?: string | null;
  role?: string | null;
}

export interface RegistrationResult {
  agentId: string;
  registeredAt: number;
}

const NOOP_LOGGER: BrokerLogger = {
  warn: () => {},
  error: () => {},
};

const EMPTY_IDENTITY: IdentityContext = {};

const DEFAULT_FANOUT_CONCURRENCY = 32;

/**
 * Minimal bounded-parallel `forEach` over async callbacks. Runs up to
 * `concurrency` callbacks in flight at once; awaits all of them
 * before resolving. Exceptions from individual callbacks are passed
 * to `onError` and swallowed from the caller's perspective — fan-out
 * must be best-effort-to-each-subscriber rather than all-or-nothing,
 * because one stuck SSE writer should not prevent delivery to the
 * other 99 subscribers on the same push.
 *
 * Kept as an inline helper (rather than adding `p-limit` as a core
 * dep) because `@control17/core` is deliberately dep-light — it
 * carries only `@control17/sdk` as a runtime dep. A 15-line
 * semaphore is cheaper than dragging p-limit into every non-Node
 * runtime that wants to embed the broker.
 */
async function boundedParallel<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
  onError: (item: T, err: unknown) => void,
): Promise<void> {
  if (items.length === 0) return;
  const limit = Math.max(1, Math.floor(concurrency));
  if (limit >= items.length) {
    await Promise.all(
      items.map(async (item) => {
        try {
          await worker(item);
        } catch (err) {
          onError(item, err);
        }
      }),
    );
    return;
  }
  let next = 0;
  const runners: Promise<void>[] = [];
  for (let i = 0; i < limit; i++) {
    runners.push(
      (async () => {
        while (true) {
          const index = next++;
          if (index >= items.length) return;
          const item = items[index] as T;
          try {
            await worker(item);
          } catch (err) {
            onError(item, err);
          }
        }
      })(),
    );
  }
  await Promise.all(runners);
}

export class Broker {
  private readonly registry = new AgentRegistry();
  private readonly eventLog: EventLog;
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly logger: BrokerLogger;
  private readonly fanoutConcurrency: number;

  constructor(options: BrokerOptions) {
    this.eventLog = options.eventLog;
    this.now = options.now ?? (() => Date.now());
    this.idFactory =
      options.idFactory ??
      (() => {
        if (!globalThis.crypto?.randomUUID) {
          throw new Error('Broker: globalThis.crypto.randomUUID is unavailable');
        }
        return globalThis.crypto.randomUUID();
      });
    this.logger = options.logger ?? NOOP_LOGGER;
    this.fanoutConcurrency = options.fanoutConcurrency ?? DEFAULT_FANOUT_CONCURRENCY;
  }

  /**
   * Explicitly register an agent so it shows up in listAgents(). If
   * `context.callsign` is supplied it must equal `agentId`; any
   * mismatch throws `AgentIdentityError`. Core tests skip the check
   * by passing no context.
   */
  async register(
    agentId: string,
    context: IdentityContext = EMPTY_IDENTITY,
  ): Promise<RegistrationResult> {
    this.assertIdentity(agentId, context.callsign);
    const state = this.registry.registerOrGet(agentId, this.now(), context.role ?? null);
    return {
      agentId: state.agent.agentId,
      registeredAt: state.agent.createdAt,
    };
  }

  /**
   * Pre-populate the registry with every slot defined in the team
   * config. Called once at server boot so the roster shows the full
   * team structure even before anyone has connected. Connection state
   * is still tracked live via SSE subscribers; seeding only creates
   * the zero-subscriber AgentState entry.
   */
  seedSlots(slots: Iterable<Slot>): void {
    const ts = this.now();
    for (const slot of slots) {
      this.registry.registerOrGet(slot.callsign, ts, slot.role, slot.authority);
    }
  }

  /**
   * Push a message to one agent (if `payload.agentId` is set) or
   * broadcast to all registered agents. Always writes to the event
   * log. Always returns the constructed Message so callers can
   * surface IDs.
   *
   * For targeted pushes, the message also fans out to the sender's
   * own agent if one is registered — multi-device sync, free of
   * charge. The sender-fanout does not count toward `delivery.targets`
   * (which still reports the primary recipient count).
   */
  async push(payload: PushPayload, context: PushContext = { from: null }): Promise<PushResult> {
    const ts = this.now();
    const targetId = payload.agentId ?? null;
    const message: Message = {
      id: this.idFactory(),
      ts,
      agentId: targetId,
      from: context.from,
      title: payload.title ?? null,
      body: payload.body,
      level: payload.level ?? 'info',
      data: payload.data ?? {},
    };

    await this.eventLog.append(message);

    const recipients = new Set<AgentState>();
    if (targetId) {
      const target = this.registry.get(targetId);
      if (target) recipients.add(target);
      if (context.from && context.from !== targetId) {
        const sender = this.registry.get(context.from);
        if (sender) recipients.add(sender);
      }
    } else {
      for (const state of this.registry.allStates()) recipients.add(state);
    }

    const targetStates = [...recipients];
    let sse = 0;

    // Flatten (state, subscriber) pairs once so one bounded-concurrency
    // sweep covers every subscriber across every recipient. With the
    // old nested serial await, one slow SSE writer on agent A would
    // head-of-line-block delivery to agent B — fine at 1–3 subscribers
    // per slot in v0 tests, visibly broken at squadron scale under
    // backpressure. See `fanoutConcurrency` in BrokerOptions for the
    // tunable; default 32 stays well above real-world subscriber
    // counts while bounding pathological broadcast cases.
    type FanoutTask = { state: AgentState; sub: Subscriber };
    const tasks: FanoutTask[] = [];
    for (const state of targetStates) {
      state.agent.lastSeen = ts;
      // Snapshot subscribers before collecting — a subscriber callback
      // is allowed to mutate the Set (e.g. self-unsubscribe, or trigger
      // cleanup that removes another subscriber). Iterating a live
      // Set while callbacks may mutate it is technically well-defined
      // for deletions but too subtle to rely on.
      for (const sub of state.subscribers) {
        tasks.push({ state, sub });
      }
    }

    await boundedParallel(
      tasks,
      this.fanoutConcurrency,
      async ({ sub }) => {
        await sub(message);
        sse++;
      },
      ({ state }, err) => {
        this.logger.warn('subscriber threw during delivery', {
          agentId: state.agent.agentId,
          messageId: message.id,
          error: err instanceof Error ? err.message : String(err),
        });
      },
    );

    return {
      delivery: {
        sse,
        targets: targetId ? (this.registry.has(targetId) ? 1 : 0) : targetStates.length,
      },
      message,
    };
  }

  /**
   * Attach a subscriber. The agent is auto-registered if unknown so
   * callers don't have to make a separate register() call. Identity
   * is checked the same way as `register` — a mismatched callsign
   * throws `AgentIdentityError`.
   */
  subscribe(
    agentId: string,
    callback: Subscriber,
    context: IdentityContext = EMPTY_IDENTITY,
  ): () => void {
    this.assertIdentity(agentId, context.callsign);
    const state = this.registry.registerOrGet(agentId, this.now(), context.role ?? null);
    state.subscribers.add(callback);
    return () => {
      const current = this.registry.get(agentId);
      current?.subscribers.delete(callback);
    };
  }

  listAgents(): Agent[] {
    return this.registry.list();
  }

  hasAgent(agentId: string): boolean {
    return this.registry.has(agentId);
  }

  getEventLog(): EventLog {
    return this.eventLog;
  }

  private assertIdentity(agentId: string, callsign: string | null | undefined): void {
    if (callsign == null) return;
    if (callsign !== agentId) {
      throw new AgentIdentityError(agentId, callsign);
    }
  }
}
