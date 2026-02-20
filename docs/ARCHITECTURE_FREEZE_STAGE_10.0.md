# ARCHITECTURE FREEZE: STAGE 10.0

Stage 10.0 is declared frozen.

## What Stage 10 Adds

Stage 10 adds a strict **protocol compatibility contract** between peers.

Problem:
- Prior stages assumed both peers spoke the same control-plane contract.
- A version/feature mismatch could allow confusing UI state or wasted transfer attempts.

Stage 10 solution:
- Peers exchange bounded capabilities and compute compatibility before enabling readiness-driven sending.
- Mismatch is fail-closed and explicit.

## Capabilities Message (Signaling App Frame)

Capabilities are exchanged via signaling app messages:

- App type: `capabilities`
- Payload:
  - `{ v, protocolVersion, minSupported, features, requiredFeatures }`

Validation/sanitization rules:
- `v` must equal `1`
- `protocolVersion` and `minSupported` must be integers in `1..65535`
- `minSupported <= protocolVersion`
- `features` is bounded (`<= 32`) and normalized
- `requiredFeatures` is bounded (`<= 16`) and normalized
- Feature names must match a constrained token format (lowercase, stable charset)

## Negotiation Rules

Compatibility is true only when all checks pass:

1. Protocol range overlap exists:
   - `max(local.minSupported, peer.minSupported) <= min(local.protocolVersion, peer.protocolVersion)`
2. Peer supports all local required features.
3. Local supports all peer required features.

If any check fails, compatibility is false with a deterministic reason code.

## Runtime Gating Behavior

- `ready` signaling is advertised as:
  - `localReady && capabilitiesCompatible`
- Send UX remains disabled until:
  - transport open
  - valid peer capabilities received
  - compatibility true
  - peer ready
  - crypto/passphrase gates satisfied
- If an inbound transfer arrives while incompatible, receiver aborts it best-effort and does not stream bytes to the sink.
- Capabilities are re-announced on transport open and signaling reconnect (RAM-only state, no persistence).

## Canonical Components

- `client/capabilities.js`
  - Capability schema, sanitization, local capability construction, compatibility evaluation.

- `client/app.js`
  - Capability exchange on connect/open/reconnect.
  - Readiness/send gating tied to compatibility.
  - Inbound fail-closed behavior on incompatibility.

- `client/test/capabilities.negotiation.test.js`
  - Unit regressions for valid negotiation, version mismatch, required-feature mismatch, and pending state.

- `e2e/webrtc-app.e2e.cjs`
  - `protocol-mismatch` scenario verifies send stays disabled with explicit mismatch reason.

## Stage 10 Invariants (Non-Negotiable)

- Fail closed:
  - Invalid/missing peer capabilities must not be treated as compatible.

- No persistence:
  - Capabilities and compatibility state are RAM-only and reset on cleanup.

- Deterministic negotiation:
  - Compatibility decisions must be reproducible from sanitized local+peer payloads.

- Separation of concerns:
  - Capability negotiation is control-plane only; it must not alter payload chunk framing semantics.

## Change Gate

Any change touching Stage 10 behavior must:

- Pass `npm test`
- Pass `npm run e2e` (including `protocol-mismatch`)

NOTE:
- Logical version name: `v0.10.0-protocol-compat-frozen`
- Git tagging occurs only when the full app is production-ready
