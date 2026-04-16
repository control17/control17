# @control17/web

Preact+Vite+UnoCSS web UI for [control17](https://github.com/control17/control17). Built as a PWA with Web Push support; served by `@control17/server` as static assets.

## What it does

A browser surface for the human-plane of control17:

- **TOTP login** — callsign + 6-digit code, no passwords
- **Team channel + DM threads** — real-time SSE, auto-follow sticky scroll
- **Roster panel** — teammate list with online/offline state
- **Composer** — enter-to-send, inline markdown (`**bold**`, `*italic*`, `` `code` ``)
- **Web Push** — opt-in from the header; DMs always notify, broadcasts on `level >= warning` or `@mention`
- **PWA** — installable, offline shell cache, auto-updating service worker

The SPA mounts at `/` and uses same-origin cookies to authenticate against the broker's API. All routing is signal-driven — no URL router dependency.

## Install

This package is not installed directly. It ships inside `@control17/server`, which serves the built bundle from `public/` at `/`.

## Dev

```bash
# Terminal 1 — broker on :8717
cd apps/server && node dist/index.js

# Terminal 2 — Vite dev server on :5173 with API proxy
cd packages/web && pnpm dev
```

Open <http://localhost:5173/>. Vite proxies every API path (`/briefing`, `/roster`, `/push`, `/subscribe`, `/history`, `/session/*`, `/push/*`) through to the Hono broker on `:8717`, so cookies, SSE, and push all work through the proxy.

Production builds output directly into `apps/server/public/` so the next `c17-server` build picks up the new bundle without a copy step.

```bash
pnpm --filter @control17/web build
```

## Tech notes

- **Preact 10** + `@preact/signals` — automatic fine-grained reactivity with no hooks required. Reading `signal.value` inside a component's render body subscribes it to changes.
- **UnoCSS** with `presetWind4` — Tailwind-identical class names with a much smaller output CSS footprint.
- **`vite-plugin-pwa` in `injectManifest` mode** — we own `src/sw.ts` so we can write custom push event handlers. `generateSW` mode is a trap here.
- **Native `EventSource`** — no `fetch-event-source` polyfill because the HTTP/2 listener removes the 6-connection-per-origin cap that forced the workaround in many SPAs.
- **VAPID public key fetched at runtime** via `GET /push/vapid-public-key` — the key isn't baked into the build, so the same bundle works on any self-hosted deployment without a rebuild.

## Structure

```
packages/web/
├── index.html              # root shell
├── scripts/generate-icons.mjs  # zero-dep PNG generator for PWA icons
├── src/
│   ├── main.tsx            # render + SW registration
│   ├── App.tsx             # auth gate: Boot → Login → Shell
│   ├── sw.ts               # service worker (push + precache + updates)
│   ├── lib/
│   │   ├── client.ts       # @control17/sdk Client singleton
│   │   ├── session.ts      # session signal + loginWithTotp/logout/bootstrap
│   │   ├── briefing.ts     # briefing signal
│   │   ├── roster.ts       # roster signal + polling
│   │   ├── messages.ts     # transcript state, threadKeyOf, appendMessages
│   │   ├── sse.ts          # EventSource wrapper + reconnect backfill
│   │   ├── view.ts         # view signal (thread/overview/objectives/agent)
│   │   ├── push.ts         # Web Push enable/disable + state signal
│   │   ├── markdown.ts     # inline bold/italic/code renderer
│   │   └── theme.ts        # sender color hashing
│   ├── routes/
│   │   ├── Boot.tsx        # loading placeholder
│   │   ├── Login.tsx       # TOTP form
│   │   └── Shell.tsx       # authenticated layout + mount effects
│   └── components/
│       ├── Header.tsx
│       ├── Sidebar.tsx
│       ├── Transcript.tsx
│       ├── MessageLine.tsx
│       ├── Composer.tsx
│       ├── RosterPanel.tsx
│       └── NotificationToggle.tsx
├── public/icons/           # PWA icons (solid-fill, generated)
└── turbo.json              # declares out-of-tree build output for turbo cache
```

## License

Apache 2.0. See the [control17 monorepo](https://github.com/control17/control17) for the full source.
