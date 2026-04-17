/**
 * Tool definitions and handlers for the link's MCP server face.
 *
 * Chat tools (dynamic descriptions composed from the briefing):
 *   - roster    — list teammates
 *   - broadcast — send to the squadron channel
 *   - send      — DM a teammate by callsign
 *   - recent    — fetch recent squadron-chat / DM history
 *
 * Objective tools (descriptions composed from briefing + live open
 * objectives set so the sticky context stays fresh across compaction):
 *   - objectives_list     — the caller's active plate
 *   - objectives_view     — full detail on one objective
 *   - objectives_update   — report progress, flag block, post note
 *   - objectives_complete — mark done with required result
 *
 * No `objectives_create` tool in v1 — objectives are created by
 * commanders / lieutenants via CLI or web UI, never by agents.
 */

import type { Client as BrokerClient, ClientError } from '@control17/sdk/client';
import type { BriefingResponse, LogLevel, Message, ObjectiveStatus } from '@control17/sdk/types';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';

const LEVELS: readonly LogLevel[] = ['debug', 'info', 'notice', 'warning', 'error', 'critical'];
const OBJECTIVE_STATUSES: readonly ObjectiveStatus[] = ['active', 'blocked', 'done', 'cancelled'];

const DEFAULT_RECENT_LIMIT = 50;
const MAX_RECENT_LIMIT = 500;

/**
 * Build the tool set with descriptions composed from the briefing.
 * Tool descriptions are stable — objective state is delivered via
 * channel notifications, not baked into tool metadata.
 */
export function defineTools(briefing: BriefingResponse): Tool[] {
  const { callsign, role, authority, squadron, teammates } = briefing;
  const identity = `${callsign} (role: ${role}, rank: ${authority})`;
  const others = teammates.filter((t) => t.callsign !== callsign);
  const teammateList =
    others.length > 0
      ? others.map((t) => `${t.callsign} (${t.role})`).join(', ')
      : '(no other teammates currently defined)';

  return [
    {
      name: 'roster',
      description:
        `List all teammates currently on the control17 net. You go by ${identity} in ` +
        `squadron ${squadron.name}. Mission: ${squadron.mission}. Returns each teammate's ` +
        `callsign, role, authority, and connection state.`,
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'broadcast',
      description:
        `Broadcast a message to the ${squadron.name} squadron channel. All teammates see it in ` +
        `real time. Use this for squadron-wide announcements, status updates, and operator ` +
        `directives. You go by ${identity}. Teammates: ${teammateList}.`,
      inputSchema: {
        type: 'object',
        properties: {
          body: { type: 'string', description: 'The message body the squadron will receive.' },
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
        `Send a direct message to a specific teammate on ${squadron.name}. Messages are ` +
        `private to you and the target. You go by ${identity}. Available callsigns: ` +
        `${teammateList}. Mission: ${squadron.mission}.`,
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'The callsign of the teammate to message.' },
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
        `Fetch recent messages from the ${squadron.name} squadron channel or a specific DM ` +
        `thread. You go by ${identity}. Squadron mission: ${squadron.mission}. Omit ` +
        `\`with\` for squadron-channel scrollback; pass \`with=CALLSIGN\` for DMs. Returns ` +
        `messages newest-first up to ${DEFAULT_RECENT_LIMIT} by default (max ${MAX_RECENT_LIMIT}).`,
      inputSchema: {
        type: 'object',
        properties: {
          with: {
            type: 'string',
            description:
              'Optional teammate callsign — narrows to DMs with that teammate instead of squadron chat.',
          },
          limit: {
            type: 'number',
            description: `Max messages to return (default ${DEFAULT_RECENT_LIMIT}, max ${MAX_RECENT_LIMIT}).`,
          },
        },
      },
    },
    {
      name: 'objectives_list',
      description:
        `List objectives you have a relationship with on squadron ${squadron.name} — ` +
        `assigned to you, originated by you, or objectives you're watching. ` +
        `Use \`status\` to filter (active | blocked | done | cancelled); omit to see all ` +
        `statuses. Objectives always carry a required outcome — use \`objectives_view\` ` +
        `for full detail including the watcher list and audit log.`,
      inputSchema: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: [...OBJECTIVE_STATUSES],
            description:
              'Filter by lifecycle status. Omit to return all statuses. Defaults to no filter.',
          },
        },
      },
    },
    {
      name: 'objectives_view',
      description:
        `Fetch the full state of a single objective including its outcome, current status, ` +
        `block reason (if any), and the append-only event history. Use this before calling ` +
        `\`objectives_update\` or \`objectives_complete\` so you have the latest acceptance ` +
        `criteria fresh in context.`,
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The objective id (e.g. obj-xxxxx-y).' },
        },
        required: ['id'],
      },
    },
    {
      name: 'objectives_update',
      description:
        `Transition an objective's status. Use status='blocked' + blockReason when you're ` +
        `stuck and need a commander to intervene. Use status='active' to resume after a ` +
        `block. This tool is for STATE transitions only — for progress notes, questions, ` +
        `intermediate findings, or any conversation about the objective, use ` +
        `\`objectives_discuss\` to post into the objective's discussion thread. This tool ` +
        `never transitions to 'done' — call \`objectives_complete\` for that.`,
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The objective id.' },
          status: {
            type: 'string',
            enum: ['active', 'blocked'],
            description:
              "Required new status. Use 'blocked' + blockReason when stuck; 'active' to resume.",
          },
          blockReason: {
            type: 'string',
            description: 'Required when status=blocked. Concisely describe what is blocking you.',
          },
        },
        required: ['id', 'status'],
      },
    },
    {
      name: 'objectives_discuss',
      description:
        `Post a message into an objective's dedicated discussion thread. The thread ` +
        `members are the originator, the assignee, and all commanders on the squadron — ` +
        `everyone who needs visibility into the work gets the message immediately on ` +
        `their live stream. Use this for progress updates, questions, intermediate ` +
        `findings, coordination with the originator, or acknowledgments — anything that's ` +
        `conversation rather than a state transition. Every post is archived alongside ` +
        `the objective's event log and is visible in the web UI's inline thread view.`,
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The objective id.' },
          body: {
            type: 'string',
            description: 'The message body to post into the objective thread.',
          },
          title: {
            type: 'string',
            description: 'Optional short title / subject line.',
          },
        },
        required: ['id', 'body'],
      },
    },
    {
      name: 'objectives_complete',
      description:
        `Mark an objective as done with a required result summary. Call ` +
        `\`objectives_view\` first to refresh the acceptance criteria in context. The ` +
        `\`result\` should explicitly address whether the stated outcome was met and link ` +
        `or describe the deliverable. Only the current assignee may call this.`,
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The objective id.' },
          result: {
            type: 'string',
            description:
              'Required summary of what was delivered and how it meets the stated outcome.',
          },
        },
        required: ['id', 'result'],
      },
    },
    // ── Authority-gated tools ────────────────────────────────────────
    //
    // These tools appear in the agent's toolbox only when their slot
    // holds the corresponding authority on the squadron. The server
    // enforces the same rules independently — if an operator somehow
    // invokes one (stale MCP client, prompt injection, etc.) the
    // request 403s — but keeping them out of the tool list is the
    // first line of defense and the natural UX.
    //
    //   commander + lieutenant: objectives_create, objectives_cancel,
    //                           objectives_watchers
    //   commander only:         objectives_reassign
    //
    // For lieutenants, `cancel` and `watchers` descriptions call out
    // the "only objectives you originated" rule so the agent doesn't
    // try to touch someone else's objective and eat a 403.
    ...buildAuthorityTools(briefing),
  ];
}

function buildAuthorityTools(briefing: BriefingResponse): Tool[] {
  const { authority, squadron, callsign, teammates } = briefing;
  if (authority === 'operator') return [];

  const others = teammates.filter((t) => t.callsign !== callsign);
  const teammateList =
    others.length > 0
      ? others.map((t) => `${t.callsign} (${t.role})`).join(', ')
      : '(no other teammates currently defined)';

  const tools: Tool[] = [];

  // objectives_create — both commander and lieutenant
  tools.push({
    name: 'objectives_create',
    description:
      `Create and assign a new objective on squadron ${squadron.name}. You can direct work ` +
      `to any teammate — the assignee receives an immediate channel push with the title, ` +
      `outcome, and originator stamped as you (${callsign}). The \`outcome\` field is ` +
      `contractual: it must state the tangible, verifiable result that defines "done", not ` +
      `just a vague intent. Optionally include a \`body\` for additional context and ` +
      `\`watchers\` (a list of callsigns) to loop other teammates into the discussion thread ` +
      `from the start. Available assignees: ${teammateList}.`,
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Short, specific title for the objective.',
        },
        outcome: {
          type: 'string',
          description:
            'Required. The tangible result that defines "done" — what specifically must be true for this objective to be marked complete.',
        },
        body: {
          type: 'string',
          description:
            'Optional longer context — constraints, scoping notes, links, reproductions.',
        },
        assignee: {
          type: 'string',
          description: 'Callsign of the teammate who will execute this objective.',
        },
        watchers: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional list of teammate callsigns to add as watchers on the objective thread from the start.',
        },
      },
      required: ['title', 'outcome', 'assignee'],
    },
  });

  // objectives_cancel — commander (any) or originating lieutenant (own)
  const cancelScope =
    authority === 'commander'
      ? 'You can cancel any non-terminal objective on the squadron.'
      : "You can cancel objectives you originated (created). Attempting to cancel someone else's objective will be refused by the server.";
  tools.push({
    name: 'objectives_cancel',
    description:
      `Terminally cancel an objective. Use this when work is no longer needed — priorities ` +
      `shifted, the problem went away, the assignee is overwhelmed, etc. Cancellation is ` +
      `terminal: a cancelled objective cannot be resumed (create a fresh one if you change ` +
      `your mind). ${cancelScope} Include a \`reason\` so the assignee and any watchers ` +
      `understand why.`,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The objective id.' },
        reason: {
          type: 'string',
          description:
            'Optional but strongly recommended — explain why the objective is being cancelled.',
        },
      },
      required: ['id'],
    },
  });

  // objectives_watchers — commander (any) or originating lieutenant (own)
  const watchersScope =
    authority === 'commander'
      ? 'You can manage watchers on any objective on the squadron.'
      : "You can manage watchers on objectives you originated. Attempting to modify watchers on someone else's objective will be refused by the server.";
  tools.push({
    name: 'objectives_watchers',
    description:
      `Add or remove watchers on an objective's discussion thread. Watchers receive every ` +
      `lifecycle event and every discussion post on the objective — use this to loop in a ` +
      `reviewer, a subject-matter expert, or anyone who should have awareness without ` +
      `being the assignee. Commanders are implicit members and never need to be added. ` +
      `${watchersScope} Pass \`add\` and/or \`remove\` as arrays of callsigns.`,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The objective id.' },
        add: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of teammate callsigns to add as watchers.',
        },
        remove: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of teammate callsigns to remove from watchers.',
        },
      },
      required: ['id'],
    },
  });

  // objectives_reassign — commander only
  if (authority === 'commander') {
    tools.push({
      name: 'objectives_reassign',
      description:
        `Reassign a non-terminal objective to a different teammate. Both the previous and ` +
        `new assignee receive channel pushes — the previous one so they know the ` +
        `objective left their plate, the new one so they know they now own it. Use this ` +
        `when the initial assignee is overwhelmed, the wrong skill match, or unavailable. ` +
        `Commander-only: lieutenants cannot reassign.`,
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The objective id.' },
          to: {
            type: 'string',
            description: 'Callsign of the new assignee.',
          },
          note: {
            type: 'string',
            description: 'Optional note explaining the reassignment.',
          },
        },
        required: ['id', 'to'],
      },
    });
  }

  return tools;
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
      case 'objectives_list':
        return await handleObjectivesList(args, brokerClient, briefing);
      case 'objectives_view':
        return await handleObjectivesView(args, brokerClient);
      case 'objectives_update':
        return await handleObjectivesUpdate(args, brokerClient);
      case 'objectives_discuss':
        return await handleObjectivesDiscuss(args, brokerClient);
      case 'objectives_complete':
        return await handleObjectivesComplete(args, brokerClient);
      case 'objectives_create':
        return await handleObjectivesCreate(args, brokerClient, briefing);
      case 'objectives_cancel':
        return await handleObjectivesCancel(args, brokerClient, briefing);
      case 'objectives_watchers':
        return await handleObjectivesWatchers(args, brokerClient, briefing);
      case 'objectives_reassign':
        return await handleObjectivesReassign(args, brokerClient, briefing);
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
    return textResult('squadron roster: (no slots defined)');
  }
  const lines = roster.teammates.map((t) => {
    const conn = connectedByCallsign.get(t.callsign) ?? 0;
    const self = t.callsign === briefing.callsign ? ' (you)' : '';
    const state = conn > 0 ? `connected=${conn}` : 'offline';
    const auth = t.authority !== 'operator' ? ` [${t.authority}]` : '';
    return `- ${t.callsign}${self} [${t.role}]${auth} ${state}`;
  });
  return textResult(`squadron ${briefing.squadron.name} roster:\n${lines.join('\n')}`);
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
    const scope = withOther ? `DM with ${withOther}` : `${briefing.squadron.name} squadron channel`;
    return textResult(`recent: no messages in ${scope}`);
  }

  const header = withOther
    ? `recent DMs with ${withOther} (${messages.length}):`
    : `recent ${briefing.squadron.name} squadron chat (${messages.length}):`;
  const lines = messages.map((m) => formatRecentLine(m));
  return textResult(`${header}\n${lines.join('\n')}`);
}

// ── Objectives handlers ────────────────────────────────────────────

async function handleObjectivesList(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
  briefing: BriefingResponse,
): Promise<CallToolResult> {
  const status = typeof args.status === 'string' ? (args.status as ObjectiveStatus) : undefined;
  if (status !== undefined && !OBJECTIVE_STATUSES.includes(status)) {
    return errorResult(
      `objectives_list: invalid status '${String(args.status)}'. Must be one of: ${OBJECTIVE_STATUSES.join(', ')}.`,
    );
  }
  const list = await brokerClient.listObjectives({
    assignee: briefing.callsign,
    ...(status ? { status } : {}),
  });
  if (list.length === 0) {
    return textResult(
      status
        ? `no ${status} objectives assigned to ${briefing.callsign}`
        : `no objectives assigned to ${briefing.callsign}`,
    );
  }
  const lines = list.map(
    (o) =>
      `- ${o.id} [${o.status}] ${o.title}\n` +
      `    outcome: ${o.outcome}\n` +
      `    updated: ${formatAgentTimestamp(o.updatedAt)} (${formatRelativeAge(o.updatedAt)})`,
  );
  return textResult(`objectives for ${briefing.callsign}:\n${lines.join('\n')}`);
}

async function handleObjectivesView(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
): Promise<CallToolResult> {
  const id = typeof args.id === 'string' ? args.id : '';
  if (!id) return errorResult('objectives_view: `id` is required');
  const { objective, events } = await brokerClient.getObjective(id);
  const lines: string[] = [
    `${objective.id} [${objective.status}] ${objective.title}`,
    `assignee: ${objective.assignee}  originator: ${objective.originator}`,
    `outcome: ${objective.outcome}`,
    `created: ${formatAgentTimestamp(objective.createdAt)} (${formatRelativeAge(objective.createdAt)})`,
    `updated: ${formatAgentTimestamp(objective.updatedAt)} (${formatRelativeAge(objective.updatedAt)})`,
  ];
  if (objective.completedAt) {
    lines.push(
      `completed: ${formatAgentTimestamp(objective.completedAt)} (${formatRelativeAge(objective.completedAt)})`,
    );
  }
  if (objective.watchers.length > 0) {
    lines.push(`watchers: ${objective.watchers.join(', ')}`);
  }
  if (objective.body) lines.push(`body: ${objective.body}`);
  if (objective.blockReason) lines.push(`block reason: ${objective.blockReason}`);
  if (objective.result) lines.push(`result: ${objective.result}`);
  lines.push('events:');
  for (const ev of events) {
    const ts = formatAgentTimestamp(ev.ts);
    const age = formatRelativeAge(ev.ts);
    lines.push(`  ${ts} (${age}) ${ev.actor} ${ev.kind} ${JSON.stringify(ev.payload)}`);
  }
  return textResult(lines.join('\n'));
}

async function handleObjectivesUpdate(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
): Promise<CallToolResult> {
  const id = typeof args.id === 'string' ? args.id : '';
  if (!id) return errorResult('objectives_update: `id` is required');
  const statusArg = typeof args.status === 'string' ? args.status : undefined;
  if (statusArg !== 'active' && statusArg !== 'blocked') {
    return errorResult(
      `objectives_update: status is required and must be 'active' or 'blocked' (use objectives_complete for 'done' and objectives_discuss for progress notes)`,
    );
  }
  const blockReason = typeof args.blockReason === 'string' ? args.blockReason : undefined;
  if (statusArg === 'blocked' && (!blockReason || blockReason.trim().length === 0)) {
    return errorResult('objectives_update: blockReason is required when status=blocked');
  }
  const updated = await brokerClient.updateObjective(id, {
    status: statusArg,
    ...(blockReason !== undefined ? { blockReason } : {}),
  });
  return textResult(
    `updated ${updated.id}: status=${updated.status}${
      updated.blockReason ? ` blockReason="${updated.blockReason}"` : ''
    }`,
  );
}

async function handleObjectivesDiscuss(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
): Promise<CallToolResult> {
  const id = typeof args.id === 'string' ? args.id : '';
  const body = typeof args.body === 'string' ? args.body : '';
  if (!id || !body) {
    return errorResult('objectives_discuss: both `id` and `body` are required');
  }
  const title = typeof args.title === 'string' ? args.title : undefined;
  const message = await brokerClient.discussObjective(id, {
    body,
    ...(title !== undefined ? { title } : {}),
  });
  return textResult(
    `posted to objective ${id} thread: msg=${message.id} (fanned out to thread members)`,
  );
}

async function handleObjectivesComplete(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
): Promise<CallToolResult> {
  const id = typeof args.id === 'string' ? args.id : '';
  const result = typeof args.result === 'string' ? args.result : '';
  if (!id || !result) {
    return errorResult('objectives_complete: both `id` and `result` are required');
  }
  const updated = await brokerClient.completeObjective(id, result);
  return textResult(`completed ${updated.id}. Result recorded and originator notified.`);
}

// ── Authority-gated handlers (defensive re-checks) ────────────────────
// The server is authoritative on permissions — if an operator somehow
// invokes one of these tools we'll get a 403 at the broker. But a
// fast local authority check gives a better error message and avoids
// a round trip. The tool list generation already prevents operators
// from seeing these tools; the handler-level check defends against a
// stale MCP client or prompt injection that name-calls the tool.

async function handleObjectivesCreate(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
  briefing: BriefingResponse,
): Promise<CallToolResult> {
  if (briefing.authority !== 'commander' && briefing.authority !== 'lieutenant') {
    return errorResult(
      'objectives_create: requires commander or lieutenant authority on the squadron',
    );
  }
  const title = typeof args.title === 'string' ? args.title.trim() : '';
  const outcome = typeof args.outcome === 'string' ? args.outcome.trim() : '';
  const assignee = typeof args.assignee === 'string' ? args.assignee : '';
  if (!title) return errorResult('objectives_create: `title` is required');
  if (!outcome) return errorResult('objectives_create: `outcome` is required');
  if (!assignee) return errorResult('objectives_create: `assignee` is required');
  const body = typeof args.body === 'string' ? args.body : undefined;
  // Watchers: accept only an array of strings; silently filter out
  // anything else so a misshapen payload doesn't poison the request.
  let watchers: string[] | undefined;
  if (Array.isArray(args.watchers)) {
    watchers = args.watchers.filter((v): v is string => typeof v === 'string');
  }
  const created = await brokerClient.createObjective({
    title,
    outcome,
    assignee,
    ...(body ? { body } : {}),
    ...(watchers && watchers.length > 0 ? { watchers } : {}),
  });
  return textResult(
    `created ${created.id} assigned to ${created.assignee}: ${created.title}\n` +
      `outcome: ${created.outcome}\n` +
      (created.watchers.length > 0
        ? `watchers: ${created.watchers.join(', ')}`
        : 'watchers: (none)'),
  );
}

async function handleObjectivesCancel(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
  briefing: BriefingResponse,
): Promise<CallToolResult> {
  if (briefing.authority !== 'commander' && briefing.authority !== 'lieutenant') {
    return errorResult(
      'objectives_cancel: requires commander or lieutenant authority on the squadron',
    );
  }
  const id = typeof args.id === 'string' ? args.id : '';
  if (!id) return errorResult('objectives_cancel: `id` is required');
  const reason = typeof args.reason === 'string' ? args.reason : undefined;
  const updated = await brokerClient.cancelObjective(id, reason ? { reason } : {});
  return textResult(`cancelled ${updated.id}: ${updated.title}`);
}

async function handleObjectivesWatchers(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
  briefing: BriefingResponse,
): Promise<CallToolResult> {
  if (briefing.authority !== 'commander' && briefing.authority !== 'lieutenant') {
    return errorResult(
      'objectives_watchers: requires commander or lieutenant authority on the squadron',
    );
  }
  const id = typeof args.id === 'string' ? args.id : '';
  if (!id) return errorResult('objectives_watchers: `id` is required');
  const add = Array.isArray(args.add)
    ? args.add.filter((v): v is string => typeof v === 'string')
    : undefined;
  const remove = Array.isArray(args.remove)
    ? args.remove.filter((v): v is string => typeof v === 'string')
    : undefined;
  if ((!add || add.length === 0) && (!remove || remove.length === 0)) {
    return errorResult('objectives_watchers: must include at least one of `add` or `remove`');
  }
  const updated = await brokerClient.updateObjectiveWatchers(id, {
    ...(add && add.length > 0 ? { add } : {}),
    ...(remove && remove.length > 0 ? { remove } : {}),
  });
  return textResult(
    `updated ${updated.id} watchers: ${
      updated.watchers.length > 0 ? updated.watchers.join(', ') : '(none)'
    }`,
  );
}

async function handleObjectivesReassign(
  args: Record<string, unknown>,
  brokerClient: BrokerClient,
  briefing: BriefingResponse,
): Promise<CallToolResult> {
  if (briefing.authority !== 'commander') {
    return errorResult('objectives_reassign: requires commander authority on the squadron');
  }
  const id = typeof args.id === 'string' ? args.id : '';
  const to = typeof args.to === 'string' ? args.to : '';
  if (!id || !to) return errorResult('objectives_reassign: both `id` and `to` are required');
  const note = typeof args.note === 'string' ? args.note : undefined;
  const updated = await brokerClient.reassignObjective(id, {
    to,
    ...(note ? { note } : {}),
  });
  return textResult(`reassigned ${updated.id} to ${updated.assignee}: ${updated.title}`);
}

function formatRecentLine(m: Message): string {
  const ts = formatAgentTimestamp(m.ts);
  const from = m.from ?? '?';
  const target = m.agentId ? ` → ${m.agentId}` : '';
  const title = m.title ? ` [${m.title}]` : '';
  return `  ${ts} ${from}${target}${title}: ${m.body}`;
}

/**
 * Format a unix-ms timestamp for agent consumption. Shape:
 *   04/15/26 14:23:45 UTC
 *
 * Rationale: agents receive timestamps in channel metadata and tool
 * output inline with text they're reading. A raw unix-ms number or a
 * bare `HH:MM` string forces them to run a tool (or guess) to figure
 * out when something happened. This format is:
 *
 *   - Unambiguous about timezone (UTC label)
 *   - Dated (mm/dd/yy so the agent can tell "today" vs "three weeks ago")
 *   - Precise to the second (distinguishes near-simultaneous events,
 *     which happens in rapid objective lifecycle transitions)
 *   - Fixed-width (21 chars) so columns line up cleanly in tables
 *
 * We intentionally don't include milliseconds — the second granularity
 * is enough for human-reasoning and avoids noise. We don't include
 * day-of-week because it's redundant with the date and bloats the line.
 */
export function formatAgentTimestamp(ms: number): string {
  const d = new Date(ms);
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const yy = String(d.getUTCFullYear()).slice(-2);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const min = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${mm}/${dd}/${yy} ${hh}:${min}:${ss} UTC`;
}

/**
 * Format a relative time hint from a unix-ms timestamp. Used in the
 * objective event log to answer "how long ago was that?" at a glance
 * without making the agent do subtraction. Caller supplies `now` so
 * tests can pin time; production uses Date.now.
 *
 * Examples: "just now", "5m ago", "2h ago", "3d ago", "future".
 */
export function formatRelativeAge(ms: number, now: number = Date.now()): string {
  const delta = now - ms;
  if (delta < 0) return 'future';
  if (delta < 60_000) return 'just now';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return `${Math.floor(delta / 86_400_000)}d ago`;
}

function isLogLevel(v: unknown): v is LogLevel {
  return typeof v === 'string' && (LEVELS as readonly string[]).includes(v);
}

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
