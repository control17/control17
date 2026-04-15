/**
 * Wire-protocol constants for control17.
 *
 * Everything that defines the contract between a broker and its clients
 * lives here. Bump PROTOCOL_VERSION on any breaking wire change.
 */

export const PROTOCOL_VERSION = 1 as const;
export const PROTOCOL_HEADER = 'X-C17-Protocol' as const;
export const AUTH_HEADER = 'Authorization' as const;

export const PATHS = {
  health: '/healthz',
  briefing: '/briefing',
  roster: '/roster',
  push: '/push',
  subscribe: '/subscribe',
  history: '/history',
  // Human-plane session management (TOTP login + session cookie).
  sessionTotp: '/session/totp',
  sessionLogout: '/session/logout',
  session: '/session',
  // Web Push (browser) — VAPID public key + per-device subscriptions.
  pushVapidPublicKey: '/push/vapid-public-key',
  pushSubscriptions: '/push/subscriptions',
  // Objectives — Commander/Lieutenant create & assign, assignees execute.
  objectives: '/objectives',
  // The helpers below compose `:id` paths at runtime rather than
  // templating here, since `PATHS` is keyed by identifier not URL.
} as const;

/** Path builders for objective subresources (the `:id` segment varies). */
export const OBJECTIVE_PATHS = {
  one: (id: string) => `/objectives/${encodeURIComponent(id)}`,
  complete: (id: string) => `/objectives/${encodeURIComponent(id)}/complete`,
  cancel: (id: string) => `/objectives/${encodeURIComponent(id)}/cancel`,
  reassign: (id: string) => `/objectives/${encodeURIComponent(id)}/reassign`,
  discuss: (id: string) => `/objectives/${encodeURIComponent(id)}/discuss`,
  watchers: (id: string) => `/objectives/${encodeURIComponent(id)}/watchers`,
  traces: (id: string) => `/objectives/${encodeURIComponent(id)}/traces`,
} as const;

export const DEFAULT_PORT = 8717 as const;

export const ENV = {
  // Client-side: broker URL + bearer token held in env for `c17` subcommands.
  url: 'C17_URL',
  token: 'C17_TOKEN',
  // Server-side: where to find the team config file + listener config.
  configPath: 'C17_CONFIG_PATH',
  port: 'C17_PORT',
  host: 'C17_HOST',
  dbPath: 'C17_DB_PATH',
} as const;

export const MCP_CHANNEL_CAPABILITY = 'claude/channel' as const;
export const MCP_CHANNEL_NOTIFICATION = 'notifications/claude/channel' as const;
