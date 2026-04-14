/**
 * Tool definitions and handlers for the link's MCP server face.
 *
 * Exposed tools (dynamic descriptions composed from the briefing):
 *   - roster    — list teammates
 *   - broadcast — send to the team channel
 *   - send      — DM a teammate by callsign
 *   - recent    — fetch recent team-chat / DM history
 *
 * Each tool's description carries the slice of team context that's
 * relevant to using that tool. Team/role/mission info is distributed
 * across the tool list rather than concentrated in one place, so the
 * LLM reads the briefing naturally while scanning what's available.
 * Because tool descriptions live in session metadata (not message
 * history), they're sticky across context compaction — the briefing
 * survives.
 */

import type { Client as BrokerClient, ClientError } from '@control17/sdk/client';
import type { BriefingResponse, LogLevel, Message } from '@control17/sdk/types';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';

const LEVELS: readonly LogLevel[] = ['debug', 'info', 'notice', 'warning', 'error', 'critical'];

const DEFAULT_RECENT_LIMIT = 50;
const MAX_RECENT_LIMIT = 500;

/**
 * Build the 4-tool set with descriptions composed from the briefing.
 * Pure function — trivially re-invokable when a future runtime
 * briefing update fires `notifications/tools/list_changed`.
 */
export function defineTools(briefing: BriefingResponse): Tool[] {
  const { callsign, role, team, teammates } = briefing;
  const others = teammates.filter((t) => t.callsign !== callsign);
  const teammateList =
    others.length > 0
      ? others.map((t) => `${t.callsign} (${t.role})`).join(', ')
      : '(no other teammates currently defined)';

  return [
    {
      name: 'roster',
      description:
        `List all teammates currently on the control17 net. You go by ${callsign} on team ` +
        `${team.name} (role: ${role}). Mission: ${team.mission}. Returns each teammate's ` +
        `callsign, role, and connection state (how many live sessions are attached).`,
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'broadcast',
      description:
        `Broadcast a message to the ${team.name} team channel. All teammates see it in real ` +
        `time. Use this for team-wide announcements, status updates, and operator directives. ` +
        `You go by ${callsign} (role: ${role}). Teammates: ${teammateList}.`,
      inputSchema: {
        type: 'object',
        properties: {
          body: { type: 'string', description: 'The message body the team will receive.' },
          title: { type: 'string', description: 'Optional short title / subject line.' },
          level: {
            type: 'string',
            enum: [...LEVELS],
            description: "Optional severity; defaults to 'info'.",
          },
        },
        required: ['body'],
      },
    },
    {
      name: 'send',
      description:
        `Send a direct message to a specific teammate on ${team.name}. Messages are private ` +
        `to you and the target. You go by ${callsign}. Available callsigns: ${teammateList}. ` +
        `Mission: ${team.mission}.`,
      inputSchema: {
        type: 'object',
        properties: {
          to: {
            type: 'string',
            description: 'The callsign of the teammate to message.',
          },
          body: { type: 'string', description: 'The message body.' },
          title: { type: 'string', description: 'Optional short title / subject line.' },
          level: {
            type: 'string',
            enum: [...LEVELS],
            description: "Optional severity; defaults to 'info'.",
          },
        },
        required: ['to', 'body'],
      },
    },
    {
      name: 'recent',
      description:
        `Fetch recent messages from the ${team.name} team channel or a specific DM thread. ` +
        `Team mission: ${team.mission}. Omit \`with\` for team-channel scrollback; pass ` +
        `\`with=CALLSIGN\` for DMs you've exchanged with that teammate. Returns messages ` +
        `newest-first up to ${DEFAULT_RECENT_LIMIT} by default (max ${MAX_RECENT_LIMIT}). ` +
        `Use this when you just connected, after a pause, or when you need context on what ` +
        `was discussed earlier.`,
      inputSchema: {
        type: 'object',
        properties: {
          with: {
            type: 'string',
            description:
              'Optional teammate callsign — narrows to DMs with that teammate instead of team chat.',
          },
          limit: {
            type: 'number',
            description: `Max messages to return (default ${DEFAULT_RECENT_LIMIT}, max ${MAX_RECENT_LIMIT}).`,
          },
        },
      },
    },
  ];
}

export async function handleToolCall(
  name: string,
  rawArgs: Record<string, unknown> | undefined,
  brokerClient: BrokerClient,
  briefing: BriefingResponse,
): Promise<CallToolResult> {
  const args = rawArgs ?? {};
  try {
    switch (name) {
      case 'roster':
        return await handleRoster(brokerClient, briefing);
      case 'broadcast':
        return await handleBroadcast(args, brokerClient);
      case 'send':
        return await handleSend(args, brokerClient);
      case 'recent':
        return await handleRecent(args, brokerClient, briefing);
      default:
        return errorResult(`unknown tool: ${name}`);
    }
  } catch (err) {
    const ce = err as ClientError;
    if (ce?.name === 'ClientError') {
      return errorResult(`broker error ${ce.status}: ${ce.body || ce.message}`);
    }
    return errorResult(err instanceof Error ? err.message : String(err));
  }
}

async function handleRoster(
  brokerClient: BrokerClient,
  briefing: BriefingResponse,
): Promise<CallToolResult> {
  const roster = await brokerClient.roster();
  const connectedByCallsign = new Map(roster.connected.map((a) => [a.agentId, a.connected]));
  if (roster.teammates.length === 0) {
    return textResult('team roster: (no slots defined)');
  }
  const lines = roster.teammates.map((t) => {
    const conn = connectedByCallsign.get(t.callsign) ?? 0;
    const self = t.callsign === briefing.callsign ? ' (you)' : '';
    const state = conn > 0 ? `connected=${conn}` : 'offline';
    return `- ${t.callsign}${self} [${t.role}] ${state}`;
  });
  return textResult(`team ${briefing.team.name} roster:\n${lines.join('\n')}`);
}

async function handleBroadcast(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
): Promise<CallToolResult> {
  const body = typeof args.body === 'string' ? args.body : '';
  if (!body) return errorResult('broadcast: `body` is required');
  const levelResult = parseLevel(args.level);
  if (levelResult.error) return errorResult(`broadcast: ${levelResult.error}`);
  const title = typeof args.title === 'string' ? args.title : null;
  const result = await brokerClient.push({ body, title, level: levelResult.level });
  return textResult(
    `broadcast delivered: sse=${result.delivery.sse} ` +
      `targets=${result.delivery.targets} msg=${result.message.id}`,
  );
}

async function handleSend(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
): Promise<CallToolResult> {
  const to = typeof args.to === 'string' ? args.to : '';
  const body = typeof args.body === 'string' ? args.body : '';
  if (!to || !body) return errorResult('send: `to` and `body` are required');
  const levelResult = parseLevel(args.level);
  if (levelResult.error) return errorResult(`send: ${levelResult.error}`);
  const title = typeof args.title === 'string' ? args.title : null;
  const result = await brokerClient.push({ agentId: to, body, title, level: levelResult.level });
  return textResult(
    `delivered to ${to}: sse=${result.delivery.sse} ` +
      `targets=${result.delivery.targets} msg=${result.message.id}`,
  );
}

async function handleRecent(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
  briefing: BriefingResponse,
): Promise<CallToolResult> {
  const withOther = typeof args.with === 'string' ? args.with : undefined;
  const limitRaw = typeof args.limit === 'number' ? args.limit : DEFAULT_RECENT_LIMIT;
  const limit = Math.min(Math.max(Math.floor(limitRaw), 1), MAX_RECENT_LIMIT);
  const messages = await brokerClient.history({ with: withOther, limit });

  if (messages.length === 0) {
    const scope = withOther ? `DM with ${withOther}` : `${briefing.team.name} team channel`;
    return textResult(`recent: no messages in ${scope}`);
  }

  const header = withOther
    ? `recent DMs with ${withOther} (${messages.length}):`
    : `recent ${briefing.team.name} team chat (${messages.length}):`;
  const lines = messages.map((m) => formatRecentLine(m));
  return textResult(`${header}\n${lines.join('\n')}`);
}

function formatRecentLine(m: Message): string {
  const ts = new Date(m.ts).toISOString().slice(11, 16);
  const from = m.from ?? '?';
  const target = m.agentId ? ` → ${m.agentId}` : '';
  const title = m.title ? ` [${m.title}]` : '';
  return `  ${ts} ${from}${target}${title}: ${m.body}`;
}

function isLogLevel(v: unknown): v is LogLevel {
  return typeof v === 'string' && (LEVELS as readonly string[]).includes(v);
}

/**
 * Parse an optional `level` tool arg. Missing / null → default 'info'.
 * Present but not a valid LogLevel → returns an error message so the
 * caller can surface it rather than silently coercing to 'info'.
 */
function parseLevel(
  raw: unknown,
): { level: LogLevel; error?: undefined } | { error: string; level?: undefined } {
  if (raw === undefined || raw === null) return { level: 'info' };
  if (isLogLevel(raw)) return { level: raw };
  return {
    error: `unknown level '${String(raw)}'. Must be one of: ${LEVELS.join(', ')}.`,
  };
}

function textResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

function errorResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}
