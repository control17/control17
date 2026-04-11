/**
 * `@control17/server` — CLI entry for the self-hosted broker.
 *
 * Thin wrapper around `runServer()` that reads config from env, wires
 * shutdown handlers, and prints a startup banner. Import `runServer`
 * directly if you want to embed the broker in another Node process.
 */

import { DEFAULT_PORT, ENV } from '@control17/sdk/protocol';
import { logger } from './logger.js';
import { runServer } from './run.js';

function readEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

async function main(): Promise<void> {
  const token = readEnv(ENV.token);
  if (!token) {
    process.stderr.write(
      `control17-server: ${ENV.token} is required (no default shared secret).\n`,
    );
    process.exit(1);
  }

  const port = Number(readEnv(ENV.port) ?? String(DEFAULT_PORT));
  if (Number.isNaN(port) || port < 1 || port > 65_535) {
    process.stderr.write(`control17-server: invalid ${ENV.port}: ${readEnv(ENV.port)}\n`);
    process.exit(1);
  }

  const host = readEnv(ENV.host) ?? '127.0.0.1';
  const dbPath = readEnv(ENV.dbPath) ?? ':memory:';

  const running = await runServer({
    token,
    port,
    host,
    dbPath,
    onListen: (info) => {
      process.stdout.write(
        `control17-server listening on http://${info.address}:${info.port} (db: ${dbPath})\n`,
      );
    },
  });

  const shutdown = async (signal: NodeJS.Signals) => {
    logger.info('shutting down', { signal });
    await running.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  process.stderr.write(
    `control17-server: fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
