/**
 * Tool definitions and handlers for the link's MCP server face.
 *
 * Exposed tools:
 *   - send_dm     — DM a specific agent
 *   - broadcast   — push a message to every registered agent
 *   - list_agents — list all currently registered agents
 */

import type { Client as BrokerClient, ClientError } from '@control17/sdk/client';
import type { LogLevel } from '@control17/sdk/types';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';

const LEVELS: readonly LogLevel[] = ['debug', 'info', 'notice', 'warning', 'error', 'critical'];

export function defineTools(selfAgentId: string): Tool[] {
  return [
    {
      name: 'send_dm',
      description:
        `Send a direct message to one control17 agent. You are '${selfAgentId}'. ` +
        'The message is private to you and the target — other agents will not see it. ' +
        'Call list_agents first to discover peers.',
      inputSchema: {
        type: 'object',
        properties: {
          to: {
            type: 'string',
            description: 'The agent_id (= principal name) of the peer to message.',
          },
          body: {
            type: 'string',
            description: 'The message body.',
          },
          title: {
            type: 'string',
            description: 'Optional short title / subject line.',
          },
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
      name: 'broadcast',
      description: `Broadcast a message to every registered agent on the squadron net. You are '${selfAgentId}'.`,
      inputSchema: {
        type: 'object',
        properties: {
          body: {
            type: 'string',
            description: 'The message body.',
          },
          title: {
            type: 'string',
            description: 'Optional short title / subject line.',
          },
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
      name: 'list_agents',
      description:
        'List all agents currently registered with the control17 broker, with their connection state.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
  ];
}

export async function handleToolCall(
  name: string,
  rawArgs: Record<string, unknown> | undefined,
  brokerClient: BrokerClient,
  selfAgentId: string,
): Promise<CallToolResult> {
  const args = rawArgs ?? {};
  try {
    switch (name) {
      case 'send_dm':
        return await handleSendDm(args, brokerClient);
      case 'broadcast':
        return await handleBroadcast(args, brokerClient);
      case 'list_agents':
        return await handleListAgents(brokerClient, selfAgentId);
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

async function handleSendDm(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
): Promise<CallToolResult> {
  const to = typeof args.to === 'string' ? args.to : '';
  const body = typeof args.body === 'string' ? args.body : '';
  if (!to || !body) return errorResult('send_dm: `to` and `body` are required');
  const level = isLogLevel(args.level) ? args.level : 'info';
  const title = typeof args.title === 'string' ? args.title : null;
  const result = await brokerClient.push({ agentId: to, body, title, level });
  return textResult(
    `delivered to ${to}: sse=${result.delivery.sse} ` +
      `targets=${result.delivery.targets} msg=${result.message.id}`,
  );
}

async function handleBroadcast(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
): Promise<CallToolResult> {
  const body = typeof args.body === 'string' ? args.body : '';
  if (!body) return errorResult('broadcast: `body` is required');
  const level = isLogLevel(args.level) ? args.level : 'info';
  const title = typeof args.title === 'string' ? args.title : null;
  const result = await brokerClient.push({ body, title, level });
  return textResult(
    `broadcast delivered: sse=${result.delivery.sse} ` +
      `targets=${result.delivery.targets} msg=${result.message.id}`,
  );
}

async function handleListAgents(
  brokerClient: BrokerClient,
  selfAgentId: string,
): Promise<CallToolResult> {
  const agents = await brokerClient.listAgents();
  if (agents.length === 0) return textResult('connected agents: (none)');
  const lines = agents.map((a) => {
    const self = a.agentId === selfAgentId ? ' (you)' : '';
    return `- ${a.agentId}${self} [${a.kind ?? '?'}] connected=${a.connected}`;
  });
  return textResult(`connected agents:\n${lines.join('\n')}`);
}

function isLogLevel(v: unknown): v is LogLevel {
  return typeof v === 'string' && (LEVELS as readonly string[]).includes(v);
}

function textResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

function errorResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}
