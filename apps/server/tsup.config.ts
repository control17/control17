import { defineConfig } from 'tsup';

export default defineConfig([
  // Library entry (consumed by @control17/cli, etc.)
  {
    name: 'lib',
    entry: { run: 'src/run.ts' },
    format: ['esm'],
    dts: true,
    sourcemap: true,
    clean: true,
    target: 'node22',
    external: ['better-sqlite3'],
  },
  // Bin entry (consumed by `c17-server`)
  {
    name: 'bin',
    entry: { index: 'src/index.ts' },
    format: ['esm'],
    dts: false,
    sourcemap: true,
    clean: false,
    target: 'node22',
    banner: { js: '#!/usr/bin/env node' },
    external: ['better-sqlite3'],
  },
]);
