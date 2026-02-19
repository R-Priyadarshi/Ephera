# Project Map (Files + Responsibilities)

This is a **file-by-file map** of what exists in this repo (excluding `node_modules/` and `.git/`).

Ephera is not “storage”. It is an **ephemeral P2P transport engine**:
- WebRTC DataChannel moves bytes directly between two peers.
- A signaling server exists only to exchange SDP/ICE so peers can connect.
- The engine is designed to be **zero-memory**: no disk writes, no DB/cache, no transfer history.

## Top-Level

- `.gitignore`
  - Ensures secrets/artifacts like `node_modules/` and `.ephera-dev-tls/` aren’t committed.
- `.dockerignore`
  - Keeps Docker builds from copying `node_modules/`, `.git/`, etc.
- `Dockerfile`
  - Container build for the app server (`npm start`), intended for HTTP behind a TLS reverse proxy.
- `package.json`
  - Root scripts:
    - `npm run dev` / `npm run dev:secure` for local usage.
    - `npm start` for a single-port deployable server (`server/serve.js`).
    - `npm run scan` runs a lightweight zero-memory compliance scan (guards against persistence regressions).
    - `npm test` for regression tests (client + server).
    - `npm run e2e` for real WebRTC E2E with Playwright.
    - `npm run e2e:perf` for heavier perf gates (100MB transfer + heap/buffer sampling).
    - `npm run e2e:soak` for optional soak gates (idle connection + extra connect/disconnect cycles).
    - `npm run verify` runs `test` then `e2e`.
    - `npm run perf` runs `test` then `e2e:perf`.
    - `npm run gates` runs `scan`, `perf`, then `e2e:soak` (slow, “do everything” mode).
  - `postinstall` runs `npm --prefix server install` so one install sets up the signaling dependency.
- `package-lock.json`
  - Dependency lock for the root package.
- `README.md`
  - “How to run” and “how to test” entry point.
- `ZERO_MEMORY_MANIFESTO.md`
  - Non-negotiable constraints (no persistence, no logs, no recovery).
- `THREAT_MODEL.md`
  - Security analysis and what Ephera does/doesn’t protect against.
- `PERFORMANCE_HARDENING_CHECKLIST.md`
  - Manual verification gates for memory/backpressure/failure behavior.

## `client/` (Browser Engine + Minimal UI)

- `client/package.json`
  - Declares `"type": "module"` so Node can run `client/test/*.js` as ESM.
- `client/index.html`
  - Minimal UI shell: room controls, secure-mode passphrase, send/receive controls, transfer list.
- `client/style.css`
  - UI styling (no framework, no bundler).
- `client/app.js`
  - Browser wiring only:
    - WebSocket signaling (create/join room, relay SDP/ICE)
    - Creates `EpheraTransport` and hooks it to the signaling channel
    - Sets up `EpheraReceiver + SessionManager` for inbound transfers
    - Streams outbound files with `EpheraSender` (supports concurrent sends + weights)
    - Tracks outbound `transferId`s to support:
      - Delivery receipts (receiver -> sender)
      - Peer abort propagation (receiver cancel -> sender abort)
    - Passphrase verification handshake (P2P, encrypted META) to prevent wasted transfers under passphrase mismatch
    - Secure mode passphrase UX (never stored; used only in memory)
    - Folder-based receive via File System Access API (secure contexts only)
    - Key hardening invariant: **signaling loss must not kill an active P2P session**
- `client/transport.js`
  - WebRTC transport + backpressure + Stage 4 fair scheduling:
    - `send(frame)` serializes all `channel.send()` to enforce backpressure correctness
    - `sendStream(readable, { weight })` streams framed messages fairly across concurrent producers
    - ICE candidate queueing to tolerate early candidate arrival
    - Deterministic teardown on close/error
- `client/sender.js`
  - Protocol framing for outbound transfers:
    - `START -> META? -> CHUNK* -> END` (or `ABORT`)
    - Chunk sizing (~64KB frames), backpressure-safe via `transport.sendStream()`
    - Stage 6 optional encryption (AES-256-GCM per chunk) when passphrase is set
    - Stage 7 optional metadata frame (filename/type/size) with bounds
- `client/receiver.js`
  - Binary protocol decoder:
    - Parses incoming framed messages
    - Emits session events (start/chunk/end/abort/meta) without owning session lifecycle
- `client/session/SessionManager.js`
  - Routes decoded events to per-transfer sessions by `transferId`
  - Owns session creation/removal and channel-death semantics (abort all)
- `client/session/TransferSession.js`
  - Per-transfer lifecycle:
    - Enforces chunk ordering
    - Exposes a single `ReadableStream`
    - Abort isolation (one session abort does not kill others)
    - Bounded buffering policy (abort if consumer stalls too hard)
    - Holds optional one-shot META (Stage 7)
- `client/crypto.js`
  - Stage 6 application-layer crypto (optional):
    - PBKDF2(passphrase, salt=transferId) -> AES-256-GCM key
    - Per-chunk nonces derived from `transferId || chunkIndex`
    - AAD binds ciphertext to protocol header fields
- `client/meaning.js`
  - “Meaning” advisory signals (not payload): category/size-range/mime-hint to improve UX hints.

### `client/test/` (Canonical Engine Regression)

All tests here run against the real engine stack using loopback transports (fast, deterministic).

- `client/test/run-all.js`
  - Runs the full client regression suite (Stage 3 + Stage 4 + Stage 6 + Stage 7).
- `client/test/run-stage3.js`
  - Runs only the Stage 3 regression set (structured concurrency / abort semantics / memory test).
- `client/test/concurrency.test.js`
  - Multiple concurrent transfers share one transport; ensures correct interleaving and isolation.
- `client/test/abort.test.js`
  - Verifies abort is terminal and isolated.
- `client/test/channel-death.test.js`
  - Verifies transport close aborts all sessions.
- `client/test/memory.test.js`
  - Repeated transfers to catch reference leaks; forces GC under Node (`--expose-gc`) and asserts sessions are collectible.
- `client/test/receiver-backpressure-overflow.test.js`
  - Verifies bounded receiver buffering: stalled consumer triggers deterministic abort (no unbounded JS-side accumulation).
- `client/test/transport.backpressure.test.js`
  - Validates DataChannel backpressure gating in `transport.send()` (wait/resume + destroy unblocks).
- `client/test/fairness.equal-weights.test.js`
  - Stage 4 scheduler fairness regression (equal weights interleave progress).
- `client/test/fairness.weighted-priority.test.js`
  - Weighted priority regression (high weight dominates early without starving low weight).
- `client/test/scheduler.liveness.test.js`
  - Scheduler deadlock/liveness regression (slow producer must not block others).
- `client/test/encryption.passphrase.test.js`
  - Stage 6 encryption regression (passphrase encrypt/decrypt correctness).
- `client/test/metadata.test.js`
  - Stage 7 META framing/routing regression (bounded + one-shot).

## `server/` (Stateless Signaling)

- `server/README.md`
  - Signaling purpose and guarantees (RAM-only rooms, no logs, no payload).
- `server/package.json` / `server/package-lock.json`
  - Minimal dependency set for signaling (`ws`).
- `server/signaling.js`
  - Testable signaling server module:
    - Validates message shapes + room IDs
    - Relays opaque `signal` payloads only (no inspection)
    - Enforces `maxPayload`, max peers per room, optional Origin allowlist
    - Ping/pong keepalive to terminate dead sockets
- `server/rooms.js`
  - In-memory room store:
    - Waiting-room TTL (0–1 peer) only
    - Room destroyed when empty
    - Active rooms (2 peers) are not killed by an absolute timer
- `server/index.js`
  - CLI entrypoint for signaling-only server (intentionally silent).
- `server/serve.js`
  - Combined “app server”:
    - Static client + same-origin signaling on one port
    - Optional HTTPS if `TLS_KEY_PATH` + `TLS_CERT_PATH` are provided
    - Health endpoints: `/healthz`, `/readyz`
    - Runtime client config endpoint: `/runtime-config` (supports `ICE_SERVERS_JSON` + `ICE_TRANSPORT_POLICY`)
    - Conservative security headers; no request logs

### `server/test/` (Signaling Regression)

- `server/test/signaling.test.js`
  - Exercises signaling behaviors: relay, room full, collisions, TTL, payload caps.
- `server/test/serve.test.js`
  - Verifies static/security headers, path guards, app-server health/readiness/runtime-config endpoints, and same-origin WS signaling.
- `server/test/run-all.js`
  - Runs the signaling suite and prints start/pass markers.

## `docs/` (Governance)

- `docs/INVARIANTS.md`
  - System-level “constitution” (what behaviors are allowed).
- `docs/GATES.md`
  - Change gates: what must pass before altering frozen components.
- `docs/ARCHITECTURE_FREEZE_STAGE_3.3.md`
  - Stage 3 structured concurrency freeze (session routing/lifecycle ownership).
- `docs/ARCHITECTURE_FREEZE_STAGE_4.0.md`
  - Stage 4 scheduler fairness freeze.
- `docs/ARCHITECTURE_FREEZE_STAGE_5.0.md`
  - Stage 5 transport hardening freeze (signaling reconnect + ICE restart gating).
- `docs/ARCHITECTURE_FREEZE_STAGE_6.0.md`
  - Stage 6 passphrase encryption freeze.
- `docs/ARCHITECTURE_FREEZE_STAGE_7.0.md`
  - Stage 7 metadata frame freeze.
- `docs/ARCHITECTURE_FREEZE_STAGE_8.0.md`
  - Stage 8 delivery receipts + peer abort freeze.
- `docs/ARCHITECTURE_FREEZE_STAGE_9.0.md`
  - Stage 9 passphrase verification handshake freeze.
- `docs/DEPLOYMENT.md`
  - Reverse proxy examples + “disable access logs” guidance.

## `e2e/` (Real WebRTC)

- `e2e/webrtc-app.e2e.cjs`
  - Headless Chrome E2E:
    - Opens two real browser pages
    - Establishes WebRTC DataChannel via signaling
    - Sends one or more files and asserts byte counts
    - Covers: same-origin signaling, secure-by-default, plain mode, multi-file, passphrase mode,
      peer-left (receiver signaling close), signaling restart, signaling server crash mid-transfer,
      sender tab close mid-transfer, receiver cancel mid-transfer, repeated connect/disconnect cycles (no reload),
      `npm start` app-server path, and a forced-GC session leak gate.
    - Optional perf mode (`npm run e2e:perf` / `E2E_PERF=1`):
      100MB transfer with heap + `bufferedAmount` sampling (automated approximation of manual performance gates).
