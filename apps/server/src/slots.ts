/**
 * Team config loading for the control17 server.
 *
 * A team config defines the mission, the roles, and the slots that
 * make up the team. A slot is a reserved position — callsign + role +
 * secret token that authenticates incoming requests. The server is
 * always one team (multi-team coordination lives at the SaaS layer).
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
 *     "team": {
 *       "name": "alpha-squadron",
 *       "mission": "Ship the payment service.",
 *       "brief": "We own the full lifecycle..."
 *     },
 *     "roles": {
 *       "operator":    { "description": "...", "instructions": "...", "editor": true },
 *       "implementer": { "description": "...", "instructions": "..." }
 *     },
 *     "slots": [
 *       { "callsign": "ACTUAL",  "role": "operator",    "tokenHash": "sha256:..." },
 *       { "callsign": "ALPHA-1", "role": "implementer", "token":     "c17_plaintext_for_migration" }
 *     ]
 *   }
 *
 * The file path defaults to `./control17.json` (relative to the server's
 * working directory). An explicit `--config-path` flag or the
 * `C17_CONFIG_PATH` env var overrides it. On first run with no file,
 * the entry points drop into the team-setup wizard; see `wizard.ts`.
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
import type { Role, Slot, Team, Teammate } from '@control17/sdk/types';
import { z } from 'zod';

export const TOKEN_HASH_PREFIX = 'sha256:';
const DEFAULT_CONFIG_FILENAME = 'control17.json';

/**
 * Hash a raw bearer token into the on-disk representation. The server
 * never persists plaintext and never logs the hash; it only uses it
 * as a map key for O(1) lookup on auth.
 */
export function hashToken(rawToken: string): string {
  return TOKEN_HASH_PREFIX + createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

/**
 * A slot materialized in memory once hashes are known. Extends the
 * wire `Slot` with server-only fields — TOTP enrollment and replay
 * guard state. These never cross the network; they live in the store
 * to gate human web-UI logins.
 */
export interface LoadedSlot extends Slot {
  /**
   * Base32 TOTP secret, if this slot has been enrolled for web-UI
   * login. null/undefined means machine-only — bearer token is the
   * only way in. Enrollment is done by the wizard or by `c17 enroll`.
   */
  totpSecret?: string | null;
  /**
   * Counter of the last accepted TOTP code. `verifyCode` rejects any
   * code whose counter is ≤ this, which prevents replay inside the
   * same period and prevents accepting a "stale" code from a past
   * period that's still within the ±1 tolerance window.
   */
  totpLastCounter?: number;
}

const CALLSIGN_REGEX = /^[a-zA-Z0-9._-]+$/;
const ROLE_KEY_REGEX = /^[a-zA-Z0-9._-]+$/;

const TeamSchema = z.object({
  name: z.string().min(1).max(128),
  mission: z.string().min(1).max(512),
  brief: z.string().max(4096).default(''),
});

const RoleSchema = z.object({
  description: z.string().max(512).default(''),
  instructions: z.string().max(8192).default(''),
  editor: z.boolean().optional(),
});

// Base32 alphabet (RFC 4648) — TOTP secrets from `otpauth` use this.
// Accept any length ≥ 16 chars (80-bit minimum) for flexibility, even
// though control17's generator always produces 32-char (160-bit) secrets.
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

/**
 * HTTPS configuration embedded in the team config file. Kept here
 * rather than a separate file so there's exactly one thing the user
 * edits to configure the server. All fields are optional with sensible
 * defaults — an absent `https` block means "HTTP only, localhost".
 *
 *   mode: 'off'         — plain HTTP on bindHttp (localhost dev)
 *   mode: 'self-signed' — auto-gen a cert stored next to the config
 *   mode: 'custom'      — load cert/key from user-supplied paths
 *
 * Future: 'acme' for Let's Encrypt. Not in v1.
 */
const SelfSignedConfigSchema = z.object({
  /** IPv4 to add as a SAN. Null = auto-detect when bound non-loopback. */
  lanIp: z.string().nullable().default(null),
  validityDays: z.number().int().positive().max(3650).default(365),
  regenerateIfExpiringWithin: z.number().int().nonnegative().max(365).default(30),
});

const CustomHttpsConfigSchema = z.object({
  certPath: z.string().nullable().default(null),
  keyPath: z.string().nullable().default(null),
});

/**
 * Web Push (VAPID) config. Generated on first boot and persisted to
 * the team config file — rotating these keys invalidates every
 * existing push subscription, so they're treated as long-lived state.
 */
const WebPushConfigSchema = z.object({
  vapidPublicKey: z.string().min(1),
  vapidPrivateKey: z.string().min(1),
  vapidSubject: z.string().min(1).default('mailto:admin@control17.local'),
});

const HttpsConfigSchema = z.object({
  mode: z.enum(['off', 'self-signed', 'custom']).default('off'),
  bindHttp: z.number().int().min(1).max(65535).default(8717),
  bindHttps: z.number().int().min(1).max(65535).default(7443),
  /**
   * When HTTPS is active, run a parallel HTTP listener on `bindHttp`
   * that 308-redirects every request to HTTPS. Off disables the
   * redirect listener entirely.
   */
  redirectHttpToHttps: z.boolean().default(true),
  /**
   * HSTS header policy. `auto` = on only when we're using a real
   * (non-self-signed) cert, which for v1 never — stays off until
   * ACME lands. Explicit `true`/`false` overrides for power users.
   */
  hsts: z.enum(['auto', 'on', 'off']).default('auto'),
  selfSigned: SelfSignedConfigSchema.default({
    lanIp: null,
    validityDays: 365,
    regenerateIfExpiringWithin: 30,
  }),
  custom: CustomHttpsConfigSchema.default({ certPath: null, keyPath: null }),
});

const TeamConfigSchema = z.object({
  _comment: z.unknown().optional(),
  team: TeamSchema,
  roles: z.record(z.string().min(1).max(64), RoleSchema),
  slots: z.array(SlotEntrySchema).min(1, 'slots must contain at least one entry'),
  https: HttpsConfigSchema.optional(),
  webPush: WebPushConfigSchema.optional(),
});

/**
 * Fully-resolved HTTPS config — every field non-optional, defaults
 * applied. This is what runServer and the https/* modules consume.
 */
export type HttpsConfig = z.infer<typeof HttpsConfigSchema>;

/** VAPID credentials for browser Web Push. Persistent per deployment. */
export type WebPushConfig = z.infer<typeof WebPushConfigSchema>;

/**
 * Thrown when a config file exists but cannot be loaded — invalid
 * JSON, schema violation, duplicate callsigns, or IO error that isn't
 * ENOENT. These are unrecoverable without operator intervention.
 */
export class SlotLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SlotLoadError';
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

export interface SlotStore {
  /** Look up the slot a raw bearer token maps to, or null if unknown. */
  resolve(rawToken: string): LoadedSlot | null;
  /**
   * Look up a slot by its callsign. Used by the TOTP login path (we
   * have the callsign from the form body, not a token) and by the
   * session resolver (cookie → stored slot callsign → LoadedSlot).
   */
  resolveByCallsign(callsign: string): LoadedSlot | null;
  /**
   * Record a successful TOTP acceptance for a slot, persisting the new
   * replay counter so subsequent logins reject any code with counter
   * ≤ `counter`. Mutates the in-memory LoadedSlot and returns it.
   */
  recordTotpAccept(callsign: string, counter: number): LoadedSlot | null;
  /** Number of loaded slots. */
  size(): number;
  /** All loaded slots (order matches the config file). */
  slots(): LoadedSlot[];
  /** All callsigns (for startup diagnostics). */
  callsigns(): string[];
}

class MapSlotStore implements SlotStore {
  // Keyed on the token hash (not the raw token), so a memory dump of
  // the running server shows hashes only. `resolve()` hashes the
  // incoming bearer token before looking up; the lookup itself is
  // O(1) regardless of the store size (Map). Note: "O(1)" is not
  // "constant-time" in the security sense — this is not a
  // side-channel-resistant comparison, and isn't meant to be, since
  // the attacker would need to pre-hash their guess and brute-force
  // SHA-256 to exploit any timing difference.
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
    // Mutate in place so every holder of the LoadedSlot reference sees
    // the new counter. MapSlotStore is authoritative for runtime state.
    // The on-disk counter isn't kept in sync on every login — we'd pay
    // a file rewrite per request. On restart we reload counters from
    // disk, meaning a process crash could theoretically let one stale
    // code be replayed after restart; acceptable given the 30s window.
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
 * tests and by alternate runtimes (e.g. the SaaS DO adapter) that
 * don't load from a file on disk. Tokens are hashed before being put
 * into the map — the store never retains plaintext.
 */
export function createSlotStore(
  entries: Array<{
    callsign: string;
    role: string;
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
      totpSecret: entry.totpSecret ?? null,
      totpLastCounter: entry.totpLastCounter ?? 0,
    });
  }
  return store;
}

/**
 * Resolve the path to the config file. Explicit env var wins;
 * otherwise fall back to `./control17.json` relative to the server's
 * working directory.
 */
export function defaultConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string {
  const explicit = env.C17_CONFIG_PATH;
  if (explicit && explicit.length > 0) return explicit;
  return join(cwd, DEFAULT_CONFIG_FILENAME);
}

/** Full team config materialized from disk. */
export interface TeamConfig {
  team: Team;
  roles: Record<string, Role>;
  store: SlotStore;
  /**
   * HTTPS settings parsed from the config file's `https` block with
   * all defaults applied. When the user omits the block entirely this
   * is still present, populated with off-mode defaults (plain HTTP on
   * 8717, no cert, localhost).
   */
  https: HttpsConfig;
  /**
   * VAPID credentials from the config file's `webPush` block. Null
   * means "never generated" — runServer() will create a fresh pair
   * on first boot and persist them back via `writeWebPushConfig`.
   */
  webPush: WebPushConfig | null;
  migrated: number;
}

/**
 * Default HTTPS config applied when the user omits the `https` block
 * entirely. Explicitly constructed rather than `schema.parse({})` so
 * downstream code sees a plain object with no zod branding.
 */
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
export function loadTeamConfigFromFile(path: string): TeamConfig {
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
  if (
    parsed &&
    typeof parsed === 'object' &&
    'tokens' in parsed &&
    !('team' in parsed) &&
    !('slots' in parsed)
  ) {
    throw new SlotLoadError(
      `config file at ${path} uses the legacy \`tokens\` schema.\n` +
        `control17 now uses a team/roles/slots schema. See apps/server/config.example.json\n` +
        `for the new format, or delete this file and re-run to launch the setup wizard.`,
    );
  }

  const result = TeamConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map(
        (issue: { path: PropertyKey[]; message: string }) =>
          `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`,
      )
      .join('\n');
    throw new SlotLoadError(`config file at ${path} is invalid:\n${issues}`);
  }

  const team: Team = result.data.team;
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
      totpSecret,
      totpLastCounter,
    });
    onDisk.push({
      callsign: entry.callsign,
      role: entry.role,
      tokenHash,
      totpSecret,
      totpLastCounter,
    });
  }

  // HTTPS config: `result.data.https` has defaults applied when the
  // block is present but partial, and is undefined when the block is
  // entirely absent. Fall back to the all-defaults config in that case.
  const https: HttpsConfig = result.data.https ?? defaultHttpsConfig();
  const webPush: WebPushConfig | null = result.data.webPush ?? null;

  if (migrated > 0) {
    const topComment =
      typeof result.data._comment === 'string' ? result.data._comment : CONFIG_FILE_COMMENT;
    writeTeamConfigFile(path, topComment, team, roles, onDisk, https, webPush);
  }

  return { team, roles, store, https, webPush, migrated };
}

/** Shape persisted to disk for a single slot entry. */
interface SlotOnDisk {
  callsign: string;
  role: string;
  tokenHash: string;
  totpSecret?: string | null;
  totpLastCounter?: number;
}

/**
 * Write a fresh config file containing the supplied team, roles, and
 * slots with their tokens hashed. Mode is 0o600. Used by the first-run
 * wizard and available for programmatic callers that want the same
 * on-disk format the server expects.
 */
export function writeTeamConfig(
  path: string,
  team: Team,
  roles: Record<string, Role>,
  slotsWithTokens: Array<{
    callsign: string;
    role: string;
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
    tokenHash: hashToken(s.token),
    totpSecret: s.totpSecret ?? null,
    totpLastCounter: s.totpLastCounter ?? 0,
  }));
  writeTeamConfigFile(path, CONFIG_FILE_COMMENT, team, roles, onDisk, https, webPush);
}

/**
 * Rewrite the config file with a fresh `webPush` block. Called by
 * `runServer` after auto-generating VAPID keys on first boot so the
 * new key material persists for subsequent restarts. Reloads the file
 * first so we don't trample concurrent edits to other blocks.
 */
export function writeWebPushConfig(path: string, webPush: WebPushConfig): void {
  const raw = readFileSync(path, 'utf8');
  const parsed = TeamConfigSchema.parse(JSON.parse(raw));
  const topComment = typeof parsed._comment === 'string' ? parsed._comment : CONFIG_FILE_COMMENT;
  // Reconstruct the on-disk slot entries from the already-validated
  // file contents — we only want to change the webPush block.
  const onDisk: SlotOnDisk[] = parsed.slots.map((s) => ({
    callsign: s.callsign,
    role: s.role,
    tokenHash: s.tokenHash ?? hashToken(s.token as string),
    totpSecret: s.totpSecret ?? null,
    totpLastCounter: s.totpLastCounter ?? 0,
  }));
  writeTeamConfigFile(path, topComment, parsed.team, parsed.roles, onDisk, parsed.https, webPush);
}

/**
 * Rewrite the config file at `path` with a new TOTP secret for
 * `callsign`. Used by the CLI `c17 enroll` command and by the wizard's
 * post-slot enrollment prompt. Pass `null` to drop an enrollment.
 * `totpLastCounter` is reset to 0 whenever the secret changes so a
 * freshly-enrolled device can accept the first code immediately.
 *
 * Atomic and mode-0600 via the same helper the main writer uses.
 * Throws `SlotLoadError` if the file is missing, corrupt, or doesn't
 * contain a slot with that callsign.
 */
export function enrollSlotTotp(path: string, callsign: string, totpSecret: string | null): void {
  // Reload from disk so we never trample concurrent edits. The config
  // file is small, this is cheap.
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
  const result = TeamConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new SlotLoadError(`config file at ${path} is invalid — cannot enroll`);
  }
  const target = result.data.slots.find((s) => s.callsign === callsign);
  if (!target) {
    throw new SlotLoadError(`no slot with callsign '${callsign}' in ${path}`);
  }

  const onDisk: SlotOnDisk[] = result.data.slots.map((s) => {
    // Every entry needs a tokenHash on disk. If a slot still has a
    // plaintext token at this point, hash it now — same migration
    // behavior as loadTeamConfigFromFile. Schema guarantees exactly
    // one of the two is present.
    const tokenHash = s.tokenHash ?? hashToken(s.token as string);
    if (s.callsign === callsign) {
      return {
        callsign: s.callsign,
        role: s.role,
        tokenHash,
        totpSecret,
        // Reset counter on re-enrollment so a freshly-scanned device
        // can verify its first code without fighting a stale counter.
        totpLastCounter: 0,
      };
    }
    return {
      callsign: s.callsign,
      role: s.role,
      tokenHash,
      totpSecret: s.totpSecret ?? null,
      totpLastCounter: s.totpLastCounter ?? 0,
    };
  });

  const topComment =
    typeof result.data._comment === 'string' ? result.data._comment : CONFIG_FILE_COMMENT;
  writeTeamConfigFile(
    path,
    topComment,
    result.data.team,
    result.data.roles,
    onDisk,
    result.data.https,
    result.data.webPush,
  );
}

function writeTeamConfigFile(
  path: string,
  comment: string,
  team: Team,
  roles: Record<string, Role>,
  slots: SlotOnDisk[],
  https?: HttpsConfig,
  webPush?: WebPushConfig | null,
): void {
  // Emit null totpSecret as `null` only when the slot was previously
  // enrolled and is being cleared; otherwise omit the field entirely
  // so new config files stay tidy. `totpLastCounter` is omitted when
  // zero for the same reason.
  const slotsForDisk = slots.map((s) => {
    const out: Record<string, unknown> = {
      callsign: s.callsign,
      role: s.role,
      tokenHash: s.tokenHash,
    };
    if (s.totpSecret !== undefined && s.totpSecret !== null) {
      out.totpSecret = s.totpSecret;
    }
    if (s.totpLastCounter !== undefined && s.totpLastCounter > 0) {
      out.totpLastCounter = s.totpLastCounter;
    }
    return out;
  });
  // Only persist the `https` block if the caller passed one AND it
  // differs from the all-defaults config. Keeps freshly-wizard-written
  // files clean for users who don't care about HTTPS until later.
  const payload: Record<string, unknown> = {
    _comment: comment,
    team,
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

/**
 * Write `body` to `path` atomically and with a restrictive mode set
 * before any bytes are written. Uses an exclusive temp file in the
 * same directory (so the rename is atomic on POSIX) and fsyncs before
 * the rename to survive a crash. No TOCTOU window: the temp is
 * created with `O_CREAT|O_WRONLY|O_EXCL` and mode `0o600`, so the
 * permission is set at creation time and the rename atomically swaps
 * it into place.
 */
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
    // Best-effort re-chmod in case the destination already existed with
    // a looser mode (rename preserves the source mode, but some FUSE
    // filesystems and Windows emulation layers ignore the create-mode
    // hint — this catches them).
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
 * identity — slots are immutable after boot, so the projection can
 * be built once per store and reused on every /briefing and /roster
 * request. The WeakMap lets the cache entry get collected when the
 * store is replaced (future config reload) without us managing
 * invalidation by hand.
 */
const teammateCache = new WeakMap<SlotStore, Teammate[]>();
export function teammatesFromStore(store: SlotStore): Teammate[] {
  const cached = teammateCache.get(store);
  if (cached) return cached;
  const teammates = store.slots().map((s) => ({ callsign: s.callsign, role: s.role }));
  teammateCache.set(store, teammates);
  return teammates;
}

/**
 * The comment block embedded at the top of generated config files.
 * Kept here (not a separate doc) so it always stays in sync with the
 * schema and with what the wizard produces.
 */
export const CONFIG_FILE_COMMENT =
  'control17 team config. Defines one team with a mission, roles, and slots. ' +
  'Each slot has { callsign, role, tokenHash }. To rotate or add a slot by hand, ' +
  'add { "callsign": "...", "role": "...", "token": "<plaintext>" } and the server ' +
  'will hash it on next boot and rewrite this file. Roles are freeform and defined ' +
  'in the top-level `roles` map. A role with `editor: true` grants its slots future ' +
  'permission to edit the team/mission/roles at runtime.';

/**
 * Example config, used in error messages and as a reference document.
 */
export function exampleConfig(): string {
  return `{
  "_comment": "${CONFIG_FILE_COMMENT}",
  "team": {
    "name": "squadron",
    "mission": "Describe what the team is working toward.",
    "brief": "Longer narrative about scope, constraints, operating window."
  },
  "roles": {
    "operator": {
      "description": "Directs the team, makes go/no-go calls, handles escalations.",
      "instructions": "The operator role on this team directs activity in the team channel and handles escalations.",
      "editor": true
    },
    "implementer": {
      "description": "Writes and ships code changes.",
      "instructions": "The implementer role on this team writes and ships code, takes direction from the operator, and reports progress in the team channel."
    }
  },
  "slots": [
    { "callsign": "ACTUAL",  "role": "operator",    "token": "c17_change_me_to_a_real_secret" },
    { "callsign": "ALPHA-1", "role": "implementer", "token": "c17_change_me_to_another_real_secret" }
  ]
}`;
}
