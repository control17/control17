/**
 * SSE subscription — live /subscribe stream feeding the messages signal.
 *
 * Uses the browser's native `EventSource`:
 *   - auto-reconnects with a built-in retry delay
 *   - auto-sends `Last-Event-ID` on reconnect (cosmetic — server doesn't
 *     use it today)
 *   - cookies are sent automatically for same-origin requests, which
 *     is how the SPA authenticates (no Authorization header needed)
 *
 * On every reconnect we re-pull `/history?limit=50` to backfill any
 * messages delivered during the gap. Merge happens through
 * `appendMessages`, which de-dupes by message id so the overlap with
 * what we already have is harmless.
 *
 * We track a `connected` signal so the header can show ON NET / OFF NET
 * state based on whether the stream is currently live.
 */

import { signal } from '@preact/signals';
import { getClient } from './client.js';
import { appendMessages } from './messages.js';

export const streamConnected = signal(false);

export interface StartSubscribeOptions {
  /** Callsign to subscribe as (= the current slot's callsign). */
  callsign: string;
  /** Max history entries to backfill on first open + every reconnect. */
  historyLimit?: number;
  /** Optional callback for errors you want to surface in the UI. */
  onError?: (err: unknown) => void;
}

/**
 * Open the SSE stream. Returns a teardown function that closes the
 * EventSource and marks the connection as disconnected. Idempotent
 * — calling teardown twice is safe.
 */
export function startSubscribe(options: StartSubscribeOptions): () => void {
  const { callsign, historyLimit = 50, onError } = options;
  const url = `/subscribe?agentId=${encodeURIComponent(callsign)}`;

  let source: EventSource | null = null;
  let cancelled = false;

  const backfill = async () => {
    try {
      const history = await getClient().history({ limit: historyLimit });
      appendMessages(callsign, history);
    } catch (err) {
      onError?.(err);
    }
  };

  const open = () => {
    if (cancelled) return;
    source = new EventSource(url, { withCredentials: true });

    source.addEventListener('open', () => {
      streamConnected.value = true;
      // Every successful connect (initial or reconnect) triggers a
      // backfill. On initial open this seeds the transcript; on
      // reconnect it fills in whatever we missed during the gap.
      void backfill();
    });

    source.addEventListener('message', (event) => {
      if (!event.data) return;
      try {
        const parsed = JSON.parse(event.data) as unknown;
        // Trust the shape — server validates on the way out. If a
        // malformed frame sneaks through, appendMessages' typing
        // catches it at the signal level.
        appendMessages(callsign, [parsed as Parameters<typeof appendMessages>[1][number]]);
      } catch (err) {
        onError?.(err);
      }
    });

    source.addEventListener('error', () => {
      streamConnected.value = false;
      // EventSource will auto-reconnect on its own. We don't close
      // and reopen manually — that would race with its internal
      // retry loop.
    });
  };

  open();

  return () => {
    cancelled = true;
    streamConnected.value = false;
    if (source !== null) {
      source.close();
      source = null;
    }
  };
}

export function __resetSseForTests(): void {
  streamConnected.value = false;
}
