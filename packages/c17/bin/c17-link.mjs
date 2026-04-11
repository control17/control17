#!/usr/bin/env node
// Thin re-entry to @control17/link so the bin gets linked on
// `npm install -g @control17/c17`. See c17.mjs for the rationale.
await import('@control17/link');
