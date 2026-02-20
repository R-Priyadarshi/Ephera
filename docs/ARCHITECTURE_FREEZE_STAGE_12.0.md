# ARCHITECTURE FREEZE: STAGE 12.0

Stage 12.0 is declared frozen.

## What Stage 12 Adds

Stage 12 adds **per-IP admission pressure controls** in the signaling layer.

Problem:
- Global limits (`MAX_CONNECTIONS`, per-socket message rate) are necessary but insufficient.
- A single abusive source can still dominate admission share.

Stage 12 solution:
- Add per-IP connection caps and per-IP message-rate caps, with explicit proxy-trust boundaries.

## Runtime Contract

New signaling controls:

- `MAX_CONNECTIONS_PER_IP` (default `64`)
- `MAX_MESSAGES_PER_IP_PER_WINDOW` (default `1200`)
- `MESSAGE_RATE_WINDOW_MS` (existing window; shared by per-socket and per-IP message caps)
- `TRUST_PROXY` (default `0`)

Behavior:
- Connections are rejected (`1013`) when an IP exceeds `MAX_CONNECTIONS_PER_IP`.
- Messages are rate-limited (`1008`) when an IP exceeds `MAX_MESSAGES_PER_IP_PER_WINDOW` in the active window.
- Without `TRUST_PROXY=1`, client IP is derived from socket remote address only.
- With `TRUST_PROXY=1`, first `X-Forwarded-For` hop may be used for IP attribution.

## Canonical Components

- `server/signaling.js`
  - Per-IP connection accounting.
  - Per-IP message-window accounting.
  - Optional proxy-aware IP attribution guarded by `TRUST_PROXY`.

- `server/test/signaling.test.js`
  - Per-IP connection cap regressions.
  - Per-IP message-rate regressions across multiple sockets.
  - Trust-proxy enabled and disabled behavior regressions.

## Stage 12 Invariants (Non-Negotiable)

- Fair admission pressure:
  - A single IP must not consume unbounded signaling admission share.

- Explicit trust boundary:
  - Forwarded client IP headers must not be trusted unless `TRUST_PROXY=1`.

- Bounded memory:
  - Per-IP accounting maps must be bounded to active IP footprint and released when no sockets remain.

## Change Gate

Any change touching Stage 12 behavior must:

- Pass `npm test`
- Pass `npm run e2e`
- Keep Stage 12 signaling regressions passing in `server/test/signaling.test.js`

NOTE:
- Logical version name: `v0.12.0-signaling-ip-controls-frozen`
- Git tagging occurs only when the full app is production-ready
