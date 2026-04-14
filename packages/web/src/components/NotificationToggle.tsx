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
          class="text-xs text-brand-muted"
          title="Add control17 to your home screen to enable notifications on iOS"
        >
          install to enable ◈
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
        class="text-xs text-brand-muted"
        title="Notifications are blocked in your browser settings"
      >
        notifications blocked
      </span>
    );
  }
  if (state.kind === 'subscribing') {
    return <span class="text-xs text-brand-muted">…</span>;
  }
  if (state.kind === 'subscribed') {
    return (
      <button
        type="button"
        onClick={() => {
          void disablePush();
        }}
        class="text-xs text-brand-primary hover:text-brand-text"
        title="Click to disable notifications for this device"
      >
        ◈ notifications on
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
        class="text-xs text-red-400 hover:text-brand-text"
        title={state.message}
      >
        notifications: {state.message.slice(0, 30)}
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
      class="text-xs text-brand-muted hover:text-brand-text"
    >
      enable notifications
    </button>
  );
}
