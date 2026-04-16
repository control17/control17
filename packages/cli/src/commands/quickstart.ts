/**
 * `c17 quickstart` — zero-to-first-mission helper.
 *
 * Assumes the operator has already run `c17 setup` (or ingested a
 * squadron config some other way). Picks up from "you have a token and
 * a broker URL" and seeds the remaining first-session experience:
 *
 *   1. Health-check the broker at the configured URL. If it's not up,
 *      print a clear "start `c17 serve` first" message and exit 1.
 *   2. Resolve an assignee for a demo objective. Defaults to the first
 *      operator-tier slot on the roster; falls back to the first slot
 *      regardless of tier if none exists.
 *   3. Create the demo objective ("summarize this repository in 3
 *      paragraphs") with the operator as originator and the chosen slot
 *      as assignee. Idempotent-ish: skips creation if a demo objective
 *      with the same title is already on the roster.
 *   4. Best-effort open the web UI in the operator's default browser.
 *      Cross-platform (macOS `open`, Linux `xdg-open`, Windows `start`).
 *      Never fails the command if the open fails — the URL is always
 *      printed alongside so the operator can click/paste themselves.
 *   5. Print a crisp "next step" block pointing at `c17 claude-code`.
 *
 * This intentionally does NOT spawn a broker in-process (that would
 * leave a long-lived process hanging off an interactive quickstart
 * invocation, which is a confusing ownership model) and does NOT run
 * the setup wizard automatically (the wizard prints credentials once
 * and an accidental re-run from quickstart would invalidate them).
 * Both of those flows stay as explicit operator actions.
 *
 * Context: part of I3 (obj-mo240qpt-6), acceptance criterion 7.
 */

import { spawn } from 'node:child_process';
import type { Client, ClientError } from '@control17/sdk/client';

const DEMO_TITLE = 'quickstart — summarize this repository';
const DEMO_OUTCOME =
  'Post a 3-paragraph summary of the current working directory to this ' +
  "objective's thread: (1) what kind of project this is, (2) the " +
  "most important entry points or subdirectories, (3) one thing that's " +
  'surprising or unusual. Read files; do not run the code.';
const DEMO_BODY =
  'This is the demo objective seeded by `c17 quickstart`. It exists to ' +
  "give you something to execute on turn 1 so you can see the whole " +
  "flow end-to-end: trace capture, objective tracking, web UI rendering. " +
  "You can cancel or reassign it at any time; it is not load-bearing.";

export interface QuickstartCommandInput {
  url: string;
  token: string;
  /** Skip the browser-open step (tests, headless CI). */
  skipBrowser?: boolean;
  /** Override the demo objective's assignee callsign. */
  assignee?: string;
}

export interface QuickstartReport {
  /** The web UI URL the operator should visit. */
  webUrl: string;
  /** The demo objective id (whether newly created or already present). */
  objectiveId: string;
  /** True if this invocation created the demo objective; false if reused. */
  created: boolean;
  /** The callsign the demo was assigned to. */
  assignee: string;
  /** Whether we attempted to open the browser, and the outcome. */
  browserOpen: 'opened' | 'skipped' | 'failed' | 'unsupported';
}

export async function runQuickstartCommand(
  input: QuickstartCommandInput,
  client: Client,
  log: (line: string) => void,
): Promise<QuickstartReport> {
  // 1. Health check — the most common failure mode is the broker
  //    simply isn't running. Surface that with a clear hint before
  //    attempting anything else.
  try {
    await client.health();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new QuickstartError(
      `broker unreachable at ${input.url}: ${msg}\n` +
        `  hint: is \`c17 serve\` running at ${input.url}?\n` +
        `        (if you have not finished setup yet, run \`c17 setup\` first)`,
    );
  }

  // 2. Resolve an assignee. Prefer operator-tier slots because the
  //    demo objective is operator-flavored work (execute a task);
  //    fall back to the first slot of any tier if the squadron has no
  //    operator configured.
  const rosterResp = await client.roster();
  if (rosterResp.teammates.length === 0) {
    throw new QuickstartError(
      'squadron has no slots configured — run `c17 setup` to create one before quickstart.',
    );
  }
  const assignee =
    input.assignee ??
    rosterResp.teammates.find((t) => t.authority === 'operator')?.callsign ??
    rosterResp.teammates[0]?.callsign;
  if (!assignee) {
    // Unreachable given the length check above, but keeps the types honest.
    throw new QuickstartError('no callsign resolvable from roster response');
  }

  // 3. Check whether the demo is already seeded. We identify it by
  //    exact title match — the quickstart title string is distinctive
  //    enough to make false positives vanishingly unlikely, and this
  //    keeps the command idempotent so re-running it doesn't spray
  //    demo objectives across the thread list.
  let objectiveId: string | null = null;
  let created = false;
  try {
    const existing = await client.listObjectives({ status: 'active' });
    const match = existing.find((o) => o.title === DEMO_TITLE);
    if (match) objectiveId = match.id;
  } catch (err) {
    // Non-fatal — we can always try to create; if creation fails with
    // a duplicate-title error the caller sees that error.
    log(
      `quickstart: could not list existing objectives (continuing): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  if (objectiveId === null) {
    try {
      const obj = await client.createObjective({
        title: DEMO_TITLE,
        outcome: DEMO_OUTCOME,
        body: DEMO_BODY,
        assignee,
      });
      objectiveId = obj.id;
      created = true;
    } catch (err) {
      const ce = err as ClientError;
      throw new QuickstartError(
        `failed to create demo objective: ${ce.message ?? String(err)}\n` +
          `  (the caller needs lieutenant or commander authority to create objectives — ` +
          `check your slot's authority with \`c17 roster\`)`,
      );
    }
  }

  // 4. Best-effort open the browser. Print the URL unconditionally so
  //    the operator can click it themselves if the open fails.
  const webUrl = input.url.replace(/\/+$/, '');
  let browserOpen: QuickstartReport['browserOpen'] = 'skipped';
  if (!input.skipBrowser) {
    browserOpen = tryOpenBrowser(webUrl);
  }

  // 5. Pretty status to stdout — the operator sees this directly.
  log('');
  log('c17 quickstart — ready.');
  log('');
  log(`  squadron  ${rosterResp.teammates[0]?.callsign ?? '?'} (and ${rosterResp.teammates.length - 1} more)`);
  log(`  broker    ${input.url} (ON NET)`);
  log(`  assignee  ${assignee}`);
  log(`  demo      ${objectiveId} ${created ? '(created)' : '(already seeded; reusing)'}`);
  log('');
  log(`  web UI    ${webUrl}`);
  switch (browserOpen) {
    case 'opened':
      log('            (opened in your default browser)');
      break;
    case 'failed':
      log('            (tried to open it — command returned an error. visit the URL above.)');
      break;
    case 'unsupported':
      log('            (no default-browser open command for this platform; visit the URL above.)');
      break;
    case 'skipped':
      break;
  }
  log('');
  log('  NEXT:     in a separate terminal, run `c17 claude-code` to execute the demo');
  log('            (or watch the web UI as you re-run this command to re-seed)');
  log('');

  return { webUrl, objectiveId, created, assignee, browserOpen };
}

/**
 * Attempt to open `url` in the OS default browser. Returns a flag
 * describing what happened — never throws. We never want a failed
 * browser open to fail the quickstart, because the operator can
 * always click the URL we already printed.
 */
function tryOpenBrowser(url: string): QuickstartReport['browserOpen'] {
  const { command, args } = openCommandFor(process.platform, url);
  if (command === null) return 'unsupported';

  try {
    // Detached + unref so the quickstart doesn't end up waiting on the
    // browser process. We don't need stdio from the browser either.
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.unref();
    child.on('error', () => {
      /* we report via the returned flag — failures from here are logged nowhere */
    });
    return 'opened';
  } catch {
    return 'failed';
  }
}

function openCommandFor(
  platform: NodeJS.Platform,
  url: string,
): { command: string | null; args: string[] } {
  switch (platform) {
    case 'darwin':
      return { command: 'open', args: [url] };
    case 'win32':
      // `start` is a cmd.exe builtin, not a program — wrap through cmd.
      return { command: 'cmd', args: ['/c', 'start', '""', url] };
    case 'linux':
    case 'freebsd':
    case 'openbsd':
      return { command: 'xdg-open', args: [url] };
    default:
      return { command: null, args: [] };
  }
}

export class QuickstartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QuickstartError';
  }
}
