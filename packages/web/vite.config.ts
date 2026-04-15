/**
 * Vite config for @control17/web.
 *
 * Build output lands directly in `apps/server/public/` so Hono's
 * static-file middleware can serve it without a copy step. Dev mode
 * proxies every control17 HTTP API path to the server running on
 * `:8717`, so `pnpm dev` at the root gives you:
 *
 *   - Vite dev server on :5173 (hot reload, fast refresh)
 *   - Hono server on :8717 (broker API)
 *   - Full local loop with cookies and SSE working through the proxy
 *
 * PWA (Phase 6): `vite-plugin-pwa` in `injectManifest` mode. The SW
 * source lives at `src/sw.ts` — we write our own handlers (push,
 * notificationclick, etc in Phase 7) and the plugin only injects the
 * precache manifest into it. `generateSW` mode is a trap here
 * because it doesn't let us add push event handlers.
 */

import { resolve } from 'node:path';
import preact from '@preact/preset-vite';
import unocss from 'unocss/vite';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// control17 API paths that dev mode must proxy through to the real
// server. Kept in sync with PATHS in packages/sdk/src/protocol.ts
// and the /session/* + /push/* routes added in later phases. Port
// matches `DEFAULT_PORT` (8717) from the SDK and the server's CLI
// default so `pnpm dev` at the root "just works" with no env vars.
const PROXY_TARGET = 'http://127.0.0.1:8717';
const PROXIED_PATHS = [
  '/healthz',
  '/briefing',
  '/roster',
  '/push',
  '/subscribe',
  '/history',
  '/session',
  '/objectives',
];

export default defineConfig({
  plugins: [
    preact(),
    unocss(),
    VitePWA({
      // `injectManifest` = we own the service worker; the plugin just
      // stamps the precache list into `self.__WB_MANIFEST`. Required
      // for Web Push support (generateSW can't host custom `push`
      // event handlers cleanly).
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'autoUpdate',
      // Disable the plugin's dev-mode service worker so tests and the
      // dev server don't try to register a half-baked SW against the
      // Vite HMR socket. In prod builds the real SW ships.
      devOptions: {
        enabled: false,
      },
      injectManifest: {
        // Default glob picks up JS/CSS/HTML/assets. Include the
        // manifest icons too so the shell works fully offline.
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'],
      },
      includeAssets: ['icons/icon-192.png', 'icons/icon-512.png'],
      manifest: {
        name: 'control17',
        short_name: 'c17',
        description: 'Self-hosted agent team control plane.',
        theme_color: '#5f875f',
        background_color: '#0b0d0c',
        display: 'standalone',
        orientation: 'any',
        start_url: '/',
        scope: '/',
        icons: [
          {
            src: 'icons/icon-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any maskable',
          },
          {
            src: 'icons/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable',
          },
        ],
      },
    }),
  ],
  // Output into the server's static dir. `emptyOutDir: true` makes
  // `vite build` idempotent across rebuilds — stale hashed assets
  // from prior builds get cleaned up instead of piling up.
  build: {
    outDir: resolve(__dirname, '../../apps/server/public'),
    emptyOutDir: true,
    sourcemap: true,
    target: 'es2022',
  },
  server: {
    port: 5173,
    // Proxy every known API path through to the Hono server. SSE
    // proxying works out of the box in Vite 5+ — no ws:true needed
    // for text/event-stream. `/subscribe` is long-lived; Vite keeps
    // the upstream socket open for the full stream.
    proxy: Object.fromEntries(
      PROXIED_PATHS.map((p) => [
        p,
        {
          target: PROXY_TARGET,
          changeOrigin: false,
          // Session cookies are set with SameSite=Strict, so we need
          // to preserve the host; `changeOrigin: false` ensures the
          // Origin header reaches Hono unchanged.
          ws: false,
        },
      ]),
    ),
  },
});
