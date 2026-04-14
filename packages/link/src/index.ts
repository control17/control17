/**
 * `@control17/link` — bin entry for the stdio MCP channel link.
 *
 * Thin wrapper that invokes `runLink()` when this file is executed
 * directly via the `c17-link` binary or spawned by Claude Code from
 * `.mcp.json`. The real implementation lives in `src/run.ts` and is
 * what the `@control17/cli` `link` subcommand imports as a library
 * call — this file never runs in that path, so there is no
 * double-invocation risk.
 */

import { LinkStartupError, runLink } from './run.js';

runLink().catch((err) => {
  if (err instanceof LinkStartupError) {
    process.stderr.write(`link: ${err.message}\n`);
    process.exit(1);
  }
  process.stderr.write(
    `link: fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
