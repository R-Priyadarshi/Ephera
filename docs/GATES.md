# FUTURE CHANGE GATES

- ANY future change touching frozen components must:
  - Pass all Stage 3.3 tests
  - Pass all Stage 4 fairness tests
  - Pass Stage 6 crypto tests (passphrase mode)
  - Pass Stage 7 metadata tests
  - Pass Stage 8 control/receipt regressions (covered by WebRTC E2E)
  - Pass Stage 9 passphrase handshake regressions (covered by WebRTC E2E)
  - Pass Stage 10 protocol compatibility regressions (`client/test/capabilities.negotiation.test.js` + WebRTC `protocol-mismatch`)
  - Pass WebRTC E2E: `npm run e2e`
  - Re-run manual memory heap snapshot
  - Explicitly list affected invariants (or state 'none')

## CI Required Checks

Branch protection must require these CI job checks before merge:

- `core-tests` (`npm test`)
- `full-gates` (`npm run gates`)
- `relay-required` (`npm run gates:relay-local` -> includes `npm run e2e:relay:required`)

Workflow file:

- `.github/workflows/ci.yml`

Recommended repository setting:

- GitHub Settings -> Branches -> Branch protection rules -> Require status checks to pass before merging
  - Mark `core-tests`, `full-gates`, and `relay-required` as required.

NOTE:
- Logical version name: v0.3.3-engine-frozen
- Logical version name (Stage 4): v0.4.0-fairness-frozen
- Logical version name (Stage 5): v0.5.0-transport-hardened-frozen
- Logical version name (Stage 6): v0.6.0-crypto-frozen
- Logical version name (Stage 7): v0.7.0-meta-frozen
- Logical version name (Stage 8): v0.8.0-control-frozen
- Logical version name (Stage 9): v0.9.0-passphrase-handshake-frozen
- Logical version name (Stage 10): v0.10.0-protocol-compat-frozen
- This is a conceptual freeze marker, not a git tag yet
- Git tagging will occur only when the full app is production-ready
