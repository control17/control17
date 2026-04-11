/**
 * `@control17/core` — runtime-agnostic broker logic.
 *
 * Everything in here must be portable across JavaScript runtimes. No
 * `node:` imports, no fs, no http. Persistence/IO is injected via the
 * `EventLog` interface.
 */

export { Broker, type BrokerLogger, type BrokerOptions } from './broker.js';
export {
  type EventLog,
  type EventLogTailOptions,
  InMemoryEventLog,
} from './event-log.js';
export { AgentRegistry, type AgentState, type Subscriber } from './registry.js';

export { CORE_VERSION } from './version.js';
