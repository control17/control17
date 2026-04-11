/**
 * `c17 serve` — start a local control17 broker.
 *
 * Calls `runServer()` from `@control17/server` in-process, so the CLI
 * stays a single Node process. The server keeps running until the
 * user sends SIGINT/SIGTERM, or the returned `stop()` resolves.
 */

import { DEFAULT_PORT, ENV } from '@control17/sdk/protocol';
import { type RunningServer, runServer } from '@control17/server';

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
