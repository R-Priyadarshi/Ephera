# SYSTEM INVARIANTS

- Decoder Truth:
  - receiver.js behavior is identical with or without callbacks
  - receiver.js never branches on session or routing logic

- Abort Semantics:
  - Sender abort → session stream errors
  - Channel death → ALL sessions abort
  - Abort is terminal; no resurrection

- Memory Safety:
  - O(1) memory per active session
  - No buffers, arrays, or accumulation
  - All references released on teardown

- Ownership Model:
  - Transport lifecycle → app.js
  - Routing → SessionManager
  - Stream lifecycle and ordering → TransferSession

- Signaling Independence (Stage 5):
  - After WebRTC P2P is open, loss of signaling must not terminate the P2P session
  - Best-effort signaling reconnect may occur, but must not restart/replace the active WebRTC transport
  - After reconnect, peers must re-announce ephemeral readiness/crypto mode (no persistence)

- Deletion Authority:
  - Sessions removed ONLY on END, ABORT, or channel death

- Fair Scheduling (Stage 4):
  - Concurrent senders must not starve each other
  - Weighting must influence early scheduling behavior
  - No stream buffering beyond bounded per-producer pending frame
  - Scheduler must not deadlock if another producer is slow or stalled

- Encryption Reinforcement (Stage 6):
  - If passphrase mode is enabled locally, transfers must fail closed on decrypt errors
  - Nonce uniqueness must hold per transfer and per chunk
  - No plaintext downgrade in passphrase mode

- Passphrase Verification Handshake (Stage 9):
  - In passphrase mode, peers may exchange a bounded encrypted META handshake over the DataChannel to confirm passphrase match
  - Handshake META must use a transferId from a disjoint domain so it can never be routed as session META (reserved: transferId[0] high bit set)
  - Outbound sending UX must be gated on verification success to avoid wasted encrypted transfers under passphrase mismatch

- Protocol Compatibility Contract (Stage 10):
  - Peers must exchange sanitized capabilities (`v`, protocol range, feature sets) before transfers are treated as compatible
  - Compatibility requires protocol range overlap and bilateral required-feature satisfaction
  - Local ready advertisement and outbound send must fail closed until compatibility is confirmed
  - Inbound sessions received while incompatible must be aborted (best-effort) and must not be streamed
  - Capability state is RAM-only and must reset on teardown/reconnect

- App-Server Shutdown Determinism (Stage 11):
  - `/readyz` must fail closed during shutdown (`stopping=true`)
  - Shutdown must be bounded even with stuck HTTP sockets (force-drain after grace window)
  - Forced drain must not persist or log request data

- Signaling Per-IP Admission Controls (Stage 12):
  - Per-IP connection and message-rate caps must be enforced independently of per-socket caps
  - Proxy-supplied client IP headers (`X-Forwarded-For`) must be ignored unless `TRUST_PROXY=1`
  - Per-IP accounting state must be bounded in RAM and released when IP has no active sockets

- Signaling Room-Abuse Throttling (Stage 13):
  - `create-room` / `join-room` attempts must be budgeted per IP with deterministic cooldown on abuse
  - Cooldown enforcement must be independent of per-socket and per-IP message-rate caps
  - Room-op throttle accounting must remain RAM-only and be released when IP has no active sockets

- Join Enumeration Resistance (Stage 14):
  - `join-room` negative outcomes that reveal room presence (`missing` vs `full`) must emit an indistinguishable error surface
  - Join-deny response shaping (bounded delay) must be configurable and RAM-only
  - Join-deny shaping must not bypass or weaken room-op budget/cooldown enforcement

- Ephemeral Room Admission Auth (Stage 15):
  - Room admission key must be RAM-only and scoped to room lifetime (destroyed with room/process)
  - `room-created` must return a join key, and `join-room` must require a matching key
  - Join auth failures must fail closed through the same non-enumerating denial surface (`Join unavailable`)

- Log-Safe Secret Link Handling (Stage 16):
  - Join-link secret material (`roomJoinKey`, optional `passphrase`) must be encoded in URL fragment (`#...`) rather than query params
  - Client link ingest must remain hash-first with query fallback for legacy links, then strip secrets from both query/hash immediately after read
  - Secret-link handling must remain RAM-only and must not introduce persistence or telemetry

- Ephemeral Peer Identity + Owner Authority (Stage 17):
  - Each signaling connection must receive an ephemeral RAM-only `peerId` (destroyed on disconnect/process death)
  - Each room must maintain an in-memory owner identity (`ownerPeerId`) and enforce owner-only privileged operations
  - Non-owner attempts for privileged room operations must fail closed (`Owner privileges required`)
  - Owner departure with remaining peers must deterministically transfer ownership in RAM-only state

- Owner Control UX Gating (Stage 18):
  - Client owner controls (`rotate-room-join-key`, `close-room`) must be locally gated to owner role and fail closed when signaling is unavailable
  - Client authority state (`peerId`, `ownerPeerId`, local role) must be RAM-only and reset on disconnect/cleanup
  - Client must handle owner-governance signaling events deterministically (`room-key-rotated`, `room-owner-changed`, `room-closed`)
  - Owner disconnect transfer must deterministically promote the remaining peer and unlock owner controls without reload

- Owner Operation Abuse Throttling (Stage 19):
  - Owner-op messages (`rotate-room-join-key`, `close-room`) must consume a bounded per-IP budget with cooldown
  - Exceeded owner-op budget must fail closed with `Too many owner operations; retry later` and bounded `retryAfterMs`
  - Owner-op throttling must also apply to non-owner abuse attempts and remain RAM-only

- TURN Secret Hygiene + Relay Required Aggregation (Stage 20):
  - Dynamic TURN runtime config must fail closed when `TURN_AUTH_SECRET` is weak (placeholder or length < 16)
  - Relay local gate must fail closed before runtime when relay secret/TTL env is invalid
  - CI aggregate required status must fail if any of `core-tests`, `full-gates`, or `relay-required` fails

- Metadata (Stage 7):
  - META is optional and must be one-shot per transfer (duplicates abort the session)
  - META must be bounded in size and must not be persisted beyond the session
  - META may improve UX (filename/progress) but must not change stream integrity semantics

- Delivery Receipts + Peer Abort (Stage 8):
  - Receiver may send a bounded receipt META (`{ v: 1, kind: "receipt", ... }`) after completion (saved/discarded)
  - Receiver cancel/abort may send ABORT to request the sender stop sending (best-effort)
  - Control messages must be P2P (DataChannel) and must not depend on signaling availability
  - Control handling must not add per-CHUNK overhead beyond constant-time type filtering

If a behavior is not listed here, it is forbidden.
