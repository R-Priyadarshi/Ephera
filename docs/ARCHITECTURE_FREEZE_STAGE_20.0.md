# ARCHITECTURE FREEZE: STAGE 20.0

Stage 20.0 is declared frozen.

## What Stage 20 Adds

Stage 20 adds **TURN secret hygiene hardening** and **required relay gate aggregation**.

Problem:
- Dynamic TURN support existed, but weak/placeholder TURN secrets could still be misconfigured.
- CI had multiple required jobs, but no single aggregate status to fail closed if any upstream gate failed.

Stage 20 solution:
- App server fail-closes dynamic TURN runtime config when `TURN_AUTH_SECRET` is weak.
- Local relay gate fail-closes early on invalid relay secret/TTL inputs.
- CI exposes one aggregate required check (`required-checks`) that fails if any upstream gate fails.

## Runtime Contract

Dynamic TURN runtime config (`server/serve.js`):
- When `TURN_URLS_JSON` is set, `TURN_AUTH_SECRET` must:
  - be at least 16 characters,
  - not equal `change-me-secret`.
- Invalid TURN secret configuration exits process with code `1` (fail-closed).

Relay local gate (`scripts/relay-gate-local.cjs`):
- `deploy/.env` relay checks fail fast before starting compose if:
  - `TURN_AUTH_SECRET` is missing,
  - `TURN_AUTH_SECRET` is `change-me-secret`,
  - `TURN_AUTH_SECRET` is shorter than 16 characters,
  - `TURN_TTL_SECONDS` is outside `30..86400`.

CI required aggregation (`.github/workflows/ci.yml`):
- `required-checks` depends on:
  - `core-tests`
  - `full-gates`
  - `relay-required`
- `required-checks` must fail if any dependency result is not `success`.
- Relay env prep must always supply a non-placeholder secret (from secret or generated random value).

## Canonical Components

- `server/serve.js`
  - Dynamic TURN secret validation (fail-closed).

- `server/test/serve.test.js`
  - Stage 20 regressions for weak/placeholder TURN auth secret startup failures.

- `scripts/relay-gate-local.cjs`
  - Relay local gate secret/TTL validation before coturn startup.

- `.github/workflows/ci.yml`
  - `required-checks` aggregate CI status and relay secret provisioning.

## Stage 20 Invariants (Non-Negotiable)

- TURN secret fail-closed:
  - Dynamic TURN mode must never accept weak placeholder secrets.

- Relay gate determinism:
  - Relay-required gating must fail before runtime when local relay env is invalid.

- CI gate aggregation:
  - Required CI status must deterministically fail if any core/full/relay gate fails.

- Zero-retention alignment:
  - TURN credentials remain ephemeral and generated per runtime request; no persistence is introduced.

## Change Gate

Any change touching Stage 20 behavior must:

- Pass `npm test`
- Pass `npm run e2e`
- Pass `npm run gates:relay-local`
- Keep Stage 20 app-server invalid TURN env regressions passing in `server/test/serve.test.js`

NOTE:
- Logical version name: `v0.20.0-relay-hardening-frozen`
- Git tagging occurs only when the full app is production-ready
