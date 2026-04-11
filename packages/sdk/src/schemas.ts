/**
 * Runtime validators for the control17 wire protocol.
 *
 * Both the server and the client use these to validate messages crossing
 * the network boundary. Pulling from `@control17/sdk/schemas` keeps zod
 * as an explicit runtime dependency for consumers that want it.
 */

import { z } from 'zod';

export const LogLevelSchema = z.enum(['debug', 'info', 'notice', 'warning', 'error', 'critical']);

export const AgentIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9._-]+$/, 'agentId must be alphanumeric with . _ - allowed');

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
});

export const AgentRegistrationRequestSchema = z.object({
  agentId: AgentIdSchema,
});

export const AgentRegistrationSchema = z.object({
  agentId: AgentIdSchema,
  registeredAt: z.number(),
});

export const DeliveryReportSchema = z.object({
  sse: z.number().int().nonnegative(),
  targets: z.number().int().nonnegative(),
});

export const PushResultSchema = z.object({
  delivery: DeliveryReportSchema,
  message: MessageSchema,
});

export const AgentListSchema = z.object({
  agents: z.array(AgentSchema),
});

export const HealthResponseSchema = z.object({
  status: z.literal('ok'),
  version: z.string(),
});
