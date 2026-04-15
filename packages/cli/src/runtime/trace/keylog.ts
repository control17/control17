/**
 * NSS-format TLS keylog tailer.
 *
 * Node's `--tls-keylog=<path>` (and libcurl/openssl's `SSLKEYLOGFILE`)
 * produce a line-oriented text file where each line is:
 *
 *   <LABEL> <client_random_hex> <secret_hex>
 *
 * Labels of interest for TLS 1.3:
 *   CLIENT_HANDSHAKE_TRAFFIC_SECRET
 *   SERVER_HANDSHAKE_TRAFFIC_SECRET
 *   CLIENT_TRAFFIC_SECRET_0
 *   SERVER_TRAFFIC_SECRET_0
 *   EXPORTER_SECRET
 *   CLIENT_EARLY_TRAFFIC_SECRET    (if 0-RTT is used)
 *
 * And for TLS 1.2 fallback:
 *   CLIENT_RANDOM                  (pre-master secret)
 *
 * The tailer polls the file for appended bytes on a short interval,
 * parses any complete new lines, and fires `onEntry` for each. Comment
 * lines (`#…`) and unknown labels pass through as entries too — the
 * decryption layer in Phase 6 decides what tshark actually needs. We
 * preserve everything verbatim because the NSS format is the source
 * of truth for whatever TLS library writes it.
 *
 * Why polling, not `fs.watch`:
 *   - `fs.watch` fires once per coarse change on Linux and gives no
 *     guarantee about the content that triggered it. We'd still need
 *     to read + track offset + handle partial lines.
 *   - Poll interval defaults to 100ms which is much faster than the
 *     ~1s–10s lifecycle of a span close, so the worst-case latency is
 *     inconsequential for Phase 5's span correlation use case.
 */

import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';

export interface KeylogEntry {
  /**
   * Label verbatim from the file. Anything before the first space on
   * a non-empty, non-comment line. Comments come through with label
   * set to the literal `#` character so downstream can filter them.
   */
  readonly label: string;
  /** Client random, hex-encoded as written. `''` for comment lines. */
  readonly clientRandom: string;
  /** Secret hex, as written. `''` for comment lines. */
  readonly secret: string;
  /** Wall-clock time the tailer observed this entry (ms since epoch). */
  readonly seenAt: number;
  /** The raw line (no trailing newline) — useful for tshark passthrough. */
  readonly rawLine: string;
}

export interface KeylogTailerOptions {
  /** Path to the NSS keylog file. The file is created if missing. */
  path: string;
  /** Poll interval in ms. Defaults to 100. */
  pollIntervalMs?: number;
  /** Called for every parsed entry (including comments). */
  onEntry?: (entry: KeylogEntry) => void;
  log?: (msg: string, ctx?: Record<string, unknown>) => void;
}

export interface KeylogTailer {
  /** Stop polling and release the file handle. Idempotent. */
  close(): Promise<void>;
  /**
   * All entries observed since tailer start. Snapshot — the caller
   * gets a live reference, so don't mutate.
   */
  readonly entries: readonly KeylogEntry[];
  /**
   * Force an immediate read regardless of the poll schedule. Useful
   * for tests that want to wait for a specific entry without racing
   * the polling interval. Resolves after the read completes.
   */
  drain(): Promise<void>;
}

const DEFAULT_POLL_MS = 100;

/**
 * Open + tail an NSS keylog file. If the file doesn't exist, we
 * create it empty with mode 0o600 so Node's `--tls-keylog` can write
 * to it. The caller is responsible for passing the same `path` into
 * the child's env.
 */
export async function startKeylogTailer(options: KeylogTailerOptions): Promise<KeylogTailer> {
  const log =
    options.log ??
    ((msg: string, ctx: Record<string, unknown> = {}): void => {
      const record = { ts: new Date().toISOString(), component: 'keylog', msg, ...ctx };
      process.stderr.write(`${JSON.stringify(record)}\n`);
    });

  // Ensure the file exists and has restrictive permissions. Create
  // with `wx` so we fail loudly if something already sits at the path
  // — the runner picks a fresh path per session so that's a red flag.
  try {
    const fh = await fs.open(options.path, 'wx', 0o600);
    await fh.close();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw err;
    }
    // If the file existed we still want to chmod it to 0o600 — don't
    // want secret key material world-readable.
    try {
      await fs.chmod(options.path, 0o600);
    } catch {
      /* best effort */
    }
  }

  const entries: KeylogEntry[] = [];
  let handle: FileHandle | null = await fs.open(options.path, 'r');
  let offset = 0;
  let carry = '';
  let closed = false;
  let pollTimer: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> | null = null;

  const readChunk = async (): Promise<void> => {
    if (closed || handle === null) return;
    // Read whatever's new since our last offset. Cap a single read at
    // 64KB so we don't stall the event loop on a huge paste.
    const buf = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buf, 0, buf.length, offset);
    if (bytesRead === 0) return;
    offset += bytesRead;
    const text = carry + buf.slice(0, bytesRead).toString('utf8');
    const lines = text.split('\n');
    carry = lines.pop() ?? '';
    const now = Date.now();
    for (const line of lines) {
      const entry = parseLine(line, now);
      if (entry !== null) {
        entries.push(entry);
        options.onEntry?.(entry);
      }
    }
  };

  const tick = async (): Promise<void> => {
    if (closed) return;
    try {
      await readChunk();
    } catch (err) {
      log('keylog: read error', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const scheduleNext = (): void => {
    if (closed) return;
    pollTimer = setTimeout(() => {
      inFlight = tick().finally(() => {
        inFlight = null;
        scheduleNext();
      });
    }, options.pollIntervalMs ?? DEFAULT_POLL_MS);
    pollTimer.unref();
  };
  scheduleNext();

  return {
    entries,
    async drain() {
      if (closed) return;
      if (inFlight !== null) await inFlight;
      await tick();
    },
    async close() {
      if (closed) return;
      closed = true;
      if (pollTimer !== null) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
      if (inFlight !== null) {
        try {
          await inFlight;
        } catch {
          /* already logged */
        }
      }
      if (handle !== null) {
        try {
          await handle.close();
        } catch {
          /* ignore */
        }
        handle = null;
      }
    },
  };
}

/**
 * Parse a single NSS keylog line into an entry. Returns null for empty
 * lines; comment lines come back with `label === '#'` so downstream
 * code can distinguish them from real entries without having to
 * re-parse the raw line.
 */
function parseLine(line: string, seenAt: number): KeylogEntry | null {
  const trimmed = line.replace(/\r$/, '');
  if (trimmed.length === 0) return null;
  if (trimmed.startsWith('#')) {
    return { label: '#', clientRandom: '', secret: '', seenAt, rawLine: trimmed };
  }
  const parts = trimmed.split(/\s+/);
  if (parts.length < 3) {
    // Malformed but non-empty; still surface it so the decryption
    // layer can log + skip rather than silently dropping.
    return {
      label: 'MALFORMED',
      clientRandom: '',
      secret: '',
      seenAt,
      rawLine: trimmed,
    };
  }
  const [label, clientRandom, secret] = parts as [string, string, string];
  return { label, clientRandom, secret, seenAt, rawLine: trimmed };
}
