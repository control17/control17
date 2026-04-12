/**
 * Pre-renders messages to terminal lines (ANSI strings).
 *
 * Instead of rendering messages as React components and fighting Ink's
 * flexbox for scrolling, we pre-render to a flat `string[]` of terminal
 * lines. The component slices this array for the visible window —
 * line-level scrolling that never orphans message groups.
 *
 * Each line is a self-contained ANSI string safe for `<Text>{line}</Text>`.
 */

import type { Message } from '@control17/sdk/types';
import chalk, { type ChalkInstance } from 'chalk';
import wrapAnsi from 'wrap-ansi';
import { colorForSender, formatTime, sameTimeWindow } from './theme.js';

const BAR = '│';
const INDENT = '       '; // 7 chars: aligns with "HH:MM  "

/** Map color names to hex values for chalk. */
const COLOR_HEX: Record<string, string> = {
  cyan: '#00AFAF',
  yellow: '#D7AF00',
  magenta: '#AF5FAF',
  blue: '#5F87D7',
};

function chalkForColor(color: string): ChalkInstance {
  if (color.startsWith('#')) return chalk.hex(color);
  return chalk.hex(COLOR_HEX[color] ?? color);
}

/**
 * Render all messages to terminal lines. Returns a flat array of ANSI
 * strings, one per terminal line. Handles wrapping, grouping, and
 * markdown formatting.
 */
export function renderToLines(messages: Message[], viewer: string, width: number): string[] {
  const lines: string[] = [];
  let prevSender: string | null = null;
  let prevTs = 0;
  const bodyWidth = Math.max(20, width - INDENT.length - 2); // -2 for "│ "

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    const sender = msg.from ?? '?';
    const color = colorForSender(sender, viewer);
    const cc = chalkForColor(color);
    const sameSender = sender === prevSender && sameTimeWindow(msg.ts, prevTs);

    if (!sameSender) {
      if (i > 0) lines.push('');
      const header = `${chalk.dim(formatTime(msg.ts))}  ${cc.bold(sender.toUpperCase())}`;
      lines.push(header);
    }

    const formatted = formatMarkdown(msg.body);
    const wrapped = wrapAnsi(formatted, bodyWidth, { hard: true, trim: false });
    for (const bodyLine of wrapped.split('\n')) {
      lines.push(`${INDENT + cc(BAR)} ${bodyLine}`);
    }

    prevSender = sender;
    prevTs = msg.ts;
  }

  return lines;
}

/**
 * Minimal markdown formatter for chat messages.
 * Handles: **bold**, *italic*, `inline code`, and fenced code blocks.
 */
function formatMarkdown(text: string): string {
  // Fenced code blocks: ```lang\n...\n```
  let result = text.replace(/```(?:\w*)\n([\s\S]*?)```/g, (_match, code: string) => {
    const trimmed = code.replace(/\n$/, '');
    return trimmed
      .split('\n')
      .map((line) => chalk.dim(`  ${line}`))
      .join('\n');
  });

  // Inline code: `code`
  result = result.replace(/`([^`]+)`/g, (_match, code: string) => chalk.dim.inverse(` ${code} `));

  // Bold: **text** or __text__
  result = result.replace(/\*\*(.+?)\*\*/g, (_match, t: string) => chalk.bold(t));
  result = result.replace(/__(.+?)__/g, (_match, t: string) => chalk.bold(t));

  // Italic: *text* or _text_
  result = result.replace(/(?<!\w)\*(?!\s)(.+?)(?<!\s)\*(?!\w)/g, (_match, t: string) =>
    chalk.italic(t),
  );
  result = result.replace(/(?<!\w)_(?!\s)(.+?)(?<!\s)_(?!\w)/g, (_match, t: string) =>
    chalk.italic(t),
  );

  return result;
}
