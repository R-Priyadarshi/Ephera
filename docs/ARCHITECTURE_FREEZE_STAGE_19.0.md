# ARCHITECTURE FREEZE: STAGE 19.0

Stage 19.0 is declared frozen.

## What Stage 19 Adds

Stage 19 adds **owner-operation abuse throttling** for privileged room controls.

Problem:
- Stage 17/18 enforced owner-only authority, but repeated owner-op spam (`rotate-room-join-key`, `close-room`) still needed bounded abuse controls.

Stage 19 solution:
- Owner-op messages are rate-limited per IP with a bounded window + cooldown.
- Throttle applies to owner and non-owner attempts (fail-closed abuse surface).
- Throttle state is RAM-only and cleared when socket/IP state is released.

## Runtime Contract

Owner-op throttle:
- `rotate-room-join-key` and `close-room` consume a per-IP owner-op budget.
- Exceeded budget returns:
  - `type: "error"`
  - `message: "Too many owner operations; retry later"`
  - `retryAfterMs` (bounded positive integer)

Scope:
- Independent from room-op (`create-room`/`join-room`) budget.
- Uses the same trusted IP model as other per-IP controls (`TRUST_PROXY` governs `X-Forwarded-For` usage).

## Canonical Components

- `server/signaling.js`
  - Owner-op per-IP budget accounting and cooldown enforcement.

- `server/test/signaling.test.js`
  - Stage 19 regressions:
    - owner-op cooldown for rotate
    - non-owner abuse throttling
    - close-room cooldown behavior

## Stage 19 Invariants (Non-Negotiable)

- Owner-op abuse must be bounded:
  - Privileged owner-op message rates must have hard per-IP caps with cooldown.

- Fail-closed surface:
  - Exceeded owner-op budget must return deterministic throttle denial.

- Zero-retention alignment:
  - Owner-op throttle state must remain RAM-only and die on process/socket/IP state teardown.

## Change Gate

Any change touching Stage 19 behavior must:

- Pass `npm test`
- Pass `npm run e2e`
- Keep Stage 19 signaling regressions passing in `server/test/signaling.test.js`

NOTE:
- Logical version name: `v0.19.0-owner-op-throttle-frozen`
- Git tagging occurs only when the full app is production-ready
