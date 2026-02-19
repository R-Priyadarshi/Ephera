# ARCHITECTURE FREEZE: STAGE 4.0

Stage 4.0 is declared frozen.

## What Stage 4 Adds

Stage 4 introduces **fair scheduling** across multiple concurrent `sendStream()` producers.

- Goal: prevent starvation when multiple transfers share a single WebRTC DataChannel.
- Constraint: preserve zero-memory behavior (no per-transfer buffering beyond a single pending frame).

## Canonical Components

- `client/transport.js`
  - `sendStream(readable, { weight })` registers a producer.
  - A scheduler implements **smooth weighted round-robin** across producers.
  - When only one producer is momentarily sendable, the scheduler may yield a single microtask
    to let in-flight reads settle (bounded to prevent deadlock).
  - Each producer holds at most:
    - one in-flight `reader.read()` promise
    - one pending framed message (`Uint8Array`)

- `client/sender.js`
  - Owns protocol framing and chunk sizing.
  - Passes `{ weight }` through to `transport.sendStream()`.

- `client/test/fairness.*.test.js`
  - Canonical regression tests for fairness and weighted priority.

## Stage 4 Invariants (Non-Negotiable)

- Fairness:
  - With equal weights, concurrent transfers must make interleaved progress.
  - With weights, higher weight must dominate early scheduling without starving lower weight.
  - Liveness: a stalled/slow producer must not prevent other sendable producers from making progress.

- Backpressure:
  - All low-level `channel.send()` calls must remain serialized.
  - Concurrent callers must not bypass `bufferedAmount` backpressure.

- Memory:
  - Scheduler must not buffer entire streams.
  - O(1) additional memory per active producer.

## Change Gate

Any change touching `client/transport.js` scheduling must:

- Pass `node client/test/run-all.js`
- Re-run browser manual memory verification
- Explicitly list which Stage 4 invariants are affected (or state "none")

NOTE:
- Logical version name: `v0.4.0-fairness-frozen`
- Git tagging occurs only when the full app is production-ready
