/**
 * Composer — textarea + send button at the bottom of the shell.
 *
 * Enter sends (without shift), Shift+Enter inserts a newline. Sends
 * route to /push with `agentId` derived from the current view:
 *   - primary thread → agentId omitted (broadcast)
 *   - dm:<other>     → agentId: other
 *   - dm:self        → agentId: viewer (self-DM)
 *
 * On the server `/push` stamps the authoritative `from` and fans out
 * to subscribers; our own SSE stream receives the echo and appends
 * it to the transcript, so we don't optimistic-append here.
 */

import { signal } from '@preact/signals';
import type { JSX } from 'preact';
import { getClient } from '../lib/client.js';
import { PRIMARY_THREAD } from '../lib/messages.js';
import { currentView } from '../lib/view.js';

const draft = signal('');
const sending = signal(false);
const sendError = signal<string | null>(null);

function targetAgentIdFor(key: string, viewer: string): string | undefined {
  if (key === PRIMARY_THREAD) return undefined;
  if (key === 'dm:self') return viewer;
  if (key.startsWith('dm:')) return key.slice(3);
  return undefined;
}

export interface ComposerProps {
  viewer: string;
}

export function Composer({ viewer }: ComposerProps) {
  const view = currentView.value;
  if (view.kind !== 'thread') return null;

  const threadKey = view.key;

  const send = async () => {
    const body = draft.value.trim();
    if (!body || sending.value) return;
    sending.value = true;
    sendError.value = null;
    try {
      const agentId = targetAgentIdFor(threadKey, viewer);
      await getClient().push({ body, ...(agentId !== undefined ? { agentId } : {}) });
      draft.value = '';
    } catch (err) {
      sendError.value = err instanceof Error ? err.message : 'send failed';
    } finally {
      sending.value = false;
    }
  };

  const onKeyDown = (event: JSX.TargetedKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  };

  const onInput = (event: JSX.TargetedInputEvent<HTMLTextAreaElement>) => {
    draft.value = event.currentTarget.value;
  };

  return (
    <div class="border-t border-brand-border bg-brand-surface px-3 sm:px-4 py-2 flex-shrink-0">
      {sendError.value && <div class="text-xs text-red-400 mb-1">{sendError.value}</div>}
      <div class="flex items-end gap-2">
        <textarea
          rows={2}
          value={draft.value}
          onInput={onInput}
          onKeyDown={onKeyDown}
          placeholder={
            threadKey === PRIMARY_THREAD
              ? 'broadcast to #team — enter to send, shift+enter for newline'
              : `message ${threadKey.slice(3)} — enter to send`
          }
          /*
           * `text-base` (16px) on mobile is load-bearing: iOS Safari
           * auto-zooms the viewport on focus for any input <16px.
           * Drop to `text-sm` (14px) at sm+ where the mouse-driven
           * layout prefers the denser type.
           */
          class="flex-1 resize-none bg-brand-bg border border-brand-border rounded px-2 py-1.5 text-base sm:text-sm text-brand-text font-mono focus:outline-none focus:border-brand-primary"
        />
        <button
          type="button"
          onClick={() => void send()}
          disabled={sending.value || draft.value.trim().length === 0}
          class="px-3 py-2 sm:py-1.5 text-xs rounded bg-brand-primary text-brand-bg font-semibold disabled:opacity-40 disabled:cursor-not-allowed hover:brightness-110 flex-shrink-0"
        >
          {sending.value ? '…' : 'send'}
        </button>
      </div>
    </div>
  );
}

export function __resetComposerForTests(): void {
  draft.value = '';
  sending.value = false;
  sendError.value = null;
}
