/**
 * `c17 connect` — interactive terminal UI for the control17 net.
 *
 * `@control17/tui` is an optional peer dep of the CLI so that users
 * who only need push/roster don't drag in Ink, React, and their tree.
 * When the user invokes `c17 connect`, we dynamically import the TUI
 * module; if it isn't installed, we exit with a friendly hint.
 */

import type { BriefingResponse } from '@control17/sdk/types';
import type { ConnectUIOptions } from '@control17/tui';

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export interface ConnectCommandInput {
  url: string;
  token: string;
}

export async function runConnectCommand(input: ConnectCommandInput): Promise<void> {
  const { Client } = await import('@control17/sdk/client');
  const client = new Client({ url: input.url, token: input.token });

  let briefing: BriefingResponse;
  try {
    briefing = await client.briefing();
  } catch (err) {
    throw new UsageError(
      `connect: failed to fetch briefing from ${input.url}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const tui = await loadTuiModule();
  const options: ConnectUIOptions = { client, briefing };

  await tui.runConnectUI(options);
}

async function loadTuiModule(): Promise<typeof import('@control17/tui')> {
  try {
    return await import('@control17/tui');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
      throw new UsageError(
        'connect: @control17/tui is not installed.\n' +
          '  This command needs the TUI package. Install it alongside the CLI:\n' +
          '    npm install -g @control17/tui\n' +
          '  Or install the full ecosystem in one step:\n' +
          '    npm install -g @control17/c17',
      );
    }
    throw err;
  }
}
