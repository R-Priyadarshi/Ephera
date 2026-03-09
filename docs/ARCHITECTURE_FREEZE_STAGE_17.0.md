# ARCHITECTURE FREEZE: STAGE 17.0

Stage 17.0 is declared frozen.

## What Stage 17 Adds

Stage 17 adds **ephemeral peer identity** and **owner authority controls** to signaling room governance.

Problem:
- Room admission keys protect joins, but room governance still lacked explicit ownership semantics for privileged operations.

Stage 17 solution:
- Every signaling socket receives an ephemeral `peerId` (RAM-only).
- Each room tracks an in-memory owner identity (`ownerPeerId`).
- Privileged room operations are owner-only.
- If owner leaves while peers remain, ownership transfers deterministically.

## Runtime Contract

Identity and ownership:
- `create-room` response includes:
  - `peerId` (requesting socket identity)
  - `roomOwnerPeerId` (initially creator peerId)
  - `role` (`owner`)
- `join-room` response includes:
  - `peerId` (joining socket identity)
  - `roomOwnerPeerId`
  - `role` (`peer` unless socket is current owner)
- `peer-joined` / `peer-left` events include the joining/leaving `peerId`.

Owner-only controls:
- `rotate-room-join-key`
  - Owner-only.
  - Rotates `roomJoinKey` in RAM.
  - Emits `room-key-rotated` to current room peers.
- `close-room`
  - Owner-only.
  - Removes current room membership and emits `room-closed` to current peers.
  - Does not persist room/session data.

Owner transfer:
- On owner leave with remaining peers, room ownership transfers to a remaining peer and emits `room-owner-changed`.

## Canonical Components

- `server/signaling.js`
  - `peerId` minting, owner enforcement, privileged operation handlers.
  - Owner transfer signaling on owner departure.

- `server/rooms.js`
  - In-memory room ownership and peerId tracking.
  - Deterministic owner transfer on leave.

- `server/test/signaling.test.js`
  - Stage 17 regressions:
    - identity contract
    - owner-only controls
    - owner transfer

## Stage 17 Invariants (Non-Negotiable)

- Ephemeral identity:
  - `peerId` values must be RAM-only and per-connection.

- Owner authority:
  - Privileged room operations must fail closed for non-owner peers.

- Transfer determinism:
  - Owner departure must produce deterministic owner transfer when peers remain.

- Zero-retention alignment:
  - Ownership/identity state must die with room/socket/process and must never be persisted.

## Change Gate

Any change touching Stage 17 behavior must:

- Pass `npm test`
- Pass `npm run e2e`
- Keep Stage 17 signaling regressions passing in `server/test/signaling.test.js`

NOTE:
- Logical version name: `v0.17.0-owner-authority-frozen`
- Git tagging occurs only when the full app is production-ready
