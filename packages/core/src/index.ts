/**
 * `@control17/core` — runtime-agnostic broker logic.
 *
 * Everything in here must be portable across JavaScript runtimes. No
 * `node:` imports, no fs, no http. Persistence/IO is injected via the
 * `EventLog` interface.
 */

export {
  Broker,
  type BrokerLogger,
  type BrokerOptions,
  type IdentityContext,
  type PushContext,
  type RegistrationResult,
} from './broker.js';
export {
  clampQueryLimit,
  DEFAULT_QUERY_LIMIT,
  type EventLog,
  type EventLogQueryOptions,
  type EventLogTailOptions,
  InMemoryEventLog,
  MAX_QUERY_LIMIT,
} from './event-log.js';
export {
  AgentIdentityError,
  AgentRegistry,
  type AgentState,
  type Subscriber,
} from './registry.js';
export {
  InMemorySessionStore,
  type InMemorySessionStoreOptions,
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
  type SessionRow,
  type SessionStore,
} from './session-store.js';
export {
  InMemoryPushSubscriptionStore,
  type InMemoryPushSubscriptionStoreOptions,
  type PushSubscriptionInput,
  type PushSubscriptionRow,
  type PushSubscriptionStore,
} from './push-subscription-store.js';

export { CORE_VERSION } from './version.js';
