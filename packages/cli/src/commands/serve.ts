/**
 * `c17 serve` — start a local control17 broker.
 *
 * Thin launcher. `@control17/server` is an *optional* peer dependency
 * of the CLI so that users who only ever push events don't drag in
 * Hono, node:sqlite, and the MCP server SDK. When the user invokes
 * `c17 serve`, we dynamically import the server at runtime. If it
 * isn't installed, we exit with a friendly hint.
 *
 * Auth comes from a JSON squadron config file. The CLI forwards the
 * resolved path to the server module; on a missing file we drop into
 * the same first-run wizard `c17-server` uses, so the two entry points
 * stay consistent.
 */

import { DEFAULT_PORT, ENV } from '@control17/sdk/protocol';

// Type-only import: compiles away, never loaded at runtime.
import type { RunningServer, SquadronConfig } from '@control17/server';

export interface ServeCommandInput {
  configPath?: string;
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
  const port = input.port ?? Number(process.env[ENV.port] ?? String(DEFAULT_PORT));
  if (Number.isNaN(port) || port < 1 || port > 65_535) {
    throw new UsageError(`serve: invalid port ${port}`);
  }
  const host = input.host ?? process.env[ENV.host] ?? '127.0.0.1';
  const dbPath = input.dbPath ?? process.env[ENV.dbPath] ?? ':memory:';

  const server = await loadServerModule();
  const configPath = input.configPath ?? process.env[ENV.configPath] ?? server.defaultConfigPath();

  const config = await loadOrCreateSquadronConfig(server, configPath, stdout);

  const running = await server.runServer({
    slots: config.store,
    squadron: config.squadron,
    roles: config.roles,
    port,
    host,
    dbPath,
    onListen: (info) => {
      stdout(
        `control17-server listening on http://${info.address}:${info.port}\n` +
          `  squadron: ${config.squadron.name}\n` +
          `  mission:  ${config.squadron.mission}\n` +
          `  config:   ${configPath}\n` +
          `  db:       ${dbPath}\n` +
          `  slots:    ${config.store.size()} (${config.store.callsigns().join(', ')})`,
      );
    },
  });

  return running;
}

async function loadOrCreateSquadronConfig(
  server: typeof import('@control17/server'),
  configPath: string,
  stdout: (line: string) => void,
): Promise<SquadronConfig> {
  try {
    const config = server.loadSquadronConfigFromFile(configPath);
    if (config.migrated > 0) {
      stdout(`c17 serve: hashed ${config.migrated} plaintext token(s) in ${configPath}`);
    }
    return config;
  } catch (err) {
    if (err instanceof server.ConfigNotFoundError) {
      return runWizardOrFail(server, configPath);
    }
    if (err instanceof server.SlotLoadError) {
      throw new UsageError(`serve: ${err.message}`);
    }
    throw err;
  }
}

async function runWizardOrFail(
  server: typeof import('@control17/server'),
  configPath: string,
): Promise<SquadronConfig> {
  const { io, close } = server.createTtyWizardIO();
  if (!io.isInteractive) {
    close();
    throw new UsageError(
      `serve: no config file at ${configPath}\n` +
        '  stdin is not a TTY, so the first-run wizard cannot prompt. Create\n' +
        '  the file yourself or pass --config-path to point at a file you already have.\n' +
        `  example config:\n\n${server.exampleConfig()}`,
    );
  }
  try {
    return await server.runFirstRunWizard({ configPath, io });
  } catch (err) {
    if (err instanceof server.SlotLoadError) {
      throw new UsageError(`serve: ${err.message}`);
    }
    throw err;
  } finally {
    close();
  }
}

/**
 * Dynamically resolve the full server module. If the package isn't
 * installed (it's an optional peer), throw a UsageError with install
 * instructions rather than a raw MODULE_NOT_FOUND trace.
 */
async function loadServerModule(): Promise<typeof import('@control17/server')> {
  try {
    return await import('@control17/server');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
      throw new UsageError(
        'serve: @control17/server is not installed.\n' +
          '  This command needs the broker package. Install it alongside the CLI:\n' +
          '    npm install -g @control17/server\n' +
          '  Or install the full ecosystem in one step:\n' +
          '    npm install -g @control17/c17',
      );
    }
    throw err;
  }
}
