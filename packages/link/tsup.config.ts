import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const pkg = JSON.parse(readFileSync('./package.json', 'utf8')) as { version: string };

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: false,
  sourcemap: true,
  clean: true,
  target: 'node22',
  banner: { js: '#!/usr/bin/env node' },
  define: {
    __PKG_VERSION__: JSON.stringify(pkg.version),
  },
});
