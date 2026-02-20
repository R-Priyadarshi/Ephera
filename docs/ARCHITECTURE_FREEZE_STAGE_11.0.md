# ARCHITECTURE FREEZE: STAGE 11.0

Stage 11.0 is declared frozen.

## What Stage 11 Adds

Stage 11 hardens **app-server shutdown determinism** for production runtime safety.

Problem:
- A stuck HTTP socket can keep Node's HTTP server open and delay process shutdown indefinitely.
- This risks non-deterministic drain behavior during deploy/restart.

Stage 11 solution:
- Track active HTTP sockets.
- On shutdown, stop signaling first, then stop accepting HTTP, then force-close remaining sockets after a bounded grace period.

## Runtime Contract

- New app-server environment control:
  - `SHUTDOWN_GRACE_MS` (default `3000`, range `0..600000`)

- Shutdown flow:
  1. Set `stopping=true` and `signalingReady=false`.
  2. Close signaling (`createSignalingServer().close()`).
  3. Call `server.close()` and wait for graceful drain.
  4. If sockets remain after grace window, destroy them and complete shutdown.

- While stopping:
  - `/readyz` must return non-ready (`503`).
  - Responses include `Connection: close` to discourage new keep-alive reuse on existing sockets.

## Canonical Components

- `server/serve.js`
  - Parses/validates `SHUTDOWN_GRACE_MS`.
  - Tracks active sockets.
  - Implements bounded forced-drain shutdown.

- `server/test/serve.test.js`
  - Adds hung-connection shutdown regression.
  - Adds invalid `SHUTDOWN_GRACE_MS` startup validation regressions.

## Stage 11 Invariants (Non-Negotiable)

- Bounded shutdown:
  - App-server shutdown must complete deterministically even with hung HTTP sockets.

- Fail closed:
  - Invalid shutdown config must fail fast at startup.

- Zero-memory unchanged:
  - Shutdown hardening must not add persistence or payload logging.

## Change Gate

Any change touching Stage 11 behavior must:

- Pass `npm test`
- Pass `npm run e2e`
- Keep `server/test/serve.test.js` hung-shutdown and invalid-env regressions passing

NOTE:
- Logical version name: `v0.11.0-server-shutdown-frozen`
- Git tagging occurs only when the full app is production-ready
