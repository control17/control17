# @control17/server

Self-hostable Node broker for [control17](https://github.com/control17/control17), an MCP-based agent team control plane.

Wraps [`@control17/core`](https://www.npmjs.com/package/@control17/core) in a Hono HTTP/2 app with two auth planes that both resolve to the same slot identity:

- **Machine plane** — `Authorization: Bearer <token>` for the operator's `c17 claude-code` runner subprocess. Tokens are backed by SHA-256 hashes in the squadron config file.
- **Human plane** — `c17_session` cookie minted after a TOTP login, used by the built-in Preact web UI (`@control17/web`) that this package serves out of its `public/` dir.

Both planes resolve to the same slot. Authority (`commander | lieutenant | operator`) is checked server-side on every mutating endpoint.

One server = one squadron. Exposes:

### Chat + identity
- `GET /healthz` — liveness probe (no auth)
- `GET /briefing` — callsign, role, authority, squadron, teammates, open objectives, and composed instructions for the authenticated slot
- `GET /roster` — full slot list plus runtime connection state
- `POST /push` — deliver a message to one teammate (DM) or broadcast
- `GET /subscribe?agentId=…` — long-lived SSE stream; the `agentId` must equal the caller's callsign
- `GET /history?with=…&limit=…&before=…` — query message log scoped to the authenticated caller

### Objectives
- `GET /objectives` — list with optional `assignee` + `status` filters; operators can only see their own
- `POST /objectives` — create and atomically assign (lieutenant+ only)
- `GET /objectives/:id` — fetch one + full event history; gated by thread membership
- `PATCH /objectives/:id` — update status (`active ↔ blocked`) and/or block reason (assignee or commander)
- `POST /objectives/:id/complete` — mark done with required result (assignee only)
- `POST /objectives/:id/cancel` — terminally cancel (originating lieutenant or commander)
- `POST /objectives/:id/reassign` — reassign to a different slot (commander only)
- `POST /objectives/:id/watchers` — add/remove watchers (commander or originating lieutenant)
- `POST /objectives/:id/discuss` — post to the `obj:<id>` thread (thread members only)

### Captured LLM traces
- `POST /objectives/:id/traces` — upload a decoded trace for an objective (**current assignee only**)
- `GET /objectives/:id/traces` — list captured traces for review (**commander only**)

### Session (human plane)
- `POST /session/totp` — exchange `{slot, code}` for a session cookie
- `POST /session/logout` — clear the server-side session row
- `GET /session` — return the current session's slot/role/expiry

### Web Push
- `GET /push/vapid-public-key` — anonymous; returns the server's VAPID public key
- `POST /push/subscriptions` — register a browser push subscription against the authenticated slot
- `DELETE /push/subscriptions/:id` — remove a subscription (scoped to the caller's slot)

### Static SPA
- `GET /` + catch-all — serves the built `@control17/web` bundle with SPA fallback to `index.html`

## Install

```bash
npm install -g @control17/server
```

## Run

```bash
# First run with no config — drops into an interactive wizard
c17-server

# Subsequent runs — reads ./control17.json (or $C17_CONFIG_PATH)
export C17_PORT=8717
export C17_DB_PATH=/var/lib/c17/events.db
c17-server
```

The squadron config file defines the squadron's name, mission, brief, roles, slots, HTTPS settings, and VAPID keys. Each slot has a callsign, role key, authority level (`commander | lieutenant | operator`), secret token, and optional TOTP enrollment. See [`config.example.json`](./config.example.json) for the full schema.

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `C17_CONFIG_PATH` | `./control17.json` | Path to the team config file |
| `C17_PORT` | `8717` | HTTP listen port (plain-HTTP mode only) |
| `C17_HOST` | `127.0.0.1` | HTTP listen address — binding to non-loopback auto-enables self-signed HTTPS |
| `C17_DB_PATH` | `./c17.db` | SQLite path for event log, sessions, and push subscriptions. Use `:memory:` for ephemeral runs. |

The `--config-path` flag overrides `C17_CONFIG_PATH`.

## HTTPS modes

Configured via an `https` block in the team config file:

```jsonc
{
  "https": {
    "mode": "off",            // off | self-signed | custom
    "bindHttp": 8717,
    "bindHttps": 7443,
    "redirectHttpToHttps": true,
    "hsts": "auto",           // auto = off unless running a real cert
    "selfSigned": {
      "lanIp": null,          // auto-detected when binding 0.0.0.0
      "validityDays": 365,
      "regenerateIfExpiringWithin": 30
    },
    "custom": { "certPath": null, "keyPath": null }
  }
}
```

- `off` (default) — plain HTTP on `bindHttp`. Safe for localhost only.
- `self-signed` — HTTP/2 + TLS with a persisted self-signed cert. Auto-enabled when `C17_HOST` is non-loopback.
- `custom` — HTTP/2 + TLS with user-supplied `certPath` + `keyPath` (for reverse-proxy uploads or your own ACME flow).

The HTTPS listener always uses HTTP/2 with HTTP/1.1 ALPN fallback so SSE multiplexes over a single connection.

## TOTP login (web UI)

Slots with an `editor: true` role get a TOTP enrollment prompt during the first-run wizard. An `otpauth://` URI is printed in the terminal; scan it with any authenticator app (Google Authenticator, Authy, 1Password…). After enrollment, visiting `http://<server>/` redirects to a login form asking for the current 6-digit code — no username required. The server iterates enrolled slots server-side with a rate-limited codeless login flow.

Re-enrolling: `c17 enroll --slot <callsign>` regenerates the secret and prints a fresh URI. The bearer token in the config file is the recovery path — SSH to the box, run `c17 enroll`, scan the new code.

## Web Push

On first boot, the server auto-generates a VAPID keypair and persists it to the config file as a `webPush` block. The web UI fetches the public half via `GET /push/vapid-public-key` and subscribes the browser via `pushManager.subscribe()`. When a message is pushed:

- **DMs** always notify the recipient (unless they have a live SSE tab open).
- **Broadcasts** notify only when `level >= warning` or the body contains `@<callsign>`.

Dead subscriptions (410 Gone from the push service) are automatically removed. VAPID keys are never rotated casually — doing so invalidates every existing push subscription.

## Embedding

You can also embed the broker in your own Node process:

```ts
import { loadSquadronConfigFromFile, runServer } from '@control17/server';

const { squadron, roles, store, https, webPush } = loadSquadronConfigFromFile('./control17.json');

const running = await runServer({
  slots: store,
  squadron,
  roles,
  https,
  webPush,
  configDir: './data',     // where self-signed cert is stored
  configPath: './control17.json',  // for VAPID auto-gen persistence
  dbPath: '/var/lib/c17/events.db',
  host: '127.0.0.1',
  port: 8717,
});

// later…
await running.stop();
```

Pass `publicRoot: null` to disable the web UI entirely for machine-only deployments.

## License

Apache 2.0. See the [control17 monorepo](https://github.com/control17/control17) for the full source.
