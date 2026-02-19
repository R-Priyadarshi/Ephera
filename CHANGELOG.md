# Changelog

## 2026-02-20

- Added secure runtime E2E coverage:
  - `secure-app-server` scenario in `e2e/webrtc-app.e2e.cjs`
  - starts `dev-secure.js` inside E2E harness and validates HTTPS/WSS path
- Added and stabilized join-link automation:
  - `join-link-autojoin` scenario
  - deterministic state waits
- Added folder-save E2E gate via in-memory picker polyfill:
  - verifies `saved` receipt path
  - verifies saved byte integrity
- Added dedicated app-server tests:
  - new `server/test/serve.test.js`
  - static/security header checks
  - same-origin WS signaling checks
  - wired into `server/test/run-all.js`
- Updated docs:
  - `README.md`
  - `PERFORMANCE_HARDENING_CHECKLIST.md`
  - `server/README.md`
  - added `RELEASE_READINESS.md`
