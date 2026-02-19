# ARCHITECTURE FREEZE: STAGE 5.0

Stage 5.0 is declared frozen.

## What Stage 5 Adds

Stage 5 hardens real-world transport behavior without violating the zero-memory constraints:

- **Signaling independence**:
  - After WebRTC P2P is open, loss of signaling must not terminate the P2P session.
- **Best-effort signaling reconnect** (RAM-only):
  - If signaling disconnects while P2P remains open, the client may reconnect signaling in the background.
  - Reconnect must not restart or replace the active WebRTC transport.
  - After reconnect, the client must re-announce its ephemeral readiness/crypto mode.
- **ICE restart support** (initiator only):
  - On unhealthy ICE states (`failed` / prolonged `disconnected`), initiator attempts ICE restart if signaling is available.
  - If signaling is unavailable, the client schedules reconnect and retries once signaling is restored.

## Canonical Components

- `client/app.js`
  - Owns signaling lifecycle and reconnect scheduling.
  - Enforces: signaling loss does not teardown active P2P.
  - Owns ICE restart triggering policy.
- `client/transport.js`
  - ICE candidate queueing before `remoteDescription` is set.
  - Deterministic teardown on connection failure.
- `e2e/webrtc-app.e2e.cjs`
  - Regression coverage for:
    - P2P transfer continuing after signaling crash
    - Signaling server restart + client reconnect + ICE restart

## Stage 5 Invariants (Non-Negotiable)

- No persistence:
  - Reconnect state is RAM-only and must be cleared on teardown.
- No transport reset:
  - Reconnect must not create a second WebRTC transport or DataChannel for the active session.
- Bounded reconnect:
  - Reconnect attempts must be bounded by backoff and must stop on cleanup.
- Deterministic failure:
  - If the transport cannot recover, teardown must be deterministic (no zombie sessions).

## Change Gate

Any change touching Stage 5 behavior must:

- Pass `npm test`
- Pass `npm run e2e`
- Re-run manual memory verification (`PERFORMANCE_HARDENING_CHECKLIST.md`)

NOTE:
- Logical version name: `v0.5.0-transport-hardened-frozen`
- Git tagging occurs only when the full app is production-ready

