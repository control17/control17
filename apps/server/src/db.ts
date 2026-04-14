/**
 * Shared SQLite connection for the control17 server.
 *
 * `node:sqlite` uses a single-connection-per-process model — opening
 * the same file twice from one Node process gives you two independent
 * handles that will fight over WAL checkpoints and write locks. So we
 * open the database exactly once at server boot and hand the same
 * `DatabaseSync` instance to every module that needs it (event log,
 * session store, push-subscription store, …).
 *
 * Why a module-level helper instead of each module opening its own:
 *   - WAL mode and PRAGMA tuning only need to run once per file
 *   - shared prepared statements are scoped to the connection
 *   - shutdown has a single close point
 */

// Suppress the experimental warning before the first node:sqlite import.
import './suppress-experimental-warnings.js';

import { createRequire } from 'node:module';

type NodeSqliteModule = typeof import('node:sqlite');
export type DatabaseSyncInstance = InstanceType<NodeSqliteModule['DatabaseSync']>;
export type StatementInstance = ReturnType<DatabaseSyncInstance['prepare']>;

// esbuild (at least up to 0.27.x) strips the `node:` prefix off
// `node:sqlite` because it treats `sqlite` as a Node built-in in its
// hardcoded list — but there is no bare `sqlite` built-in, so the
// emitted `import from "sqlite"` breaks at runtime. Resolve at runtime
// via createRequire so esbuild can't touch the specifier string.
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as NodeSqliteModule;

/**
 * Open the control17 server database at `path` and apply the PRAGMAs
 * every module expects. Pass `:memory:` for an in-memory DB (tests,
 * ephemeral runs). The returned handle is owned by the caller —
 * typically `runServer`, which closes it during shutdown.
 */
export function openDatabase(path: string): DatabaseSyncInstance {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}
