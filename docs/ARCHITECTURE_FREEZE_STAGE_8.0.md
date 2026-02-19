# ARCHITECTURE FREEZE: STAGE 8.0

Stage 8.0 is declared frozen.

## What Stage 8 Adds

Stage 8 adds **bidirectional control** for outbound transfers:

- **Delivery receipts**:
  - After a receiver finishes processing a transfer (saved or discarded), it may send a bounded receipt back to the sender.
- **Peer abort propagation**:
  - If a receiver cancels or aborts a transfer, it may request the sender stop sending (best-effort).

This improves UX correctness ("did it actually arrive?") without violating zero-memory constraints.

## Control Encoding (No New Message Types)

Stage 8 uses existing protocol frames:

### 1) Peer Abort

- Message type: `MSG_ABORT = 0x04`
- Frame: `[type(1)] [transferId(8)]`

Semantics extension:
- ABORT may be sent by either peer as a best-effort request to stop the transfer.

### 2) Delivery Receipt (META)

- Message type: `MSG_META = 0x05`
- Frame: `[type(1)] [transferId(8)] [flags(1)] [metaLen(2)] [metaPayload(metaLen)]`

Receipt payload:
- JSON bytes with version marker:
  - `{ v: 1, kind: "receipt", status: "ok"|"abort", sink: "saved"|"discarded", bytes: number }`

Receipt rules:
- Receipt META is bounded (`<= 1024` plaintext bytes).
- Receipt META is best-effort:
  - If it is not delivered, the transfer is still considered "sent" but not "confirmed".

## Encryption Interaction (Stage 6 + Stage 8)

If passphrase mode is enabled, receipt META may be encrypted using Stage 6 META encryption:

- `META_FLAG_ENCRYPTED = 0x01`
- META encryption domain uses the reserved nonce:
  - `nonce = transferId(8) || 0xFFFFFFFF(4)`
- AAD binds to:
  - `MSG_META`, `transferId`, `flags`

## Canonical Components

- `client/app.js`
  - Tracks outbound transfers by `transferId` (in-memory only) to match receipts/aborts.
  - Listens for inbound `MSG_ABORT` / `MSG_META` frames and applies to outbound UI state.
  - Receiver sends:
    - ABORT on cancel/abort (best-effort)
    - Receipt META on clean completion (best-effort)

- `e2e/webrtc-app.e2e.cjs`
  - Asserts receipts arrive for successful transfers (plain + passphrase + multi-file).
  - Asserts receiver cancel mid-transfer aborts sender deterministically.

## Stage 8 Invariants (Non-Negotiable)

- No persistence:
  - No receipts, transferIds, or passphrases may be persisted (RAM-only, cleared on teardown).

- Bounded memory:
  - Outbound tracking map must be cleared on cleanup.
  - Receipt waiting must be bounded by a timeout.

- No hot-path regressions:
  - Outbound control handling must not add per-CHUNK allocations or routing work.
  - Control handling must early-filter by type.

- Signaling independence:
  - Receipts/aborts are sent over the DataChannel (P2P). Signaling availability must not be required.

## Change Gate

Any change touching Stage 8 behavior must:

- Pass `npm test`
- Pass `npm run e2e`
- Re-run manual memory verification (`PERFORMANCE_HARDENING_CHECKLIST.md`)

NOTE:
- Logical version name: `v0.8.0-control-frozen`
- Git tagging occurs only when the full app is production-ready

