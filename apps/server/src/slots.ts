/**
 * Squadron config loading for the control17 server.
 *
 * A squadron config defines the mission, the roles, and the slots that
 * make up the squadron. A slot is a reserved position — callsign + role +
 * authority tier + secret token that authenticates incoming requests.
 * The server is always one squadron (multi-squadron coordination lives
 * at the SaaS layer).
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
 *     "squadron": {
 *       "name": "alpha-squadron",
 *       "mission": "Ship the payment service.",
 *       "brief": "We own the full lifecycle..."
 *     },
 *     "roles": {
 *       "operator":    { "description": "...", "instructions": "..." },
 *       "implementer": { "description": "...", "instructions": "..." }
 *     },
 *     "slots": [
 *       { "callsign": "ACTUAL",  "role": "operator",    "authority": "commander",  "tokenHash": "sha256:..." },
 *       { "callsign": "LT-ONE",  "role": "operator",    "authority": "lieutenant", "tokenHash": "sha256:..." },
 *       { "callsign": "ALPHA-1", "role": "implementer",                             "token":     "c17_plaintext_for_migration" }
 *     ]
 *   }
 *
 * Missing `authority` defaults to `operator`. The file path defaults
 * to `./control17.json` (relative to the server's working directory);
 * an explicit `--config-path` flag or `C17_CONFIG_PATH` env var overrides.
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants as FS,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { Authority, Role, Slot, Squadron, Teammate } from '@control17/sdk/types';
import { z } from 'zod';

export const TOKEN_HASH_PREFIX = 'sha256:';
const DEFAULT_CONFIG_FILENAME = 'control17.json';

/**
 * Hash a raw bearer token into the on-disk representation.
 */
export function hashToken(rawToken: string): string {
  return TOKEN_HASH_PREFIX + createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

/**
 * A slot materialized in memory once hashes are known. Extends the
 * wire `Slot` with server-only fields — TOTP enrollment and replay
 * guard state. These never cross the network.
 */
export interface LoadedSlot extends Slot {
  totpSecret?: string | null;
  totpLastCounter?: number;
}

const CALLSIGN_REGEX = /^[a-zA-Z0-9._-]+$/;
const ROLE_KEY_REGEX = /^[a-zA-Z0-9._-]+$/;

const SquadronSchema = z.object({
  name: z.string().min(1).max(128),
  mission: z.string().min(1).max(512),
  brief: z.string().max(4096).default(''),
});

const RoleSchema = z.object({
  description: z.string().max(512).default(''),
  instructions: z.string().max(8192).default(''),
});

const AuthoritySchema = z.enum(['commander', 'lieutenant', 'operator']);

// Base32 alphabet (RFC 4648) — TOTP secrets from `otpauth` use this.
const TOTP_SECRET_REGEX = /^[A-Z2-7]+=*$/;

const SlotEntrySchema = z
  .object({
    callsign: z
      .string()
      .min(1)
      .max(128)
      .regex(CALLSIGN_REGEX, 'callsign must be alphanumeric with . _ - allowed'),
    role: z
      .string()
      .min(1)
      .max(64)
      .regex(ROLE_KEY_REGEX, 'role must be alphanumeric with . _ - allowed'),
    authority: AuthoritySchema.default('operator'),
    token: z.string().min(8, 'token must be at least 8 characters').optional(),
    tokenHash: z
      .string()
      .startsWith(TOKEN_HASH_PREFIX, `tokenHash must start with '${TOKEN_HASH_PREFIX}'`)
      .optional(),
    totpSecret: z
      .string()
      .min(16, 'totpSecret must be at least 16 base32 characters')
      .max(128)
      .regex(TOTP_SECRET_REGEX, 'totpSecret must be a base32-encoded string')
      .nullable()
      .optional(),
    totpLastCounter: z.number().int().nonnegative().optional(),
  })
  .refine((e) => Boolean(e.token) !== Boolean(e.tokenHash), {
    message: 'exactly one of `token` or `tokenHash` is required',
  });

const SelfSignedConfigSchema = z.object({
  lanIp: z.string().nullable().default(null),
  validityDays: z.number().int().positive().max(3650).default(365),
  regenerateIfExpiringWithin: z.number().int().nonnegative().max(365).default(30),
});

const CustomHttpsConfigSchema = z.object({
  certPath: z.string().nullable().default(null),
  keyPath: z.string().nullable().default(null),
});

const WebPushConfigSchema = z.object({
  vapidPublicKey: z.string().min(1),
  vapidPrivateKey: z.string().min(1),
  vapidSubject: z.string().min(1).default('mailto:admin@control17.local'),
});

const HttpsConfigSchema = z.object({
  mode: z.enum(['off', 'self-signed', 'custom']).default('off'),
  bindHttp: z.number().int().min(1).max(65535).default(8717),
  bindHttps: z.number().int().min(1).max(65535).default(7443),
  redirectHttpToHttps: z.boolean().default(true),
  hsts: z.enum(['auto', 'on', 'off']).default('auto'),
  selfSigned: SelfSignedConfigSchema.default({
    lanIp: null,
    validityDays: 365,
    regenerateIfExpiringWithin: 30,
  }),
  custom: CustomHttpsConfigSchema.default({ certPath: null, keyPath: null }),
});

const SquadronConfigSchema = z.object({
  _comment: z.unknown().optional(),
  squadron: SquadronSchema,
  roles: z.record(z.string().min(1).max(64), RoleSchema),
  slots: z.array(SlotEntrySchema).min(1, 'slots must contain at least one entry'),
  https: HttpsConfigSchema.optional(),
  webPush: WebPushConfigSchema.optional(),
});

export type HttpsConfig = z.infer<typeof HttpsConfigSchema>;
export type WebPushConfig = z.infer<typeof WebPushConfigSchema>;

export class SlotLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SlotLoadError';
  }
}

export class ConfigNotFoundError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`no config file at ${path}`);
    this.name = 'ConfigNotFoundError';
    this.path = path;
  }
}

export interface SlotStore {
  resolve(rawToken: string): LoadedSlot | null;
  resolveByCallsign(callsign: string): LoadedSlot | null;
  recordTotpAccept(callsign: string, counter: number): LoadedSlot | null;
  size(): number;
  slots(): LoadedSlot[];
  callsigns(): string[];
}

class MapSlotStore implements SlotStore {
  private readonly byHash = new Map<string, LoadedSlot>();
  private readonly byCallsign = new Map<string, LoadedSlot>();
  private readonly order: LoadedSlot[] = [];

  addHashed(tokenHash: string, slot: LoadedSlot): void {
    if (this.byHash.has(tokenHash)) {
      throw new SlotLoadError(`duplicate token detected for slot '${slot.callsign}'`);
    }
    if (this.byCallsign.has(slot.callsign)) {
      throw new SlotLoadError(`duplicate callsign '${slot.callsign}'`);
    }
    this.byHash.set(tokenHash, slot);
    this.byCallsign.set(slot.callsign, slot);
    this.order.push(slot);
  }

  resolve(rawToken: string): LoadedSlot | null {
    return this.byHash.get(hashToken(rawToken)) ?? null;
  }

  resolveByCallsign(callsign: string): LoadedSlot | null {
    return this.byCallsign.get(callsign) ?? null;
  }

  recordTotpAccept(callsign: string, counter: number): LoadedSlot | null {
    const slot = this.byCallsign.get(callsign);
    if (!slot) return null;
    slot.totpLastCounter = counter;
    return slot;
  }

  size(): number {
    return this.byHash.size;
  }

  slots(): LoadedSlot[] {
    return [...this.order];
  }

  callsigns(): string[] {
    return this.order.map((s) => s.callsign);
  }
}

/**
 * Build a slot store programmatically from plaintext entries. Used by
 * tests and by alternate runtimes. Tokens are hashed before storage.
 */
export function createSlotStore(
  entries: Array<{
    callsign: string;
    role: string;
    authority?: Authority;
    token: string;
    totpSecret?: string | null;
    totpLastCounter?: number;
  }>,
): SlotStore {
  if (entries.length === 0) {
    throw new SlotLoadError('createSlotStore: at least one entry is required');
  }
  const store = new MapSlotStore();
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.callsign)) {
      throw new SlotLoadError(`duplicate callsign '${entry.callsign}'`);
    }
    seen.add(entry.callsign);
    store.addHashed(hashToken(entry.token), {
      callsign: entry.callsign,
      role: entry.role,
      authority: entry.authority ?? 'operator',
      totpSecret: entry.totpSecret ?? null,
      totpLastCounter: entry.totpLastCounter ?? 0,
    });
  }
  return store;
}

export function defaultConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string {
  const explicit = env.C17_CONFIG_PATH;
  if (explicit && explicit.length > 0) return explicit;
  return join(cwd, DEFAULT_CONFIG_FILENAME);
}

/** Full squadron config materialized from disk. */
export interface SquadronConfig {
  squadron: Squadron;
  roles: Record<string, Role>;
  store: SlotStore;
  https: HttpsConfig;
  webPush: WebPushConfig | null;
  migrated: number;
}

export function defaultHttpsConfig(): HttpsConfig {
  return {
    mode: 'off',
    bindHttp: 8717,
    bindHttps: 7443,
    redirectHttpToHttps: true,
    hsts: 'auto',
    selfSigned: {
      lanIp: null,
      validityDays: 365,
      regenerateIfExpiringWithin: 30,
    },
    custom: {
      certPath: null,
      keyPath: null,
    },
  };
}

/**
 * Read, validate, and optionally rewrite the config file at `path`.
 * Throws `ConfigNotFoundError` on ENOENT and `SlotLoadError` on
 * everything else. If any slot carried a plaintext `token`, the file
 * is rewritten with `tokenHash` and chmod 0o600 before returning.
 */
export function loadSquadronConfigFromFile(path: string): SquadronConfig {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new ConfigNotFoundError(path);
    throw new SlotLoadError(`failed to read config file at ${path}: ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new SlotLoadError(`config file at ${path} is not valid JSON: ${(err as Error).message}`);
  }

  // Legacy schema detection — clean-break error pointing at the new format.
  if (parsed && typeof parsed === 'object' && 'team' in parsed && !('squadron' in parsed)) {
    throw new SlotLoadError(
      `config file at ${path} uses the legacy \`team\` schema.\n` +
        `control17 now uses a squadron/roles/slots schema with an authority tier on each slot.\n` +
        `See apps/server/config.example.json for the new format, or delete this file and\n` +
        `re-run to launch the setup wizard.`,
    );
  }
  // Also catch the even-older `tokens` top-level array.
  if (
    parsed &&
    typeof parsed === 'object' &&
    'tokens' in parsed &&
    !('squadron' in parsed) &&
    !('slots' in parsed)
  ) {
    throw new SlotLoadError(
      `config file at ${path} uses the legacy \`tokens\` schema.\n` +
        `control17 now uses a squadron/roles/slots schema. See apps/server/config.example.json\n` +
        `for the new format, or delete this file and re-run to launch the setup wizard.`,
    );
  }

  const result = SquadronConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map(
        (issue: { path: PropertyKey[]; message: string }) =>
          `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`,
      )
      .join('\n');
    throw new SlotLoadError(`config file at ${path} is invalid:\n${issues}`);
  }

  const squadron: Squadron = result.data.squadron;
  const roles: Record<string, Role> = result.data.roles;

  // Every slot's role must reference a known role key.
  for (const slot of result.data.slots) {
    if (!Object.hasOwn(roles, slot.role)) {
      throw new SlotLoadError(
        `slot '${slot.callsign}' references unknown role '${slot.role}' in ${path}. ` +
          `Known roles: ${Object.keys(roles).join(', ') || '(none)'}`,
      );
    }
  }

  // At least one slot must hold commander authority so there's always
  // someone who can edit the squadron config.
  const hasCommander = result.data.slots.some((s) => s.authority === 'commander');
  if (!hasCommander) {
    throw new SlotLoadError(
      `squadron config at ${path} has no slot with authority='commander'. ` +
        `At least one commander is required to administer the squadron.`,
    );
  }

  const store = new MapSlotStore();
  const seen = new Set<string>();
  const onDisk: SlotOnDisk[] = [];
  let migrated = 0;

  for (const entry of result.data.slots) {
    if (seen.has(entry.callsign)) {
      throw new SlotLoadError(`duplicate callsign '${entry.callsign}' in ${path}`);
    }
    seen.add(entry.callsign);

    let tokenHash: string;
    if (entry.tokenHash) {
      tokenHash = entry.tokenHash;
    } else if (entry.token) {
      tokenHash = hashToken(entry.token);
      migrated++;
    } else {
      throw new SlotLoadError(
        `slot entry '${entry.callsign}' in ${path} has neither token nor tokenHash`,
      );
    }

    const totpSecret = entry.totpSecret ?? null;
    const totpLastCounter = entry.totpLastCounter ?? 0;

    store.addHashed(tokenHash, {
      callsign: entry.callsign,
      role: entry.role,
      authority: entry.authority,
      totpSecret,
      totpLastCounter,
    });
    onDisk.push({
      callsign: entry.callsign,
      role: entry.role,
      authority: entry.authority,
      tokenHash,
      totpSecret,
      totpLastCounter,
    });
  }

  const https: HttpsConfig = result.data.https ?? defaultHttpsConfig();
  const webPush: WebPushConfig | null = result.data.webPush ?? null;

  if (migrated > 0) {
    const topComment =
      typeof result.data._comment === 'string' ? result.data._comment : CONFIG_FILE_COMMENT;
    writeSquadronConfigFile(path, topComment, squadron, roles, onDisk, https, webPush);
  }

  return { squadron, roles, store, https, webPush, migrated };
}

/** Shape persisted to disk for a single slot entry. */
interface SlotOnDisk {
  callsign: string;
  role: string;
  authority: Authority;
  tokenHash: string;
  totpSecret?: string | null;
  totpLastCounter?: number;
}

/**
 * Write a fresh config file containing the supplied squadron, roles,
 * and slots with their tokens hashed. Mode is 0o600.
 */
export function writeSquadronConfig(
  path: string,
  squadron: Squadron,
  roles: Record<string, Role>,
  slotsWithTokens: Array<{
    callsign: string;
    role: string;
    authority?: Authority;
    token: string;
    totpSecret?: string | null;
    totpLastCounter?: number;
  }>,
  https?: HttpsConfig,
  webPush?: WebPushConfig | null,
): void {
  const onDisk: SlotOnDisk[] = slotsWithTokens.map((s) => ({
    callsign: s.callsign,
    role: s.role,
    authority: s.authority ?? 'operator',
    tokenHash: hashToken(s.token),
    totpSecret: s.totpSecret ?? null,
    totpLastCounter: s.totpLastCounter ?? 0,
  }));
  writeSquadronConfigFile(path, CONFIG_FILE_COMMENT, squadron, roles, onDisk, https, webPush);
}

/**
 * Rewrite the config file with a fresh `webPush` block. Called by
 * `runServer` after auto-generating VAPID keys on first boot.
 */
export function writeWebPushConfig(path: string, webPush: WebPushConfig): void {
  const raw = readFileSync(path, 'utf8');
  const parsed = SquadronConfigSchema.parse(JSON.parse(raw));
  const topComment = typeof parsed._comment === 'string' ? parsed._comment : CONFIG_FILE_COMMENT;
  const onDisk: SlotOnDisk[] = parsed.slots.map((s) => ({
    callsign: s.callsign,
    role: s.role,
    authority: s.authority,
    tokenHash: s.tokenHash ?? hashToken(s.token as string),
    totpSecret: s.totpSecret ?? null,
    totpLastCounter: s.totpLastCounter ?? 0,
  }));
  writeSquadronConfigFile(
    path,
    topComment,
    parsed.squadron,
    parsed.roles,
    onDisk,
    parsed.https,
    webPush,
  );
}

/**
 * Rewrite the config file at `path` with a new TOTP secret for
 * `callsign`. Used by the CLI `c17 enroll` command and by the wizard.
 */
export function enrollSlotTotp(path: string, callsign: string, totpSecret: string | null): void {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new ConfigNotFoundError(path);
    throw new SlotLoadError(`failed to read config file at ${path}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new SlotLoadError(`config file at ${path} is not valid JSON: ${(err as Error).message}`);
  }
  const result = SquadronConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new SlotLoadError(`config file at ${path} is invalid — cannot enroll`);
  }
  const target = result.data.slots.find((s) => s.callsign === callsign);
  if (!target) {
    throw new SlotLoadError(`no slot with callsign '${callsign}' in ${path}`);
  }

  const onDisk: SlotOnDisk[] = result.data.slots.map((s) => {
    const tokenHash = s.tokenHash ?? hashToken(s.token as string);
    if (s.callsign === callsign) {
      return {
        callsign: s.callsign,
        role: s.role,
        authority: s.authority,
        tokenHash,
        totpSecret,
        totpLastCounter: 0,
      };
    }
    return {
      callsign: s.callsign,
      role: s.role,
      authority: s.authority,
      tokenHash,
      totpSecret: s.totpSecret ?? null,
      totpLastCounter: s.totpLastCounter ?? 0,
    };
  });

  const topComment =
    typeof result.data._comment === 'string' ? result.data._comment : CONFIG_FILE_COMMENT;
  writeSquadronConfigFile(
    path,
    topComment,
    result.data.squadron,
    result.data.roles,
    onDisk,
    result.data.https,
    result.data.webPush,
  );
}

function writeSquadronConfigFile(
  path: string,
  comment: string,
  squadron: Squadron,
  roles: Record<string, Role>,
  slots: SlotOnDisk[],
  https?: HttpsConfig,
  webPush?: WebPushConfig | null,
): void {
  const slotsForDisk = slots.map((s) => {
    const out: Record<string, unknown> = {
      callsign: s.callsign,
      role: s.role,
    };
    // Only emit `authority` when it differs from the default, to keep
    // freshly-written configs tidy for plain-operator-only squadrons.
    if (s.authority !== 'operator') {
      out.authority = s.authority;
    }
    out.tokenHash = s.tokenHash;
    if (s.totpSecret !== undefined && s.totpSecret !== null) {
      out.totpSecret = s.totpSecret;
    }
    if (s.totpLastCounter !== undefined && s.totpLastCounter > 0) {
      out.totpLastCounter = s.totpLastCounter;
    }
    return out;
  });
  const payload: Record<string, unknown> = {
    _comment: comment,
    squadron,
    roles,
    slots: slotsForDisk,
  };
  if (https && !httpsConfigEqualsDefault(https)) {
    payload.https = https;
  }
  if (webPush) {
    payload.webPush = webPush;
  }
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  atomicWriteRestricted(path, body);
}

function httpsConfigEqualsDefault(https: HttpsConfig): boolean {
  const def = defaultHttpsConfig();
  return JSON.stringify(https) === JSON.stringify(def);
}

function atomicWriteRestricted(path: string, body: string): void {
  const dir = dirname(path);
  const nonce = randomBytes(6).toString('hex');
  const tmp = join(dir, `.control17.${nonce}.tmp`);
  let fd: number | null = null;
  try {
    fd = openSync(tmp, FS.O_CREAT | FS.O_WRONLY | FS.O_EXCL, 0o600);
    writeSync(fd, body);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmp, path);
    try {
      chmodSync(path, 0o600);
    } catch {
      // best-effort only
    }
  } catch (err) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    try {
      unlinkSync(tmp);
    } catch {
      // tmp might not exist, or already renamed — either way, ignore
    }
    throw err;
  }
}

/**
 * Project the loaded slots into a teammate list suitable for the
 * briefing response. Preserves config ordering. Cached by store
 * identity since slots are immutable after boot.
 */
const teammateCache = new WeakMap<SlotStore, Teammate[]>();
export function teammatesFromStore(store: SlotStore): Teammate[] {
  const cached = teammateCache.get(store);
  if (cached) return cached;
  const teammates = store.slots().map((s) => ({
    callsign: s.callsign,
    role: s.role,
    authority: s.authority,
  }));
  teammateCache.set(store, teammates);
  return teammates;
}

export const CONFIG_FILE_COMMENT =
  'control17 squadron config. Defines one squadron with a mission, roles, and slots. ' +
  'Each slot has { callsign, role, authority, tokenHash }. `authority` is one of ' +
  '`commander | lieutenant | operator`, defaulting to `operator` when omitted. ' +
  'At least one commander is required. To rotate or add a slot by hand, add ' +
  '{ "callsign": "...", "role": "...", "authority": "...", "token": "<plaintext>" } ' +
  'and the server will hash the token on next boot and rewrite this file.';

export function exampleConfig(): string {
  return `{
  "_comment": "${CONFIG_FILE_COMMENT}",
  "squadron": {
    "name": "alpha-squadron",
    "mission": "Describe what the squadron is working toward.",
    "brief": "Longer narrative about scope, constraints, operating window."
  },
  "roles": {
    "operator": {
      "description": "Human directs the squadron, makes go/no-go calls, handles escalations.",
      "instructions": "The operator role directs activity in the squadron channel and handles escalations."
    },
    "implementer": {
      "description": "Writes and ships code changes.",
      "instructions": "The implementer role writes and ships code, takes direction from the commander, and reports progress."
    },
    "reviewer": {
      "description": "Reviews implementer work before it ships.",
      "instructions": "The reviewer role checks diffs and signs off on changes."
    },
    "watcher": {
      "description": "Passively monitors squadron activity and flags anomalies.",
      "instructions": "The watcher role observes squadron activity and surfaces issues."
    }
  },
  "slots": [
    { "callsign": "ACTUAL",  "role": "operator",    "authority": "commander",  "token": "c17_change_me_to_a_real_secret" },
    { "callsign": "LT-ONE",  "role": "operator",    "authority": "lieutenant", "token": "c17_change_me_to_another_real_secret" },
    { "callsign": "ALPHA-1", "role": "implementer",                             "token": "c17_change_me_to_another_real_secret" }
  ]
}`;
}
