/**
 * Broker — the runtime-agnostic core of control17.
 *
 * Ties the agent registry to an event log and handles the push fanout.
 * Knows nothing about HTTP, MCP, or persistence; runtime adapters layer
 * those on top.
 */

import type {
  Agent,
  AgentRegistration,
  Message,
  PushPayload,
  PushResult,
} from '@control17/sdk/types';
import type { EventLog } from './event-log.js';
import { AgentRegistry, type AgentState, type Subscriber } from './registry.js';

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

const NOOP_LOGGER: BrokerLogger = {
  warn: () => {},
  error: () => {},
};

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

  /** Explicitly register an agent so it shows up in listAgents(). */
  async register(agentId: string): Promise<AgentRegistration> {
    const state = this.registry.registerOrGet(agentId, this.now());
    return {
      agentId: state.agent.agentId,
      registeredAt: state.agent.createdAt,
    };
  }

  /**
   * Push a message to one agent (if `payload.agentId` is set) or broadcast
   * to all registered agents. Always writes to the event log. Always
   * returns the constructed Message so callers can surface IDs.
   */
  async push(payload: PushPayload): Promise<PushResult> {
    const ts = this.now();
    const targetId = payload.agentId ?? null;
    const message: Message = {
      id: this.idFactory(),
      ts,
      agentId: targetId,
      title: payload.title ?? null,
      body: payload.body,
      level: payload.level ?? 'info',
      data: payload.data ?? {},
    };

    await this.eventLog.append(message);

    const targetStates: AgentState[] = targetId
      ? this.resolveTarget(targetId)
      : this.registry.allStates();

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
      delivery: { sse, targets: targetStates.length },
      message,
    };
  }

  /**
   * Attach a subscriber. The agent is auto-registered if unknown so
   * callers don't have to make a separate register() call for SSE setup.
   * Returns an unsubscribe function.
   */
  subscribe(agentId: string, callback: Subscriber): () => void {
    const state = this.registry.registerOrGet(agentId, this.now());
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

  /** Return [] if the target isn't registered — caller can 404 the push. */
  private resolveTarget(agentId: string): AgentState[] {
    const state = this.registry.get(agentId);
    return state ? [state] : [];
  }
}
