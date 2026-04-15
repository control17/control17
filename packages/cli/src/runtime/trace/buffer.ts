/**
 * Per-objective trace buffer.
 *
 * The runner opens a "span" when an agent takes ownership of an
 * objective (assigned / taken / created-and-self-assigned) and closes
 * it when the objective reaches a terminal state (completed, cancelled,
 * reassigned away). Every proxy chunk and every keylog entry observed
 * while a span is open is appended to that span's buffer. At close
 * time, the buffer hands back a SpanSnapshot that Phase 6 can shove
 * through tshark for decryption + Anthropic-API parsing + upload.
 *
 * Concurrency model:
 *   - Multiple spans can be open at the same time. A single proxy
 *     chunk lands in every currently-open span — we have no way to
 *     attribute a TCP connection back to a single objective, so time-
 *     bounded union is the safest default. Consumers can filter later
 *     if they want finer attribution.
 *   - Keylog entries follow the same broadcast-to-active-spans rule.
 *   - There's no cross-span deduplication. The cost is one extra
 *     reference per chunk per overlapping span, which is fine.
 *
 * Cap policy:
 *   - Each span has a soft byte cap (default 10MB). Once exceeded,
 *     further chunks are dropped and `truncated` is set to `true`.
 *     Keylog entries still pass through unconditionally — they're
 *     small and essential for decryption.
 *   - No hard cap on number of spans or keys. The runner lives for
 *     one agent session; realistic ceilings are tens of spans and
 *     hundreds of keys.
 */

import type { KeylogEntry } from './keylog.js';
import type { ProxyChunk } from './proxy.js';

export interface TraceBufferOptions {
  /** Soft byte cap per span. Default: 10 MB. */
  byteSoftCapPerSpan?: number;
  log?: (msg: string, ctx?: Record<string, unknown>) => void;
}

export interface SpanSnapshot {
  readonly objectiveId: string;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly chunks: readonly ProxyChunk[];
  readonly keys: readonly KeylogEntry[];
  readonly truncated: boolean;
  /** Total chunk bytes recorded (pre-truncation if hit cap). */
  readonly bytesRecorded: number;
}

interface Span {
  objectiveId: string;
  startedAt: number;
  chunks: ProxyChunk[];
  keys: KeylogEntry[];
  bytesRecorded: number;
  truncated: boolean;
}

const DEFAULT_BYTE_CAP = 10 * 1024 * 1024;

export class TraceBuffer {
  private readonly spans = new Map<string, Span>();
  private readonly byteCap: number;
  private readonly log: (msg: string, ctx?: Record<string, unknown>) => void;

  constructor(options: TraceBufferOptions = {}) {
    this.byteCap = options.byteSoftCapPerSpan ?? DEFAULT_BYTE_CAP;
    this.log =
      options.log ??
      ((msg, ctx = {}) => {
        const record = { ts: new Date().toISOString(), component: 'trace-buffer', msg, ...ctx };
        process.stderr.write(`${JSON.stringify(record)}\n`);
      });
  }

  /**
   * Open a new span for an objective. If a span is already open for
   * the same id, this is a no-op — we don't reset the buffer, because
   * an objective going from `assigned` to `assigned` (e.g. noisy SSE)
   * shouldn't lose earlier chunks. If you really want a fresh span,
   * close the old one first.
   */
  openSpan(objectiveId: string): void {
    if (this.spans.has(objectiveId)) {
      this.log('trace-buffer: openSpan on already-open id', { objectiveId });
      return;
    }
    this.spans.set(objectiveId, {
      objectiveId,
      startedAt: Date.now(),
      chunks: [],
      keys: [],
      bytesRecorded: 0,
      truncated: false,
    });
  }

  /**
   * Close a span and return its snapshot. Returns `null` if there was
   * no open span for this id — let the caller decide whether that's
   * a warning or an expected idempotency. The snapshot freezes the
   * current arrays; further chunks for this id (should any arrive
   * after close) are dropped.
   */
  closeSpan(objectiveId: string): SpanSnapshot | null {
    const span = this.spans.get(objectiveId);
    if (!span) return null;
    this.spans.delete(objectiveId);
    return {
      objectiveId: span.objectiveId,
      startedAt: span.startedAt,
      endedAt: Date.now(),
      chunks: span.chunks,
      keys: span.keys,
      truncated: span.truncated,
      bytesRecorded: span.bytesRecorded,
    };
  }

  hasOpenSpan(objectiveId: string): boolean {
    return this.spans.has(objectiveId);
  }

  openSpanIds(): string[] {
    return Array.from(this.spans.keys());
  }

  /**
   * Append a proxy chunk to every currently-open span. No-op if no
   * spans are open. Truncation is per-span: a span that has hit the
   * cap ignores further chunks but still accepts keys; other spans
   * keep collecting normally.
   */
  ingestChunk(chunk: ProxyChunk): void {
    if (this.spans.size === 0) return;
    for (const span of this.spans.values()) {
      if (span.truncated) continue;
      if (span.bytesRecorded + chunk.bytes.length > this.byteCap) {
        span.truncated = true;
        this.log('trace-buffer: span truncated', {
          objectiveId: span.objectiveId,
          cap: this.byteCap,
          attempted: span.bytesRecorded + chunk.bytes.length,
        });
        continue;
      }
      // Hold a copy — the source buffer from the proxy relay is a
      // live Node network buffer that may be recycled once the data
      // handler returns.
      const copied: ProxyChunk = {
        ...chunk,
        bytes: Buffer.from(chunk.bytes),
      };
      span.chunks.push(copied);
      span.bytesRecorded += chunk.bytes.length;
    }
  }

  /**
   * Append a keylog entry to every currently-open span. Keys bypass
   * the byte cap — they're tiny, essential for decryption, and
   * dropping them would silently corrupt the output of tshark.
   */
  ingestKey(entry: KeylogEntry): void {
    if (this.spans.size === 0) return;
    for (const span of this.spans.values()) {
      span.keys.push(entry);
    }
  }
}
