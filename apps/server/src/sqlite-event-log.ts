/**
 * SQLite-backed implementation of `@control17/core`'s EventLog.
 *
 * Uses better-sqlite3 with WAL mode for durability + concurrent reads.
 * The schema is a single `events` table; this log is append-only and
 * small-scale by design. Swap out for Postgres/D1/etc. if we outgrow it.
 */

import type { EventLog, EventLogTailOptions } from '@control17/core';
import type { LogLevel, Message } from '@control17/sdk/types';
import Database from 'better-sqlite3';

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
  private readonly db: Database.Database;
  private readonly insertStmt: Database.Statement;
  private readonly tailSinceStmt: Database.Statement;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
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
    const rows = this.tailSinceStmt.all(since, limit) as EventRow[];
    // DB returns newest-first (ORDER BY ts DESC) so callers get stable order.
    // Reverse to match the in-memory impl's oldest-first-within-window shape.
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
