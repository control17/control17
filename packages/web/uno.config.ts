/**
 * UnoCSS config — `presetWind4` gives us Tailwind-identical class
 * names so the mental model matches 90% of web tutorials, without
 * Tailwind's fixed ~30KB CSS floor. For a ~3-view app the generated
 * stylesheet lands well under 10KB.
 *
 * Brand theme mirrors the canonical design system at
 * `platform/docs/brand-guide.html`. Existing `brand-*` token names are
 * preserved (so every component that reads `text-brand-primary` or
 * `bg-brand-surface` keeps working), but the palette is extended with
 * a full mathematical tonal range (bright / dim / deep / faint for the
 * two hero colors) and a finer neutral ladder (subtle / raised / hover
 * / inset). Neutrals carry a faint OD-green undertone for cohesion
 * with the primary.
 *
 * Display face is Barlow Condensed — picked as "aircraft lettering,"
 * drawn from Californian public/transportation signage. Body stays
 * IBM Plex Mono — industrial mono with 6 weights and excellent
 * small-size legibility. Both loaded via Google Fonts in `brand.css`.
 *
 * Namespace note: the brand namespace is `brand-*`, NOT `c17-*`, even
 * though the project is "control17". presetWind4 normalises class names
 * by inserting a dash between any letter→digit boundary before walking
 * the theme tree, so `bg-c17-primary` is parsed as the path
 * `["c", "17", "primary"]` and never finds `colors.c17.primary`.
 * Using a digit-free namespace sidesteps the splitter entirely.
 */

import { defineConfig, presetWind4 } from 'unocss';

export default defineConfig({
  presets: [presetWind4()],

  // ─── Custom rules ──────────────────────────────────────────────
  // Font-family utilities are defined as rules rather than via
  // `theme.fontFamily` because presetWind4's Theme type doesn't
  // expose a fontFamily slot. Rules give us full control and both
  // typecheck and extract cleanly through the shortcut processor.
  rules: [
    [
      'font-display',
      {
        'font-family':
          "'Barlow Condensed', 'Oswald', 'Helvetica Neue Condensed', 'Arial Narrow', 'Roboto Condensed', sans-serif",
      },
    ],
    [
      'font-mono',
      {
        'font-family':
          "'IBM Plex Mono', ui-monospace, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace",
      },
    ],
  ],

  // Safelist the sender color tokens. They're referenced via a
  // ternary inside `src/lib/theme.ts` and the default extractor
  // sometimes misses them after tsc narrowing — pinning them here
  // guarantees both tokens ship in every build.
  safelist: [
    'text-brand-primary',
    'text-brand-primary-bright',
    'text-brand-coyote',
    'text-brand-coyote-bright',
    'text-brand-ok',
    'text-brand-warn',
    'text-brand-err',
    'font-display',
  ],
  theme: {
    colors: {
      brand: {
        // ─── Surfaces (near-black w/ faint OD-green undertone) ─────
        bg: '#0b0d0c',
        'bg-inset': '#070908',
        surface: '#141817',
        'surface-raised': '#1c2120',
        'surface-hover': '#232827',

        // ─── Borders (green-tinted grays) ──────────────────────────
        'border-subtle': '#1a1e1d',
        border: '#2a312f',
        'border-strong': '#3a423f',

        // ─── Foreground (slight warm shift from pure gray) ─────────
        text: '#e8ebe8',
        muted: '#9da299',
        subtle: '#6e736e',
        faint: '#444a47',

        // ─── Primary — olive drab (OSS anchor, full tonal range) ───
        // OSS-canonical base value preserved; variants derived as
        // HSL shifts so hover / active / disabled / wash states are
        // mathematical, not eyeballed.
        primary: '#5f875f',
        'primary-bright': '#7ba67b',
        'primary-dim': '#425d42',
        'primary-deep': '#2b3e2b',

        // ─── Secondary — coyote tan (OSS anchor, full tonal range) ──
        // Warm earthy foil to the cool primary so you can tell "me"
        // from "them" in chat without leaning on cyan/yellow noise.
        coyote: '#c19a6b',
        'coyote-bright': '#d5ae7e',
        'coyote-dim': '#8a6b4a',

        // ─── Semantic (derived from brand, not a rainbow) ──────────
        ok: '#5f875f', // alias primary — "operational / on net"
        warn: '#c19a6b', // alias coyote — "advisory / standby"
        err: '#a84a42', // muted warm red
        info: '#6b8691', // cool steel
      },
    },
  },

  shortcuts: {
    // ─── Brand utility shortcuts — composed from the brand theme.
    //     Keeps common patterns one token instead of a stack of utilities.
    'c17-eyebrow':
      'inline-flex items-center gap-2 font-display font-semibold uppercase tracking-widest text-sm text-brand-primary leading-none',
    'c17-label':
      'font-display font-semibold uppercase tracking-widest text-xs text-brand-subtle leading-tight',
    'c17-headline': 'font-display font-bold uppercase tracking-tight leading-none text-brand-text',
    'c17-status-badge':
      'inline-flex items-center gap-2 font-display font-semibold uppercase tracking-wider text-xs leading-none',
    // Button primitives — primary (filled) and ghost (outlined)
    'c17-btn':
      'inline-flex items-center justify-center gap-2 font-display font-semibold uppercase tracking-widest text-sm px-4 py-2 rounded-sm border transition-colors duration-100 ease-out',
    'c17-btn-primary':
      'c17-btn bg-brand-primary text-brand-bg border-brand-primary hover:bg-brand-primary-bright hover:border-brand-primary-bright disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-brand-primary disabled:hover:border-brand-primary',
    'c17-btn-ghost':
      'c17-btn bg-transparent text-brand-text border-brand-border-strong hover:bg-brand-surface-hover disabled:opacity-40 disabled:cursor-not-allowed',
    'c17-btn-danger':
      'c17-btn bg-transparent text-brand-err border-brand-err/60 hover:bg-brand-err/10 hover:border-brand-err disabled:opacity-40 disabled:cursor-not-allowed',
    'c17-btn-warn':
      'c17-btn bg-transparent text-brand-warn border-brand-warn/60 hover:bg-brand-warn/10 hover:border-brand-warn disabled:opacity-40 disabled:cursor-not-allowed',
    // Compact button — for panel actions and inline controls
    'c17-btn-sm':
      'inline-flex items-center justify-center gap-1 font-display font-semibold uppercase tracking-wider text-xs px-3 py-1.5 rounded-sm border transition-colors duration-100 ease-out leading-none',
    'c17-btn-sm-primary':
      'c17-btn-sm bg-brand-primary text-brand-bg border-brand-primary hover:bg-brand-primary-bright hover:border-brand-primary-bright disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-brand-primary disabled:hover:border-brand-primary',
    'c17-btn-sm-ghost':
      'c17-btn-sm bg-transparent text-brand-text border-brand-border-strong hover:bg-brand-surface-hover disabled:opacity-40 disabled:cursor-not-allowed',
    'c17-btn-sm-danger':
      'c17-btn-sm bg-transparent text-brand-err border-brand-err/60 hover:bg-brand-err/10 hover:border-brand-err disabled:opacity-40 disabled:cursor-not-allowed',
    'c17-btn-sm-warn':
      'c17-btn-sm bg-transparent text-brand-warn border-brand-warn/60 hover:bg-brand-warn/10 hover:border-brand-warn disabled:opacity-40 disabled:cursor-not-allowed',
    // Input primitive — bg-inset with OD-green focus ring
    'c17-input':
      'w-full bg-brand-bg-inset border border-brand-border rounded-sm px-3 py-2 text-brand-text font-mono font-medium focus:outline-none focus:border-brand-primary focus:ring-2 focus:ring-brand-primary/25 placeholder:text-brand-faint',
    // Panel heading — Barlow display, bigger than an eyebrow
    'c17-panel-title':
      'font-display font-bold uppercase tracking-tight text-lg text-brand-text leading-none',
  },
});
