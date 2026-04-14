/**
 * `c17 link` — run the stdio MCP channel link.
 *
 * Thin launcher that dynamically imports `@control17/link` at runtime
 * and calls its named `runLink()` entry point. The link package is an
 * optional peer of `@control17/cli` so users who only run `c17 push` /
 * `c17 roster` don't drag in the MCP SDK.
 *
 * This subcommand is equivalent to invoking the `c17-link` binary
 * directly — both routes end up calling `runLink()`. Configure it via
 * the standard link env vars: `C17_URL`, `C17_TOKEN`. The link derives
 * its callsign from the broker's `/briefing` response — there is no
 * separate agent-id env var.
 *
 * Typical usage is from a Claude Code `.mcp.json`:
 *
 *   {
 *     "mcpServers": {
 *       "c17": {
 *         "command": "c17",
 *         "args": ["link"],
 *         "env": { "C17_URL": "...", "C17_TOKEN": "..." }
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
  let linkModule: typeof import('@control17/link');
  try {
    linkModule = await import('@control17/link');
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

  // Call the named entry point. This awaits through startup (briefing
  // fetch, MCP handshake) and returns once the background forwarder is
  // launched; process stays alive via stdin + the forwarder loop.
  //
  // TypeScript's `instanceof` narrowing doesn't flow through the
  // destructured `LinkStartupError` binding cleanly when the module
  // comes from a dynamic `import()` (the binding is typed as `typeof
  // LinkStartupError` but control flow analysis still leaves `err`
  // at `unknown`). Cast to `Error` after the runtime check — which
  // is sound because LinkStartupError extends Error.
  const { LinkStartupError } = linkModule;
  try {
    await linkModule.runLink();
  } catch (err) {
    if (err instanceof LinkStartupError) {
      throw new UsageError(`link: ${(err as Error).message}`);
    }
    throw err;
  }
}
