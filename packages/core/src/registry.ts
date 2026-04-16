/**
 * Agent registry — tracks known agents and their live subscribers.
 *
 * "Subscriber" here is a callback invoked when a message targets this
 * agent. The Node server creates one subscriber per live SSE connection;
 * anything else that wants to observe pushes can attach the same way.
 *
 * Identity model: `agentId === slot.callsign`. The broker enforces
 * this at the register/subscribe call sites (the registry itself is
 * identity-agnostic so core stays testable without wiring up auth).
 * A mismatched identity surfaces as `AgentIdentityError`.
 */

import type { Agent, Authority, Message } from '@control17/sdk/types';

export type Subscriber = (message: Message) => void | Promise<void>;

export interface AgentState {
  agent: Agent;
  subscribers: Set<Subscriber>;
}

/**
 * Thrown by `Broker.register` / `Broker.subscribe` when the caller's
 * authenticated slot callsign doesn't match the agentId they're trying
 * to act on. Runtime adapters translate this into an HTTP 403.
 */
export class AgentIdentityError extends Error {
  readonly agentId: string;
  readonly callsign: string;
  constructor(agentId: string, callsign: string) {
    super(
      `slot '${callsign}' cannot act on agent '${agentId}'; ` +
        `agentId must equal the calling slot's callsign`,
    );
    this.name = 'AgentIdentityError';
    this.agentId = agentId;
    this.callsign = callsign;
  }
}

export class AgentRegistry {
  private readonly agents = new Map<string, AgentState>();

  /**
   * Look up or create an agent state entry. Updates `lastSeen` on each
   * call so the list endpoint reflects recent activity. Role + authority
   * are first-register-wins: once set, subsequent registrations ignore
   * the values (registry is authoritative about slot identity, not
   * about runtime role changes).
   */
  registerOrGet(
    agentId: string,
    now: number,
    role: string | null = null,
    authority: Authority = 'operator',
  ): AgentState {
    const existing = this.agents.get(agentId);
    if (existing) {
      existing.agent.lastSeen = now;
      return existing;
    }
    const state: AgentState = {
      agent: {
        agentId,
        connected: 0,
        createdAt: now,
        lastSeen: now,
        role,
        authority,
      },
      subscribers: new Set(),
    };
    this.agents.set(agentId, state);
    return state;
  }

  get(agentId: string): AgentState | undefined {
    return this.agents.get(agentId);
  }

  has(agentId: string): boolean {
    return this.agents.has(agentId);
  }

  list(): Agent[] {
    const out: Agent[] = [];
    for (const state of this.agents.values()) {
      out.push({
        agentId: state.agent.agentId,
        connected: state.subscribers.size,
        createdAt: state.agent.createdAt,
        lastSeen: state.agent.lastSeen,
        role: state.agent.role,
        authority: state.agent.authority,
      });
    }
    return out;
  }

  /** Snapshot of all live agent states (for broadcast fanout). */
  allStates(): AgentState[] {
    return Array.from(this.agents.values());
  }
}
