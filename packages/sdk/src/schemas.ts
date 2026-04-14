/**
 * Runtime validators for the control17 wire protocol.
 *
 * Both the server and the client use these to validate messages crossing
 * the network boundary. Pulling from `@control17/sdk/schemas` keeps zod
 * as an explicit runtime dependency for consumers that want it.
 */

import { z } from 'zod';

export const LogLevelSchema = z.enum(['debug', 'info', 'notice', 'warning', 'error', 'critical']);

/**
 * A role label — freeform string, 1-64 chars. No fixed enum; operators
 * define their own role names in the team config. Suggested defaults
 * (shipped by the wizard): `operator`, `implementer`, `reviewer`, `watcher`.
 */
export const RoleNameSchema = z.string().min(1).max(64);

/**
 * Callsigns obey the same shape rules as legacy agent IDs: alphanumeric
 * plus `.`, `_`, `-`, 1-128 chars. These show up in wire messages, URLs,
 * and terminals, so we keep them tight.
 */
export const CallsignSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9._-]+$/, 'callsign must be alphanumeric with . _ - allowed');

/** Alias — `agentId` in wire payloads is always a callsign. */
export const AgentIdSchema = CallsignSchema;

export const TeamSchema = z.object({
  name: z.string().min(1).max(128),
  mission: z.string().min(1).max(512),
  brief: z.string().max(4096).default(''),
});

export const RoleSchema = z.object({
  description: z.string().max(512).default(''),
  instructions: z.string().max(8192).default(''),
  editor: z.boolean().optional(),
});

export const SlotSchema = z.object({
  callsign: CallsignSchema,
  role: RoleNameSchema,
});

export const TeammateSchema = z.object({
  callsign: CallsignSchema,
  role: RoleNameSchema,
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
  /** Target callsign, or null for a broadcast. */
  agentId: AgentIdSchema.nullable(),
  /** Broker-stamped sender callsign, or null for system events. */
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

export const BriefingResponseSchema = z.object({
  callsign: CallsignSchema,
  role: RoleNameSchema,
  team: TeamSchema,
  teammates: z.array(TeammateSchema),
  instructions: z.string(),
  canEdit: z.boolean(),
});

export const RosterResponseSchema = z.object({
  teammates: z.array(TeammateSchema),
  connected: z.array(AgentSchema),
});

export const HistoryResponseSchema = z.object({
  messages: z.array(MessageSchema),
});

export const TotpLoginRequestSchema = z.object({
  slot: CallsignSchema,
  code: z.string().regex(/^\d{6}$/, 'code must be exactly 6 digits'),
});

export const SessionResponseSchema = z.object({
  slot: CallsignSchema,
  role: RoleNameSchema,
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
