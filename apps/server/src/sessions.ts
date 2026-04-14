/**
 * SQLite-backed session store for human web-UI auth.
 *
 * A session is a server-issued capability: after a human completes
 * TOTP verification, we mint a random `id`, store a row binding that
 * id to a slot callsign, and return it as an HttpOnly cookie. Every
 * subsequent request presenting the cookie resolves back to the slot
 * via the dual-auth middleware, same as a bearer-token request.
 *
 * Lifetime: sliding 7-day TTL. Every `touch()` bumps `last_seen` and
 * extends `expires_at`. Sessions older than their `expires_at` are
 * treated as nonexistent on read and purged by `purgeExpired()`.
 *
 * The store does NOT own the DB handle — `runServer` opens one shared
 * `DatabaseSync` via `openDatabase()` and passes it here alongside the
 * event log.
 */

import { randomBytes } from 'node:crypto';
import type { DatabaseSyncInstance, StatementInstance } from './db.js';

export const SESSION_COOKIE_NAME = 'c17_session';

/** 7 days. Sliding — every API call resets the window. */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** How many bytes of entropy per session id. 32 bytes = 256 bits. */
const SESSION_ID_BYTES = 32;

const CREATE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS sessions (
    id            TEXT PRIMARY KEY,
    slot_callsign TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    expires_at    INTEGER NOT NULL,
    last_seen     INTEGER NOT NULL,
    user_agent    TEXT
  );
  CREATE INDEX IF NOT EXISTS sessions_slot_idx ON sessions(slot_callsign);
  CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions(expires_at);
`;

export interface SessionRow {
  id: string;
  slotCallsign: string;
  createdAt: number;
  expiresAt: number;
  lastSeen: number;
  userAgent: string | null;
}

interface RawRow {
  id: string;
  slot_callsign: string;
  created_at: number;
  expires_at: number;
  last_seen: number;
  user_agent: string | null;
}

function rowToSession(row: RawRow): SessionRow {
  return {
    id: row.id,
    slotCallsign: row.slot_callsign,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastSeen: row.last_seen,
    userAgent: row.user_agent,
  };
}

export class SessionStore {
  private readonly db: DatabaseSyncInstance;
  private readonly insertStmt: StatementInstance;
  private readonly selectStmt: StatementInstance;
  private readonly touchStmt: StatementInstance;
  private readonly deleteStmt: StatementInstance;
  private readonly purgeStmt: StatementInstance;
  private readonly now: () => number;

  constructor(db: DatabaseSyncInstance, options: { now?: () => number } = {}) {
    this.db = db;
    this.now = options.now ?? Date.now;
    this.db.exec(CREATE_SCHEMA);
    this.insertStmt = this.db.prepare(
      'INSERT INTO sessions (id, slot_callsign, created_at, expires_at, last_seen, user_agent) VALUES (?, ?, ?, ?, ?, ?)',
    );
    this.selectStmt = this.db.prepare(
      'SELECT id, slot_callsign, created_at, expires_at, last_seen, user_agent FROM sessions WHERE id = ?',
    );
    this.touchStmt = this.db.prepare(
      'UPDATE sessions SET last_seen = ?, expires_at = ? WHERE id = ?',
    );
    this.deleteStmt = this.db.prepare('DELETE FROM sessions WHERE id = ?');
    this.purgeStmt = this.db.prepare('DELETE FROM sessions WHERE expires_at < ?');
  }

  /**
   * Mint a fresh session for `slotCallsign`. Returns the row so the
   * caller can put the `id` in a Set-Cookie header and return the
   * `expiresAt` to the SPA.
   */
  create(slotCallsign: string, userAgent: string | null): SessionRow {
    const id = randomBytes(SESSION_ID_BYTES).toString('base64url');
    const now = this.now();
    const expiresAt = now + SESSION_TTL_MS;
    this.insertStmt.run(id, slotCallsign, now, expiresAt, now, userAgent);
    return {
      id,
      slotCallsign,
      createdAt: now,
      expiresAt,
      lastSeen: now,
      userAgent,
    };
  }

  /**
   * Look up a session by id. Returns null if the row doesn't exist or
   * is expired. Expired rows are not eagerly deleted here; that's the
   * periodic `purgeExpired()` job's responsibility.
   */
  get(id: string): SessionRow | null {
    const raw = this.selectStmt.get(id) as RawRow | undefined;
    if (!raw) return null;
    const row = rowToSession(raw);
    if (row.expiresAt < this.now()) return null;
    return row;
  }

  /**
   * Bump `last_seen` and extend `expires_at` for an existing session.
   * Called on every authenticated request the session carries, so the
   * TTL slides as long as the operator stays active.
   */
  touch(id: string): void {
    const now = this.now();
    this.touchStmt.run(now, now + SESSION_TTL_MS, id);
  }

  /** Delete a specific session (logout). No-op if the id doesn't exist. */
  delete(id: string): void {
    this.deleteStmt.run(id);
  }

  /**
   * Best-effort cleanup of expired rows. Safe to call periodically and
   * on shutdown. Not called on every request — we don't want auth
   * latency to include a DELETE.
   */
  purgeExpired(): number {
    const result = this.purgeStmt.run(this.now());
    return Number(result.changes ?? 0);
  }
}
