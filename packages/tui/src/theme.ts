/**
 * Visual design tokens for the control17 TUI.
 *
 * Strict palette — military display aesthetic. Constrained to 4 sender
 * colors + primary green + chrome gray. No neon, no rainbow.
 */

/** Muted military green — primary accent for the entire UI. */
export const PRIMARY = '#5f875f';

/** Sender color palette — self is always PRIMARY; others rotate through these. */
const SENDER_COLORS = ['cyan', 'yellow', 'magenta', 'blue'] as const;

/** Deterministic color for a sender name. Self always gets PRIMARY. */
export function colorForSender(name: string, viewer: string): string {
  if (name === viewer) return PRIMARY;
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return SENDER_COLORS[Math.abs(hash) % SENDER_COLORS.length]!;
}

/** Format a unix-ms timestamp as HH:MM. */
export function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** True if two timestamps are within 2 minutes (message grouping window). */
export function sameTimeWindow(a: number, b: number): boolean {
  return Math.abs(a - b) < 120_000;
}
