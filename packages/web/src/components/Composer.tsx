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
    <div class="border-t border-brand-border-subtle bg-brand-surface px-3 sm:px-4 py-3 flex-shrink-0">
      {sendError.value && <div class="c17-label !text-brand-err mb-2">◆ {sendError.value}</div>}
      <div class="flex items-end gap-2">
        <textarea
          rows={2}
          value={draft.value}
          onInput={onInput}
          onKeyDown={onKeyDown}
          placeholder={
            threadKey === PRIMARY_THREAD
              ? 'Broadcast to #team — enter to send, shift+enter for newline'
              : `Message ${threadKey.slice(3)} — enter to send`
          }
          /*
           * `text-base` (16px) on mobile is load-bearing: iOS Safari
           * auto-zooms the viewport on focus for any input <16px.
           * Drop to `text-sm` (14px) at sm+ where the mouse-driven
           * layout prefers the denser type.
           */
          class="c17-input flex-1 resize-none text-base sm:text-sm !py-2"
        />
        <button
          type="button"
          onClick={() => void send()}
          disabled={sending.value || draft.value.trim().length === 0}
          class="c17-btn-sm-primary flex-shrink-0"
        >
          {sending.value ? '…' : 'Send →'}
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
