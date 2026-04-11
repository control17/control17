/**
 * Tool definitions and handlers for the link's MCP server face.
 *
 * Exposed tools:
 *   - send        — push a message to another control17-connected agent
 *   - list_agents — list all currently registered agents
 *   - register    — register an agent id (rarely needed; the link does it automatically)
 */

import type { Client as BrokerClient, ClientError } from '@control17/sdk/client';
import type { LogLevel } from '@control17/sdk/types';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';

const LEVELS: readonly LogLevel[] = ['debug', 'info', 'notice', 'warning', 'error', 'critical'];

export function defineTools(selfAgentId: string): Tool[] {
  return [
    {
      name: 'send',
      description:
        `Push a message to another control17-connected agent. The target receives it as a ` +
        `channel event in real time. You are agent '${selfAgentId}'. ` +
        `Call list_agents first to discover peers.`,
      inputSchema: {
        type: 'object',
        properties: {
          targetAgentId: {
            type: 'string',
            description: 'The agent_id of the peer to message.',
          },
          body: {
            type: 'string',
            description: 'The message body the peer will receive.',
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
        required: ['targetAgentId', 'body'],
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
    {
      name: 'register',
      description:
        'Register (or re-register) an agent id with the broker. The link registers itself ' +
        'automatically at startup; this tool is for edge cases.',
      inputSchema: {
        type: 'object',
        properties: {
          agentId: {
            type: 'string',
            description: 'The agent_id to register.',
          },
        },
        required: ['agentId'],
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
      case 'send':
        return await handleSend(args, brokerClient, selfAgentId);
      case 'list_agents':
        return await handleListAgents(brokerClient);
      case 'register':
        return await handleRegister(args, brokerClient);
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

async function handleSend(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
  selfAgentId: string,
): Promise<CallToolResult> {
  const targetAgentId = typeof args.targetAgentId === 'string' ? args.targetAgentId : '';
  const body = typeof args.body === 'string' ? args.body : '';
  if (!targetAgentId || !body) {
    return errorResult('send: targetAgentId and body are required');
  }
  const level = isLogLevel(args.level) ? args.level : 'info';
  const title = typeof args.title === 'string' ? args.title : null;

  const result = await brokerClient.push({
    agentId: targetAgentId,
    body,
    title,
    level,
    data: { from: selfAgentId },
  });
  return textResult(
    `delivered to ${targetAgentId}: sse=${result.delivery.sse} ` +
      `targets=${result.delivery.targets} msg=${result.message.id}`,
  );
}

async function handleListAgents(brokerClient: BrokerClient): Promise<CallToolResult> {
  const agents = await brokerClient.listAgents();
  if (agents.length === 0) {
    return textResult('connected agents: (none)');
  }
  const lines = agents.map(
    (a) =>
      `- ${a.agentId} (connected=${a.connected}, lastSeen=${new Date(a.lastSeen).toISOString()})`,
  );
  return textResult(`connected agents:\n${lines.join('\n')}`);
}

async function handleRegister(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
): Promise<CallToolResult> {
  const agentId = typeof args.agentId === 'string' ? args.agentId : '';
  if (!agentId) {
    return errorResult('register: agentId is required');
  }
  const reg = await brokerClient.register(agentId);
  return textResult(`registered ${reg.agentId} at ${new Date(reg.registeredAt).toISOString()}`);
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
