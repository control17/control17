/**
 * Messages signal — transcript state keyed by thread.
 *
 * A "thread" is:
 *   - the shared squadron channel (`primary`)
 *   - a DM conversation (`dm:<other>`)
 *   - an objective's discussion thread (`obj:<id>`)
 *
 * `threadKeyOf` maps a Message to its thread key from the perspective
 * of the current viewer. When the sender tags a message with an
 * explicit thread key in `data.thread`, that wins — this is how
 * objective discussions and objective lifecycle events route into
 * their dedicated thread. Otherwise we fall back to the legacy
 * primary/DM derivation based on `agentId` + `from`.
 *
 * The signal value is a `Map<threadKey, Message[]>` — we store the Map
 * itself so reads stay O(1) and we can still replace it on change to
 * trigger signal reactivity. Append dedupes by message id — important
 * because SSE reconnects re-pull /history and we don't want duplicates
 * when reconciling.
 */

import type { Message } from '@control17/sdk/types';
import { signal } from '@preact/signals';

export const PRIMARY_THREAD = 'primary';
export const DM_PREFIX = 'dm:';
export const OBJ_PREFIX = 'obj:';

/**
 * Build a DM thread key from the counterpart callsign. Centralized
 * so callers (sidebar clicks, composer targeting, transcript empty
 * state) never build the `dm:X` string literal by hand — if the key
 * format ever changes, this is the single point of edit.
 */
export function dmThreadKey(other: string): string {
  return `${DM_PREFIX}${other}`;
}

/** True if `key` names a DM thread (not the shared team channel). */
export function isDmThread(key: string): boolean {
  return key.startsWith(DM_PREFIX);
}

/** Build an objective thread key from an objective id. */
export function objectiveThreadKey(id: string): string {
  return `${OBJ_PREFIX}${id}`;
}

/** True if `key` names an objective discussion thread. */
export function isObjectiveThread(key: string): boolean {
  return key.startsWith(OBJ_PREFIX);
}

/**
 * Extract the counterpart callsign from a DM thread key. Returns
 * `null` for `PRIMARY_THREAD` or any non-DM key so callers can
 * short-circuit cleanly.
 */
export function dmOther(key: string): string | null {
  if (!isDmThread(key)) return null;
  return key.slice(DM_PREFIX.length);
}

/** Thread key for `msg` from the perspective of the viewer `self`. */
export function threadKeyOf(msg: Message, self: string): string {
  // Explicit thread override wins. Objective lifecycle events and
  // discussion posts both ship with `data.thread = 'obj:<id>'` so
  // they route straight into the objective's dedicated thread,
  // bypassing the primary/DM heuristics below.
  const explicit = typeof msg.data?.thread === 'string' ? (msg.data.thread as string) : null;
  if (explicit !== null && explicit.length > 0) return explicit;

  if (msg.agentId === null) return PRIMARY_THREAD;
  if (msg.agentId === self) {
    // DM addressed to me — thread is keyed by the other party's
    // callsign. Edge case: self-DM (agentId=self AND from=self) gets
    // its own `dm:self` key so it doesn't collide with primary.
    return msg.from && msg.from !== self ? dmThreadKey(msg.from) : dmThreadKey('self');
  }
  // Outbound DM from me to someone else.
  return dmThreadKey(msg.agentId);
}

/**
 * The message store. Map identity changes on every write so signal
 * subscribers re-render; individual arrays inside the map are also
 * replaced rather than mutated for the same reason.
 */
export const messagesByThread = signal<Map<string, Message[]>>(new Map());

/**
 * Append one or more messages to their respective threads. Handles
 * inbound sorting (keeps arrays ordered by `ts` ascending) and dedups
 * by message id, so calling this repeatedly with overlapping history
 * pages is safe.
 */
export function appendMessages(viewer: string, msgs: Message[]): void {
  if (msgs.length === 0) return;
  const next = new Map(messagesByThread.value);

  // Bucket by thread key in one pass so we only touch each thread
  // array once even if msgs covers many threads.
  const byThread = new Map<string, Message[]>();
  for (const m of msgs) {
    const key = threadKeyOf(m, viewer);
    const arr = byThread.get(key) ?? [];
    arr.push(m);
    byThread.set(key, arr);
  }

  for (const [key, incoming] of byThread) {
    const existing = next.get(key) ?? [];
    const seenIds = new Set(existing.map((m) => m.id));
    const fresh = incoming.filter((m) => !seenIds.has(m.id));
    if (fresh.length === 0) continue;
    const merged = [...existing, ...fresh].sort((a, b) => a.ts - b.ts);
    next.set(key, merged);
  }

  messagesByThread.value = next;
}

/** Read the messages for a given thread, never null. */
export function threadMessages(key: string): Message[] {
  return messagesByThread.value.get(key) ?? [];
}

/**
 * Enumerate every thread key currently in the store, plus
 * `PRIMARY_THREAD` if it isn't already present. Used by the sidebar
 * so the team channel is always clickable even when it has no messages.
 */
export function threadKeys(): string[] {
  const keys = new Set(messagesByThread.value.keys());
  keys.add(PRIMARY_THREAD);
  // Sort: primary first, then DM threads alphabetically by callsign.
  return [...keys].sort((a, b) => {
    if (a === PRIMARY_THREAD) return -1;
    if (b === PRIMARY_THREAD) return 1;
    return a.localeCompare(b);
  });
}

/** Test hook: wipe the store between it() blocks. */
export function __resetMessagesForTests(): void {
  messagesByThread.value = new Map();
}
