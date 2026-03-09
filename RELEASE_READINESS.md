# Ephera Release Readiness

Date: 2026-03-09  
Scope: backend production-readiness checkpoint

## Summary

Release status: IN PROGRESS (not production-complete)

- Engine invariants/freeze docs are present through Stage 20.
- Local automated gates are available and passing.
- GitHub CI required checks are active and green.
- Manual deploy-targeted gate exists (`staging-smoke`).

## What Is Completed

- Core transport/signaling architecture and test suites.
- CI workflow (`.github/workflows/ci.yml`) including required-check aggregation.
- Deploy-target WebRTC smoke gate (`.github/workflows/staging-smoke.yml`).
- Deployment guidance for reverse proxy + TURN runtime config.

## Remaining Production Blockers

- Public HTTPS staging deployment must be live.
- `staging-smoke` must pass against the deployed URL.
- Production TURN path must be validated in deployed environment.
- Final manual QA sign-off on deployed UX (create/join/send/cancel/folder-save).

## Command Gates (Local)

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

1. Bring up public staging (for example via Render blueprint `render.yaml`).
2. Run `staging-smoke` against that URL.
3. Close remaining manual QA items.
4. Then declare backend production-complete and move to frontend productization final pass.
