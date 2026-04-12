/**
 * Ambient module declarations for optional peer deps that the CLI only
 * imports for side effects (`await import('...')`).
 *
 * `@control17/link` is a stdio MCP binary with no public TypeScript
 * exports; its package ships `dts: false` in tsup config, so TS can't
 * resolve types for it. We import it solely to kick off its top-level
 * `main()` inside `c17 link`, and we never touch its exports, so an
 * untyped ambient declaration is sufficient and honest.
 */

declare module '@control17/link';
