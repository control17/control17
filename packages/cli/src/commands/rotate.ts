/**
 * `c17 rotate` — regenerate a slot's bearer token.
 *
 * Closes the "no bearer-token rotation flow" gap from the 2026-04-16
 * audit. Before this, rotating a slot's bearer meant hand-editing
 * `control17.json` — risky (easy to typo / clobber another slot) and
 * skipped in practice.
 *
 * Flow:
 *   1. Load the squadron config at the resolved path.
 *   2. Error clearly if `--slot` is missing or the callsign isn't
 *      known.
 *   3. Call `rotateSlotToken` — atomic config rewrite at `0o600`
 *      with a fresh `c17_<base64url>` token; every other slot's
 *      state (authority, role, TOTP) is preserved byte-for-byte.
 *   4. Print the NEW plaintext token once with explicit save-now
 *      framing. The plaintext is never persisted to disk; only the
 *      SHA-256 hash lands in the config file.
 *
 * Recovery: if the operator loses the new token between the print
 * and saving it somewhere, they can just re-run `c17 rotate --slot X`
 * — it'll invalidate this one and mint a fresh one. Each rotation is
 * idempotent in posture; there's no recovery-of-a-lost-token path
 * because losing a secret is the whole point of treating it as a
 * secret.
 */

import { ENV } from '@control17/sdk/protocol';
import { UsageError } from './errors.js';

export { UsageError };

export interface RotateCommandInput {
  /** Callsign of the slot to rotate. Required. */
  slot?: string;
  /** Override the config file location (defaults to $C17_CONFIG_PATH → ./control17.json). */
  configPath?: string;
}

export async function runRotateCommand(
  input: RotateCommandInput,
  stdout: (line: string) => void,
): Promise<void> {
  if (!input.slot) {
    throw new UsageError('rotate: --slot <callsign> is required');
  }

  const server = await loadServerModule();
  const configPath = input.configPath ?? process.env[ENV.configPath] ?? server.defaultConfigPath();

  // Install the KEK before loading — the config on disk may have
  // encrypted TOTP secrets / VAPID private key that must round-trip
  // cleanly through load+write even on this rotation-only call path.
  try {
    server.setKek(server.resolveKek(configPath));
  } catch (err) {
    if (err instanceof server.KekResolutionError) {
      throw new UsageError(`rotate: ${err.message}`);
    }
    throw err;
  }

  // Defensive load — we want to fail fast with a useful error if the
  // config is missing or invalid rather than let `rotateSlotToken`
  // surface the SlotLoadError raw.
  let config: Awaited<ReturnType<typeof server.loadSquadronConfigFromFile>>;
  try {
    config = server.loadSquadronConfigFromFile(configPath);
  } catch (err) {
    if (err instanceof server.ConfigNotFoundError) {
      throw new UsageError(
        `rotate: no config file at ${configPath}\n` + '  Run `c17 setup` first to create one.',
      );
    }
    if (err instanceof server.SlotLoadError) {
      throw new UsageError(`rotate: ${err.message}`);
    }
    throw err;
  }

  if (!config.store.resolveByCallsign(input.slot)) {
    const known = config.store.callsigns().join(', ');
    throw new UsageError(
      `rotate: no slot with callsign '${input.slot}' in ${configPath}\n` +
        `  known callsigns: ${known || '(none)'}`,
    );
  }

  let newToken: string;
  try {
    newToken = server.rotateSlotToken(configPath, input.slot);
  } catch (err) {
    if (err instanceof server.SlotLoadError) {
      throw new UsageError(`rotate: ${err.message}`);
    }
    throw err;
  }

  // Explicit save-now framing. Matches the wizard's token-reveal
  // treatment without the ANSI scrollback-clearing trick — for a
  // one-off rotation the operator knows why they're seeing the
  // banner and doesn't need the wipe-after-confirm dance.
  stdout('');
  stdout(`✓ rotated bearer token for '${input.slot}'`);
  stdout(`  config: ${configPath}`);
  stdout('');
  stdout('  ┌─ NEW TOKEN — save this now; it is not persisted anywhere else ─┐');
  stdout(`  │ ${newToken}`);
  stdout('  └────────────────────────────────────────────────────────────────┘');
  stdout('');
  stdout('  The previous token for this slot is now invalid. Any process using');
  stdout('  it (runners, CI, scripts) will need the new value to re-authenticate.');
  stdout('');
}

async function loadServerModule(): Promise<typeof import('@control17/server')> {
  try {
    return await import('@control17/server');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
      throw new UsageError(
        'rotate: @control17/server is not installed.\n' +
          '  This command needs the broker package. Install it alongside the CLI:\n' +
          '    npm install -g @control17/server\n' +
          '  Or install the full ecosystem in one step:\n' +
          '    npm install -g @control17/c17',
      );
    }
    throw err;
  }
}
