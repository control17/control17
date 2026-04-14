/**
 * One message in the transcript.
 *
 * Two rendering modes:
 *
 *   1. **Header row** — the first message in a group. Full layout:
 *      `[HH:MM] SENDER: inline-markdown-body`. Gets a small top
 *      margin when there's a previous message, so groups breathe.
 *
 *   2. **Continuation row** — a follow-up from the same sender
 *      within a short window. Hides the sender (that's the
 *      redundant bit that makes bursts noisy) but keeps the
 *      timestamp so per-row timing stays visible — a same-sender
 *      burst can span seconds or minutes and the reader shouldn't
 *      have to guess. Timestamps render in the same font-mono
 *      gutter as the header so the HH:MM column lines up vertically.
 *
 * Grouping rules (computed in `isContinuationOf`):
 *   - same `from` callsign
 *   - same `level` (an info message next to an `error` never groups)
 *   - no `title` on either message (titled messages are distinct)
 *   - the gap between `ts` values is ≤ 5 minutes
 *
 * Sender name is colored by `senderTextClass` — green for the viewer,
 * coyote tan for every teammate — so "me vs them" is obvious at a
 * glance. The body runs through `renderInlineMarkdown`, which escapes
 * HTML before applying any formatting — safe for
 * `dangerouslySetInnerHTML`.
 */

import type { Message } from '@control17/sdk/types';
import { renderInlineMarkdown } from '../lib/markdown.js';
import { senderTextClass } from '../lib/theme.js';

/** 5 minutes — matches Slack's default "merge into a group" threshold. */
const GROUP_WINDOW_MS = 5 * 60 * 1000;

export interface MessageLineProps {
  message: Message;
  viewer: string;
  /**
   * The message rendered just before this one in the same thread,
   * if any. When omitted the row always renders as a header — that's
   * the right default for the first message of any thread, and it
   * keeps the component usable outside a sequential transcript
   * (e.g. single-message previews).
   */
  previousMessage?: Message;
}

function formatTs(ts: number): string {
  const d = new Date(ts);
  const hh = d.getHours().toString().padStart(2, '0');
  const mm = d.getMinutes().toString().padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * Should `msg` render as a continuation of `prev`, sharing its
 * header? Pure predicate — no rendering side effects.
 */
export function isContinuationOf(msg: Message, prev: Message): boolean {
  if (prev.from !== msg.from) return false;
  if (prev.from === null || msg.from === null) return false;
  if (prev.level !== msg.level) return false;
  if (prev.title !== null || msg.title !== null) return false;
  if (msg.ts - prev.ts > GROUP_WINDOW_MS) return false;
  // Backwards-in-time gap (e.g. out-of-order SSE reconnect backfill):
  // treat as distinct so the "grouped by time" intuition doesn't fib.
  if (msg.ts < prev.ts) return false;
  return true;
}

export function MessageLine({ message, viewer, previousMessage }: MessageLineProps) {
  const sender = message.from ?? '?';
  const colorClass = senderTextClass(sender, viewer);
  const body = renderInlineMarkdown(message.body);

  const isContinuation =
    previousMessage !== undefined && isContinuationOf(message, previousMessage);

  // Two-column row: a fixed timestamp gutter on the left and the
  // message column on the right. Putting the body in its own flex
  // child means long messages wrap *within* that column instead of
  // flowing back to the container's left edge, so second-line text
  // naturally aligns with the first line. Continuation and header
  // rows use the exact same gutter width so timestamps line up
  // vertically across a burst.
  //
  // `max-w-[72ch]` on the body column caps line length at roughly
  // the 65–75ch readability sweet spot. The gutter sits outside that
  // cap, so the full row can still be wider than 72ch on desktop.
  //
  // `min-w-0` on the body column is the flex-child "don't let long
  // tokens blow out the parent" trick — without it, a very long
  // unbroken URL or codeblock pushes the gutter off-screen.
  if (isContinuation) {
    // Continuation: timestamp in the gutter, sender suppressed, body
    // occupies the message column.
    return (
      <div class="flex gap-2 py-0.5 leading-snug text-sm">
        <span class="text-brand-muted text-xs font-mono flex-shrink-0 mt-[3px]">
          {formatTs(message.ts)}
        </span>
        <div class="flex-1 min-w-0 max-w-[72ch] text-brand-text break-words">
          <span dangerouslySetInnerHTML={{ __html: body }} />
        </div>
      </div>
    );
  }

  // Header row. `mt-2` adds breathing room between groups — only
  // when there IS a previous message (the first message in a thread
  // shouldn't get a top margin and push away from the top of the
  // transcript container).
  const marginClass = previousMessage !== undefined ? 'mt-2' : '';
  return (
    <div class={`flex gap-2 py-0.5 leading-snug text-sm ${marginClass}`}>
      <span class="text-brand-muted text-xs font-mono flex-shrink-0 mt-[3px]">
        {formatTs(message.ts)}
      </span>
      <div class="flex-1 min-w-0 max-w-[72ch] text-brand-text break-words">
        <span class={`${colorClass} font-semibold mr-2`}>{sender}</span>
        {message.title && <span class="text-brand-muted mr-2">[{message.title}]</span>}
        <span dangerouslySetInnerHTML={{ __html: body }} />
      </div>
    </div>
  );
}
