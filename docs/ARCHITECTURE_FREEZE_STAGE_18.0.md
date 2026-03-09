# ARCHITECTURE FREEZE: STAGE 18.0

Stage 18.0 is declared frozen.

## What Stage 18 Adds

Stage 18 adds **client-side owner control wiring** on top of Stage 17 signaling authority.

Problem:
- Stage 17 introduced owner authority at signaling level, but client UX did not yet enforce/reflect that authority contract.

Stage 18 solution:
- Client tracks ephemeral authority state (`peerId`, `ownerPeerId`, local role) in RAM-only state.
- Owner-only room controls are exposed and locally gated:
  - `rotate-room-join-key`
  - `close-room`
- Client handles owner-governance events deterministically:
  - `room-key-rotated`
  - `room-owner-changed`
  - `room-closed`
- Ownership transfer on abrupt owner disconnect must re-gate controls without page reload.

## Runtime Contract

Authority state:
- Client updates local authority state only from authoritative signaling responses/events.
- Authority state is reset on cleanup/disconnect and never persisted.

Owner controls:
- Owner controls remain disabled unless:
  - signaling socket is open,
  - client is in a room,
  - local role is owner.
- Non-owner attempts fail closed locally and on server (`Owner privileges required`).

Room governance events:
- `room-key-rotated` updates active room key + join link state.
- `room-owner-changed` updates role/owner indicators.
- `room-closed` triggers deterministic cleanup and clear user feedback.

## Canonical Components

- `client/index.html`
  - Owner control buttons and authority state UI.

- `client/app.js`
  - Authority state tracking, owner-gated controls, governance event handling.

- `e2e/webrtc-app.e2e.cjs`
  - Stage 18 `owner-authority-ui` and `owner-disconnect-transfer-ui` scenarios.

## Stage 18 Invariants (Non-Negotiable)

- Fail-closed control gating:
  - Owner-only actions must not be enabled for non-owner peers.

- RAM-only authority:
  - `peerId`/`ownerPeerId`/role state must remain ephemeral and reset on teardown.

- Deterministic governance handling:
  - Rotation/owner-change/room-close events must yield deterministic local state transitions.
  - Owner disconnect transfer must deterministically unlock owner controls on the promoted peer.

## Change Gate

Any change touching Stage 18 behavior must:

- Pass `npm test`
- Pass `npm run e2e`
- Keep Stage 18 owner-control scenarios passing in `e2e/webrtc-app.e2e.cjs` (`owner-authority-ui`, `owner-disconnect-transfer-ui`)

NOTE:
- Logical version name: `v0.18.0-owner-control-ux-frozen`
- Git tagging occurs only when the full app is production-ready
