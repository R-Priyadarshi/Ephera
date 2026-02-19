# FUTURE CHANGE GATES

- ANY future change touching frozen components must:
  - Pass all Stage 3.3 tests
  - Pass all Stage 4 fairness tests
  - Pass Stage 6 crypto tests (passphrase mode)
  - Pass Stage 7 metadata tests
  - Pass Stage 8 control/receipt regressions (covered by WebRTC E2E)
  - Pass Stage 9 passphrase handshake regressions (covered by WebRTC E2E)
  - Pass WebRTC E2E: `npm run e2e`
  - Re-run manual memory heap snapshot
  - Explicitly list affected invariants (or state 'none')

NOTE:
- Logical version name: v0.3.3-engine-frozen
- Logical version name (Stage 4): v0.4.0-fairness-frozen
- Logical version name (Stage 5): v0.5.0-transport-hardened-frozen
- Logical version name (Stage 6): v0.6.0-crypto-frozen
- Logical version name (Stage 7): v0.7.0-meta-frozen
- Logical version name (Stage 8): v0.8.0-control-frozen
- Logical version name (Stage 9): v0.9.0-passphrase-handshake-frozen
- This is a conceptual freeze marker, not a git tag yet
- Git tagging will occur only when the full app is production-ready
