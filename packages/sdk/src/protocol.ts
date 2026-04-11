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
  agents: '/agents',
  register: '/register',
  push: '/push',
  subscribe: '/subscribe',
  mcp: '/mcp',
  events: '/events',
} as const;

export const DEFAULT_PORT = 8717 as const;

export const ENV = {
  url: 'C17_URL',
  token: 'C17_TOKEN',
  agentId: 'C17_AGENT_ID',
  port: 'C17_PORT',
  host: 'C17_HOST',
  dbPath: 'C17_DB_PATH',
} as const;

export const MCP_CHANNEL_CAPABILITY = 'claude/channel' as const;
export const MCP_CHANNEL_NOTIFICATION = 'notifications/claude/channel' as const;
