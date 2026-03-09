# ARCHITECTURE FREEZE: STAGE 14.0

Stage 14.0 is declared frozen.

## What Stage 14 Adds

Stage 14 adds **join-room enumeration resistance** for negative join outcomes.

Problem:
- Distinct `join-room` errors (`Room not found` vs `Room full`) provide a room-presence oracle for brute-force probing.

Stage 14 solution:
- Return a single denial surface for join misses/full capacity and shape response timing with a bounded delay.

## Runtime Contract

New signaling control:

- `JOIN_DENY_DELAY_MS` (default `120`)

Behavior:
- `join-room` for a non-existent room and `join-room` for a full room both return:
  - Error: `Join unavailable`
- Join-deny responses are delayed by `JOIN_DENY_DELAY_MS` to reduce timing-based enumeration signal.
- Throttle behavior from Stage 13 remains independent and unchanged:
  - `Too many room operations; retry later` + bounded `retryAfterMs`.

## Canonical Components

- `server/signaling.js`
  - Join-deny shaping helper and unified join-deny error surface.
  - Configurable delay parsing for `JOIN_DENY_DELAY_MS`.

- `server/test/signaling.test.js`
  - Regression updates for unified join-deny response.
  - New shaping regression covering both miss and full-capacity denial paths.

- `client/app.js`
  - Reconnect handling updated to tolerate unified join-deny response while preserving initiator room-recreate repair path.

## Stage 14 Invariants (Non-Negotiable)

- Indistinguishable join denial:
  - Missing-room and full-room `join-room` denial paths must remain externally indistinguishable by explicit error semantics.

- Bounded shaping:
  - Join-deny delay must be bounded, configurable, and RAM-only.

- No throttle regression:
  - Stage 13 room-op budget/cooldown guarantees must remain intact and independent.

## Change Gate

Any change touching Stage 14 behavior must:

- Pass `npm test`
- Pass `npm run e2e`
- Keep Stage 14 signaling regressions passing in `server/test/signaling.test.js`

NOTE:
- Logical version name: `v0.14.0-signaling-join-enumeration-frozen`
- Git tagging occurs only when the full app is production-ready
