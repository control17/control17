/**
 * `c17 enroll` — rotate or add a TOTP secret for a slot.
 *
 * The wizard's first-run flow offers TOTP enrollment inline for
 * editor-role slots, but it's optional there. This command closes
 * the loop for two real cases:
 *
 *   1. User skipped enrollment during the wizard and now wants to
 *      use the web UI for that slot.
 *   2. User lost the device that had the authenticator app and
 *      needs to rotate the secret. The bearer token in config.json
 *      is the recovery capability for this path — whoever can read
 *      the config file can re-enroll, which is exactly the threat
 *      model we want (physical access to the server = trust).
 *
 * Flow (mirrors the wizard's prompt, but with rotation wording):
 *   1. Load the team config at the resolved path.
 *   2. Look up the slot by callsign; error clearly if missing.
 *   3. Warn if the slot already has a secret — re-enrollment will
 *      invalidate every authenticator currently bound to it.
 *   4. Generate a fresh secret + otpauth URI.
 *   5. Render a QR to the terminal and print the base32 fallback.
 *   6. Prompt for a live 6-digit confirmation code; retry on errors
 *      up to 3 times; empty input = abort with the config untouched.
 *   7. On success, call `enrollSlotTotp` to atomically rewrite the
 *      config with the new secret (and reset the replay counter).
 *
 * We duplicate the wizard's QR/verify loop here rather than
 * importing it. The two call sites have different framing (first
 * enrollment vs. rotation), different error messages, and a
 * different outer lifecycle (wizard writes the whole config from
 * scratch, enroll patches one slot in place). Sharing would force
 * the wizard's internal types through the CLI boundary for little
 * code savings.
 */

import { ENV } from '@control17/sdk/protocol';

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export interface EnrollCommandInput {
  /** Callsign of the slot to (re-)enroll. Required. */
  slot?: string;
  /** Override the config file location (defaults to $C17_CONFIG_PATH → ./control17.json). */
  configPath?: string;
}

const TOTP_ISSUER = 'control17';
const MAX_CONFIRM_ATTEMPTS = 3;

export async function runEnrollCommand(
  input: EnrollCommandInput,
  stdout: (line: string) => void,
): Promise<void> {
  if (!input.slot) {
    throw new UsageError('enroll: --slot <callsign> is required');
  }

  const server = await loadServerModule();
  const configPath = input.configPath ?? process.env[ENV.configPath] ?? server.defaultConfigPath();

  // Load the existing config. Any failure here (missing, invalid)
  // gets mapped to a user-facing UsageError so the raw SlotLoadError
  // stack doesn't surface.
  let config: Awaited<ReturnType<typeof server.loadTeamConfigFromFile>>;
  try {
    config = server.loadTeamConfigFromFile(configPath);
  } catch (err) {
    if (err instanceof server.ConfigNotFoundError) {
      throw new UsageError(
        `enroll: no config file at ${configPath}\n` +
          '  Run `pnpm wizard` (or `c17 setup`) first to create one.',
      );
    }
    if (err instanceof server.SlotLoadError) {
      throw new UsageError(`enroll: ${err.message}`);
    }
    throw err;
  }

  const targetSlot = config.store.resolveByCallsign(input.slot);
  if (!targetSlot) {
    const known = config.store.callsigns().join(', ');
    throw new UsageError(
      `enroll: no slot with callsign '${input.slot}' in ${configPath}\n` +
        `  known callsigns: ${known || '(none)'}`,
    );
  }

  const alreadyEnrolled = Boolean(targetSlot.totpSecret);
  if (alreadyEnrolled) {
    stdout('');
    stdout(`⚠  '${input.slot}' is already enrolled for web UI login.`);
    stdout('   Re-enrolling rotates the secret and invalidates any authenticator');
    stdout('   currently bound to this slot. If you proceed, the old device will');
    stdout('   stop working for sign-in on the next restart.');
    stdout('');
  }

  // The wizard IO abstraction is what gives us interactive prompts,
  // redactable scrollback, and the same TTY guard every CLI path uses.
  const { io, close } = server.createTtyWizardIO();
  if (!io.isInteractive) {
    close();
    throw new UsageError(
      'enroll: stdin is not a TTY — this command needs interactive input.\n' +
        '  Run it in a real terminal (not piped / under turbo).',
    );
  }

  try {
    const secret = server.generateTotpSecret();
    const uri = server.otpauthUri({
      secret,
      issuer: TOTP_ISSUER,
      label: `${TOTP_ISSUER}:${input.slot}`,
    });

    stdout('');
    stdout(`-- web UI login for ${input.slot} --`);
    stdout(
      alreadyEnrolled
        ? 'Rotating the TOTP secret. Scan this with your authenticator app:'
        : 'This role can sign into the browser UI with a 6-digit authenticator code.',
    );
    if (!alreadyEnrolled) {
      stdout('Scan this with your authenticator app:');
    }
    stdout('');

    const qr = renderQr(uri);
    for (const line of qr.split('\n')) stdout(line);
    stdout('');
    stdout('or paste this secret manually:');
    stdout(`  ${secret}`);
    stdout('');

    // Prompt loop — mirrors the wizard's retry policy exactly.
    let confirmed = false;
    let lastCounter = 0;
    for (let attempt = 0; attempt < MAX_CONFIRM_ATTEMPTS; attempt++) {
      const raw = (await io.prompt('enter the 6-digit code to confirm: ')).trim();
      if (raw.length === 0) {
        stdout('  aborted — config not changed.');
        return;
      }
      const result = server.verifyTotpCode(secret, raw, lastCounter, Date.now());
      if (result.ok) {
        lastCounter = result.counter;
        confirmed = true;
        break;
      }
      stdout(`  ${describeVerifyError(result.reason)} — try again`);
    }

    if (!confirmed) {
      throw new UsageError('enroll: too many bad attempts — no changes written to the config.');
    }

    // Persist the new secret. enrollSlotTotp reloads the config file
    // defensively, patches the target slot, and rewrites atomically
    // at 0o600, so a concurrent edit elsewhere in the file doesn't
    // get trampled.
    server.enrollSlotTotp(configPath, input.slot, secret);

    stdout('');
    stdout(`✓ ${alreadyEnrolled ? 're-enrolled' : 'enrolled'} '${input.slot}' for web UI login`);
    stdout(`  config: ${configPath}`);
    stdout('');
    if (alreadyEnrolled) {
      stdout('  The old authenticator is now invalid. Use the new one on your next sign-in.');
    }
    stdout('');
  } finally {
    close();
  }
}

/**
 * Render an `otpauth://` URI as a terminal QR code using
 * `qrcode-terminal`'s small (half-block) mode.
 *
 * `qrcode-terminal` is a transitive dep of `@control17/server`, not a
 * direct CLI dep — we resolve it lazily via `createRequire` scoped at
 * the server module's location. This keeps the CLI's dep tree lean
 * (users who never run `c17 enroll` never load it) and avoids
 * duplicating the package between CLI and server node_modules.
 *
 * `qrcode-terminal` is CJS with a lazily-initialized internal error
 * level — calling `setErrorLevel('L')` up front is required to
 * avoid "bad rs block @ errorCorrectLevel: undefined" on the first
 * generate() call. The wizard has the same guard for the same reason.
 */
function renderQr(uri: string): string {
  const req = nodeRequire('qrcode-terminal');
  const qrcode = req as {
    generate: (text: string, opts: { small: boolean }, cb: (out: string) => void) => void;
    setErrorLevel: (level: 'L' | 'M' | 'Q' | 'H') => void;
  };
  qrcode.setErrorLevel('L');
  let out = '';
  qrcode.generate(uri, { small: true }, (q) => {
    out = q;
  });
  return out;
}

/**
 * Build a `require` scoped to the resolved `@control17/server`
 * package, so we can pull in `qrcode-terminal` from the server's
 * node_modules without declaring it as a direct CLI dep.
 */
function nodeRequire(moduleId: string): unknown {
  // Lazy `require('node:module')` inside an ESM file — the CJS
  // interop keeps `node:module` out of the CLI's startup graph for
  // users who never invoke `c17 enroll`.
  const { createRequire } = require('node:module') as typeof import('node:module');
  // import.meta.resolve isn't available in all Node versions we support;
  // resolve through a stable anchor (this file) instead.
  const base = createRequire(import.meta.url);
  const serverPkgPath = base.resolve('@control17/server/package.json');
  const fromServer = createRequire(serverPkgPath);
  return fromServer(moduleId);
}

function describeVerifyError(reason: 'malformed' | 'invalid' | 'replay'): string {
  switch (reason) {
    case 'malformed':
      return 'that code is not 6 digits';
    case 'invalid':
      return 'that code is incorrect';
    case 'replay':
      return 'that code is expired (enter the next one your app shows)';
  }
}

async function loadServerModule(): Promise<typeof import('@control17/server')> {
  try {
    return await import('@control17/server');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
      throw new UsageError(
        'enroll: @control17/server is not installed.\n' +
          '  This command needs the broker package. Install it alongside the CLI:\n' +
          '    npm install -g @control17/server\n' +
          '  Or install the full ecosystem in one step:\n' +
          '    npm install -g @control17/c17',
      );
    }
    throw err;
  }
}
