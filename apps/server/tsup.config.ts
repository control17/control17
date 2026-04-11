import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const pkg = JSON.parse(readFileSync('./package.json', 'utf8')) as { version: string };
const define = { __PKG_VERSION__: JSON.stringify(pkg.version) };

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
    define,
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
    define,
  },
]);
