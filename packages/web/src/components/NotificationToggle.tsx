/**
 * Notification toggle — a small button that enables/disables Web Push
 * for the current device.
 *
 * Rendered in the Header next to the sign-out button. Reads the
 * `pushState` signal set up by `lib/push.ts` and renders one of:
 *
 *   - nothing (when unsupported in a way the header can't help with,
 *     to avoid cluttering the strip)
 *   - "enable notifications" button (idle)
 *   - "…" spinner placeholder (subscribing)
 *   - "notifications on" + disable link (subscribed)
 *   - "denied in browser settings" hint
 *   - "install to enable" hint (iOS not-yet-installed)
 *
 * Click handlers call into `lib/push.ts` which manages the whole
 * subscribe/unsubscribe pipeline and updates the signal.
 */

import { disablePush, enablePush, pushState } from '../lib/push.js';

export function NotificationToggle() {
  const state = pushState.value;

  if (state.kind === 'unsupported') {
    if (state.reason === 'ios-needs-install') {
      return (
        <span
          class="c17-status-badge text-brand-subtle"
          title="Add control17 to your home screen to enable notifications on iOS"
        >
          ◈ Install to enable
        </span>
      );
    }
    // Other unsupported reasons mean the browser genuinely can't do
    // Web Push. Don't clutter the header for those.
    return null;
  }
  if (state.kind === 'denied') {
    return (
      <span
        class="c17-status-badge text-brand-subtle"
        title="Notifications are blocked in your browser settings"
      >
        ◇ Notifications blocked
      </span>
    );
  }
  if (state.kind === 'subscribing') {
    return <span class="c17-status-badge text-brand-subtle">…</span>;
  }
  if (state.kind === 'subscribed') {
    return (
      <button
        type="button"
        onClick={() => {
          void disablePush();
        }}
        class="c17-status-badge text-brand-ok hover:text-brand-primary-bright"
        title="Click to disable notifications for this device"
      >
        ● Notifications on
      </button>
    );
  }
  if (state.kind === 'error') {
    return (
      <button
        type="button"
        onClick={() => {
          void enablePush();
        }}
        class="c17-status-badge text-brand-err hover:text-brand-text"
        title={state.message}
      >
        ◆ Notifications: {state.message.slice(0, 30)}
      </button>
    );
  }
  // idle
  return (
    <button
      type="button"
      onClick={() => {
        void enablePush();
      }}
      class="c17-status-badge text-brand-subtle hover:text-brand-text"
    >
      ◇ Enable notifications
    </button>
  );
}
