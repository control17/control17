#!/usr/bin/env node
// Thin re-entry to @control17/server's bin entry so the binary gets
// linked on `npm install -g @control17/c17`. Imports the bin subpath
// explicitly (the package's root export is the library entry).
await import('@control17/server/bin');
