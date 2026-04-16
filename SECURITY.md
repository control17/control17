# Security

## Reporting a vulnerability

Please do **not** file public GitHub issues for security vulnerabilities.
Email **security@control17.com** with a description, affected version, and
reproduction steps. We aim to acknowledge within 72 hours and patch
in-band-severity issues within 14 days.

If the vulnerability is in a dependency rather than control17 itself, please
still let us know so we can pin or fork as needed.

## What we protect

1. **Slot bearer tokens** — per-slot shared secrets used by agents and
   operator terminals to authenticate to the broker.
2. **TOTP secrets** — per-slot secrets backing the web UI's 2FA login.
3. **Captured LLM traces** — prompts, tool calls, tool results, and
   response bodies observed by the MITM TLS proxy and streamed to the
   broker as agent activity rows.
4. **The per-session MITM CA** — short-lived root that the runner uses
   to mint leaf certs for upstream hostnames.
5. **Session cookies** — `c17_session` cookies minted after TOTP login.
6. **VAPID private key** — used to sign Web Push notifications.

## Architecture that serves those protections

| Asset | Control |
|---|---|
| Bearer tokens | SHA-256 hashed on disk. Plaintext in the config file is auto-migrated to a hash on first boot and the file is atomically rewritten at `0o600`. |
| TOTP secrets | Encrypted at rest with AES-256-GCM (random IV per field, authenticated). Replay-guarded per slot (monotonic counter). Per-slot + global codeless-login rate limits (5 / 15 min per slot, 10 / 15 min global). Legacy plaintext values are auto-migrated on first boot under an active KEK. |
| Trace payloads | Captured only inside the runner process on loopback. Redaction at parse time strips `Authorization`, `Cookie`, `x-api-key`, `x-anthropic-api-key`, `proxy-authorization`, and scrubs common API-key patterns (`sk-ant-…`, `sk-…`, `AKIA…`, `ghp_…`, `xox[baprs]-…`). Upload is authenticated and self-only (`POST /agents/:callsign/activity`). Read is gated to self or commander (`GET /agents/:callsign/activity`). |
| MITM CA | Generated fresh per runner process. Private key **never touches disk**. CA cert PEM is written `0o600` to `$TMPDIR/c17-trace-ca-<pid>-<nonce>.pem` and `unlink()`ed on every runner exit path (normal, SIGINT, SIGTERM, uncaughtException, unhandledRejection). |
| Session cookies | `HttpOnly` + `SameSite=Strict`. `Secure` set when the broker is listening over HTTPS. 7-day sliding TTL. |
| Authority enforcement | Commander / Lieutenant / Operator tiers are checked **server-side on every mutating endpoint**. No client-side gating relied upon. |
| Identity binding | `agentId === slot.callsign` is enforced in the broker core (`packages/core/src/broker.ts`) and pre-stream in the HTTP handler. A slot cannot subscribe to another slot's activity. |

## Known limitations

These are documented rather than hidden. Each is tracked as a roadmap item; the delta from "documented" to "closed" is visible in this file's history.

- **KEK handling today is limited to an env var or a local key file.** The KEK used to encrypt TOTP + VAPID at rest is resolved from `C17_KEK` (base64-encoded 32 bytes) or an auto-generated `<configDir>/c17-kek.bin` on first boot. This is strictly better than plaintext-at-rest (where the config file alone leaked every credential), but still: if both the config file AND the key file leak together, encryption buys you nothing. Operators who want separation should set `C17_KEK` to a value managed by their secret manager / OS keychain / HSM and ensure the key file never exists. OS-keychain native integration is a follow-up.
- **Redaction is pattern-based and incomplete.** Custom schemes, JWTs, shorter API keys, base64-encoded secrets, and **any secret inside message content or tool I/O** pass through unmodified. `redactJson` in `packages/cli/src/runtime/trace/redact.ts` is the full pattern set. Treat traces as sensitive; only grant commander authority to slots that need trace access.
- **HTTP/2 is not intercepted.** The MITM proxy negotiates `http/1.1` only (ALPN). H2-forcing clients silently fall out of trace capture. The Anthropic SDK defaults to HTTP/1.1 for `/v1/messages` today, so the practical gap is minimal.
- **`/history` is viewer-scoped but not rate-limited.** A compromised bearer token can fan-scan squadron history it is entitled to see. Scope is bounded by identity, but request rate is not.
- **No bearer-token rotation flow yet.** `c17 rotate --slot <callsign>` ships in this release (see "Changes in this release" below).
- **Session cookie lacks `__Host-` prefix** and there is no CSRF token on cookie-authed state-changing POSTs. `SameSite=Strict` is the only CSRF defense today — strong in current browsers but not universal.
- **No SNI validation on MITM leaf issuance.** The proxy issues a leaf matching the CONNECT host regardless of ClientHello SNI. Node clients currently send matching SNI; nothing in the proxy enforces it.

## Changes in this release

### `NODE_TLS_REJECT_UNAUTHORIZED=0` is no longer set by default on the agent child

Earlier versions of the runner unconditionally set `NODE_TLS_REJECT_UNAUTHORIZED=0`
on the spawned Claude Code child as a failsafe for packaged-binary Node
distributions that can't pick up `NODE_EXTRA_CA_CERTS`. The blast radius was
the entire agent process — any HTTPS the agent made, proxied or not, had no
certificate validation.

Starting with this release:

- The runner no longer sets `NODE_TLS_REJECT_UNAUTHORIZED=0` by default. The
  agent child's Node runtime validates TLS normally and trusts our MITM CA via
  `NODE_EXTRA_CA_CERTS`.
- Users running packaged Claude binaries that cannot honor
  `NODE_EXTRA_CA_CERTS` can opt in with `c17 claude-code --unsafe-tls`.
- Opting in triggers a prominent terminal-banner warning on every session
  start and surfaces as a `WARN` in `c17 claude-code --doctor` output.
- The flag is sunset-dated; once a kernel-level interception path (or
  trust-store injection) lands, it will be removed.

This change closes the first of two HIGH-severity findings from the
2026-04-16 internal audit.

### `c17 rotate --slot <callsign>` — atomic bearer-token rotation

Slot bearer tokens used to be rotatable only by hand-editing the squadron config — risky (easy to typo or clobber an unrelated slot) and skipped in practice, so rotation events never happened. `c17 rotate` regenerates a cryptorandom `c17_<base64url>` bearer (~256 bits of entropy), atomically rewrites the config at `0o600`, and prints the new plaintext once with explicit save-now framing. Every other slot's authority, role, TOTP state, and bearer stay untouched byte-for-byte. The plaintext is never persisted; only the SHA-256 hash lands on disk.

### TOTP secrets + VAPID private key encrypted at rest (AES-256-GCM)

TOTP secrets were stored base32, and the VAPID private key was stored as a PEM. A read-only exfiltration of `control17.json` would have leaked every slot's web-login credential permanently (rotating would have meant re-enrolling every slot from scratch). That was the second HIGH-severity finding in the 2026-04-16 audit.

Starting with this release:

- Both fields are now encrypted at rest with AES-256-GCM (12-byte random IV per field, 16-byte authentication tag). Wire format is `enc-v1:<base64url(iv)>:<base64url(tag)>:<base64url(ct)>`.
- The KEK is resolved at server boot, in order: (1) `C17_KEK` env var (base64-encoded 32 bytes) — for operators who manage keys via their secret manager / OS keychain / HSM; (2) `<configDir>/c17-kek.bin` — auto-generated on first boot at `0o600` when `C17_KEK` isn't set, which keeps zero-config self-host working.
- Authenticated-encryption means a tampered ciphertext or a wrong KEK surfaces as a clear error, not a silent bit flip.
- Configs written by older versions (plaintext TOTP / VAPID) migrate transparently on first load under an active KEK: the loader detects plaintext, counts it against the `migrated` field, and the subsequent config rewrite emits `enc-v1:...` values. Single-release upgrade path, no manual migration required.

This closes the second of two HIGH-severity findings from the 2026-04-16 internal audit. The remaining open items are MED/LOW severity; see **Known limitations** above for the current slate.

## Disclosure history

*(Will be maintained as issues are reported and patched. Empty at first release.)*
