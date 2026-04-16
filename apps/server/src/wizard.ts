/**
 * First-run interactive wizard for the control17 broker.
 *
 * Triggered when the server boots without a config file at the expected
 * path AND stdin is a TTY. Walks the operator through creating a
 * squadron (name, mission, brief) and its initial slots, generates
 * fresh random tokens per slot, optionally enrolls human-operator
 * slots in TOTP for web-UI login, writes a hashed config to disk
 * (0o600), and returns the loaded `SquadronConfig`.
 *
 * Authority model: the first slot is always a commander (at least one
 * commander is required). Subsequent slots prompt for their authority
 * tier (commander / lieutenant / operator) defaulting to operator.
 *
 * Default role bundle: the wizard always ships 4 starter role
 * definitions (operator, implementer, reviewer, watcher) in the
 * generated config. Users can edit, remove, or add roles in the config
 * file after the wizard runs.
 */

import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import type { Authority, Role, Squadron } from '@control17/sdk/types';
// qrcode-terminal is CJS; default-import the namespace and destructure.
import qrcodeTerminal from 'qrcode-terminal';
import {
  createSlotStore,
  defaultHttpsConfig,
  SlotLoadError,
  type SquadronConfig,
  writeSquadronConfig,
} from './slots.js';
import { generateSecret, otpauthUri, verifyCode } from './totp.js';

const { generate: generateQrCode, setErrorLevel } = qrcodeTerminal;

// `qrcode-terminal` lazily initializes its internal error-correction
// level, and some code paths read the unset value before the first
// `setErrorLevel` call, throwing "bad rs block @ … errorCorrectLevel:
// undefined". Set it explicitly at module load so every subsequent
// generate() sees a valid state. 'L' is the smallest (~7% recovery)
// which keeps the QR compact enough to fit in a terminal.
setErrorLevel('L');

const CALLSIGN_REGEX = /^[a-zA-Z0-9._-]+$/;
const ROLE_KEY_REGEX = /^[a-zA-Z0-9._-]+$/;
const TOKEN_BYTES = 32;
const TOKEN_PREFIX = 'c17_';
const TOTP_ISSUER = 'control17';
const TOTP_MAX_CONFIRM_ATTEMPTS = 3;

interface WizardSlot {
  callsign: string;
  role: string;
  authority: Authority;
  token: string;
  /** Set when the user enrolls this slot in TOTP during the wizard. */
  totpSecret?: string | null;
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
  /** Override TOTP secret generation for tests. Defaults to 160-bit random. */
  totpSecretFactory?: () => string;
  /**
   * Clock injection for TOTP code verification during enrollment.
   * Tests use this to produce a predictable code for a fixed secret;
   * production uses `Date.now`.
   */
  now?: () => number;
  /**
   * Override the in-terminal QR renderer. Tests pass a no-op or
   * capture what would have been drawn. Production defaults to
   * `qrcode-terminal`'s `small: true` mode.
   */
  qrRenderer?: (uri: string) => string;
}

/** Starter role definitions shipped with every new squadron config. */
export const DEFAULT_ROLES: Record<string, Role> = {
  operator: {
    description: 'Directs the squadron, makes go/no-go calls, handles escalations.',
    instructions:
      'The operator role in this squadron directs activity in the squadron channel, ' +
      'assigns objectives to teammates, and handles escalations. Issue clear ' +
      'directives and keep the squadron aligned on the mission.',
  },
  implementer: {
    description: 'Writes and ships work — code, configuration, content.',
    instructions:
      'The implementer role in this squadron does the hands-on work. Take direction ' +
      'from command, report progress in the squadron channel, and use DMs for ' +
      'clarifications. When you finish an objective, mark it complete with a clear result.',
  },
  reviewer: {
    description: 'Checks implementer work before it ships.',
    instructions:
      'The reviewer role in this squadron verifies work before it ships. Read updates ' +
      'posted in the squadron channel, check for quality and correctness, and post ' +
      'approve or request-changes decisions with clear rationale.',
  },
  watcher: {
    description: 'Passively monitors squadron activity and flags anomalies.',
    instructions:
      'The watcher role in this squadron observes activity without initiating ' +
      'work. Surface unusual signals, blockers, or quiet stretches to command ' +
      'via DM. Stay out of the way unless you see something worth raising.',
  },
};

/**
 * Drive the wizard to completion, write the config file, and return
 * the loaded squadron config. Throws `SlotLoadError` if the IO is not
 * interactive — the CLI catches that and prints a friendly
 * non-interactive hint instead.
 */
export async function runFirstRunWizard(options: RunWizardOptions): Promise<SquadronConfig> {
  const { io, configPath } = options;
  const mintToken = options.tokenFactory ?? defaultTokenFactory;
  const mintTotpSecret = options.totpSecretFactory ?? generateSecret;
  const nowFn = options.now ?? Date.now;
  const renderQr = options.qrRenderer ?? defaultQrRenderer;

  if (!io.isInteractive) {
    throw new SlotLoadError(
      `no config file at ${configPath} and stdin is not a TTY. ` +
        'Create the file manually, pass --config-path, or re-run interactively.',
    );
  }

  io.println('');
  io.println(`control17: no config file found at`);
  io.println(`  ${configPath}`);
  io.println('');
  io.println(`Let's set up a squadron. We'll ask for a name, mission, brief, and slots,`);
  io.println(`then generate tokens. Copy each token somewhere safe as it appears —`);
  io.println(`they're hashed on disk and can't be recovered afterward.`);
  io.println('');

  // ── Squadron ────────────────────────────────────────────────────
  io.println('-- squadron --');
  const squadron = await promptSquadron(io);

  io.println('');
  io.println('-- slots --');
  io.println(`(built-in roles: ${Object.keys(DEFAULT_ROLES).join(', ')}; custom roles OK)`);
  io.println(`(the first slot is the commander — required for every squadron)`);

  const slots: WizardSlot[] = [];
  const usedCallsigns = new Set<string>();

  while (true) {
    const slot = await collectSlot(io, usedCallsigns, slots.length === 0, mintToken);
    slots.push(slot);
    usedCallsigns.add(slot.callsign);

    const bannerLines = printTokenBanner(io, slot);
    await io.prompt('press enter once you have saved the token above ');
    io.redactLines?.(bannerLines + 1);

    // Offer TOTP enrollment for slots with elevated authority
    // (commander + lieutenant). Plain operators can still enroll later
    // via `c17 enroll` — the wizard just defaults to "machine-plane
    // only" for the common case of AI-agent operator slots.
    if (slot.authority !== 'operator') {
      const totpSecret = await promptTotpEnrollment(io, slot, squadron, {
        mintTotpSecret,
        now: nowFn,
        renderQr,
      });
      if (totpSecret) {
        slot.totpSecret = totpSecret;
      }
    }

    const more = (await io.prompt('add another slot? [y/N] ')).trim().toLowerCase();
    if (more !== 'y' && more !== 'yes') break;
  }

  // Validate: at least one commander. Since the first slot is always
  // prompted with commander as the default this is normally satisfied,
  // but a paranoid user could type `operator` — catch that here rather
  // than letting the loader reject the write.
  const hasCommander = slots.some((s) => s.authority === 'commander');
  if (!hasCommander) {
    throw new SlotLoadError(
      'at least one slot must have authority=commander. Re-run the wizard to set one.',
    );
  }

  // Start from the 4 default roles, then auto-add a placeholder for
  // any custom role a slot referenced.
  const roles: Record<string, Role> = { ...DEFAULT_ROLES };
  for (const slot of slots) {
    if (!Object.hasOwn(roles, slot.role)) {
      roles[slot.role] = {
        description: `(custom role defined by the wizard for ${slot.callsign}; edit me)`,
        instructions:
          `Custom role '${slot.role}' — replace this text with your own role notes. ` +
          'This is what the agent will see as its role-specific briefing.',
      };
    }
  }
  writeSquadronConfig(configPath, squadron, roles, slots);

  io.println('');
  io.println(`wrote squadron '${squadron.name}' with ${slots.length} slot(s) to`);
  io.println(`  ${configPath}`);
  io.println('file is chmod 600; tokens are stored as SHA-256 hashes only.');
  const enrolled = slots.filter((s) => s.totpSecret);
  if (enrolled.length > 0) {
    io.println(`web UI login enabled for: ${enrolled.map((s) => s.callsign).join(', ')}`);
  }
  io.println('');

  const store = createSlotStore(slots);
  return {
    squadron,
    roles,
    store,
    https: defaultHttpsConfig(),
    webPush: null,
    migrated: 0,
  };
}

async function promptSquadron(io: WizardIO): Promise<Squadron> {
  const name = await promptRequired(io, 'squadron name [my-team]: ', 'my-team', (v) =>
    v.length > 0 && v.length <= 128 ? null : 'must be 1-128 characters',
  );
  const mission = await promptRequired(
    io,
    'mission (short, e.g. "Ship the payment service"): ',
    '',
    (v) => (v.length > 0 && v.length <= 512 ? null : 'mission is required, max 512 chars'),
  );
  const brief = (await io.prompt('brief (longer context, press enter to skip): ')).trim();
  return { name, mission, brief };
}

async function promptRequired(
  io: WizardIO,
  prompt: string,
  defaultValue: string,
  validate: (v: string) => string | null,
): Promise<string> {
  while (true) {
    const raw = (await io.prompt(prompt)).trim();
    const candidate = raw.length === 0 ? defaultValue : raw;
    const err = validate(candidate);
    if (err !== null) {
      io.println(`  ${err}`);
      continue;
    }
    return candidate;
  }
}

async function collectSlot(
  io: WizardIO,
  usedCallsigns: Set<string>,
  first: boolean,
  mintToken: () => string,
): Promise<WizardSlot> {
  io.println(first ? '' : '');
  const callsign = await promptCallsign(io, usedCallsigns, first);
  const role = await promptRole(io, first);
  const authority = await promptAuthority(io, first);
  return { callsign, role, authority, token: mintToken() };
}

async function promptAuthority(io: WizardIO, first: boolean): Promise<Authority> {
  // First slot defaults to commander since every squadron must have
  // at least one. Subsequent slots default to operator — the common
  // case is AI-agent operators under a single human commander.
  const suggested: Authority = first ? 'commander' : 'operator';
  while (true) {
    const raw = (await io.prompt(`authority [commander | lieutenant | operator] [${suggested}]: `))
      .trim()
      .toLowerCase();
    const candidate = raw.length === 0 ? suggested : raw;
    if (candidate === 'commander' || candidate === 'lieutenant' || candidate === 'operator') {
      return candidate;
    }
    io.println('  authority must be one of: commander, lieutenant, operator');
  }
}

async function promptCallsign(
  io: WizardIO,
  usedCallsigns: Set<string>,
  first: boolean,
): Promise<string> {
  const suggested = first ? 'operator-1' : '';
  const prompt = suggested ? `callsign [${suggested}]: ` : 'callsign: ';
  while (true) {
    const raw = (await io.prompt(prompt)).trim();
    const candidate = raw.length === 0 ? suggested : raw;
    if (!candidate) {
      io.println('  callsign cannot be empty');
      continue;
    }
    if (candidate.length > 128) {
      io.println('  callsign must be 128 characters or fewer');
      continue;
    }
    if (!CALLSIGN_REGEX.test(candidate)) {
      io.println('  callsign must be alphanumeric with . _ - allowed');
      continue;
    }
    if (usedCallsigns.has(candidate)) {
      io.println(`  '${candidate}' already added in this session`);
      continue;
    }
    return candidate;
  }
}

async function promptRole(io: WizardIO, first: boolean): Promise<string> {
  const suggested = first ? 'operator' : 'implementer';
  const defaultNames = Object.keys(DEFAULT_ROLES).join(', ');
  while (true) {
    const raw = (await io.prompt(`role [${suggested}]: `)).trim().toLowerCase();
    const candidate = raw.length === 0 ? suggested : raw;
    if (candidate.length === 0 || candidate.length > 64) {
      io.println('  role must be 1-64 characters');
      continue;
    }
    if (!ROLE_KEY_REGEX.test(candidate)) {
      io.println('  role must be alphanumeric with . _ - allowed');
      continue;
    }
    if (!Object.hasOwn(DEFAULT_ROLES, candidate)) {
      // Custom role — accept it, but flag that the user will need to
      // define it in the config file before the server will accept
      // a load. We don't reject it; the wizard is for setup, and the
      // config file is the authoritative place to define roles.
      io.println(
        `  note: '${candidate}' is a custom role — the generated config ships with ` +
          `${defaultNames}. Add a \`roles.${candidate}\` entry to the config file ` +
          `before starting the server (see the example config in the server README).`,
      );
    }
    return candidate;
  }
}

/**
 * Render the token banner and return the number of terminal lines
 * emitted. The caller passes the count to `redactLines` so the wipe
 * stays in sync with the banner if its shape is edited later.
 */
function printTokenBanner(io: WizardIO, slot: WizardSlot): number {
  const bar = '='.repeat(68);
  const lines = [
    '',
    bar,
    `  ${slot.callsign} (${slot.role})`,
    '',
    `  ${slot.token}`,
    bar,
    'save this token NOW — it will be hashed and removed from scrollback.',
  ];
  for (const line of lines) io.println(line);
  return lines.length;
}

/**
 * Offer TOTP enrollment for an editor-role slot. Returns the persisted
 * base32 secret on success, or `null` if the user declined.
 *
 * UX:
 *   Header + Y/n prompt + success line stay visible so the user can
 *   see the decision they made and the positive confirmation. Only
 *   the sensitive block — QR code, base32 secret, and the entered
 *   codes — gets wiped from scrollback after enrollment succeeds.
 *
 * We count every line we print into `redactCount` as we go, so the
 * redact is exact regardless of how many retries the user needed.
 * Previous versions used a "generous upper bound" that over-redacted
 * on first-try enrollments and chewed into unrelated earlier output.
 */
async function promptTotpEnrollment(
  io: WizardIO,
  slot: WizardSlot,
  _squadron: Squadron,
  deps: {
    mintTotpSecret: () => string;
    now: () => number;
    renderQr: (uri: string) => string;
  },
): Promise<string | null> {
  // ── Visible header (stays on screen after enrollment) ───────────
  io.println('');
  io.println(`-- web UI login for ${slot.callsign} --`);
  io.println('This role can sign into the browser UI with a 6-digit authenticator code.');
  io.println('Your bearer token stays as the recovery path if you skip this now.');
  const answer = (await io.prompt('enable web UI login? [Y/n] ')).trim().toLowerCase();
  if (answer === 'n' || answer === 'no') {
    io.println(`  skipped — run \`c17 enroll --slot ${slot.callsign}\` later to enable.`);
    return null;
  }

  // ── Sensitive block (redacted on success) ───────────────────────
  // Track every printed line so the redact count is exact.
  let redactCount = 0;
  const printRedacted = (line: string) => {
    io.println(line);
    redactCount++;
  };

  const secret = deps.mintTotpSecret();
  const uri = otpauthUri({
    secret,
    issuer: TOTP_ISSUER,
    label: `${TOTP_ISSUER}:${slot.callsign}`,
  });
  const qr = deps.renderQr(uri);

  printRedacted('');
  printRedacted('scan this QR code with Google Authenticator, Authy, 1Password, …');
  printRedacted('');
  for (const line of qr.split('\n')) printRedacted(line);
  printRedacted('');
  printRedacted('or paste this secret manually:');
  printRedacted(`  ${secret}`);
  printRedacted('');

  let lastCounter = 0;
  let confirmed = false;
  for (let attempt = 0; attempt < TOTP_MAX_CONFIRM_ATTEMPTS; attempt++) {
    const raw = (await io.prompt('enter the 6-digit code to confirm: ')).trim();
    // readline writes the prompt + user's echoed input + newline as
    // a single visual line.
    redactCount += 1;
    if (raw.length === 0) {
      io.println(`  skipped — run \`c17 enroll --slot ${slot.callsign}\` later to enable.`);
      redactCount += 1;
      io.redactLines?.(redactCount);
      return null;
    }
    const result = verifyCode(secret, raw, lastCounter, deps.now());
    if (result.ok) {
      lastCounter = result.counter;
      confirmed = true;
      break;
    }
    io.println(`  ${describeVerifyError(result.reason)} — try again`);
    redactCount += 1;
  }
  if (!confirmed) {
    io.println('  too many bad attempts — skipping web UI enrollment');
    redactCount += 1;
    io.println(`  you can retry with \`c17 enroll --slot ${slot.callsign}\` later`);
    redactCount += 1;
    io.redactLines?.(redactCount);
    return null;
  }

  // Wipe the QR + secret + code-entry prompts from scrollback, THEN
  // print the success line so it lands fresh right above whatever
  // prompt comes next. The visible header + Y/n answer stay put —
  // they're useful context, not sensitive.
  io.redactLines?.(redactCount);
  io.println(`  ✓ enrollment confirmed for ${slot.callsign}`);

  return secret;
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

/**
 * Default in-terminal QR renderer using `qrcode-terminal` in small
 * (half-block) mode so a typical 33-module TOTP QR fits in 40 cols.
 * Synchronous wrapper around the library's callback-based generator —
 * the callback is always invoked synchronously on the same tick.
 */
function defaultQrRenderer(uri: string): string {
  let out = '';
  generateQrCode(uri, { small: true }, (qr) => {
    out = qr;
  });
  return out;
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
