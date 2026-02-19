# ARCHITECTURE FREEZE: STAGE 7.0

Stage 7.0 is declared frozen.

## What Stage 7 Adds

Stage 7 introduces an **optional, bounded metadata frame** so receivers can:

- Save using the original filename (when provided)
- Show progress (% of expected total bytes)

This does not change the core payload stream semantics:

- Chunks remain stream-only (no buffering, no persistence)
- Metadata is an ephemeral hint attached to the transfer lifecycle

## Protocol Extension (META)

New message type:

- `MSG_META = 0x05`

Frame layout:

- `[type(1)] [transferId(8)] [flags(1)] [metaLen(2)] [metaPayload(metaLen)]`

Rules:

- META is sent at most once per transfer.
- Sender order is: `START -> META? -> CHUNK* -> END` (META is before any CHUNK).
- Receiver enforces deterministic framing: `metaLen` must match the remaining bytes exactly.
- META payload is bounded by sender (`<= 2048` plaintext bytes) and receiver (`<= 4096` bytes).

Metadata encoding:

- JSON bytes with stable version marker:
  - `{ v: 1, name?: string, type?: string, size?: number }`

## Encryption Interaction (Stage 6 + Stage 7)

If passphrase mode is enabled, META is encrypted using the same per-transfer AES-256-GCM key:

- META flag bit0: `META_FLAG_ENCRYPTED = 0x01`
- META nonce domain is distinct from CHUNK nonces:
  - `nonce = transferId(8) || 0xFFFFFFFF(4)`
- META AAD binds to:
  - `MSG_META`, `transferId`, `flags`

This keeps nonce uniqueness intact and prevents cross-frame substitution.

## Canonical Components

- `client/sender.js`
  - Sends META after START (if metadata is present).
  - Encrypts META payload if `_aesKey` exists.

- `client/receiver.js`
  - Decodes META frames and emits `{ type, transferId, flags, meta }`.
  - Enforces `metaLen` exactness and a hard upper bound.

- `client/session/SessionManager.js`
  - Routes META by `transferId` value to the owning `TransferSession`.

- `client/session/TransferSession.js`
  - Stores meta once (`handleMeta`).
  - Aborts on duplicate meta.
  - Exposes `onMeta` and `getMeta()` (no persistence beyond session).
  - Uses a byte-based stream queueing strategy to bound JS buffering.

- `client/app.js`
  - Sender includes `{ name, type, size }` derived from `File`.
  - Receiver uses META to set:
    - Display title (filename)
    - Save filename (if receive folder is set before writer opens)
    - Progress percent (if size is present)

## Tests / Gates

- Regression:
  - `client/test/metadata.test.js`
- WebRTC E2E:
  - `npm run e2e` asserts receiver observed `recvTitle === "e2e.bin"`

## Stage 7 Invariants (Non-Negotiable)

- No persistence:
  - Metadata is ephemeral and must not be stored beyond the session.

- Bounded memory:
  - META must remain bounded in size.
  - Receiver must not allow unbounded buffering if the consumer stalls.

- Determinism:
  - META is one-shot per transfer.
  - Protocol framing must remain message-boundary deterministic (no partial reads, no concatenation).

