# Ephera Release Readiness

Date: 2026-03-09  
Scope: backend production-readiness checkpoint

## Summary

Backend status: PRODUCTION-CANDIDATE (current scope)

- Engine invariants/freeze docs are present through Stage 20.
- Local automated gates are available and passing.
- GitHub CI required checks are active and green.
- Public staging deployment is live (`https://ephera.onrender.com`).
- Deploy-target smoke gate passed on deployed URL.

## Completed Milestones

- Core transport/signaling architecture and test suites.
- CI workflow (`.github/workflows/ci.yml`) including required-check aggregation.
- Deploy-target WebRTC smoke gate (`.github/workflows/staging-smoke.yml`).
- Public staging deployment blueprint (`render.yaml`) and live service.
- Staging health/readiness verification:
  - `GET /healthz` => `ok: true`
  - `GET /readyz` => `ok: true`
- Staging smoke verification on deployed URL:
  - `create_join_transport` pass
  - `small_transfer_success` pass
  - `receiver_cancel_aborts_sender` pass

## Remaining Work (Full-App Completion)

- Final frontend productization pass (world-class UX/UI quality bar).
- Production TURN rollout validation in hosted environment (if relay-first policy is required for launch).
- Final manual QA sign-off on deployed UX (create/join/send/cancel/folder-save on target browsers/devices).

## Command Gates (Reference)

- Full local gate:
  - `npm run gates`
- Server-only:
  - `npm run test:server`
- Fast E2E:
  - `npm run e2e:fast`
- Deploy-target smoke:
  - `STAGING_BASE_URL='https://<public-url>' npm run e2e:staging-smoke`

## Deploy-Target Gate (GitHub Actions)

- Workflow: `staging-smoke`
- Inputs:
  - `staging_base_url` (required, public HTTPS URL)
  - `staging_signal_url` (optional, only if signaling host is separate)

## Current Recommendation

1. Keep backend baseline frozen at current milestone.
2. Start frontend productization sprint.
3. Re-run staging smoke after major frontend transport-flow changes.
