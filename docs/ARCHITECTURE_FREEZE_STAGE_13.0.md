# ARCHITECTURE FREEZE: STAGE 13.0

Stage 13.0 is declared frozen.

## What Stage 13 Adds

Stage 13 adds **signaling room-abuse throttling** for `create-room` and `join-room`.

Problem:
- Even with connection/message caps, repeated room operations can be abused to brute-force room IDs or create avoidable control-plane pressure.

Stage 13 solution:
- Add per-IP room operation budget with deterministic cooldown after budget exhaustion.

## Runtime Contract

New signaling controls:

- `MAX_ROOM_OPS_PER_IP_PER_WINDOW` (default `120`)
- `ROOM_OPS_WINDOW_MS` (default `60000`)
- `ROOM_OPS_COOLDOWN_MS` (default `30000`)
- `TRUST_PROXY` (existing; default `0`) controls whether `X-Forwarded-For` contributes to IP attribution

Behavior:
- Each `create-room` and `join-room` attempt consumes room-op budget for the caller IP.
- If budget is exceeded within the window, further room-op attempts are rejected during cooldown:
  - Error: `Too many room operations; retry later`
  - Includes bounded `retryAfterMs` hint.
- Cooldown and room-op budget are independent from per-socket / per-IP message-rate limits.

## Canonical Components

- `server/signaling.js`
  - Per-IP room-op accounting map.
  - Windowed budget + cooldown enforcement for room operations.

- `server/test/signaling.test.js`
  - Room-op budget + cooldown regression.
  - Proxy-aware room-op budget attribution regression.

## Stage 13 Invariants (Non-Negotiable)

- Abuse resistance:
  - Repeated room operations from a single IP must be bounded with deterministic cooldown behavior.

- Explicit trust boundary:
  - Proxy headers influence IP attribution only when `TRUST_PROXY=1`.

- Bounded memory:
  - Room-op accounting is RAM-only and released once an IP has no active sockets.

## Change Gate

Any change touching Stage 13 behavior must:

- Pass `npm test`
- Pass `npm run e2e`
- Keep Stage 13 signaling regressions passing in `server/test/signaling.test.js`

NOTE:
- Logical version name: `v0.13.0-signaling-room-throttle-frozen`
- Git tagging occurs only when the full app is production-ready
