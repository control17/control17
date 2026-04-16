/**
 * Runtime validators for the control17 wire protocol.
 *
 * Both the server and the client use these to validate messages crossing
 * the network boundary. Pulling from `@control17/sdk/schemas` keeps zod
 * as an explicit runtime dependency for consumers that want it.
 */

import { z } from 'zod';

export const LogLevelSchema = z.enum(['debug', 'info', 'notice', 'warning', 'error', 'critical']);

export const AuthoritySchema = z.enum(['commander', 'lieutenant', 'operator']);

/**
 * A role label — freeform string, 1-64 chars. No fixed enum; operators
 * define their own role names in the squadron config. Suggested defaults
 * (shipped by the wizard): `operator`, `implementer`, `reviewer`, `watcher`.
 */
export const RoleNameSchema = z.string().min(1).max(64);

/**
 * Callsigns obey the same shape rules as legacy agent IDs: alphanumeric
 * plus `.`, `_`, `-`, 1-128 chars.
 */
export const CallsignSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9._-]+$/, 'callsign must be alphanumeric with . _ - allowed');

/** Alias — `agentId` in wire payloads is always a callsign. */
export const AgentIdSchema = CallsignSchema;

export const SquadronSchema = z.object({
  name: z.string().min(1).max(128),
  mission: z.string().min(1).max(512),
  brief: z.string().max(4096).default(''),
});

export const RoleSchema = z.object({
  description: z.string().max(512).default(''),
  instructions: z.string().max(8192).default(''),
});

export const SlotSchema = z.object({
  callsign: CallsignSchema,
  role: RoleNameSchema,
  authority: AuthoritySchema.default('operator'),
});

export const TeammateSchema = z.object({
  callsign: CallsignSchema,
  role: RoleNameSchema,
  authority: AuthoritySchema,
});

export const PushPayloadSchema = z.object({
  agentId: AgentIdSchema.nullable().optional(),
  title: z.string().max(200).nullable().optional(),
  body: z
    .string()
    .min(1)
    .max(64 * 1024),
  level: LogLevelSchema.default('info'),
  data: z.record(z.string(), z.unknown()).optional(),
});

export const MessageSchema = z.object({
  id: z.string(),
  ts: z.number(),
  agentId: AgentIdSchema.nullable(),
  from: z.string().nullable(),
  title: z.string().nullable(),
  body: z.string(),
  level: LogLevelSchema,
  data: z.record(z.string(), z.unknown()),
});

export const AgentSchema = z.object({
  agentId: AgentIdSchema,
  connected: z.number().int().nonnegative(),
  createdAt: z.number(),
  lastSeen: z.number(),
  role: RoleNameSchema.nullable(),
  authority: AuthoritySchema,
});

export const DeliveryReportSchema = z.object({
  sse: z.number().int().nonnegative(),
  targets: z.number().int().nonnegative(),
});

export const PushResultSchema = z.object({
  delivery: DeliveryReportSchema,
  message: MessageSchema,
});

export const HealthResponseSchema = z.object({
  status: z.literal('ok'),
  version: z.string(),
});

// ───────────────────────── Objectives ─────────────────────────

export const ObjectiveStatusSchema = z.enum(['active', 'blocked', 'done', 'cancelled']);

export const ObjectiveSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(200),
  body: z.string().max(4096).default(''),
  outcome: z.string().min(1).max(2048),
  status: ObjectiveStatusSchema,
  assignee: CallsignSchema,
  originator: CallsignSchema,
  watchers: z.array(CallsignSchema).default([]),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  completedAt: z.number().int().nonnegative().nullable(),
  result: z.string().nullable(),
  blockReason: z.string().nullable(),
});

export const ObjectiveEventKindSchema = z.enum([
  'assigned',
  'blocked',
  'unblocked',
  'completed',
  'cancelled',
  'reassigned',
  'watcher_added',
  'watcher_removed',
]);

export const ObjectiveEventSchema = z.object({
  objectiveId: z.string().min(1),
  ts: z.number().int().nonnegative(),
  actor: CallsignSchema,
  kind: ObjectiveEventKindSchema,
  payload: z.record(z.string(), z.unknown()),
});

export const CreateObjectiveRequestSchema = z.object({
  title: z.string().min(1).max(200),
  outcome: z.string().min(1).max(2048),
  body: z.string().max(4096).optional(),
  assignee: CallsignSchema,
  watchers: z.array(CallsignSchema).max(64).optional(),
});

export const UpdateWatchersRequestSchema = z
  .object({
    add: z.array(CallsignSchema).max(64).optional(),
    remove: z.array(CallsignSchema).max(64).optional(),
  })
  .refine(
    (v) => (v.add && v.add.length > 0) || (v.remove && v.remove.length > 0),
    'must include at least one of: add, remove',
  );

export const UpdateObjectiveRequestSchema = z
  .object({
    status: z.enum(['active', 'blocked']).optional(),
    blockReason: z.string().max(2048).optional(),
  })
  .refine(
    (v) => v.status !== undefined || v.blockReason !== undefined,
    'update must include at least one of: status, blockReason',
  );

export const DiscussObjectiveRequestSchema = z.object({
  body: z
    .string()
    .min(1)
    .max(16 * 1024),
  title: z.string().max(200).optional(),
});

export const CompleteObjectiveRequestSchema = z.object({
  result: z.string().min(1).max(4096),
});

export const CancelObjectiveRequestSchema = z.object({
  reason: z.string().max(2048).optional(),
});

export const ReassignObjectiveRequestSchema = z.object({
  to: CallsignSchema,
  note: z.string().max(2048).optional(),
});

export const ListObjectivesResponseSchema = z.object({
  objectives: z.array(ObjectiveSchema),
});

export const GetObjectiveResponseSchema = z.object({
  objective: ObjectiveSchema,
  events: z.array(ObjectiveEventSchema),
});

export const ListObjectivesQuerySchema = z.object({
  assignee: CallsignSchema.optional(),
  status: ObjectiveStatusSchema.optional(),
});

// ───────────────────────── Trace entries ─────────────────────
//
// Trace entries are produced by the runner's MITM proxy as
// captured HTTP/1.1 exchanges. They flow through the agent
// activity stream (below) rather than a per-objective table.
// Schemas stay permissive because Anthropic's API shape evolves
// and opaque HTTP records can carry anything. The server stores
// them as JSON; the web UI walks them with its own renderer.

const AnthropicContentBlockSchema = z.union([
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('tool_use'),
    id: z.string(),
    name: z.string(),
    input: z.unknown(),
  }),
  z.object({
    type: z.literal('tool_result'),
    toolUseId: z.string(),
    content: z.unknown(),
    isError: z.boolean(),
  }),
  z.object({ type: z.literal('image'), mediaType: z.string().nullable() }),
  z.object({ type: z.literal('thinking'), text: z.string() }),
  z.object({ type: z.literal('unknown'), raw: z.unknown() }),
]);

const AnthropicMessageSchema = z.object({
  role: z.string(),
  content: z.array(AnthropicContentBlockSchema),
});

const AnthropicUsageSchema = z.object({
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  cacheCreationInputTokens: z.number().nullable(),
  cacheReadInputTokens: z.number().nullable(),
});

const AnthropicToolSchema = z.object({
  name: z.string(),
  description: z.string().nullable(),
  inputSchema: z.unknown(),
});

export const TraceEntrySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('anthropic_messages'),
    startedAt: z.number().int().nonnegative(),
    endedAt: z.number().int().nonnegative(),
    request: z.object({
      model: z.string().nullable(),
      maxTokens: z.number().nullable(),
      temperature: z.number().nullable(),
      system: z.string().nullable(),
      messages: z.array(AnthropicMessageSchema),
      tools: z.array(AnthropicToolSchema).nullable(),
    }),
    response: z
      .object({
        stopReason: z.string().nullable(),
        stopSequence: z.string().nullable(),
        messages: z.array(AnthropicMessageSchema),
        usage: AnthropicUsageSchema.nullable(),
        status: z.number().nullable(),
      })
      .nullable(),
  }),
  z.object({
    kind: z.literal('opaque_http'),
    startedAt: z.number().int().nonnegative(),
    endedAt: z.number().int().nonnegative(),
    host: z.string(),
    method: z.string(),
    url: z.string(),
    status: z.number().nullable(),
    requestHeaders: z.record(z.string(), z.string()),
    responseHeaders: z.record(z.string(), z.string()),
    requestBodyPreview: z.string().nullable(),
    responseBodyPreview: z.string().nullable(),
  }),
]);

// Pull out the two concrete entry variants so activity events
// can reference them directly (an LLM exchange carries an
// AnthropicMessagesEntry; an opaque HTTP event carries an
// OpaqueHttpEntry).
const AnthropicMessagesEntrySchema = z.object({
  kind: z.literal('anthropic_messages'),
  startedAt: z.number().int().nonnegative(),
  endedAt: z.number().int().nonnegative(),
  request: z.object({
    model: z.string().nullable(),
    maxTokens: z.number().nullable(),
    temperature: z.number().nullable(),
    system: z.string().nullable(),
    messages: z.array(AnthropicMessageSchema),
    tools: z.array(AnthropicToolSchema).nullable(),
  }),
  response: z
    .object({
      stopReason: z.string().nullable(),
      stopSequence: z.string().nullable(),
      messages: z.array(AnthropicMessageSchema),
      usage: AnthropicUsageSchema.nullable(),
      status: z.number().nullable(),
    })
    .nullable(),
});

const OpaqueHttpEntrySchema = z.object({
  kind: z.literal('opaque_http'),
  startedAt: z.number().int().nonnegative(),
  endedAt: z.number().int().nonnegative(),
  host: z.string(),
  method: z.string(),
  url: z.string(),
  status: z.number().nullable(),
  requestHeaders: z.record(z.string(), z.string()),
  responseHeaders: z.record(z.string(), z.string()),
  requestBodyPreview: z.string().nullable(),
  responseBodyPreview: z.string().nullable(),
});

// ───────────────────────── Agent activity stream ──────────────

export const AgentActivityKindSchema = z.enum([
  'objective_open',
  'objective_close',
  'llm_exchange',
  'opaque_http',
]);

export const AgentActivityEventSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('objective_open'),
    ts: z.number().int().nonnegative(),
    objectiveId: z.string().min(1),
  }),
  z.object({
    kind: z.literal('objective_close'),
    ts: z.number().int().nonnegative(),
    objectiveId: z.string().min(1),
    result: z.enum(['done', 'cancelled', 'reassigned', 'runner_shutdown']),
  }),
  z.object({
    kind: z.literal('llm_exchange'),
    ts: z.number().int().nonnegative(),
    duration: z.number().int().nonnegative(),
    entry: AnthropicMessagesEntrySchema,
  }),
  z.object({
    kind: z.literal('opaque_http'),
    ts: z.number().int().nonnegative(),
    duration: z.number().int().nonnegative(),
    entry: OpaqueHttpEntrySchema,
  }),
]);

export const AgentActivityRowSchema = z.object({
  id: z.number().int().nonnegative(),
  slotCallsign: CallsignSchema,
  event: AgentActivityEventSchema,
  createdAt: z.number().int().nonnegative(),
});

export const UploadAgentActivityRequestSchema = z.object({
  events: z.array(AgentActivityEventSchema).min(1).max(500),
});

export const UploadAgentActivityResponseSchema = z.object({
  accepted: z.number().int().nonnegative(),
});

export const ListAgentActivityResponseSchema = z.object({
  activity: z.array(AgentActivityRowSchema),
});

export const ListAgentActivityQuerySchema = z.object({
  from: z.number().int().nonnegative().optional(),
  to: z.number().int().nonnegative().optional(),
  kind: z.union([AgentActivityKindSchema, z.array(AgentActivityKindSchema)]).optional(),
  limit: z.number().int().positive().max(1000).optional(),
});

// ───────────────────────── Briefing + session ─────────────────

export const BriefingResponseSchema = z.object({
  callsign: CallsignSchema,
  role: RoleNameSchema,
  authority: AuthoritySchema,
  squadron: SquadronSchema,
  teammates: z.array(TeammateSchema),
  openObjectives: z.array(ObjectiveSchema),
  instructions: z.string(),
});

export const RosterResponseSchema = z.object({
  teammates: z.array(TeammateSchema),
  connected: z.array(AgentSchema),
});

export const HistoryResponseSchema = z.object({
  messages: z.array(MessageSchema),
});

export const TotpLoginRequestSchema = z.object({
  code: z.string().regex(/^\d{6}$/, 'code must be exactly 6 digits'),
  slot: CallsignSchema.optional(),
});

export const SessionResponseSchema = z.object({
  slot: CallsignSchema,
  role: RoleNameSchema,
  authority: AuthoritySchema,
  expiresAt: z.number().int().positive(),
});

export const VapidPublicKeyResponseSchema = z.object({
  publicKey: z.string().min(1),
});

export const PushSubscriptionPayloadSchema = z.object({
  endpoint: z.string().url('endpoint must be a URL').max(2048),
  keys: z.object({
    p256dh: z.string().min(1).max(256),
    auth: z.string().min(1).max(256),
  }),
});

export const PushSubscriptionResponseSchema = z.object({
  id: z.number().int().nonnegative(),
  endpoint: z.string(),
  createdAt: z.number().int().nonnegative(),
});
