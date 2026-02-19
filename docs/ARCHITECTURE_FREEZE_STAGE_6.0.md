# ARCHITECTURE FREEZE: STAGE 6.0

Stage 6.0 is declared frozen.

## What Stage 6 Adds

Stage 6 introduces **optional application-layer encryption** to remain secure even if signaling is compromised.

- AES-256-GCM per protocol chunk
- Key derived from a passphrase (PBKDF2, salt = `transferId`)
- Nonce per chunk = `transferId(8) || chunkIndex(4)` (12 bytes)
- AAD binds ciphertext to the protocol CHUNK header fields

This is additive: the transport remains WebRTC (DTLS), and Stage 6 adds an extra independent encryption layer.

## Canonical Components

- `client/crypto.js`
  - `deriveAesGcmKey(passphrase, transferId)` (PBKDF2)
  - `encryptChunk(...)` / `decryptChunk(...)` (AES-GCM)
  - `GCM_TAG_BYTES` used to keep frames under the 64KB bound

- `client/sender.js`
  - If `passphrase` is set, encrypts each CHUNK payload before framing.
  - Reduces plaintext slice size by `GCM_TAG_BYTES` to keep frames bounded.

- `client/app.js`
  - UI exposes a passphrase field (ephemeral, memory-only).
  - Includes `cryptoMode` in the "ready" signal to prevent accidental mode mismatch.
  - If passphrase is set locally, receiver **fails closed** (decrypt required; no plaintext fallback).

- Tests:
  - `client/test/encryption.passphrase.test.js` (loopback regression)
  - `npm run e2e` runs both plain + passphrase WebRTC scenarios

## Stage 6 Invariants (Non-Negotiable)

- No persistence:
  - Passphrase must not be stored (no LocalStorage, IndexedDB, cookies, etc.).

- Fail-closed:
  - If passphrase mode is enabled locally, decryption is mandatory.
  - Decryption failure aborts the transfer; no automatic downgrade to plaintext.

- Determinism:
  - Nonce uniqueness must be guaranteed per transfer.
  - Decryption must be chunk-order deterministic.

- Memory:
  - Derive the key once per transfer.
  - No buffering of entire payloads; chunk-by-chunk only.

## Change Gate

Any change touching Stage 6 crypto must:

- Pass `npm test`
- Pass `npm run e2e`
- Re-run browser manual memory verification
- Explicitly list affected invariants (or state "none")

