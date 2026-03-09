# FUTURE CHANGE GATES

- ANY future change touching frozen components must:
  - Pass all Stage 3.3 tests
  - Pass all Stage 4 fairness tests
  - Pass Stage 6 crypto tests (passphrase mode)
  - Pass Stage 7 metadata tests
  - Pass Stage 8 control/receipt regressions (covered by WebRTC E2E)
  - Pass Stage 9 passphrase handshake regressions (covered by WebRTC E2E)
  - Pass Stage 10 protocol compatibility regressions (`client/test/capabilities.negotiation.test.js` + WebRTC `protocol-mismatch`)
  - Pass Stage 11 app-server shutdown regressions (`server/test/serve.test.js` hung-connection shutdown + env validation)
  - Pass Stage 12 signaling per-IP admission regressions (`server/test/signaling.test.js`: per-IP cap + trust-proxy behavior)
  - Pass Stage 13 signaling room-abuse throttle regressions (`server/test/signaling.test.js`: room-op budget + cooldown)
  - Pass Stage 14 signaling join-enumeration resistance regressions (`server/test/signaling.test.js`: shaped join denial + indistinguishable miss/full errors)
  - Pass Stage 15 signaling room-admission-auth regressions (`server/test/signaling.test.js`: room join key required/match + custom key contract)
  - Pass Stage 16 secret-link hygiene regressions (WebRTC E2E URL-fragment assertions + autojoin flow)
  - Pass Stage 17 owner-authority regressions (`server/test/signaling.test.js`: peer identity contract + owner-only room ops + owner transfer)
  - Pass Stage 18 owner-control UX regressions (WebRTC E2E `owner-authority-ui` + `owner-disconnect-transfer-ui` scenarios)
  - Pass Stage 19 owner-op abuse throttling regressions (`server/test/signaling.test.js`: owner-op cooldown + non-owner abuse throttle + close-room cooldown)
  - Pass Stage 20 TURN secret hygiene + relay gate aggregation regressions (`server/test/serve.test.js`: weak TURN secret fail-fast; relay required gate path remains non-skippable in CI via `required-checks`)
  - Pass WebRTC E2E: `npm run e2e`
  - Re-run manual memory heap snapshot
  - Explicitly list affected invariants (or state 'none')

## CI Required Checks

Branch protection should require this CI job check before merge:

- `required-checks` (aggregates `core-tests`, `full-gates`, and `relay-required`; fails if any upstream job fails)

Upstream CI jobs validated by `required-checks`:

- `core-tests` (`npm test`)
- `full-gates` (`npm run gates`)
- `relay-required` (`npm run gates:relay-local` -> includes `npm run e2e:relay:required`)

Workflow file:

- `.github/workflows/ci.yml`

Recommended repository setting:

- GitHub Settings -> Branches -> Branch protection rules -> Require status checks to pass before merging
  - Mark `required-checks` as required.

NOTE:
- Logical version name: v0.3.3-engine-frozen
- Logical version name (Stage 4): v0.4.0-fairness-frozen
- Logical version name (Stage 5): v0.5.0-transport-hardened-frozen
- Logical version name (Stage 6): v0.6.0-crypto-frozen
- Logical version name (Stage 7): v0.7.0-meta-frozen
- Logical version name (Stage 8): v0.8.0-control-frozen
- Logical version name (Stage 9): v0.9.0-passphrase-handshake-frozen
- Logical version name (Stage 10): v0.10.0-protocol-compat-frozen
- Logical version name (Stage 11): v0.11.0-server-shutdown-frozen
- Logical version name (Stage 12): v0.12.0-signaling-ip-controls-frozen
- Logical version name (Stage 13): v0.13.0-signaling-room-throttle-frozen
- Logical version name (Stage 14): v0.14.0-signaling-join-enumeration-frozen
- Logical version name (Stage 15): v0.15.0-room-admission-auth-frozen
- Logical version name (Stage 16): v0.16.0-log-safe-secret-links-frozen
- Logical version name (Stage 17): v0.17.0-owner-authority-frozen
- Logical version name (Stage 18): v0.18.0-owner-control-ux-frozen
- Logical version name (Stage 19): v0.19.0-owner-op-throttle-frozen
- Logical version name (Stage 20): v0.20.0-relay-hardening-frozen
- This is a conceptual freeze marker, not a git tag yet
- Git tagging will occur only when the full app is production-ready
