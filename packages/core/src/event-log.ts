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

/**
 * Query filter for fetching thread history on behalf of a viewer.
 * Only rows "relevant to the viewer" are returned:
 *   - broadcasts (`agentId === null`), always
 *   - DMs the viewer sent (`from === viewer`)
 *   - DMs addressed to the viewer (`agentId === viewer`)
 *
 * When `with` is set, the filter narrows to DMs between the viewer
 * and that other party (primary thread is excluded). Rows are
 * returned newest-first up to `limit`.
 */
export interface EventLogQueryOptions {
  viewer: string;
  /** If set, narrow to DMs between viewer and this other principal. */
  with?: string;
  /** Hard upper bound on rows returned. Defaults to 100, max 1000. */
  limit?: number;
  /** Return only rows with `ts < before`. For pagination. */
  before?: number;
}

export interface EventLog {
  append(message: Message): Promise<void>;
  tail(options?: EventLogTailOptions): Promise<Message[]>;
  /**
   * Return messages relevant to the viewer, newest-first. Used by
   * the broker's /history endpoint to hydrate the TUI on connect and
   * after reconnects.
   */
  query(options: EventLogQueryOptions): Promise<Message[]>;
  /** Close any underlying resources. No-op for in-memory impl. */
  close?(): Promise<void>;
}

export const DEFAULT_QUERY_LIMIT = 100;
export const MAX_QUERY_LIMIT = 1000;

/** In-memory event log. Useful for tests and ephemeral dev runs. */
export class InMemoryEventLog implements EventLog {
  private readonly events: Message[] = [];

  async append(message: Message): Promise<void> {
    this.events.push(message);
  }

  async tail(options: EventLogTailOptions = {}): Promise<Message[]> {
    const since = options.since ?? 0;
    const limit = options.limit ?? DEFAULT_QUERY_LIMIT;
    const filtered = this.events.filter((e) => e.ts >= since);
    return filtered.slice(-limit);
  }

  async query(options: EventLogQueryOptions): Promise<Message[]> {
    const limit = clampLimit(options.limit);
    const matches: Message[] = [];
    // Walk newest-first so we can bail out once we've filled `limit`.
    for (let i = this.events.length - 1; i >= 0; i--) {
      const ev = this.events[i];
      if (!ev) continue;
      if (options.before !== undefined && ev.ts >= options.before) continue;
      if (!matchesViewer(ev, options.viewer, options.with)) continue;
      matches.push(ev);
      if (matches.length >= limit) break;
    }
    return matches;
  }

  /** Test-only: number of events currently in the log. */
  size(): number {
    return this.events.length;
  }
}

function matchesViewer(ev: Message, viewer: string, withOther?: string): boolean {
  if (withOther !== undefined) {
    // Narrowed DM view: only messages between `viewer` and `withOther`.
    // A DM from viewer to withOther has from=viewer, agentId=withOther.
    // A DM from withOther to viewer has from=withOther, agentId=viewer.
    if (ev.agentId === null) return false;
    if (ev.from === viewer && ev.agentId === withOther) return true;
    if (ev.from === withOther && ev.agentId === viewer) return true;
    return false;
  }
  // Default feed: broadcasts + any DM where viewer is either end.
  if (ev.agentId === null) return true;
  if (ev.from === viewer) return true;
  if (ev.agentId === viewer) return true;
  return false;
}

function clampLimit(raw: number | undefined): number {
  if (raw === undefined) return DEFAULT_QUERY_LIMIT;
  if (raw <= 0) return DEFAULT_QUERY_LIMIT;
  return Math.min(raw, MAX_QUERY_LIMIT);
}
