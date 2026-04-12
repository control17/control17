/**
 * Principal loading and lookup for the control17 server.
 *
 * A principal is a named token holder — it has a name (stamped onto
 * every push as `from`), a cosmetic `kind` classification, and a
 * secret token that authenticates incoming requests. There is no
 * "unnamed" or "default" principal; every authenticated request maps
 * to exactly one named principal loaded from the config file.
 *
 * On disk the config stores SHA-256 hashes, not plaintext secrets.
 * Humans editing the file by hand can paste a plaintext `token`; the
 * server will hash it on next boot and rewrite the file. A broker
 * compromise via read-only disk access therefore leaks hashes, not
 * the original tokens.
 *
 * Config file format (JSON):
 *
 *   {
 *     "_comment": "...",
 *     "tokens": [
 *       { "name": "alice",     "kind": "human",   "tokenHash": "sha256:..." },
 *       { "name": "build-bot", "kind": "agent",   "tokenHash": "sha256:..." },
 *       { "name": "operator",  "kind": "human",   "token": "c17_plaintext_for_migration" }
 *     ]
 *   }
 *
 * The file path defaults to `./control17.json` (relative to the server's
 * working directory). An explicit `--config-path` flag or the
 * `C17_CONFIG_PATH` env var overrides it. On first run with no file,
 * the `c17-server` / `c17 serve` entry points drop into an interactive
 * wizard; see `wizard.ts`.
 */

import { createHash } from 'node:crypto';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PrincipalKind } from '@control17/sdk/types';
import { z } from 'zod';

export const TOKEN_HASH_PREFIX = 'sha256:';
const DEFAULT_CONFIG_FILENAME = 'control17.json';

/**
 * Hash a raw bearer token into the on-disk representation. The
 * server never persists plaintext and never logs the hash; it only
 * uses it as a map key for O(1) lookup on auth.
 */
export function hashToken(rawToken: string): string {
  return TOKEN_HASH_PREFIX + createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

/** A loaded principal, materialized in memory once hashes are known. */
export interface Principal {
  name: string;
  kind: PrincipalKind;
}

const NAME_REGEX = /^[a-zA-Z0-9._-]+$/;

/**
 * An entry in the `tokens` array on disk. Exactly one of `token`
 * (plaintext, will be migrated) or `tokenHash` (already hashed) must
 * be present. Anything else is a schema error.
 */
const TokenEntrySchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(128)
      .regex(NAME_REGEX, 'name must be alphanumeric with . _ - allowed'),
    kind: z.string().min(1).max(64),
    token: z.string().min(8, 'token must be at least 8 characters').optional(),
    tokenHash: z
      .string()
      .startsWith(TOKEN_HASH_PREFIX, `tokenHash must start with '${TOKEN_HASH_PREFIX}'`)
      .optional(),
  })
  .refine((e) => Boolean(e.token) !== Boolean(e.tokenHash), {
    message: 'exactly one of `token` or `tokenHash` is required',
  });

const ConfigSchema = z.object({
  _comment: z.unknown().optional(),
  tokens: z.array(TokenEntrySchema).min(1, 'tokens must contain at least one entry'),
});

/**
 * Thrown when a config file exists but cannot be loaded — invalid JSON,
 * schema violation, duplicate names, or IO error that isn't ENOENT.
 * These are unrecoverable without operator intervention.
 */
export class PrincipalLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrincipalLoadError';
  }
}

/**
 * Thrown when the config file simply does not exist at the expected
 * path. This is recoverable: the CLI entry points catch it and drop
 * into the first-run wizard (or, if stdin isn't a TTY, print a
 * friendly message with an example config).
 */
export class ConfigNotFoundError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`no config file at ${path}`);
    this.name = 'ConfigNotFoundError';
    this.path = path;
  }
}

export interface PrincipalStore {
  /** Look up the principal a raw bearer token maps to, or null if unknown. */
  resolve(rawToken: string): Principal | null;
  /** Number of loaded principals. */
  size(): number;
  /** List loaded principal names (for startup diagnostics, not UI). */
  names(): string[];
}

/**
 * Build a principal store programmatically from plaintext entries.
 * Used by tests and by alternate runtimes (e.g. the SaaS DO adapter)
 * that don't load from a file on disk. Tokens are hashed before
 * being put into the map — the store never retains plaintext.
 */
export function createPrincipalStore(
  entries: Array<{ name: string; kind: PrincipalKind; token: string }>,
): PrincipalStore {
  if (entries.length === 0) {
    throw new PrincipalLoadError('createPrincipalStore: at least one entry is required');
  }
  const store = new MapPrincipalStore();
  const seenNames = new Set<string>();
  for (const entry of entries) {
    if (seenNames.has(entry.name)) {
      throw new PrincipalLoadError(`duplicate principal name '${entry.name}'`);
    }
    seenNames.add(entry.name);
    store.addHashed(hashToken(entry.token), { name: entry.name, kind: entry.kind });
  }
  return store;
}

class MapPrincipalStore implements PrincipalStore {
  // Keyed on the token hash (not the raw token), so a memory dump of
  // the running server shows hashes only. `resolve()` hashes the
  // incoming bearer token before looking up, which is constant-time
  // relative to the size of the store.
  private readonly byHash = new Map<string, Principal>();

  addHashed(tokenHash: string, principal: Principal): void {
    if (this.byHash.has(tokenHash)) {
      throw new PrincipalLoadError(`duplicate token detected for principal '${principal.name}'`);
    }
    this.byHash.set(tokenHash, principal);
  }

  resolve(rawToken: string): Principal | null {
    return this.byHash.get(hashToken(rawToken)) ?? null;
  }

  size(): number {
    return this.byHash.size;
  }

  names(): string[] {
    return Array.from(this.byHash.values()).map((p) => p.name);
  }
}

/**
 * Resolve the path to the config file. Explicit env var wins;
 * otherwise fall back to `./control17.json` relative to the server's
 * working directory. The `--config-path` CLI flag is applied at the
 * caller level, not here, because we don't want this helper to know
 * about argv.
 */
export function defaultConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string {
  const explicit = env.C17_CONFIG_PATH;
  if (explicit && explicit.length > 0) return explicit;
  return join(cwd, DEFAULT_CONFIG_FILENAME);
}

/**
 * Result of a config load: the built store plus a count of how many
 * plaintext tokens were auto-migrated to hashes. Callers that want to
 * print a diagnostic ("hashed N plaintext token(s)") use the count.
 */
export interface LoadPrincipalsResult {
  store: PrincipalStore;
  migrated: number;
}

/**
 * Thin wrapper that discards the migration count — matches the
 * previous signature so callers that don't care can keep using it.
 */
export function loadPrincipalsFromFile(path: string): PrincipalStore {
  return loadPrincipalsFromFileVerbose(path).store;
}

/**
 * Read, validate, and optionally rewrite the config file at `path`.
 * Throws `ConfigNotFoundError` on ENOENT and `PrincipalLoadError`
 * on everything else. If any entry carried a plaintext `token`, the
 * file is rewritten with `tokenHash` and chmod 0o600 before returning.
 */
export function loadPrincipalsFromFileVerbose(path: string): LoadPrincipalsResult {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new ConfigNotFoundError(path);
    throw new PrincipalLoadError(
      `failed to read config file at ${path}: ${(err as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new PrincipalLoadError(
      `config file at ${path} is not valid JSON: ${(err as Error).message}`,
    );
  }

  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map(
        (issue: { path: PropertyKey[]; message: string }) =>
          `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`,
      )
      .join('\n');
    throw new PrincipalLoadError(`config file at ${path} is invalid:\n${issues}`);
  }

  const store = new MapPrincipalStore();
  const seenNames = new Set<string>();
  const onDisk: Array<{ name: string; kind: PrincipalKind; tokenHash: string }> = [];
  let migrated = 0;

  for (const entry of result.data.tokens) {
    if (seenNames.has(entry.name)) {
      throw new PrincipalLoadError(`duplicate principal name '${entry.name}' in ${path}`);
    }
    seenNames.add(entry.name);

    let tokenHash: string;
    if (entry.tokenHash) {
      tokenHash = entry.tokenHash;
    } else if (entry.token) {
      tokenHash = hashToken(entry.token);
      migrated++;
    } else {
      // Unreachable — the schema refine guarantees exactly one is set —
      // but TS doesn't know that.
      throw new PrincipalLoadError(
        `token entry '${entry.name}' in ${path} has neither token nor tokenHash`,
      );
    }

    store.addHashed(tokenHash, { name: entry.name, kind: entry.kind });
    onDisk.push({ name: entry.name, kind: entry.kind, tokenHash });
  }

  if (migrated > 0) {
    const topComment =
      typeof result.data._comment === 'string' ? result.data._comment : CONFIG_FILE_COMMENT;
    const rewritten = `${JSON.stringify({ _comment: topComment, tokens: onDisk }, null, 2)}\n`;
    writeFileSync(path, rewritten, { mode: 0o600 });
    try {
      chmodSync(path, 0o600);
    } catch {
      // best-effort — some filesystems (Windows, some FUSE mounts)
      // don't support POSIX modes and that's OK.
    }
  }

  return { store, migrated };
}

/**
 * Write a fresh config file containing the supplied entries with
 * their tokens already hashed. Mode is 0o600. Used by the first-run
 * wizard and available for programmatic callers that want the same
 * on-disk format the server expects.
 */
export function writeHashedConfig(
  path: string,
  entries: Array<{ name: string; kind: PrincipalKind; token: string }>,
): void {
  const onDisk = entries.map((e) => ({
    name: e.name,
    kind: e.kind,
    tokenHash: hashToken(e.token),
  }));
  const body = `${JSON.stringify({ _comment: CONFIG_FILE_COMMENT, tokens: onDisk }, null, 2)}\n`;
  writeFileSync(path, body, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // best-effort
  }
}

/**
 * The comment block embedded at the top of generated config files.
 * Kept here (not a separate doc) so it always stays in sync with the
 * schema and with what the wizard produces.
 */
export const CONFIG_FILE_COMMENT =
  'control17 server config. Each token entry has { name, kind, tokenHash }. ' +
  'To rotate or add a principal by hand, add { "name": "...", "kind": "<any label>", "token": "<plaintext>" } ' +
  'and the server will hash it on next boot and rewrite this file. ' +
  '`kind` is freeform (e.g. operator, agent, service) — labels the principal in logs but does not gate auth.';

/**
 * Example config, used in error messages and as a reference document.
 */
export function exampleConfig(): string {
  return `{
  "_comment": "${CONFIG_FILE_COMMENT}",
  "tokens": [
    { "name": "operator", "kind": "operator", "token": "c17_change_me_to_a_real_secret" }
  ]
}`;
}
