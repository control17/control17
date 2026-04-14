import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const pkg = JSON.parse(readFileSync('./package.json', 'utf8')) as { version: string };
const define = { __PKG_VERSION__: JSON.stringify(pkg.version) };

// Dual-entry build mirroring @control17/server:
// - `dist/run.js` is the library entry, imported by the CLI's `c17 link`
//   subcommand via a named call. No top-level side effects — `runLink()`
//   runs only when called.
// - `dist/index.js` is the bin entry. It imports `runLink()` and invokes
//   it, so `c17-link` on the PATH still works as a one-shot command.
export default defineConfig([
  {
    name: 'lib',
    entry: { run: 'src/run.ts' },
    format: ['esm'],
    dts: true,
    sourcemap: true,
    clean: true,
    target: 'node22',
    define,
  },
  {
    name: 'bin',
    entry: { index: 'src/index.ts' },
    format: ['esm'],
    dts: false,
    sourcemap: true,
    clean: false,
    target: 'node22',
    banner: { js: '#!/usr/bin/env node' },
    define,
  },
]);
