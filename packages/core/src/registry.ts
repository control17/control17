/**
 * Agent registry — tracks known agents and their live subscribers.
 *
 * "Subscriber" here is a callback invoked when a message targets this
 * agent. The Node server creates one subscriber per live SSE connection;
 * anything else that wants to observe pushes can attach the same way.
 */

import type { Agent, Message } from '@control17/sdk/types';

export type Subscriber = (message: Message) => void | Promise<void>;

export interface AgentState {
  agent: Agent;
  subscribers: Set<Subscriber>;
}

export class AgentRegistry {
  private readonly agents = new Map<string, AgentState>();

  /**
   * Look up or create an agent state entry. Updates `lastSeen` on each
   * call so the list endpoint reflects recent activity.
   */
  registerOrGet(agentId: string, now: number): AgentState {
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
      });
    }
    return out;
  }

  /** Snapshot of all live agent states (for broadcast fanout). */
  allStates(): AgentState[] {
    return Array.from(this.agents.values());
  }
}
