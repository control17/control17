/**
 * Pure TypeScript types for the control17 wire protocol.
 *
 * Zero runtime dependencies. Consumers that only want types should import
 * from `@control17/sdk/types`.
 */

export type LogLevel = 'debug' | 'info' | 'notice' | 'warning' | 'error' | 'critical';

/**
 * A team is the top-level unit the server controls. One server = one
 * team (multi-team lives at the SaaS layer). The team defines the
 * mission and the context every slot inherits.
 */
export interface Team {
  name: string;
  mission: string;
  brief: string;
}

/**
 * A named bundle of role-specific instructions. Roles are defined in
 * the server config and referenced by slots. Multiple slots can share
 * a role — e.g., two `implementer` slots running in parallel.
 *
 * `editor: true` grants the slot permission to edit the team/roles
 * via (future) runtime admin endpoints. Today the flag is plumbed
 * through `/briefing.canEdit` but no edit endpoints exist yet.
 */
export interface Role {
  description: string;
  instructions: string;
  editor?: boolean;
}

/**
 * A reserved position on the team. The token is the auth boundary;
 * the callsign is the team-context identity; the role string is a
 * key into the team's roles map.
 *
 * On the wire, slots never carry their token — it's resolved by auth
 * and never returned in any response.
 */
export interface Slot {
  callsign: string;
  role: string;
}

/** Projection of a slot for rendering in the roster / briefing. */
export interface Teammate {
  callsign: string;
  role: string;
}

export interface Agent {
  agentId: string;
  /** Number of live SSE subscribers currently attached to this agent. */
  connected: number;
  createdAt: number;
  lastSeen: number;
  /**
   * Role the occupying slot plays on the team. Cosmetic at the broker
   * level — never gates auth or delivery, purely for display and
   * dashboards. null for seeded-but-never-connected agents in some
   * test paths.
   */
  role: string | null;
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
  /** Target agent callsign, or null for a broadcast. */
  agentId: string | null;
  /**
   * Authoritative sender callsign, stamped by the broker based on the
   * caller's authenticated slot. Never trusted from the request payload.
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

export interface HealthResponse {
  status: 'ok';
  version: string;
}

/**
 * Full team-context packet returned from `GET /briefing`. Used by the
 * link and the TUI to initialize themselves with team/role/mission
 * context. The `instructions` string is pre-composed server-side and
 * passed verbatim into the MCP `Server({instructions})` init.
 *
 * This is the "on the net, you go by X and your role is Y" payload —
 * it complements the agent's base identity with team context, it
 * doesn't overwrite it.
 */
export interface BriefingResponse {
  callsign: string;
  role: string;
  team: Team;
  teammates: Teammate[];
  instructions: string;
  canEdit: boolean;
}

/** Response from `GET /roster`. */
export interface RosterResponse {
  /** Every slot defined in the team config. */
  teammates: Teammate[];
  /** Runtime connection state for slots currently registered with the broker. */
  connected: Agent[];
}

/** Query parameters for `GET /history`. */
export interface HistoryQuery {
  /** DM counterpart callsign — omit for full feed (broadcasts + DMs). */
  with?: string;
  /** Max results (default 100, max 1000). */
  limit?: number;
  /** Return only messages with `ts < before` (for pagination). */
  before?: number;
}

export interface HistoryResponse {
  messages: Message[];
}

/**
 * Request body for `POST /session/totp`. The SPA submits the slot's
 * callsign and a current 6-digit TOTP code; the server verifies and
 * issues a session cookie on success.
 */
export interface TotpLoginRequest {
  slot: string;
  code: string;
}

/**
 * Response body for `POST /session/totp` (on success) and `GET /session`.
 * Carries the authenticated slot's callsign and the session expiry
 * timestamp (ms since epoch) so the SPA can show "stay signed in for
 * N days" UI hints and redirect on expiry.
 */
export interface SessionResponse {
  slot: string;
  role: string;
  expiresAt: number;
}

/**
 * VAPID public key advertisement — returned from
 * `GET /push/vapid-public-key`. The SPA passes this into
 * `pushManager.subscribe({applicationServerKey})` so the browser
 * signs its subscription to our key rather than hardcoding one at
 * build time.
 */
export interface VapidPublicKeyResponse {
  publicKey: string;
}

/**
 * Push subscription payload the SPA POSTs after the browser hands
 * over a subscription. Matches the shape of a JSON-serialized
 * `PushSubscription`.
 */
export interface PushSubscriptionPayload {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

/** Response for a successful push-subscription registration. */
export interface PushSubscriptionResponse {
  id: number;
  endpoint: string;
  createdAt: number;
}
