/**
 * `@control17/server` — CLI entry for the self-hosted broker.
 *
 * Thin wrapper around `runServer()` that reads config from env/argv,
 * loads the principal config file (or drops into the first-run wizard
 * if the file is missing and stdin is a TTY), wires shutdown handlers,
 * and prints a startup banner. Import `runServer` directly if you want
 * to embed the broker in another Node process.
 */

import { parseArgs } from 'node:util';
import { DEFAULT_PORT, ENV } from '@control17/sdk/protocol';
import { logger } from './logger.js';
import {
  ConfigNotFoundError,
  defaultConfigPath,
  exampleConfig,
  loadPrincipalsFromFileVerbose,
  PrincipalLoadError,
  type PrincipalStore,
} from './principals.js';
import { runServer } from './run.js';
import { createTtyWizardIO, runFirstRunWizard } from './wizard.js';

const USAGE = `control17-server

usage:
  control17-server [--config-path <path>]

options:
  --config-path <path>   path to the principal config file
                         (default: ./control17.json, or $C17_CONFIG_PATH)
  -h, --help             print this message and exit

env:
  ${ENV.port}      TCP port to listen on (default: ${DEFAULT_PORT})
  ${ENV.host}      hostname to bind (default: 127.0.0.1)
  ${ENV.dbPath}    SQLite path (default: :memory:)
  ${ENV.configPath}  config file path (overridden by --config-path)
`;

function readEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

function parseServerArgs(argv: string[]): { configPath?: string; help: boolean } {
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        'config-path': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: false,
    });
    return {
      configPath: typeof values['config-path'] === 'string' ? values['config-path'] : undefined,
      help: values.help === true,
    };
  } catch (err) {
    process.stderr.write(`control17-server: ${(err as Error).message}\n\n${USAGE}`);
    process.exit(2);
  }
}

async function loadOrCreatePrincipals(configPath: string): Promise<PrincipalStore> {
  try {
    const { store, migrated } = loadPrincipalsFromFileVerbose(configPath);
    if (migrated > 0) {
      process.stdout.write(
        `control17-server: hashed ${migrated} plaintext token(s) in ${configPath}\n`,
      );
    }
    return store;
  } catch (err) {
    if (err instanceof ConfigNotFoundError) {
      return runWizardOrFail(configPath);
    }
    if (err instanceof PrincipalLoadError) {
      process.stderr.write(`control17-server: ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
}

async function runWizardOrFail(configPath: string): Promise<PrincipalStore> {
  const { io, close } = createTtyWizardIO();
  if (!io.isInteractive) {
    close();
    process.stderr.write(
      `control17-server: no config file at ${configPath}\n\n` +
        `stdin is not a TTY, so the first-run wizard can't prompt. Create\n` +
        `the file yourself with contents like:\n\n${exampleConfig()}\n\n` +
        `or pass --config-path to point at a file you already have.\n`,
    );
    process.exit(1);
  }
  try {
    return await runFirstRunWizard({ configPath, io });
  } catch (err) {
    if (err instanceof PrincipalLoadError) {
      process.stderr.write(`control17-server: ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  } finally {
    close();
  }
}

async function main(): Promise<void> {
  const args = parseServerArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE);
    return;
  }

  const port = Number(readEnv(ENV.port) ?? String(DEFAULT_PORT));
  if (Number.isNaN(port) || port < 1 || port > 65_535) {
    process.stderr.write(`control17-server: invalid ${ENV.port}: ${readEnv(ENV.port)}\n`);
    process.exit(1);
  }

  const host = readEnv(ENV.host) ?? '127.0.0.1';
  const dbPath = readEnv(ENV.dbPath) ?? ':memory:';
  const configPath = args.configPath ?? defaultConfigPath();

  const principals = await loadOrCreatePrincipals(configPath);

  const running = await runServer({
    principals,
    port,
    host,
    dbPath,
    onListen: (info) => {
      process.stdout.write(
        `control17-server listening on http://${info.address}:${info.port}\n` +
          `  config: ${configPath}\n` +
          `  db:     ${dbPath}\n` +
          `  tokens: ${principals.size()} (${principals.names().join(', ')})\n`,
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
