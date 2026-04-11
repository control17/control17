/**
 * `c17 serve` — start a local control17 broker.
 *
 * This is a thin launcher. `@control17/server` is an *optional* peer
 * dependency of the CLI so that users who only ever push events don't
 * drag in Hono, better-sqlite3 (native addon!), and the MCP server SDK.
 * When the user invokes `c17 serve`, we dynamically import the server
 * at runtime. If it isn't installed, we exit with a friendly hint.
 */

import { DEFAULT_PORT, ENV } from '@control17/sdk/protocol';

// Type-only import: compiles away, never loaded at runtime.
import type { RunningServer } from '@control17/server';

export interface ServeCommandInput {
  token?: string;
  port?: number;
  host?: string;
  dbPath?: string;
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export async function runServeCommand(
  input: ServeCommandInput,
  stdout: (line: string) => void,
): Promise<RunningServer> {
  const token = input.token ?? process.env[ENV.token];
  if (!token) {
    throw new UsageError(
      `serve: --token or ${ENV.token} env is required (shared secret for /push and /agents)`,
    );
  }
  const port = input.port ?? Number(process.env[ENV.port] ?? String(DEFAULT_PORT));
  if (Number.isNaN(port) || port < 1 || port > 65_535) {
    throw new UsageError(`serve: invalid port ${port}`);
  }
  const host = input.host ?? process.env[ENV.host] ?? '127.0.0.1';
  const dbPath = input.dbPath ?? process.env[ENV.dbPath] ?? ':memory:';

  const runServer = await loadRunServer();

  const running = await runServer({
    token,
    port,
    host,
    dbPath,
    onListen: (info) => {
      stdout(`control17-server listening on http://${info.address}:${info.port} (db: ${dbPath})`);
    },
  });

  return running;
}

/**
 * Dynamically resolve `@control17/server`'s `runServer` export. If the
 * package isn't installed (it's an optional peer), throw a UsageError
 * with install instructions rather than a raw MODULE_NOT_FOUND trace.
 */
async function loadRunServer(): Promise<typeof import('@control17/server')['runServer']> {
  try {
    const mod = await import('@control17/server');
    return mod.runServer;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
      throw new UsageError(
        'serve: @control17/server is not installed.\n' +
          '  This command needs the broker package. Install it alongside the CLI:\n' +
          '    npm install -g @control17/server\n' +
          '  Or install the full ecosystem in one step:\n' +
          '    npm install -g @control17/control17',
      );
    }
    throw err;
  }
}
