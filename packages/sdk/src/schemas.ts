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
