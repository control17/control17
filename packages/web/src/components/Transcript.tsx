/**
 * Transcript — scrolling message list for the current thread.
 *
 * Reads from the `messagesByThread` signal and the `currentView`
 * signal; both drive re-renders on change. Auto-scrolls to bottom
 * when a new message arrives AND the user is already near the bottom
 * — lets operators read history without being yanked back.
 */

import { useEffect, useRef } from 'preact/hooks';
import { dmOther, messagesByThread, PRIMARY_THREAD, threadMessages } from '../lib/messages.js';
import { currentView } from '../lib/view.js';
import { MessageLine } from './MessageLine.js';

const STICKY_BOTTOM_PX = 64;

export interface TranscriptProps {
  viewer: string;
}

export function Transcript({ viewer }: TranscriptProps) {
  // Subscribe to both signals by reading them in the render body.
  const view = currentView.value;
  const _map = messagesByThread.value;
  void _map;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const stickyRef = useRef(true);

  const threadKey = view.kind === 'thread' ? view.key : null;
  const messages = threadKey ? threadMessages(threadKey) : [];

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

  if (view.kind !== 'thread' || threadKey === null) return null;

  return (
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
