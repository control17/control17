/**
 * Sender color — two-tone: the viewer's own callsign renders in the
 * brand primary (green), everyone else in coyote tan. Binary split
 * keeps the chat readable without rainbow noise and mirrors the way
 * the TUI distinguishes self from the team.
 */

export function senderTextClass(sender: string, viewer: string): string {
  return sender === viewer ? 'text-brand-primary' : 'text-brand-coyote';
}
