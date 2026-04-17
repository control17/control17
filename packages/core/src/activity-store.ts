/**
 * Activity store — per-slot append-only timeline of everything a
 * slot's runner observed.
 *
 * The broker's activity surface captures four kinds of events (see
 * `@control17/sdk/types`'s `AgentActivityEvent`):
 *   - `llm_exchange` — a decoded LLM request/response pair, shipped
 *     by the MITM trace host on the runner side.
 *   - `opaque_http` — a non-LLM HTTP exchange observed by the proxy.
 *   - `objective_open` / `objective_close` — lifecycle markers the
 *     runner emits when the objectives tracker's open set changes.
 *
 * Objective "traces" are a time-range view over this stream: the web
 * UI queries `GET /agents/:callsign/activity?from=<open>&to=<close>
 * &kind=llm_exchange` rather than reading a separately-stored per-
 * objective blob.
 *
 * This module defines the runtime-agnostic `ActivityStore` interface
 * plus an in-memory reference implementation. The concrete SQLite
 * implementation lives in `@control17/server`; a future Cloudflare
 * Durable Objects implementation will live in `control17/platform`.
 * Both must preserve the same observable behavior: appends fire
 * subscribers synchronously after the write commits, listing is
 * newest-first with composable `from`/`to`/`kinds` filters, and
 * subscribers never see a row they'd miss via a concurrent `list`.
 */

import type { AgentActivityEvent, AgentActivityKind, AgentActivityRow } from '@control17/sdk/types';

/** Filter for `ActivityStore.list`. All fields AND-combined. */
export interface ListActivityFilter {
  /** Callsign whose stream to query. Required. */
  slotCallsign: string;
  /** Lower bound (inclusive) on `event.ts`. Omit for no lower bound. */
  from?: number;
  /** Upper bound (inclusive) on `event.ts`. Omit for no upper bound. */
  to?: number;
  /** If set, only return rows whose `event.kind` is in this list. */
  kinds?: readonly AgentActivityKind[];
  /**
   * Max rows returned. Callers should cap this in-band; implementations
   * should clamp to a sane upper bound (the SQLite impl caps at 1000).
   * Defaults to the implementation's own default (200 in the SQLite
   * impl; unbounded-with-array-cap in the in-memory impl below).
   */
  limit?: number;
}

/** Listener fired synchronously after each successful `append` row. */
export type ActivityListener = (row: AgentActivityRow) => void;

/**
 * Runtime-agnostic activity-store contract. Implementations are
 * responsible for:
 *
 *   - Atomicity on `append`: if any event in the batch fails to land,
 *     nothing lands (transaction or rollback).
 *   - Monotonic `id`s assigned per row. The SQLite impl uses
 *     `AUTOINCREMENT`; the in-memory impl uses a simple counter.
 *     IDs are unique within a store, but not globally across stores.
 *   - Subscriber fan-out happens AFTER the write commits but BEFORE
 *     `append` returns. This guarantees that any `list()` call from
 *     inside a subscriber sees the event the subscriber is being
 *     notified about.
 *   - `list` returns rows newest-first (by `event.ts` DESC, then by
 *     `id` DESC to stabilize same-ts ordering).
 */
export interface ActivityStore {
  /**
   * Persist events for a slot. Returns the fully-formed rows (with
   * assigned ids + createdAt) in the order they were inserted.
   * Empty-array inputs are a no-op and return `[]`.
   */
  append(slotCallsign: string, events: readonly AgentActivityEvent[]): AgentActivityRow[];

  /**
   * Range query. Returns newest-first, bounded by `filter.limit`
   * (implementation-defined default, implementation-defined max).
   */
  list(filter: ListActivityFilter): AgentActivityRow[];

  /**
   * Attach a listener for rows landing for `slotCallsign`. Fires
   * synchronously per row after the write commits. Returns an
   * unsubscribe function. Safe to call from inside a listener
   * (implementations must iterate a snapshot, not a live set).
   */
  subscribe(slotCallsign: string, listener: ActivityListener): () => void;

  /**
   * Delete every row where `event.ts < cutoffTs`, across every
   * slot. Returns the number of rows deleted. Idempotent — calling
   * twice with the same cutoff on the same store returns 0 the
   * second time.
   *
   * Added in the I2 operability chunk. In-memory stores implement
   * this via array filter; persistent stores map to
   * `DELETE FROM ... WHERE ts < ?`. A future in-broker background-
   * sweep timer wraps this method.
   */
  prune(cutoffTs: number): number;
}

/** Options for `InMemoryActivityStore`. */
export interface InMemoryActivityStoreOptions {
  /** Clock injection point. Defaults to `Date.now`. Tests pin this for deterministic `createdAt`. */
  now?: () => number;
  /**
   * Hard upper bound on `list.limit` — callers asking for more are
   * clamped down. Defaults to 1000 to match the SQLite impl. Also
   * sets the default `limit` when the caller omits it (halved:
   * 500 by default).
   */
  maxLimit?: number;
}

const DEFAULT_MAX_LIMIT = 1000;

/**
 * Reference implementation. Pure JS — no Node built-ins, no external
 * state. Suitable for tests, ephemeral dev runs, and any runtime
 * that doesn't (yet) have a persistence adapter. Data is lost on
 * restart; that's by design.
 */
export class InMemoryActivityStore implements ActivityStore {
  private readonly rowsBySlot = new Map<string, AgentActivityRow[]>();
  private readonly listenersBySlot = new Map<string, Set<ActivityListener>>();
  private readonly now: () => number;
  private readonly maxLimit: number;
  private nextId = 1;

  constructor(options: InMemoryActivityStoreOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.maxLimit = options.maxLimit ?? DEFAULT_MAX_LIMIT;
  }

  append(slotCallsign: string, events: readonly AgentActivityEvent[]): AgentActivityRow[] {
    if (events.length === 0) return [];

    const createdAt = this.now();
    const rows: AgentActivityRow[] = events.map((event) => ({
      id: this.nextId++,
      slotCallsign,
      event,
      createdAt,
    }));

    // All-or-nothing: the in-memory store has no real transaction,
    // but we build the full row array BEFORE mutating state so an
    // exception inside this loop can't leave a half-written append.
    let bucket = this.rowsBySlot.get(slotCallsign);
    if (!bucket) {
      bucket = [];
      this.rowsBySlot.set(slotCallsign, bucket);
    }
    for (const row of rows) bucket.push(row);

    // Snapshot listeners before iterating — a handler may unsubscribe
    // (or subscribe a new handler) during delivery; iterating a live
    // Set would produce undefined-order behavior for those cases.
    const listeners = this.listenersBySlot.get(slotCallsign);
    if (listeners && listeners.size > 0) {
      for (const listener of [...listeners]) {
        try {
          listener(rows[0] as AgentActivityRow);
          for (let i = 1; i < rows.length; i++) {
            listener(rows[i] as AgentActivityRow);
          }
        } catch {
          // Ref impl swallows listener errors — production uses the
          // SQLite impl where logging is wired. Raising here would
          // partial-fanout the remaining listeners for this append.
        }
      }
    }

    return rows;
  }

  list(filter: ListActivityFilter): AgentActivityRow[] {
    const bucket = this.rowsBySlot.get(filter.slotCallsign);
    if (!bucket || bucket.length === 0) return [];

    const limit = clampListLimit(filter.limit, this.maxLimit);
    const kindSet = filter.kinds && filter.kinds.length > 0 ? new Set(filter.kinds) : null;

    const matches: AgentActivityRow[] = [];
    // Walk newest-first so we can bail once `limit` is full.
    for (let i = bucket.length - 1; i >= 0; i--) {
      const row = bucket[i];
      if (!row) continue;
      if (filter.from !== undefined && row.event.ts < filter.from) continue;
      if (filter.to !== undefined && row.event.ts > filter.to) continue;
      if (kindSet && !kindSet.has(row.event.kind)) continue;
      matches.push(row);
      if (matches.length >= limit) break;
    }
    return matches;
  }

  subscribe(slotCallsign: string, listener: ActivityListener): () => void {
    let listeners = this.listenersBySlot.get(slotCallsign);
    if (!listeners) {
      listeners = new Set();
      this.listenersBySlot.set(slotCallsign, listeners);
    }
    listeners.add(listener);
    return () => {
      const current = this.listenersBySlot.get(slotCallsign);
      current?.delete(listener);
    };
  }

  prune(cutoffTs: number): number {
    let deleted = 0;
    for (const [slot, bucket] of this.rowsBySlot) {
      const kept: AgentActivityRow[] = [];
      for (const row of bucket) {
        if (row.event.ts < cutoffTs) {
          deleted++;
        } else {
          kept.push(row);
        }
      }
      if (kept.length === 0) {
        this.rowsBySlot.delete(slot);
      } else if (kept.length !== bucket.length) {
        this.rowsBySlot.set(slot, kept);
      }
    }
    return deleted;
  }

  /** Test-only: total row count across all slots. */
  size(): number {
    let total = 0;
    for (const bucket of this.rowsBySlot.values()) total += bucket.length;
    return total;
  }
}

/**
 * Normalize a caller-provided `limit` for `ActivityStore.list`.
 *   - undefined / non-finite  → half of `max` (same convention the SDK uses
 *     for page-size defaults).
 *   - `<= 0`                   → half of `max` (defensive: a zero limit is
 *     almost certainly a bad value, not an intent to query nothing).
 *   - `> max`                  → clamped to `max`.
 */
export function clampListLimit(raw: number | undefined, max: number): number {
  const defaultLimit = Math.max(1, Math.floor(max / 2));
  if (raw === undefined) return defaultLimit;
  if (!Number.isFinite(raw) || raw <= 0) return defaultLimit;
  return Math.min(Math.floor(raw), max);
}
