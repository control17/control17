/**
 * Event log — append-only record of every message the broker has handled.
 *
 * Core depends only on this interface; the concrete implementation is
 * injected by the runtime adapter (Node server uses SQLite, tests use
 * the in-memory variant below).
 */

import type { Message } from '@control17/sdk/types';

export interface EventLogTailOptions {
  /** Return only events with `ts >= since`. Defaults to 0 (all). */
  since?: number;
  /** Return at most this many events. Defaults to 100. */
  limit?: number;
}

export interface EventLog {
  append(message: Message): Promise<void>;
  tail(options?: EventLogTailOptions): Promise<Message[]>;
  /** Close any underlying resources. No-op for in-memory impl. */
  close?(): Promise<void>;
}

/** In-memory event log. Useful for tests and ephemeral dev runs. */
export class InMemoryEventLog implements EventLog {
  private readonly events: Message[] = [];

  async append(message: Message): Promise<void> {
    this.events.push(message);
  }

  async tail(options: EventLogTailOptions = {}): Promise<Message[]> {
    const since = options.since ?? 0;
    const limit = options.limit ?? 100;
    const filtered = this.events.filter((e) => e.ts >= since);
    return filtered.slice(-limit);
  }

  /** Test-only: number of events currently in the log. */
  size(): number {
    return this.events.length;
  }
}
