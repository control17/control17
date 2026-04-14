/**
 * `c17 setup` — run the first-time wizard and exit.
 *
 * Thin launcher over `@control17/server`'s `runFirstRunWizard`. The
 * server package is an optional peer of the CLI, so we dynamically
 * import it at call time and print a friendly install hint if it's
 * missing — same pattern as `c17 serve`.
 *
 * Resolution of the config path:
 *   1. explicit `--config-path` on the command line
 *   2. `$C17_CONFIG_PATH` in the environment
 *   3. `./control17.json` relative to the caller's cwd
 *
 * Safety behavior: if a config already exists at the resolved path,
 * we refuse to overwrite it and print the existing team/slot summary.
 * Re-running the wizard against a live config would mint fresh tokens
 * and invalidate any deployed links — that's a foot-gun we'd rather
 * require an explicit `rm control17.json` for.
 */

import { ENV } from '@control17/sdk/protocol';

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export interface SetupCommandInput {
  configPath?: string;
}

export async function runSetupCommand(
  input: SetupCommandInput,
  stdout: (line: string) => void,
): Promise<void> {
  const server = await loadServerModule();
  const configPath = input.configPath ?? process.env[ENV.configPath] ?? server.defaultConfigPath();

  // Refuse to touch an existing config. Parse it so the user gets a
  // diagnostic showing what's already there — that's usually enough
  // to realize they didn't actually want to re-run setup.
  try {
    const existing = server.loadTeamConfigFromFile(configPath);
    throw new UsageError(
      `setup: a config already exists at ${configPath}\n` +
        `  team:   ${existing.team.name}\n` +
        `  slots:  ${existing.store.size()} (${existing.store.callsigns().join(', ')})\n` +
        '\n' +
        '  Running the wizard now would overwrite every slot token and\n' +
        '  invalidate any deployed links. If that is what you want,\n' +
        `  delete the file first:   rm ${configPath}`,
    );
  } catch (err) {
    if (err instanceof UsageError) throw err;
    if (!(err instanceof server.ConfigNotFoundError)) {
      if (err instanceof server.SlotLoadError) {
        throw new UsageError(`setup: existing config at ${configPath} is invalid: ${err.message}`);
      }
      throw err;
    }
    // ConfigNotFoundError is the happy path — drop through to the wizard.
  }

  const { io, close } = server.createTtyWizardIO();
  if (!io.isInteractive) {
    close();
    throw new UsageError(
      'setup: stdin is not a TTY — the wizard needs interactive input.\n' +
        '  Run this command in a real terminal (not piped / under turbo), or\n' +
        `  create ${configPath} by hand using the example config in the\n` +
        '  server README.',
    );
  }

  try {
    const config = await server.runFirstRunWizard({ configPath, io });
    stdout('');
    stdout('✓ setup complete');
    stdout(`  team:   ${config.team.name}`);
    stdout(`  slots:  ${config.store.callsigns().join(', ')}`);
    stdout(`  config: ${configPath}`);
    stdout('');
    stdout('Next steps:');
    stdout('  pnpm dev          # watch-mode server + Vite dev for the web UI');
    stdout('  c17 serve         # one-shot server run against this config');
    stdout('');
  } catch (err) {
    if (err instanceof server.SlotLoadError) {
      throw new UsageError(`setup: ${err.message}`);
    }
    throw err;
  } finally {
    close();
  }
}

/**
 * Dynamically resolve the full server module. If the package isn't
 * installed (it's an optional peer), throw a UsageError with install
 * instructions rather than a raw MODULE_NOT_FOUND trace. Same
 * implementation as the one in `commands/serve.ts` — small enough
 * that duplication beats a shared helper module.
 */
async function loadServerModule(): Promise<typeof import('@control17/server')> {
  try {
    return await import('@control17/server');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
      throw new UsageError(
        'setup: @control17/server is not installed.\n' +
          '  This command needs the broker package. Install it alongside the CLI:\n' +
          '    npm install -g @control17/server\n' +
          '  Or install the full ecosystem in one step:\n' +
          '    npm install -g @control17/c17',
      );
    }
    throw err;
  }
}
