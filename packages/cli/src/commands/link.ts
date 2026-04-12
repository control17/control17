/**
 * `c17 link` — run the stdio MCP channel link.
 *
 * Thin launcher that dynamically imports `@control17/link` at runtime.
 * The link package is an optional peer of `@control17/cli` so users
 * who only run `c17 push` / `c17 agents` don't drag in the MCP SDK.
 *
 * This subcommand is equivalent to invoking the `c17-link` binary
 * directly — both routes land in the same `@control17/link` entry
 * point. Configure it via the standard link env vars:
 *   C17_URL, C17_TOKEN, C17_AGENT_ID
 *
 * Typical usage is from a Claude Code `.mcp.json`:
 *
 *   {
 *     "mcpServers": {
 *       "c17": {
 *         "command": "c17",
 *         "args": ["link"],
 *         "env": { "C17_URL": "...", "C17_TOKEN": "...", "C17_AGENT_ID": "..." }
 *       }
 *     }
 *   }
 */

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export async function runLinkCommand(): Promise<void> {
  try {
    // Importing the package kicks off its top-level `main()` call, which
    // installs the stdio transport and starts the forwarder loop. The
    // promise resolves once setup is synchronous; the process stays
    // alive because the event loop is held open by stdin + timers.
    await import('@control17/link');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
      throw new UsageError(
        'link: @control17/link is not installed.\n' +
          '  This command needs the link package. Install it alongside the CLI:\n' +
          '    npm install -g @control17/link\n' +
          '  Or install the full ecosystem in one step:\n' +
          '    npm install -g @control17/c17',
      );
    }
    throw err;
  }
}
