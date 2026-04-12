/**
 * Pure TypeScript types for the control17 wire protocol.
 *
 * Zero runtime dependencies. Consumers that only want types should import
 * from `@control17/sdk/types`.
 */

export type LogLevel = 'debug' | 'info' | 'notice' | 'warning' | 'error' | 'critical';

/**
 * Cosmetic classification of a principal (named-token holder). Never
 * gates wire-level behavior — the broker treats every kind identically.
 * Exists so dashboards and tools can label participants consistently
 * (`human` for interactive operators, `agent` for Claude Code sessions
 * and other long-lived bots, `service` for webhooks / CI tokens).
 */
export type PrincipalKind = 'human' | 'agent' | 'service';

export interface Agent {
  agentId: string;
  /** Number of live SSE subscribers currently attached to this agent. */
  connected: number;
  createdAt: number;
  lastSeen: number;
  /**
   * The kind of the principal that registered this agent.
   * Cosmetic only — never affects auth or delivery.
   *
   * Identity note: the `agentId` itself IS the owning principal's
   * name. Each principal has exactly one canonical agent id equal to
   * its name, and the broker enforces that rule on register and
   * subscribe. There is no separate `owner` field because it would
   * always be redundant with `agentId`.
   */
  kind: PrincipalKind | null;
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
  /** Target agent id, or null for a broadcast. */
  agentId: string | null;
  /**
   * Authoritative sender name, stamped by the broker based on the
   * caller's authenticated principal. Never trusted from the request
   * payload.
   */
  from: string | null;
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

/**
 * Identity of the principal that authenticated the current request.
 * Returned from `/whoami`, used by clients (link, tui) to self-derive
 * their canonical `agentId` from the server's view of their token.
 */
export interface WhoamiResponse {
  name: string;
  kind: PrincipalKind;
}

/** Query parameters for `GET /history`. */
export interface HistoryQuery {
  /** DM counterpart principal — omit for full feed (broadcasts + DMs). */
  with?: string;
  /** Max results (default 100, max 1000). */
  limit?: number;
  /** Return only messages with `ts < before` (for pagination). */
  before?: number;
}

export interface HistoryResponse {
  messages: Message[];
}
