# ARCHITECTURE FREEZE: STAGE 15.0

Stage 15.0 is declared frozen.

## What Stage 15 Adds

Stage 15 adds **ephemeral room admission auth** to signaling room membership.

Problem:
- Room IDs alone are guessable/brute-forceable, enabling unauthorized join attempts.

Stage 15 solution:
- Every room has an in-memory admission key.
- `join-room` must present the matching key.
- Auth failures are shaped through the Stage 14 denial surface (`Join unavailable`).

## Runtime Contract

Protocol contract:

- `create-room`:
  - Request may include optional `roomJoinKey` (custom key).
  - If omitted, server mints a random key in RAM.
  - Response returns `roomJoinKey`.

- `join-room`:
  - Request must include matching `roomJoinKey`.
  - Missing/wrong key returns `Join unavailable` (shaped denial).

Properties:
- Room join keys are RAM-only and room-scoped.
- Room join keys are destroyed when room is destroyed.
- Process death wipes all join keys.

## Canonical Components

- `server/signaling.js`
  - Join-key mint/sanitize/validation.
  - `create-room`/`join-room` protocol extensions.
  - Stage 14 denial shaping reuse for auth failures.

- `server/rooms.js`
  - Room structure now includes in-memory `joinKey`.

- `client/app.js`
  - Room key input + generation.
  - Join-link propagation (`roomJoinKey`).
  - Reconnect/create/join wiring with join key.

- `server/test/signaling.test.js`
  - Stage 15 auth regressions (required/matching/custom key).

## Stage 15 Invariants (Non-Negotiable)

- Fail closed:
  - Joining a protected room without a valid key must never succeed.

- Zero retention:
  - Room admission keys are never persisted and must not outlive room/process.

- Enumeration resistance preserved:
  - Auth failures must not introduce new room-existence oracle surface.

## Change Gate

Any change touching Stage 15 behavior must:

- Pass `npm test`
- Pass `npm run e2e`
- Keep Stage 15 signaling regressions passing in `server/test/signaling.test.js`

NOTE:
- Logical version name: `v0.15.0-room-admission-auth-frozen`
- Git tagging occurs only when the full app is production-ready
