/**
 * Pure TypeScript types for the control17 wire protocol.
 *
 * Zero runtime dependencies. Consumers that only want types should import
 * from `@control17/sdk/types`.
 */

export type LogLevel = 'debug' | 'info' | 'notice' | 'warning' | 'error' | 'critical';

export interface Agent {
  agentId: string;
  /** Number of live SSE subscribers currently attached to this agent. */
  connected: number;
  createdAt: number;
  lastSeen: number;
}

export interface AgentRegistration {
  agentId: string;
  registeredAt: number;
}

export interface PushPayload {
  agentId?: string | null;
  title?: string | null;
  body: string;
  level?: LogLevel;
  data?: Record<string, unknown>;
}

export interface Message {
  id: string;
  ts: number;
  agentId: string | null;
  title: string | null;
  body: string;
  level: LogLevel;
  data: Record<string, unknown>;
}

export interface DeliveryReport {
  /** Number of subscribers that received the message over SSE. */
  sse: number;
  /** Number of targeted agents resolved (0 if the target was unknown, N for broadcast). */
  targets: number;
}

export interface PushResult {
  delivery: DeliveryReport;
  message: Message;
}

export interface AgentList {
  agents: Agent[];
}

export interface HealthResponse {
  status: 'ok';
  version: string;
}
