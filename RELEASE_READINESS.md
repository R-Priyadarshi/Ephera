# Ephera Release Readiness (Local)

Date: 2026-02-20
Scope: local release-finalization checkpoint (no remote push)

## Summary

Release status: READY (local)

- Engine invariants and freeze docs are present.
- Automated gates pass end-to-end.
- Manual QA reported as passed by operator.

## Automated Validation

Latest full gate run:

- Command: `npm run gates`
- Result: PASS
- Date: 2026-02-20
- Includes:
  - `npm run scan` (zero-memory scan)
  - `npm test` (client + signaling + app-server tests)
  - `npm run e2e:perf` (includes 100MB transfer perf gate)
  - `npm run e2e:soak` (idle stability + repeated connect/disconnect cycles)

Latest production smoke run (`npm start` path):

- Date: 2026-02-20
- Server boot: PASS (`HTTP_OK`)
- Security headers: PASS (`HTTP_HEADERS_OK`)
- Same-origin signaling over WS: PASS (`WS_SIGNALING_OK`)

Notable E2E checks covered:

- passphrase mismatch gate (send remains disabled)
- signaling restart and crash resilience
- same-origin app server flow (`npm start` path)
- secure runtime flow (`dev-secure.js`, HTTPS/WSS, self-signed)
- join-link auto-join
- folder-save path (polyfilled picker + saved receipt + byte integrity)
- sender-close/receiver-cancel abort semantics
- session collectability/GC checks

## Manual QA

Operator status: PASS (reported)

Manual checklist intent:

- create/join transfer flow
- ready/discard flow
- passphrase match/mismatch behavior
- cancel/abort behavior
- folder-save behavior in browser that supports directory picker

## Known Notes

- Browser support caveat: some Brave environments may not expose
  `showDirectoryPicker`, forcing discard-only mode.
  Use Chrome/Edge (or enable relevant Brave flag) for real folder-save UX checks.

## Governance

Freeze and governance docs:

- `docs/INVARIANTS.md`
- `docs/GATES.md`
- `docs/ARCHITECTURE_FREEZE_STAGE_9.0.md`
- earlier stage freeze docs remain present

## Release Action

This checkpoint is local-only by request.

- Local commit: allowed
- Push to GitHub: deferred until explicit approval
