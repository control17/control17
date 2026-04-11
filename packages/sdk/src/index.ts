/**
 * `@control17/sdk` — contract and runtime client for control17.
 *
 * The root entry point re-exports everything for convenience. Consumers
 * that only want types or schemas should import the subpath entries:
 *
 *   import type { Agent, Message } from '@control17/sdk/types';
 *   import { PushPayloadSchema } from '@control17/sdk/schemas';
 *   import { DEFAULT_PORT, PATHS } from '@control17/sdk/protocol';
 *   import { Client, ClientError } from '@control17/sdk/client';
 */

export * from './client.js';
export * from './protocol.js';
export * from './schemas.js';
export * from './types.js';
