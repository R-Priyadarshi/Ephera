# ARCHITECTURE FREEZE: STAGE 16.0

Stage 16.0 is declared frozen.

## What Stage 16 Adds

Stage 16 adds **log-safe secret-link handling** for join flows.

Problem:
- Secret material in query params (`roomJoinKey`, `passphrase`) can leak through request lines and access logs.

Stage 16 solution:
- Generated join links move secret material to URL fragment (`#...`) instead of query.
- Client ingest is hash-first with query fallback for backward compatibility.
- After read, secret params are stripped from address bar and in-memory URL param stores.

## Runtime Contract

Join-link generation:
- `roomJoinKey` is required and encoded in fragment.
- `passphrase` is optional and encoded in fragment only when explicitly enabled.
- Non-secret controls (`roomId`, `autojoin`, signaling/ICE options) remain in query as needed.

Join-link ingestion:
- Read secrets from fragment first, then query fallback (`roomJoinKey`/`joinKey`, `passphrase`).
- Immediately strip secrets from both query and fragment after ingest.

## Canonical Components

- `client/app.js`
  - Hash/query secret param handling.
  - Join-link construction and strip-on-read behavior.

- `e2e/webrtc-app.e2e.cjs`
  - Stage 16 URL generation and join-link assertions:
    - secrets present in fragment
    - secrets absent from query

- `README.md` / `server/README.md`
  - Public contract for fragment-based secret-link behavior.

## Stage 16 Invariants (Non-Negotiable)

- No secret query emission:
  - Generated join links must not place `roomJoinKey`/`passphrase` in query params.

- Backward compatibility:
  - Legacy query-based secret links must still work, then be stripped.

- Zero-retention alignment:
  - Secret-link parsing/stripping must remain RAM-only and must not add persistence or telemetry.

## Change Gate

Any change touching Stage 16 behavior must:

- Pass `npm test`
- Pass `npm run e2e`
- Keep Stage 16 fragment/query regressions passing in `e2e/webrtc-app.e2e.cjs`

NOTE:
- Logical version name: `v0.16.0-log-safe-secret-links-frozen`
- Git tagging occurs only when the full app is production-ready
