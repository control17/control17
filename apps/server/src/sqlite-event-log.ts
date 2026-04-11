/**
 * SQLite-backed implementation of `@control17/core`'s EventLog using
 * Node's built-in `node:sqlite` module.
 *
 * Why `node:sqlite` over `better-sqlite3`:
 *   - Zero native addons in the install graph — no node-gyp, no prebuild
 *     download, no C++ toolchain requirement. Alpine/minimal containers
 *     and future Bun-compile paths just work.
 *   - Same synchronous API shape as `better-sqlite3`, so the SqliteEventLog
 *     surface is essentially a rename.
 *
 * Caveat: `node:sqlite` is still marked experimental in Node 22 LTS
 * (unflagged but labelled). We suppress the single startup warning so
 * the server's stdout stays clean — users don't need the reminder on
 * every launch.
 */

// Suppress the experimental warning before the first node:sqlite import.
import './suppress-experimental-warnings.js';

import { createRequire } from 'node:module';
import type { EventLog, EventLogTailOptions } from '@control17/core';
import type { LogLevel, Message } from '@control17/sdk/types';

// esbuild (at least up to 0.27.x) strips the `node:` prefix off
// `node:sqlite` because it treats `sqlite` as a Node built-in in its
// hardcoded list — but there is no bare `sqlite` built-in, so the
// emitted `import from "sqlite"` breaks at runtime. Resolve at runtime
// via createRequire so esbuild can't touch the specifier string.
//
// Alias the class name for types separately from the value binding so
// TypeScript can refer to it in type position.
type NodeSqliteModule = typeof import('node:sqlite');
type DatabaseSyncInstance = InstanceType<NodeSqliteModule['DatabaseSync']>;
type StatementInstance = ReturnType<DatabaseSyncInstance['prepare']>;
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as NodeSqliteModule;

interface EventRow {
  id: string;
  ts: number;
  agent_id: string | null;
  title: string | null;
  body: string;
  level: string;
  data: string;
}

const CREATE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    ts INTEGER NOT NULL,
    agent_id TEXT,
    title TEXT,
    body TEXT NOT NULL,
    level TEXT NOT NULL,
    data TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS events_ts_idx ON events (ts);
`;

export class SqliteEventLog implements EventLog {
  private readonly db: DatabaseSyncInstance;
  private readonly insertStmt: StatementInstance;
  private readonly tailSinceStmt: StatementInstance;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    // node:sqlite doesn't have a .pragma() helper — use exec() for PRAGMAs.
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec(CREATE_SCHEMA);
    this.insertStmt = this.db.prepare(
      'INSERT INTO events (id, ts, agent_id, title, body, level, data) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    this.tailSinceStmt = this.db.prepare(
      'SELECT id, ts, agent_id, title, body, level, data FROM events WHERE ts >= ? ORDER BY ts DESC LIMIT ?',
    );
  }

  async append(message: Message): Promise<void> {
    this.insertStmt.run(
      message.id,
      message.ts,
      message.agentId,
      message.title,
      message.body,
      message.level,
      JSON.stringify(message.data),
    );
  }

  async tail(options: EventLogTailOptions = {}): Promise<Message[]> {
    const since = options.since ?? 0;
    const limit = options.limit ?? 100;
    const rows = this.tailSinceStmt.all(since, limit) as unknown as EventRow[];
    // DB returns newest-first (ORDER BY ts DESC) — reverse to match the
    // in-memory impl's oldest-first-within-window shape.
    return rows.reverse().map(rowToMessage);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

function rowToMessage(row: EventRow): Message {
  return {
    id: row.id,
    ts: row.ts,
    agentId: row.agent_id,
    title: row.title,
    body: row.body,
    level: row.level as LogLevel,
    data: JSON.parse(row.data) as Record<string, unknown>,
  };
}
