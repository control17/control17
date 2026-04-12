/**
 * First-run interactive wizard for the control17 broker.
 *
 * Triggered when the server boots without a config file at the expected
 * path AND stdin is a TTY. Walks the operator through creating one or
 * more principals, generates fresh random tokens, writes a hashed
 * config to disk (0o600), and returns a populated `PrincipalStore`.
 *
 * The wizard is pure IO-over-callbacks so it can be unit-tested without
 * a real terminal. `runFirstRunWizard` takes a `WizardIO` and never
 * touches `process.stdin`/`process.stdout` itself; the CLI entry points
 * build a default TTY-backed `WizardIO` via `createTtyWizardIO`.
 *
 * The same module is exported from `@control17/server` so both
 * `c17-server` and `c17 serve` can call it.
 */

import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import type { PrincipalKind } from '@control17/sdk/types';
import {
  createPrincipalStore,
  PrincipalLoadError,
  type PrincipalStore,
  writeHashedConfig,
} from './principals.js';

const NAME_REGEX = /^[a-zA-Z0-9._-]+$/;
const TOKEN_BYTES = 32;
const TOKEN_PREFIX = 'c17_';

export interface WizardEntry {
  name: string;
  kind: PrincipalKind;
  token: string;
}

/**
 * The wizard's view of its terminal. Inject your own for tests.
 *
 * `prompt` returns a single line of input (no trailing newline).
 * `println` writes a line to the "terminal" (newline appended for you).
 * `redactLines` is an optional best-effort erase of the last N lines
 * of output so a printed token doesn't linger in scrollback; real
 * TTYs use ANSI escapes, tests no-op it. `isInteractive` gates whether
 * the caller should run the wizard at all.
 */
export interface WizardIO {
  prompt(question: string): Promise<string>;
  println(line: string): void;
  redactLines?(count: number): void;
  isInteractive: boolean;
}

export interface RunWizardOptions {
  configPath: string;
  io: WizardIO;
  /** Override token generation for tests. Defaults to random 32 bytes. */
  tokenFactory?: () => string;
}

/**
 * Drive the wizard to completion, write the config file, and return
 * a populated store. Throws `PrincipalLoadError` if the IO is not
 * interactive — the CLI catches that and prints a friendly
 * non-interactive hint instead.
 */
export async function runFirstRunWizard(options: RunWizardOptions): Promise<PrincipalStore> {
  const { io, configPath } = options;
  const mintToken = options.tokenFactory ?? defaultTokenFactory;

  if (!io.isInteractive) {
    throw new PrincipalLoadError(
      `no config file at ${configPath} and stdin is not a TTY. ` +
        'Create the file manually, pass --config-path, or re-run interactively.',
    );
  }

  io.println('');
  io.println(`control17: no config file found at`);
  io.println(`  ${configPath}`);
  io.println('');
  io.println(`Let's create one. You'll need to copy each generated token`);
  io.println('somewhere the caller (Claude Code, a CI job, you) will read it.');
  io.println('');

  const entries: WizardEntry[] = [];
  const usedNames = new Set<string>();

  while (true) {
    const entry = await collectEntry(io, usedNames, entries.length === 0, mintToken);
    entries.push(entry);
    usedNames.add(entry.name);

    printTokenBanner(io, entry);
    await io.prompt('press enter once you have saved the token above ');
    io.redactLines?.(9);

    const more = (await io.prompt('add another identity? [y/N] ')).trim().toLowerCase();
    if (more !== 'y' && more !== 'yes') break;
  }

  writeHashedConfig(configPath, entries);

  io.println('');
  io.println(`wrote ${entries.length} principal(s) to`);
  io.println(`  ${configPath}`);
  io.println('file is chmod 600; tokens are stored as SHA-256 hashes only.');
  io.println('');

  return createPrincipalStore(entries);
}

async function collectEntry(
  io: WizardIO,
  usedNames: Set<string>,
  first: boolean,
  mintToken: () => string,
): Promise<WizardEntry> {
  io.println(first ? '-- first identity --' : '-- next identity --');

  const name = await promptName(io, usedNames, first);
  const kind = await promptKind(io);
  return { name, kind, token: mintToken() };
}

async function promptName(io: WizardIO, usedNames: Set<string>, first: boolean): Promise<string> {
  const suggested = first ? 'operator' : '';
  const prompt = suggested ? `name [${suggested}]: ` : 'name: ';
  while (true) {
    const raw = (await io.prompt(prompt)).trim();
    const candidate = raw.length === 0 ? suggested : raw;
    if (!candidate) {
      io.println('  name cannot be empty');
      continue;
    }
    if (candidate.length > 128) {
      io.println('  name must be 128 characters or fewer');
      continue;
    }
    if (!NAME_REGEX.test(candidate)) {
      io.println('  name must be alphanumeric with . _ - allowed');
      continue;
    }
    if (usedNames.has(candidate)) {
      io.println(`  '${candidate}' already added in this session`);
      continue;
    }
    return candidate;
  }
}

async function promptKind(io: WizardIO): Promise<PrincipalKind> {
  while (true) {
    const raw = (await io.prompt('kind (e.g. operator, agent, service): ')).trim().toLowerCase();
    if (raw.length === 0) return 'operator';
    if (raw.length > 64) {
      io.println('  kind must be 64 characters or fewer');
      continue;
    }
    return raw;
  }
}

function printTokenBanner(io: WizardIO, entry: WizardEntry): void {
  const bar = '='.repeat(68);
  io.println('');
  io.println(bar);
  io.println(`  ${entry.name} (${entry.kind})`);
  io.println('');
  io.println(`  ${entry.token}`);
  io.println(bar);
  io.println('save this token NOW — it will be hashed and removed from scrollback.');
}

function defaultTokenFactory(): string {
  return `${TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString('base64url')}`;
}

/**
 * Build a TTY-backed `WizardIO` that reads from stdin, writes to
 * stdout, and uses ANSI escapes to wipe the token banner from visible
 * scrollback after the user confirms they've saved it. Returns both
 * the `io` and a `close` function that releases the underlying
 * readline interface — callers should always invoke `close` in a
 * `finally`.
 *
 * Scrollback redaction is best-effort. A terminal recorder, a tmux
 * buffer, a long-lived SSH session, or the OS clipboard will still
 * see the token if the operator copied it. This is a usability
 * nicety, not a security boundary.
 */
export function createTtyWizardIO(
  stdin: NodeJS.ReadStream = process.stdin,
  stdout: NodeJS.WriteStream = process.stdout,
): { io: WizardIO; close: () => void } {
  const rl = createInterface({ input: stdin, output: stdout });
  const isInteractive = Boolean(stdin.isTTY && stdout.isTTY);
  const io: WizardIO = {
    prompt: (question) => rl.question(question),
    println: (line) => {
      stdout.write(`${line}\n`);
    },
    redactLines: (count) => {
      if (!stdout.isTTY) return;
      try {
        stdout.moveCursor?.(0, -count);
        stdout.clearScreenDown?.();
      } catch {
        // best-effort — some non-TTY wrappers that set isTTY=true
        // still lack moveCursor.
      }
    },
    isInteractive,
  };
  return { io, close: () => rl.close() };
}
