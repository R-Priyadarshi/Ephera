# ARCHITECTURE FREEZE: STAGE 9.0

Stage 9.0 is declared frozen.

## What Stage 9 Adds

Stage 9 adds a **passphrase verification handshake** to prevent wasted encrypted transfers.

Problem:
- If both peers are in passphrase mode but the passphrases do not match, encrypted transfers will fail on decrypt.

Stage 9 solution:
- Before enabling outbound sending in passphrase mode, peers verify they share the same passphrase using a small P2P handshake.

## Handshake Encoding (Encrypted META)

Stage 9 uses an encrypted META frame over the DataChannel (no new message types):

- Message type: `MSG_META = 0x05`
- Frame: `[type(1)] [transferId(8)] [flags(1)] [metaLen(2)] [metaPayload(metaLen)]`

Handshake payload:
- JSON bytes:
  - `{ v: 1, kind: "handshake", ... }`

Encryption:
- `META_FLAG_ENCRYPTED = 0x01`
- Encryption uses the Stage 6 per-transfer meta domain:
  - `nonce = transferId(8) || 0xFFFFFFFF(4)`
  - AAD binds to `MSG_META`, `transferId`, `flags`

## Reserved transferId Domain (Disjoint From Transfers)

Handshake META frames MUST NOT be routable as session META.

Rule:
- Handshake frames use a disjoint transferId domain:
  - Reserved: `transferId[0]` high bit set (`0x80`)
  - Regular transfers MUST clear this bit.

This makes collisions impossible and prevents handshake META from ever being treated as per-transfer metadata.

## Canonical Components

- `client/app.js`
  - Sends best-effort handshake META when:
    - transport is open
    - both peers are in passphrase mode
  - Marks `passphraseVerified=true` only when a valid handshake is decrypted.
  - Gates Send UX on verification (passphrase mode only).

- `client/sender.js`
  - Generates transferIds with `transferId[0]` high bit cleared to preserve the reserved domain.

- `e2e/webrtc-app.e2e.cjs`
  - Adds a passphrase mismatch scenario asserting Send remains disabled.

## Stage 9 Invariants (Non-Negotiable)

- No persistence:
  - Verification state is RAM-only and cleared on teardown.

- No crypto footguns:
  - META encryption nonce MUST NOT be reused with the same key.
  - Handshake frames MUST use unique transferIds (and thus unique meta nonces).

- No protocol lifecycle interference:
  - Handshake META must never create or mutate a `TransferSession`.

## Change Gate

Any change touching Stage 9 behavior must:

- Pass `npm test`
- Pass `npm run e2e`

NOTE:
- Logical version name: `v0.9.0-passphrase-handshake-frozen`
- Git tagging occurs only when the full app is production-ready

