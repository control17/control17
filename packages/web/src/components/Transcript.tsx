/**
 * Transcript — scrolling message list for the current thread.
 *
 * Reads from the `messagesByThread` signal and the `view`
 * signal; both drive re-renders on change. Auto-scrolls to bottom
 * when a new message arrives AND the user is already near the bottom
 * — lets operators read history without being yanked back.
 */

import { useEffect, useRef } from 'preact/hooks';
import { briefing } from '../lib/briefing.js';
import { dmOther, messagesByThread, PRIMARY_THREAD, threadMessages } from '../lib/messages.js';
import { selectAgentDetail, view } from '../lib/view.js';
import { MessageLine } from './MessageLine.js';

const STICKY_BOTTOM_PX = 64;

export interface TranscriptProps {
  viewer: string;
}

export function Transcript({ viewer }: TranscriptProps) {
  // Subscribe to both signals by reading them in the render body.
  const v = view.value;
  const _map = messagesByThread.value;
  void _map;
  const b = briefing.value;
  const isCommander = b?.authority === 'commander';

  const containerRef = useRef<HTMLDivElement | null>(null);
  const stickyRef = useRef(true);

  const threadKey = v.kind === 'thread' ? v.key : null;
  const messages = threadKey ? threadMessages(threadKey) : [];
  const dmCounterpart = threadKey !== null ? dmOther(threadKey) : null;
  const showDmHeader =
    dmCounterpart !== null && dmCounterpart !== 'self' && dmCounterpart !== viewer;

  // Track whether the user is pinned to the bottom so we know whether
  // to auto-follow on new-message arrival.
  const onScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickyRef.current = gap < STICKY_BOTTOM_PX;
  };

  // Auto-scroll after render when sticky. Depends on messages.length
  // so a thread switch and a new message both trigger the effect.
  useEffect(() => {
    if (!stickyRef.current) return;
    const el = containerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length, threadKey]);

  if (v.kind !== 'thread' || threadKey === null) return null;

  return (
    <div class="flex-1 flex flex-col min-h-0">
      {/* DM header — only for direct-message threads with another
          slot (not primary, not obj:<id>, not self). Shows the
          counterpart callsign and, for commanders, a link to that
          agent's detail page. */}
      {showDmHeader && dmCounterpart && (
        <div class="flex items-center justify-between border-b border-brand-border-subtle px-3 sm:px-5 py-2 bg-brand-surface/40">
          <div class="c17-label text-brand-subtle">
            ━━ DM with <span class="text-brand-primary-bright font-semibold">{dmCounterpart}</span>
          </div>
          {isCommander && (
            <button
              type="button"
              onClick={() => selectAgentDetail(dmCounterpart)}
              class="c17-label text-brand-subtle hover:text-brand-primary-bright"
            >
              → VIEW AGENT
            </button>
          )}
        </div>
      )}
      <div
        ref={containerRef}
        onScroll={onScroll}
        class="flex-1 overflow-y-auto px-3 sm:px-5 py-4 space-y-0.5 bg-brand-bg"
      >
        {messages.length === 0 ? (
          <EmptyState threadKey={threadKey} />
        ) : (
          messages.map((m, i) => (
            <MessageLine
              key={m.id}
              message={m}
              viewer={viewer}
              {...(i > 0 && messages[i - 1] ? { previousMessage: messages[i - 1] } : {})}
            />
          ))
        )}
      </div>
    </div>
  );
}

/**
 * Empty-state copy varies by thread type so new users aren't left
 * staring at "net is quiet" on a DM they just opened and wondering
 * if the app is broken.
 */
function EmptyState({ threadKey }: { threadKey: string }) {
  if (threadKey === PRIMARY_THREAD) {
    return <div class="c17-label text-brand-subtle text-center py-10">◇ Net is quiet</div>;
  }
  const other = dmOther(threadKey);
  if (other !== null && other !== 'self') {
    return (
      <div class="c17-label text-brand-subtle text-center py-10">
        ◇ No messages yet with <span class="text-brand-primary-bright">@{other}</span> — send one
        below to start
      </div>
    );
  }
  return <div class="c17-label text-brand-subtle text-center py-10">◇ No messages yet</div>;
}
