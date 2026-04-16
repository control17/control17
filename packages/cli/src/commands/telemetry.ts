/**
 * `c17 telemetry` — opt-in, zero-PII, off-by-default install telemetry.
 *
 * This command is the operator-facing surface of the telemetry
 * mechanism. The mechanism itself is designed to be the most honest
 * possible telemetry: **silence by default; precise when enabled;
 * auditable at every step.**
 *
 * Design invariants (locked in with andrew on 2026-04-16; rationale
 * lives in `control17/platform:/crew/deliverables/2026-04-16-productive-pete-defaults-q3-q4.md`):
 *
 *   1. **Off by default.** Control17's brand promise is data-local.
 *      Telemetry must be opted into explicitly (`c17 telemetry enable`);
 *      no implicit activation from any other flow.
 *   2. **Zero PII.** Payload is a rotatable 128-bit random install-id
 *      plus coarse environment facts (Control17 version, OS, arch,
 *      Node version, broker deploy mode). No hostnames, no usernames,
 *      no IPs logged, no objective content, no trace content. Source
 *      IP is stripped at the edge.
 *   3. **Two events max per enable-session.** One on first `c17 serve`
 *      boot after enable; one on first successful objective completion
 *      after enable. No periodic beacon. No call-home-on-every-run.
 *   4. **Full transparency.** `c17 telemetry preview` prints the exact
 *      bytes that would be sent. No hidden fields. No encoded blob.
 *      The source is public (Apache-2.0) and the monthly aggregate
 *      rollup is published at `telemetry.control17.dev/rollup/`.
 *   5. **Rotatable.** `c17 telemetry rotate` mints a fresh install-id
 *      so the operator can reset correlation at any time without
 *      disabling.
 *
 * Subcommands:
 *   c17 telemetry enable   — opt in; mint install-id if missing
 *   c17 telemetry disable  — opt out; state file retained, no further sends
 *   c17 telemetry preview  — print the exact payload that would be sent
 *   c17 telemetry rotate   — mint a fresh install-id (breaks correlation)
 *   c17 telemetry status   — show enabled flag + install-id prefix (for debugging)
 *
 * The send path itself (`sendTelemetryEvent`) is exported but NOT wired
 * into `c17 serve` boot or objective-complete paths yet — that wiring
 * lands in a separate follow-up PR so this one stays purely additive
 * and reviewable on its own.
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { UsageError } from './errors.js';

export { UsageError };

/**
 * Wire-format version. Bump when the payload shape changes. Stays in
 * the payload so the receiver knows how to parse it.
 */
export const TELEMETRY_SCHEMA_VERSION = 1;

/**
 * Default endpoint. Overridable via `C17_TELEMETRY_ENDPOINT` — useful
 * for `c17 telemetry preview` in test environments and for future
 * self-host-your-own-aggregator scenarios.
 */
export const DEFAULT_TELEMETRY_ENDPOINT = 'https://telemetry.control17.dev/v1/install';

export type TelemetryEventKind = 'boot' | 'mission-complete';

export interface TelemetryState {
  enabled: boolean;
  /** Opaque 128-bit random, base64url-encoded (22 chars). Rotatable. */
  installId: string;
  /** Monotonically updated; used to inform `status` output. */
  enabledAt: string | null;
  /** Whether the one-shot `boot` event has been sent in this enable-session. */
  bootEventSent: boolean;
  /** Whether the one-shot `mission-complete` event has been sent. */
  missionEventSent: boolean;
}

export interface TelemetryPayload {
  schema: typeof TELEMETRY_SCHEMA_VERSION;
  event: TelemetryEventKind;
  installId: string;
  control17Version: string;
  nodeVersion: string;
  platform: NodeJS.Platform;
  arch: string;
  /** `localhost` / `lan` / `public` — coarse deploy mode, no hostnames. */
  deployMode: 'localhost' | 'lan' | 'public' | 'unknown';
}

/**
 * Resolve the telemetry state file path. XDG-style on Linux/BSD,
 * platform-appropriate fallbacks elsewhere. Operator can override
 * via `$C17_TELEMETRY_PATH` — useful for tests and air-gapped users
 * who never plan to enable this anyway but want predictable paths.
 */
export function telemetryStatePath(): string {
  const override = process.env.C17_TELEMETRY_PATH;
  if (override) return override;

  // XDG on Linux/BSD; %APPDATA% on Windows; ~/Library/Application Support on macOS.
  const home = homedir();
  if (process.platform === 'win32') {
    const appdata = process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
    return join(appdata, 'c17', 'telemetry.json');
  }
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'c17', 'telemetry.json');
  }
  const xdg = process.env.XDG_CONFIG_HOME ?? join(home, '.config');
  return join(xdg, 'c17', 'telemetry.json');
}

/**
 * Read the telemetry state. Returns a fresh disabled-default state
 * if the file doesn't exist. Never throws on ENOENT.
 */
export function loadTelemetryState(path: string = telemetryStatePath()): TelemetryState {
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as Partial<TelemetryState>;
    return {
      enabled: parsed.enabled === true,
      installId: typeof parsed.installId === 'string' ? parsed.installId : mintInstallId(),
      enabledAt: typeof parsed.enabledAt === 'string' ? parsed.enabledAt : null,
      bootEventSent: parsed.bootEventSent === true,
      missionEventSent: parsed.missionEventSent === true,
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return {
        enabled: false,
        installId: mintInstallId(),
        enabledAt: null,
        bootEventSent: false,
        missionEventSent: false,
      };
    }
    throw err;
  }
}

/**
 * Write the telemetry state at `0o600`. Creates the containing
 * directory if missing.
 */
export function saveTelemetryState(
  state: TelemetryState,
  path: string = telemetryStatePath(),
): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

function mintInstallId(): string {
  // 128 bits of randomness → 22 base64url characters (no padding).
  return randomBytes(16).toString('base64url');
}

/**
 * Build the exact payload that would be sent for a given event kind.
 * Used by both `preview` and the send path so the two can't drift.
 */
export function buildPayload(
  state: TelemetryState,
  event: TelemetryEventKind,
  control17Version: string,
  deployMode: TelemetryPayload['deployMode'] = 'unknown',
): TelemetryPayload {
  return {
    schema: TELEMETRY_SCHEMA_VERSION,
    event,
    installId: state.installId,
    control17Version,
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    deployMode,
  };
}

/**
 * Send a telemetry event. Noop when telemetry is disabled or the
 * event's one-shot flag is already set. Updates state and writes it
 * back to disk on a successful send. Silent on network failure —
 * telemetry must never block or error the operator's flow.
 *
 * Returns a status flag so callers can log what happened if they
 * care. Most callers won't.
 *
 * NOTE: not wired into `c17 serve` boot or objective-complete paths
 * yet. That wiring is a follow-up PR.
 */
export async function sendTelemetryEvent(
  event: TelemetryEventKind,
  control17Version: string,
  deployMode: TelemetryPayload['deployMode'] = 'unknown',
  options: { path?: string; endpoint?: string } = {},
): Promise<'sent' | 'disabled' | 'already-sent' | 'failed'> {
  const path = options.path ?? telemetryStatePath();
  const state = loadTelemetryState(path);
  if (!state.enabled) return 'disabled';
  if (event === 'boot' && state.bootEventSent) return 'already-sent';
  if (event === 'mission-complete' && state.missionEventSent) return 'already-sent';

  const endpoint =
    options.endpoint ?? process.env.C17_TELEMETRY_ENDPOINT ?? DEFAULT_TELEMETRY_ENDPOINT;
  const payload = buildPayload(state, event, control17Version, deployMode);

  try {
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      // Fail fast — we never want telemetry to extend the operator's
      // wall-clock path. 3 seconds is generous.
      signal: AbortSignal.timeout(3000),
    });
    if (!resp.ok) return 'failed';
  } catch {
    return 'failed';
  }

  if (event === 'boot') state.bootEventSent = true;
  if (event === 'mission-complete') state.missionEventSent = true;
  saveTelemetryState(state, path);
  return 'sent';
}

// ---------------------------------------------------------------------------
// CLI plumbing
// ---------------------------------------------------------------------------

export interface TelemetryCommandInput {
  /** Which subverb: enable / disable / preview / rotate / status. */
  action: string;
  /** Override the state-file path (tests, $C17_TELEMETRY_PATH mirror). */
  statePath?: string;
  /** For `preview`, which event kind to show. Defaults to 'boot'. */
  event?: TelemetryEventKind;
  /** The Control17 version string to bake into preview payloads. */
  control17Version: string;
}

export async function runTelemetryCommand(
  input: TelemetryCommandInput,
  log: (line: string) => void,
): Promise<void> {
  const path = input.statePath ?? telemetryStatePath();

  switch (input.action) {
    case 'enable': {
      const state = loadTelemetryState(path);
      if (state.enabled) {
        log(`c17 telemetry: already enabled (install-id ${shortId(state.installId)})`);
        return;
      }
      state.enabled = true;
      state.enabledAt = new Date().toISOString();
      // Reset one-shot flags so the boot + mission events can fire
      // once per enable-session.
      state.bootEventSent = false;
      state.missionEventSent = false;
      saveTelemetryState(state, path);
      log('c17 telemetry: enabled.');
      log(`  install-id: ${state.installId}`);
      log(`  state file: ${path}`);
      log('  will send at most 2 events per enable-session (first boot, first mission complete).');
      log('  `c17 telemetry preview` shows the exact bytes that would be sent.');
      log('  `c17 telemetry disable` stops sends; `c17 telemetry rotate` mints a fresh install-id.');
      return;
    }
    case 'disable': {
      const state = loadTelemetryState(path);
      if (!state.enabled) {
        log('c17 telemetry: already disabled.');
        return;
      }
      state.enabled = false;
      saveTelemetryState(state, path);
      log('c17 telemetry: disabled. No further events will be sent.');
      log('  (install-id retained on disk; `c17 telemetry rotate` mints a fresh one if you want to reset.)');
      return;
    }
    case 'rotate': {
      const state = loadTelemetryState(path);
      const old = state.installId;
      state.installId = mintInstallId();
      // Reset one-shot flags so the new id gets a full pair of events
      // if the operator re-enables or re-boots.
      state.bootEventSent = false;
      state.missionEventSent = false;
      saveTelemetryState(state, path);
      log('c17 telemetry: install-id rotated.');
      log(`  old: ${shortId(old)}...`);
      log(`  new: ${state.installId}`);
      log('  server cannot correlate past events to the new id.');
      return;
    }
    case 'preview': {
      const state = loadTelemetryState(path);
      const event: TelemetryEventKind = input.event ?? 'boot';
      const payload = buildPayload(state, event, input.control17Version);
      log('c17 telemetry: the exact bytes that would be sent for this event:');
      log('');
      log(`  POST ${process.env.C17_TELEMETRY_ENDPOINT ?? DEFAULT_TELEMETRY_ENDPOINT}`);
      log('  Content-Type: application/json');
      log('');
      const body = JSON.stringify(payload, null, 2);
      for (const line of body.split('\n')) log(`  ${line}`);
      log('');
      log(
        state.enabled
          ? `  (telemetry is currently ENABLED — the next ${event} event will actually send this.)`
          : '  (telemetry is currently DISABLED — this is what the payload would look like if you enable.)',
      );
      return;
    }
    case 'status': {
      const state = loadTelemetryState(path);
      log(`c17 telemetry: ${state.enabled ? 'ENABLED' : 'disabled'}`);
      log(`  install-id:       ${state.installId}`);
      log(`  enabled at:       ${state.enabledAt ?? '(never)'}`);
      log(`  boot event sent:  ${state.bootEventSent ? 'yes' : 'no'}`);
      log(`  mission event:    ${state.missionEventSent ? 'yes' : 'no'}`);
      log(`  state file:       ${path}`);
      return;
    }
    default:
      throw new UsageError(
        `unknown telemetry subcommand: ${input.action}\n` +
          '  valid subcommands: enable | disable | preview | rotate | status',
      );
  }
}

function shortId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}...` : id;
}
