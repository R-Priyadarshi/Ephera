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
