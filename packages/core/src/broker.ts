/**
 * Broker — the runtime-agnostic core of control17.
 *
 * Ties the agent registry to an event log and handles the push fanout.
 * Knows nothing about HTTP, MCP, or persistence; runtime adapters layer
 * those on top.
 *
 * Identity model: every authenticated caller has a principal name. The
 * broker enforces `agentId === principal.name` on register and
 * subscribe, so a principal can only act on its own canonical agent.
 * DMs go to the target agent and also fan out to the sender's agent
 * (if registered), which keeps multiple live sessions of the same
 * principal in sync with zero client-side bookkeeping.
 */

import type {
  Agent,
  AgentRegistration,
  Message,
  PrincipalKind,
  PushPayload,
  PushResult,
} from '@control17/sdk/types';
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
}

/**
 * Per-push context supplied by the runtime adapter. `from` is the
 * authenticated principal name; the broker stamps it onto
 * `message.from` verbatim and never reads sender identity from the
 * payload. Pass `from: null` for unauthenticated / system-originated
 * pushes (tests, internal fanout).
 */
export interface PushContext {
  from: string | null;
}

/**
 * Per-register / per-subscribe context. `principal` is the caller's
 * authenticated principal name — the broker checks it matches the
 * `agentId` being registered/subscribed. Pass `principal: null` to
 * skip the check (tests, in-process core usage without a runtime).
 * `kind` is cosmetic.
 */
export interface IdentityContext {
  principal?: string | null;
  kind?: PrincipalKind | null;
}

const NOOP_LOGGER: BrokerLogger = {
  warn: () => {},
  error: () => {},
};

const EMPTY_IDENTITY: IdentityContext = {};

export class Broker {
  private readonly registry = new AgentRegistry();
  private readonly eventLog: EventLog;
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly logger: BrokerLogger;

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
  }

  /**
   * Explicitly register an agent so it shows up in listAgents(). If
   * `context.principal` is supplied it must equal `agentId`; any
   * mismatch throws `AgentIdentityError`. Core tests skip the check
   * by passing no context.
   */
  async register(
    agentId: string,
    context: IdentityContext = EMPTY_IDENTITY,
  ): Promise<AgentRegistration> {
    this.assertIdentity(agentId, context.principal);
    const state = this.registry.registerOrGet(agentId, this.now(), context.kind ?? null);
    return {
      agentId: state.agent.agentId,
      registeredAt: state.agent.createdAt,
    };
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
    for (const state of targetStates) {
      state.agent.lastSeen = ts;
      for (const sub of state.subscribers) {
        try {
          await sub(message);
          sse++;
        } catch (err) {
          this.logger.warn('subscriber threw during delivery', {
            agentId: state.agent.agentId,
            messageId: message.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

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
   * is checked the same way as `register` — a mismatched principal
   * throws `AgentIdentityError`.
   */
  subscribe(
    agentId: string,
    callback: Subscriber,
    context: IdentityContext = EMPTY_IDENTITY,
  ): () => void {
    this.assertIdentity(agentId, context.principal);
    const state = this.registry.registerOrGet(agentId, this.now(), context.kind ?? null);
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

  private assertIdentity(agentId: string, principal: string | null | undefined): void {
    if (principal == null) return;
    if (principal !== agentId) {
      throw new AgentIdentityError(agentId, principal);
    }
  }
}
