/**
 * Agent activity stream — hydration + live SSE tailing for a single
 * slot's `/agents/:callsign/activity` timeline.
 *
 * There's exactly one active subscription at a time — a new call
 * to `startAgentActivitySubscribe(callsign)` tears down the
 * previous EventSource before opening a new one. This matches how
 * the AgentPage component mounts/unmounts across navigation.
 *
 * On open:
 *   1. Hydrate via `listAgentActivity(callsign)` — the server
 *      returns up to 200 most-recent rows newest-first. We flip
 *      them into oldest-first order so the UI can prepend newer
 *      events naturally at the top.
 *   2. Open the EventSource at `/agents/:callsign/activity/stream`.
 *   3. Every incoming `message` event is a JSON-encoded
 *      `AgentActivityRow`. Append to the head of the list
 *      (newest-first), de-duping by `id` so a backfill
 *      immediately after a reconnect doesn't double-render.
 *
 * We cap the in-memory list at `MAX_ROWS` to avoid unbounded
 * growth on long-running pages — oldest rows drop when the cap is
 * exceeded. `loadOlder()` fetches older rows on demand for
 * pagination.
 */

import { AgentActivityRowSchema } from '@control17/sdk/schemas';
import type { AgentActivityRow } from '@control17/sdk/types';
import { signal } from '@preact/signals';
import { getClient } from './client.js';

/** Hard cap on the in-memory row list per subscription. */
const MAX_ROWS = 500;

/**
 * Rows for the currently-subscribed agent, **newest-first**. Empty
 * when no subscription is active or before hydration completes.
 */
export const agentActivityRows = signal<AgentActivityRow[]>([]);

/** True while the SSE connection is live. False before open / after drop. */
export const agentActivityConnected = signal(false);

/** True during initial hydration + any time `loadOlder()` is in flight. */
export const agentActivityLoading = signal(false);

/** Non-null when hydration failed — surfaced inline on the page. */
export const agentActivityError = signal<string | null>(null);

/** Callsign of the currently-subscribed agent. null when idle. */
export const agentActivityCallsign = signal<string | null>(null);

/**
 * True when we've scrolled back as far as the server has — no more
 * older rows to fetch. Set when a `loadOlder()` call returns fewer
 * rows than the limit it asked for.
 */
export const agentActivityExhausted = signal(false);

export interface StartAgentActivityOptions {
  callsign: string;
  /** Backfill depth on hydrate. Default 200 (max). */
  hydrationLimit?: number;
  /** Surface errors to the page. */
  onError?: (err: unknown) => void;
}

/**
 * Start (or switch) the agent-activity subscription to the given
 * callsign. Returns a teardown function that closes the SSE stream
 * and clears the signals. Idempotent.
 */
export function startAgentActivitySubscribe(options: StartAgentActivityOptions): () => void {
  const { callsign, hydrationLimit = 200, onError } = options;
  const url = `/agents/${encodeURIComponent(callsign)}/activity/stream`;

  let source: EventSource | null = null;
  let cancelled = false;

  // Reset state for the new subscription — previous pages leave
  // their rows in the signal which would otherwise briefly flash
  // the old agent's data.
  agentActivityRows.value = [];
  agentActivityConnected.value = false;
  agentActivityLoading.value = true;
  agentActivityError.value = null;
  agentActivityExhausted.value = false;
  agentActivityCallsign.value = callsign;

  const hydrate = async (): Promise<void> => {
    try {
      const rows = await getClient().listAgentActivity(callsign, { limit: hydrationLimit });
      if (cancelled) return;
      // Server returns newest-first; we keep that ordering in the
      // signal (render reads left-to-right as newest-first).
      agentActivityRows.value = rows.slice(0, MAX_ROWS);
      // If the server returned fewer than requested, there's no
      // more history to fetch.
      if (rows.length < hydrationLimit) agentActivityExhausted.value = true;
      agentActivityError.value = null;
    } catch (err) {
      if (cancelled) return;
      const msg = err instanceof Error ? err.message : String(err);
      agentActivityError.value = msg;
      onError?.(err);
    } finally {
      if (!cancelled) agentActivityLoading.value = false;
    }
  };

  const open = (): void => {
    if (cancelled) return;
    source = new EventSource(url, { withCredentials: true });

    source.addEventListener('open', () => {
      agentActivityConnected.value = true;
      // Re-hydrate on every successful connect: on initial open
      // this seeds the list, on reconnect it fills any gap the
      // stream dropped. `mergeRows` de-dupes by id so the overlap
      // is harmless.
      void hydrate();
    });

    source.addEventListener('message', (event) => {
      if (!event.data) return;
      try {
        const row = AgentActivityRowSchema.parse(JSON.parse(event.data));
        mergeRow(row);
      } catch (err) {
        onError?.(err);
      }
    });

    source.addEventListener('error', () => {
      agentActivityConnected.value = false;
      // EventSource auto-reconnects; we don't close and reopen
      // manually or we'd race with its internal retry.
    });
  };

  open();

  return () => {
    cancelled = true;
    agentActivityConnected.value = false;
    agentActivityLoading.value = false;
    agentActivityCallsign.value = null;
    agentActivityRows.value = [];
    agentActivityError.value = null;
    agentActivityExhausted.value = false;
    if (source !== null) {
      source.close();
      source = null;
    }
  };
}

/**
 * Merge a single freshly-arrived row into the newest-first list.
 * Deduped by `id` — if an earlier hydration already has this row,
 * we leave the list alone. Inserts new rows at the head and
 * enforces the `MAX_ROWS` cap on the tail.
 */
function mergeRow(row: AgentActivityRow): void {
  const existing = agentActivityRows.value;
  if (existing.some((r) => r.id === row.id)) return;
  // Insert in ts-descending position. The common case is that the
  // new row is newer than everything in the list, so we fast-path
  // that and only walk the list for out-of-order arrivals.
  const newest = existing[0];
  if (!newest || row.event.ts >= newest.event.ts) {
    const next = [row, ...existing];
    agentActivityRows.value = next.length > MAX_ROWS ? next.slice(0, MAX_ROWS) : next;
    return;
  }
  const inserted = [...existing];
  const idx = inserted.findIndex((r) => r.event.ts <= row.event.ts);
  if (idx === -1) inserted.push(row);
  else inserted.splice(idx, 0, row);
  agentActivityRows.value = inserted.length > MAX_ROWS ? inserted.slice(0, MAX_ROWS) : inserted;
}

/**
 * Load one more page of older rows for the currently-subscribed
 * agent. Uses the oldest row in the current list as an upper
 * bound on the `to` query and asks the server for another
 * hydration-sized chunk. No-op if we're already exhausted or no
 * subscription is active.
 */
export async function loadOlderAgentActivity(limit = 100): Promise<void> {
  const callsign = agentActivityCallsign.value;
  if (!callsign) return;
  if (agentActivityExhausted.value) return;
  const rows = agentActivityRows.value;
  const oldest = rows[rows.length - 1];
  if (!oldest) return;
  agentActivityLoading.value = true;
  try {
    // `to = oldest.ts - 1` so we don't re-fetch the oldest row.
    const older = await getClient().listAgentActivity(callsign, {
      to: oldest.event.ts - 1,
      limit,
    });
    if (older.length === 0) {
      agentActivityExhausted.value = true;
      return;
    }
    const merged = [...rows, ...older];
    // Dedup by id as a safety net against concurrent inserts.
    const seen = new Set<number>();
    const deduped: AgentActivityRow[] = [];
    for (const r of merged) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      deduped.push(r);
    }
    agentActivityRows.value = deduped.slice(0, MAX_ROWS);
    if (older.length < limit) agentActivityExhausted.value = true;
  } catch (err) {
    agentActivityError.value = err instanceof Error ? err.message : String(err);
  } finally {
    agentActivityLoading.value = false;
  }
}

/** Test-only reset for unit tests. */
export function __resetAgentActivityForTests(): void {
  agentActivityRows.value = [];
  agentActivityConnected.value = false;
  agentActivityLoading.value = false;
  agentActivityError.value = null;
  agentActivityCallsign.value = null;
  agentActivityExhausted.value = false;
}
