/**
 * Agent activity stream store.
 *
 * Append-only timeline per slot, capturing everything the slot's
 * runner observed: LLM exchanges through the MITM proxy, opaque
 * HTTP calls to non-Anthropic endpoints, and objective lifecycle
 * markers (`objective_open` / `objective_close`). Objective traces
 * are a view over this stream — you query by time range bounded
 * by the markers for a given objectiveId.
 *
 * The store is a thin wrapper around SQLite plus an in-process
 * `EventEmitter` that the SSE endpoint subscribes to for live
 * tail. Appends fire the emitter synchronously after the insert
 * commits, so a subscriber attached during an append never misses
 * a row — and a subscriber that attaches AFTER an append can pull
 * the tail via `list()` and merge with the live stream, if the
 * client cares about zero gaps.
 *
 * Payloads are stored as JSON blobs (`event_json`). The server
 * doesn't introspect them beyond validating the discriminator at
 * the app layer; everything else is the SDK's responsibility.
 */

import { EventEmitter } from 'node:events';
import type {
  ActivityListener,
  ActivityStore as CoreActivityStore,
  ListActivityFilter as CoreListActivityFilter,
} from '@control17/core';
import { AgentActivityEventSchema } from '@control17/sdk/schemas';
import type { AgentActivityEvent, AgentActivityRow } from '@control17/sdk/types';
import type { DatabaseSyncInstance, StatementInstance } from './db.js';

const CREATE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS agent_activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slot_callsign TEXT NOT NULL,
    ts INTEGER NOT NULL,
    kind TEXT NOT NULL,
    event_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS agent_activity_slot_ts_idx
    ON agent_activity (slot_callsign, ts);
  CREATE INDEX IF NOT EXISTS agent_activity_slot_kind_ts_idx
    ON agent_activity (slot_callsign, kind, ts);
`;

interface AgentActivityRowRaw {
  id: number;
  slot_callsign: string;
  ts: number;
  kind: string;
  event_json: string;
  created_at: number;
}

function rowToActivity(row: AgentActivityRowRaw): AgentActivityRow {
  let event: AgentActivityEvent;
  try {
    event = AgentActivityEventSchema.parse(JSON.parse(row.event_json));
  } catch {
    // Malformed row — shouldn't happen since the app layer validates
    // on write, but degrade gracefully with a placeholder rather
    // than throw so one corrupt row can't break the whole query.
    event = {
      kind: 'opaque_http',
      ts: row.ts,
      duration: 0,
      entry: {
        kind: 'opaque_http',
        startedAt: row.ts,
        endedAt: row.ts,
        host: 'malformed-payload',
        method: 'UNKNOWN',
        url: '',
        status: null,
        requestHeaders: {},
        responseHeaders: {},
        requestBodyPreview: null,
        responseBodyPreview: null,
      },
    };
  }
  return {
    id: row.id,
    slotCallsign: row.slot_callsign,
    event,
    createdAt: row.created_at,
  };
}

/**
 * Server-side alias for `@control17/core`'s `ListActivityFilter`.
 * Re-exported so existing server callers don't have to switch imports
 * in the same PR; new code should import directly from core.
 */
export type ListActivityFilter = CoreListActivityFilter;

/**
 * Server-side alias for `@control17/core`'s `ActivityStore`. The
 * SQLite impl below `implements ActivityStore` from core; this alias
 * keeps existing server-side consumer types stable while the consumer
 * migration PR moves the rest of the codebase onto the core import
 * directly.
 */
export type AgentActivityStore = CoreActivityStore;

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

class SqliteAgentActivityStore implements CoreActivityStore {
  private readonly db: DatabaseSyncInstance;
  private readonly insertStmt: StatementInstance;
  private readonly emitter = new EventEmitter();

  constructor(db: DatabaseSyncInstance) {
    this.db = db;
    this.db.exec(CREATE_SCHEMA);
    // Prepared statements for the two common paths. Range queries
    // are built on the fly because the WHERE clause varies.
    this.insertStmt = db.prepare(
      `INSERT INTO agent_activity (slot_callsign, ts, kind, event_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    // EventEmitter's default max listeners is 10; a commander with
    // the web UI open + the slot itself tailing its own stream
    // could realistically hit 2-3 per slot, so bump to 50 to be safe.
    this.emitter.setMaxListeners(50);
  }

  append(slotCallsign: string, events: readonly AgentActivityEvent[]): AgentActivityRow[] {
    if (events.length === 0) return [];
    const now = Date.now();
    const inserted: AgentActivityRow[] = [];

    // Transaction: either all rows land or none. node:sqlite doesn't
    // expose a high-level transaction API; BEGIN/COMMIT via exec is
    // the standard pattern.
    this.db.exec('BEGIN');
    try {
      for (const event of events) {
        const result = this.insertStmt.run(
          slotCallsign,
          event.ts,
          event.kind,
          JSON.stringify(event),
          now,
        );
        const id = Number(result.lastInsertRowid ?? 0);
        inserted.push({
          id,
          slotCallsign,
          event,
          createdAt: now,
        });
      }
      this.db.exec('COMMIT');
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw err;
    }

    // Fan out to live subscribers. Synchronous — if a subscriber
    // throws, we log nothing here and let the emitter's default
    // behavior propagate (which at this point is harmless since
    // the write already committed).
    for (const row of inserted) {
      this.emitter.emit(`row:${slotCallsign}`, row);
    }

    return inserted;
  }

  list(filter: ListActivityFilter): AgentActivityRow[] {
    const limit = Math.min(filter.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const conditions: string[] = ['slot_callsign = ?'];
    const params: Array<string | number> = [filter.slotCallsign];
    if (filter.from !== undefined) {
      conditions.push('ts >= ?');
      params.push(filter.from);
    }
    if (filter.to !== undefined) {
      conditions.push('ts <= ?');
      params.push(filter.to);
    }
    if (filter.kinds && filter.kinds.length > 0) {
      const placeholders = filter.kinds.map(() => '?').join(',');
      conditions.push(`kind IN (${placeholders})`);
      params.push(...filter.kinds);
    }
    const sql =
      `SELECT * FROM agent_activity WHERE ${conditions.join(' AND ')} ` +
      `ORDER BY ts DESC, id DESC LIMIT ?`;
    params.push(limit);
    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as unknown as AgentActivityRowRaw[];
    return rows.map(rowToActivity);
  }

  subscribe(slotCallsign: string, listener: ActivityListener): () => void {
    const key = `row:${slotCallsign}`;
    this.emitter.on(key, listener);
    return () => {
      this.emitter.off(key, listener);
    };
  }

  /**
   * Delete every activity row older than `cutoffTs` (by `event.ts`).
   * Returns the number of rows deleted. Not part of the core
   * `ActivityStore` interface — a non-persistent backend has
   * nothing to prune — but surfaced on the SQLite impl for the
   * `c17 prune-traces` CLI and any future background-sweep timer.
   */
  prune(cutoffTs: number): number {
    const stmt = this.db.prepare('DELETE FROM agent_activity WHERE ts < ?');
    const result = stmt.run(cutoffTs);
    return Number(result.changes ?? 0);
  }
}

/**
 * Public type for the SQLite activity store, exposed so callers like
 * the `c17 prune-traces` CLI can invoke the impl-specific `prune`
 * method without casting. The core `ActivityStore` interface covers
 * the append/list/subscribe surface.
 */
export type SqliteAgentActivityStoreHandle = SqliteAgentActivityStore;

export function createSqliteAgentActivityStore(
  db: DatabaseSyncInstance,
): SqliteAgentActivityStoreHandle {
  return new SqliteAgentActivityStore(db);
}

/**
 * Stand-alone helper for tools (like `c17 prune-traces`) that need to
 * open the activity DB, prune, and close — without spinning up a full
 * `runServer`. The caller is responsible for picking `cutoffTs`; see
 * `parseDurationToCutoff` in the CLI for the user-facing shape.
 *
 * Returns the number of activity rows deleted.
 */
export function pruneActivityDb(db: DatabaseSyncInstance, cutoffTs: number): number {
  // Ensure the schema exists before pruning — `c17 prune-traces` may
  // be run against a fresh DB that the server has never booted
  // against, in which case the table wouldn't exist yet. Idempotent
  // with the constructor's CREATE IF NOT EXISTS.
  db.exec(CREATE_SCHEMA);
  const stmt = db.prepare('DELETE FROM agent_activity WHERE ts < ?');
  const result = stmt.run(cutoffTs);
  return Number(result.changes ?? 0);
}

export { parseDurationMs } from './duration.js';
