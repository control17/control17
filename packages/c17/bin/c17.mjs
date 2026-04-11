#!/usr/bin/env node
// Thin re-entry to @control17/cli so the bin gets linked on
// `npm install -g @control17/c17`. npm only links bins declared on the
// top-level package being installed, not on its transitive deps, so a
// meta-package without its own `bin` entries wouldn't expose anything.
await import('@control17/cli');
