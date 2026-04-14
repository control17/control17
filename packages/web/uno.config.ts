/**
 * UnoCSS config — `presetWind4` gives us Tailwind-identical class
 * names so the mental model matches 90% of web tutorials, without
 * Tailwind's fixed ~30KB CSS floor. For a ~3-view app the generated
 * stylesheet lands well under 10KB.
 *
 * Custom theme tokens mirror the existing TUI colors so desktop and
 * terminal surfaces feel like the same product.
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
  // Safelist the sender color tokens. They're referenced via a
  // ternary inside `src/lib/theme.ts` and the default extractor
  // sometimes misses them after tsc narrowing — pinning them here
  // guarantees both tokens ship in every build.
  safelist: ['text-brand-primary', 'text-brand-coyote'],
  theme: {
    colors: {
      // Matches packages/tui/src/theme.ts PRIMARY (#5f875f).
      brand: {
        primary: '#5f875f',
        bg: '#0b0d0c',
        surface: '#14171a',
        border: '#2a2f35',
        text: '#e8e8e8',
        muted: '#8a8f97',
        // Coyote tan — used for teammate callsigns in chat. Warm
        // earthy foil to the cool primary so you can tell "me" from
        // "them" at a glance without leaning on cyan/yellow noise.
        coyote: '#c19a6b',
      },
    },
  },
});
